import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import {
  DEFAULT_MONEY_SETTINGS,
  MAX_RISK_TIERS,
  breakEvenPrice,
  effectiveRisk,
  findTier,
  capitalOf,
  floorToStep,
  isLiveTrade,
  lotsLabel,
  moneyLabel,
  moneySettingsSchema,
  pendingExecution,
  percentLabel,
  sizePosition,
  tradeR,
  tradeGestureSchema,
  tradeSchema,
  valueOfDistance,
  type AccountSnapshot,
  type Drawing,
  type MoneySettings,
  type OrderExecution,
  type Risk,
  type RiskTier,
  type SymbolTerms,
  type Ticket,
  type TicketAction,
  type Trade,
  type TradeExit,
  type TradeGesture,
  type TradeLeg,
  type TradingState,
} from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { startOfDay } from "../common/dates.js";
import { ConfigService } from "../config/config.service.js";
import { DatabaseService } from "../db/database.service.js";
import { DashboardService } from "../dashboard/dashboard.service.js";
import { MarketService } from "../market/market.service.js";
import { MarketError, frenchPrice } from "../market/metaapi.js";
import { commissionFromDeals, exitReasonOf, type BrokerDeal, type BrokerOrder, type BrokerPosition } from "../market/broker.js";
import { ScenarioService } from "../setups/scenario.service.js";
import { closedTexts, filledTexts, gestureText, manageTicketText, openTicketText, placedTexts, reminderTexts, rLabel, tradeLine } from "./trading-texts.js";

/** Erreur lisible de la prise de position, renvoyée telle quelle à Kopilia ou à l'écran. */
export class TradingError extends Error {}

/** Un ticket attend la confirmation au plus ce délai. */
export const TICKET_TTL_MS = 90_000;
/** Les trades en cours sont relus chez le courtier à ce rythme. */
const SYNC_MS = 4_000;
/** Le compte (solde, capitaux propres) est relu au plus à ce rythme. */
const ACCOUNT_MS = 30_000;
/** Les conditions d'un produit (fiche, valeur du tick) sont gardées ce délai. */
const TERMS_MS = 10 * 60_000;
/** La commission lue sur les transactions est recalculée à ce rythme, sur cette période. */
const COMMISSION_MS = 6 * 3_600_000;
const COMMISSION_SPAN_MS = 30 * 86_400_000;
/** Trades terminés envoyés aux écrans : ceux de ce délai, ce nombre au plus. */
const RECENT_MS = 24 * 3_600_000;
const RECENT_MAX = 20;
/** Objectifs au plus d'un ordre d'ouverture (une jambe chacun). */
export const MAX_TARGETS = 3;
/** Après un geste demandé à Kopilia, la relecture attend le nouveau niveau au plus ce délai. */
const EXPECT_MS = 30_000;

/** Ce que garde le journal d'un trade : un ordre, une réponse du courtier, un geste, une note… */
export interface TradeEvent {
  at: number;
  kind: string;
  text: string;
  data?: unknown;
}

/** Ce qui arrive à un trade, pour les écrans et Kopilia. */
export interface TradingSignal {
  kind: "placed" | "filled" | "closed" | "rejected" | "reminder" | "error";
  trade?: Trade;
  title: string;
  detail?: string;
  /** Confirmé à la voix : Kopilia le dit déjà dans sa réponse. */
  quiet?: boolean;
  /** Pour Kopilia : ce qui s'est passé, en une phrase. */
  line: string;
}

/** Une demande d'ouverture : la boîte, et ce qui change pour cet ordre. */
export interface OpenRequest {
  drawingId: string;
  /** Au marché (tout de suite), ou en attente au prix de l'entrée (par défaut). */
  execution?: "market" | "pending";
  /** Plusieurs objectifs (une jambe par objectif) ; sans : celui de la boîte. */
  targets?: number[];
  /** Part de chaque objectif (0 à 1, même nombre que targets) ; sans : parts égales. */
  shares?: number[];
  risk?: Risk;
  /** Un palier de l'utilisateur (« A+ ») : son pourcentage. */
  tier?: string;
  setupId?: string;
}

/** Une demande de gestion d'un trade en cours. */
export interface ManageRequest {
  action: Exclude<TicketAction, "open">;
  trade?: string;
  drawingId?: string;
  symbol?: string;
  stop?: number;
  target?: number;
  fraction?: number;
  /** Il a effacé la boîte du trade : elle partira une fois l'ordre retiré (ou la position fermée). */
  eraseBox?: boolean;
}

/** Le ticket en attente, avec ce qui partira chez le courtier sur confirmation. */
interface PendingTicket {
  ticket: Ticket;
  requests: Array<Record<string, unknown>>;
  /** Ouverture : le trade à enregistrer avant l'envoi (ses jambes portent leur clientId). */
  draft?: Trade;
  terms?: SymbolTerms;
}

interface TradeRow {
  id: string;
  symbol: string;
  state: string;
  spec: string;
  created_at: number;
  updated_at: number;
}

/**
 * La prise de position : le money management de l'utilisateur, la taille de
 * ses boîtes de trade calculée sur son compte, et les ordres qu'il fait passer.
 * L'IA prépare un ticket (ouverture depuis une boîte, break-even, stop,
 * clôture…) ; il part chez le courtier seulement quand l'utilisateur le
 * confirme, au clic ou en disant « je confirme » (reconnu par le code, pas par
 * l'IA), avant qu'il expire. Un ordre n'est jamais renvoyé de lui-même. Les
 * trades de Kopilia sont suivis chez le courtier (leur clientId) tant qu'ils
 * vivent. Émet `changed` (l'état des écrans) et `signal`.
 */
@Injectable()
export class TradingService
  extends EventEmitter<{ changed: []; signal: [TradingSignal]; confirmed: [Trade]; noted: [Trade] }>
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  /** Remplaçables en test. */
  now = () => Date.now();
  syncMs = SYNC_MS;
  private account?: { at: number; value: AccountSnapshot };
  private accountError?: string;
  private accountRead?: Promise<AccountSnapshot>;
  private readonly terms = new Map<string, { at: number; value: SymbolTerms; bid: number; ask: number }>();
  private readonly termsReads = new Map<string, Promise<void>>();
  private commissions?: { at: number; deals: BrokerDeal[] };
  private pending?: PendingTicket;
  /** Les trades dont la boîte s'efface quand ils se terminent chez le courtier (retrait ou fermeture confirmés). */
  private readonly eraseOnEnd = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticketTimer?: NodeJS.Timeout;
  private syncRun?: Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  /** Les niveaux que Kopilia vient de demander au courtier, attendus à la relecture. */
  private readonly expected = new Map<string, { stop?: number; target?: number; until: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly market: MarketService,
    private readonly dashboard: DashboardService,
    private readonly logger: AppLogger,
    @Optional() private readonly scenarios?: ScenarioService,
  ) {
    super();
    // La boîte d'un trade en cours ne s'efface pas d'un geste : retirer l'ordre (ou fermer la position) passe par un ticket confirmé.
    if (dashboard.drawings) dashboard.drawings.guard = (ids) => this.liveBoxes(ids);
  }

  onApplicationBootstrap() {
    this.restoreBoxes();
  }

  onModuleInit() {
    // Une boîte posée ou déplacée, un graphique ouvert : leurs conditions et le compte sont relus (regroupés).
    this.dashboard.on("updated", () => this.refreshSoon());
    // L'encart Journal montre les trades en cours en direct : leurs produits sont suivis tant qu'il est là.
    const follow = () => this.dashboard.followTrades(this.liveTrades().map((t) => t.symbol));
    this.on("changed", follow);
    follow();
    if (this.market.enabled) setTimeout(() => this.refreshSoon(), 4_000).unref();
    this.timer = setInterval(() => void this.tick(), this.syncMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.ticketTimer);
    clearTimeout(this.refreshTimer);
  }

  /** Les ordres sont permis par la configuration (sinon : calculs seulement). */
  get ordersEnabled(): boolean {
    return this.config.tradingOrders && this.market.enabled;
  }

  /* ------------------------------ Réglages ------------------------------ */

  settings(): MoneySettings {
    const row = this.db.db.prepare("SELECT value FROM trading_settings WHERE key = 'money'").get() as { value: string } | undefined;
    if (!row) return DEFAULT_MONEY_SETTINGS;
    const parsed = moneySettingsSchema.safeParse({ ...DEFAULT_MONEY_SETTINGS, ...(JSON.parse(row.value) as object) });
    return parsed.success ? parsed.data : DEFAULT_MONEY_SETTINGS;
  }

  /**
   * Change le money management ; `null` retire une limite (ou une commission
   * réglée, qui revient alors à celle lue sur les transactions).
   */
  updateSettings(patch: {
    defaultRisk?: Risk;
    maxRiskPercent?: number;
    maxOpenRiskPercent?: number | null;
    maxDailyLossPercent?: number | null;
    maxWeeklyLossPercent?: number | null;
    capitalBase?: MoneySettings["capitalBase"];
    breakEvenAtR?: number | null;
    commission?: { symbol: string; value: number | null };
    /** Un palier ajouté ou changé (même nom), ou retiré par son nom. */
    tier?: RiskTier;
    removeTier?: string;
  }): MoneySettings {
    const current = this.settings();
    const next: Record<string, unknown> = { ...current };
    for (const key of ["defaultRisk", "maxRiskPercent", "capitalBase"] as const) if (patch[key] !== undefined) next[key] = patch[key];
    for (const key of ["maxOpenRiskPercent", "maxDailyLossPercent", "maxWeeklyLossPercent", "breakEvenAtR"] as const) {
      if (patch[key] === null) delete next[key];
      else if (patch[key] !== undefined) next[key] = patch[key];
    }
    if (patch.commission) {
      const commissions = { ...current.commissions };
      if (patch.commission.value === null) delete commissions[patch.commission.symbol];
      else commissions[patch.commission.symbol] = patch.commission.value;
      next.commissions = commissions;
    }
    if (patch.tier || patch.removeTier) {
      let tiers = [...current.tiers];
      if (patch.removeTier) {
        const gone = findTier(tiers, patch.removeTier);
        if (!gone) throw new TradingError(`aucun palier « ${patch.removeTier} »${tiers.length ? ` ; les tiens : ${tiers.map((t) => t.name).join(", ")}` : ""}`);
        tiers = tiers.filter((t) => t !== gone);
      }
      if (patch.tier) {
        const same = findTier(tiers, patch.tier.name);
        tiers = same ? tiers.map((t) => (t === same ? { ...patch.tier!, when: patch.tier!.when ?? same.when } : t)) : [...tiers, patch.tier];
        if (tiers.length > MAX_RISK_TIERS) throw new TradingError(`${MAX_RISK_TIERS} paliers au plus : retires-en un d'abord`);
      }
      next.tiers = tiers.sort((a, b) => a.percent - b.percent);
    }
    const parsed = moneySettingsSchema.safeParse(next);
    if (!parsed.success) throw new TradingError(`réglage illisible : ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ")}`);
    const s = parsed.data;
    if (s.defaultRisk.mode === "percent" && s.defaultRisk.value > s.maxRiskPercent) {
      throw new TradingError(`le risque par défaut (${percentLabel(s.defaultRisk.value)}) dépasse le plafond par trade (${percentLabel(s.maxRiskPercent)})`);
    }
    const over = s.tiers.find((t) => t.percent > s.maxRiskPercent);
    if (over) throw new TradingError(`le palier ${over.name} (${percentLabel(over.percent)}) dépasse le plafond par trade (${percentLabel(s.maxRiskPercent)})`);
    this.db.db
      .prepare(
        "INSERT INTO trading_settings (key, value, updated_at) VALUES ('money', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(s), this.now());
    if (patch.commission) this.terms.delete(patch.commission.symbol);
    this.emit("changed");
    if (patch.commission) this.refreshSoon();
    return s;
  }

  /* ---------------------------- État des écrans ---------------------------- */

  /** L'état envoyé aux écrans. */
  state(): TradingState {
    const terms: Record<string, SymbolTerms> = {};
    for (const [symbol, t] of this.terms) terms[symbol] = t.value;
    return {
      ordersEnabled: this.ordersEnabled,
      ...(this.account ? { account: this.account.value } : {}),
      settings: this.settings(),
      terms,
      trades: this.recentTrades(),
      ...(this.pending && this.pending.ticket.expiresAt > this.now() ? { ticket: this.pending.ticket } : {}),
      ...(this.accountError && !this.account ? { error: this.accountError } : {}),
    };
  }

  /** Relit bientôt le compte et les conditions des produits qui ont une boîte (plusieurs changements d'affilée : une fois). */
  refreshSoon(delay = 800) {
    if (this.refreshTimer || !this.market.enabled) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
    this.refreshTimer.unref();
  }

  /** Les produits dont il faut les conditions : ceux qui ont une boîte de trade à l'écran, ou un trade en cours. */
  private wantedSymbols(): string[] {
    const boxes = this.dashboard
      .view()
      .drawings.filter((d) => d.kind === "position")
      .map((d) => d.symbol);
    const live = this.liveTrades().map((t) => t.symbol);
    return [...new Set([...boxes, ...live])];
  }

  private async refresh() {
    const symbols = this.wantedSymbols();
    if (!symbols.length && !this.liveTrades().length) return;
    const before = JSON.stringify(this.state());
    await this.readAccount().catch(() => undefined);
    await Promise.all(symbols.map((s) => this.ensureTerms(s).catch(() => undefined)));
    if (JSON.stringify(this.state()) !== before) this.emit("changed");
  }

  /** Le compte, relu s'il date (ou `fresh`) ; garde la dernière erreur pour l'écran. */
  async readAccount(fresh = false): Promise<AccountSnapshot> {
    if (!fresh && this.account && this.now() - this.account.at < ACCOUNT_MS) return this.account.value;
    this.accountRead ??= (async () => {
      try {
        const info = await this.market.brokerAccount();
        const value: AccountSnapshot = { ...info, at: this.now() };
        this.account = { at: this.now(), value };
        this.accountError = undefined;
        return value;
      } catch (e) {
        this.accountError = (e as Error).message;
        throw e;
      } finally {
        this.accountRead = undefined;
      }
    })();
    return this.accountRead;
  }

  /** Les conditions d'un produit (gardées 10 minutes), avec sa commission. */
  async ensureTerms(symbol: string, fresh = false): Promise<{ value: SymbolTerms; bid: number; ask: number }> {
    const known = this.terms.get(symbol);
    if (!fresh && known && this.now() - known.at < TERMS_MS) return known;
    let read = this.termsReads.get(symbol);
    if (!read) {
      read = (async () => {
        const [{ terms, bid, ask }, commission] = await Promise.all([this.market.brokerTerms(symbol), this.commissionOf(symbol)]);
        const digits = terms.digits ?? this.dashboard.list().find((p) => p.symbol === symbol)?.digits;
        this.terms.set(symbol, {
          at: this.now(),
          value: { symbol, ...terms, ...(digits !== undefined ? { digits } : {}), commission: commission.value, commissionSource: commission.source },
          bid,
          ask,
        });
      })().finally(() => this.termsReads.delete(symbol));
      this.termsReads.set(symbol, read);
    }
    await read;
    return this.terms.get(symbol)!;
  }

  /** La commission d'un lot : réglée par l'utilisateur, sinon lue sur ses transactions des 30 derniers jours, sinon 0. */
  private async commissionOf(symbol: string): Promise<{ value: number; source: SymbolTerms["commissionSource"] }> {
    const set = this.settings().commissions[symbol];
    if (set !== undefined) return { value: set, source: "user" };
    try {
      if (!this.commissions || this.now() - this.commissions.at > COMMISSION_MS) {
        const now = this.now();
        this.commissions = { at: now, deals: await this.market.brokerDeals(now - COMMISSION_SPAN_MS, now) };
      }
      const value = commissionFromDeals(this.commissions.deals, symbol);
      return value !== undefined && value > 0 ? { value, source: "history" } : { value: 0, source: "none" };
    } catch {
      return { value: 0, source: "none" };
    }
  }

  /* ------------------------------ Tickets ------------------------------ */

  /** Le ticket en attente de confirmation (undefined : aucun, ou expiré). */
  ticket(): Ticket | undefined {
    const t = this.pending?.ticket;
    return t && t.expiresAt > this.now() ? t : undefined;
  }

  /**
   * Prépare l'ouverture d'une position depuis une boîte de trade : la taille
   * selon le risque (le sien, sinon celui du money management), les limites du
   * compte vérifiées, un ordre par objectif. Rien ne part : le ticket attend la
   * confirmation de l'utilisateur.
   */
  async prepareOpen(req: OpenRequest): Promise<Ticket> {
    this.assertOrders();
    const box = this.dashboard.drawings.get(req.drawingId);
    if (!box || box.kind !== "position") throw new TradingError(`aucune boîte de trade « ${req.drawingId} » : liste les tracés (chart_drawings)`);
    const account = await this.tradableAccount();
    const settings = this.settings();
    const { value: terms, bid, ask } = await this.ensureTerms(box.symbol, true);
    const market = req.execution === "market";
    const entry = market ? (box.side === "long" ? ask : bid) : box.entry;
    const execution: OrderExecution = market ? "market" : pendingExecution(box.side, box.entry, { bid, ask });
    const targets = (req.targets?.length ? req.targets : [box.target]).slice(0, MAX_TARGETS);
    if (req.targets && req.targets.length > MAX_TARGETS) throw new TradingError(`${MAX_TARGETS} objectifs au plus`);
    for (const t of targets) {
      if (box.side === "long" ? !(t > entry) : !(t < entry))
        throw new TradingError(`l'objectif ${this.price(t, terms)} n'est pas du bon côté de l'entrée ${this.price(entry, terms)}`);
    }
    // L'ordre suit la boîte : au marché seulement si son entrée est au prix du moment. Sinon, c'est un ordre en attente à son entrée.
    if (market) {
      const gap = Math.abs(entry - box.entry);
      if (gap > marketTolerance(box, { bid, ask }, terms)) {
        throw new TradingError(
          `la boîte attend une entrée à ${this.price(box.entry, terms)} et le prix est à ${this.price(entry, terms)} : un ordre au marché ne correspondrait pas à la boîte. ` +
            `Pour l'ordre en attente à ${this.price(box.entry, terms)}, prépare-le sans market ; pour entrer maintenant, déplace d'abord l'entrée de la boîte au prix du moment (chart_move entry), s'il le demande`,
        );
      }
    }
    if (market && (box.side === "long" ? !(box.stop < bid) : !(box.stop > ask))) {
      throw new TradingError(`le prix (${this.price(box.side === "long" ? bid : ask, terms)}) a déjà passé le stop ${this.price(box.stop, terms)}`);
    }
    let chosen = req.risk ?? box.risk ?? settings.defaultRisk;
    if (req.tier) {
      const tier = findTier(settings.tiers, req.tier);
      if (!tier) {
        throw new TradingError(
          `aucun palier « ${req.tier} »${settings.tiers.length ? ` ; les siens : ${settings.tiers.map((t) => tierLabelShort(t)).join(", ")}` : " : il n'en a pas encore (trading_settings)"}`,
        );
      }
      chosen = { mode: "percent", value: tier.percent, tier: tier.name };
    }
    const risk = effectiveRisk(chosen, settings);
    const capital = capitalOf(account, settings);
    const far = targets.reduce((a, b) => (box.side === "long" ? Math.max(a, b) : Math.min(a, b)));
    const sizing = sizePosition({ entry, stop: box.stop, target: far }, terms, capital, risk, {
      maxRiskPercent: settings.maxRiskPercent,
      currency: account.currency,
    });
    if (sizing.problem) throw new TradingError(sizing.problem);
    const legs = splitLegs(sizing.lots, targets, req.shares, terms);
    const perLotLoss = valueOfDistance(entry - box.stop, terms) + terms.commission;
    const gain = legs.reduce(
      (sum, l) => sum + l.lots * (valueOfDistance(l.target! - entry, terms, terms.tickValueProfit ?? terms.tickValue) - terms.commission),
      0,
    );
    const loss = sizing.lots * perLotLoss;
    await this.checkLimits(account, settings, loss);
    // La marge que le courtier demanderait : au-delà de la marge libre, l'ordre serait refusé.
    let margin: number | undefined;
    try {
      margin = await this.market.brokerMargin({ symbol: box.symbol, side: box.side, volume: sizing.lots, price: entry });
    } catch (e) {
      this.logger.warn(`marge non calculée (${(e as Error).message})`, "trading");
    }
    if (margin !== undefined && account.freeMargin !== undefined && margin > account.freeMargin) {
      throw new TradingError(
        `marge insuffisante : il faudrait ${moneyLabel(margin, account.currency)}, il reste ${moneyLabel(account.freeMargin, account.currency)} de marge libre`,
      );
    }
    const warnings: string[] = [];
    if (sizing.capped === "max-risk") warnings.push(`taille réduite à ton plafond de ${percentLabel(settings.maxRiskPercent)} par trade`);
    if (sizing.capped === "max-volume") warnings.push(`taille réduite au volume maximal du courtier (${lotsLabel(terms.maxVolume)})`);
    if (terms.commissionSource === "none") warnings.push("commission inconnue, comptée à 0 : dis-la-moi si ton compte en prend une");
    if (market) warnings.push("au marché : le prix d'exécution peut différer un peu");
    const product = this.productOf(box.symbol);
    const tradeId = `t_${randomBytes(3).toString("hex")}`;
    const draft: Trade = {
      id: tradeId,
      symbol: box.symbol,
      name: product.name,
      ...(terms.digits !== undefined ? { digits: terms.digits } : {}),
      side: box.side,
      drawingId: box.id,
      ...(req.setupId ? { setupId: req.setupId } : {}),
      execution,
      entry,
      stop: box.stop,
      initialStop: box.stop,
      targets: legs.map((l) => l.target!),
      lots: sizing.lots,
      risk: loss,
      riskPercent: (loss / capital) * 100,
      ...(risk.tier ? { tier: risk.tier } : {}),
      currency: account.currency,
      state: "pending",
      legs: legs.map((l, i) => ({ clientId: `ec_${tradeId.slice(2)}_${i + 1}`, lots: l.lots, target: l.target, state: "pending" as const })),
      protected: false,
      demo: account.demo,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const actionType = `ORDER_TYPE_${box.side === "long" ? "BUY" : "SELL"}${execution === "market" ? "" : `_${execution.toUpperCase()}`}`;
    const requests = draft.legs.map((l) => ({
      actionType,
      symbol: box.symbol,
      volume: l.lots,
      ...(execution === "market" ? {} : { openPrice: box.entry }),
      stopLoss: box.stop,
      ...(l.target !== undefined ? { takeProfit: l.target } : {}),
      clientId: l.clientId,
      comment: "Kopilia",
    }));
    const base = {
      id: `tk_${randomBytes(3).toString("hex")}`,
      action: "open" as const,
      symbol: box.symbol,
      name: product.name,
      ...(terms.digits !== undefined ? { digits: terms.digits } : {}),
      side: box.side,
      drawingId: box.id,
      ...(req.setupId ? { setupId: req.setupId } : {}),
      execution,
      entry,
      stop: box.stop,
      legs,
      lots: sizing.lots,
      loss,
      gain,
      fees: sizing.lots * terms.commission,
      riskPercent: (loss / capital) * 100,
      currency: account.currency,
      ...(margin !== undefined ? { margin } : {}),
      ...(risk.tier ? { tier: risk.tier } : {}),
      warnings,
      account: account.name,
      demo: account.demo,
      createdAt: this.now(),
      expiresAt: this.now() + TICKET_TTL_MS,
    };
    return this.hold({ ticket: { ...base, text: openTicketText(base) }, requests, draft, terms });
  }

  /** Prépare la gestion d'un trade en cours : break-even, stop ou objectif déplacé, clôture (toute ou en partie), ordre retiré. */
  async prepareManage(req: ManageRequest): Promise<Ticket> {
    this.assertOrders();
    await this.sync();
    const trade = this.findTrade(req);
    const account = await this.tradableAccount();
    const { value: terms, bid, ask } = await this.ensureTerms(trade.symbol, true);
    const open = trade.legs.filter((l) => l.state === "open" && l.positionId);
    const pendingLegs = trade.legs.filter((l) => l.state === "pending" && l.orderId);
    const now = trade.side === "long" ? bid : ask;
    const requests: Array<Record<string, unknown>> = [];
    let newStop: number | undefined;
    let newTarget: number | undefined;
    let lots = trade.lots;
    let fraction: number | undefined;
    const extra: { price?: number; profit?: number } = {};
    switch (req.action) {
      case "breakeven": {
        if (!open.length) throw new TradingError("pas de position ouverte sur ce trade : le break-even se règle une fois l'ordre exécuté");
        const avg = averageOpen(open) ?? trade.entry;
        newStop = breakEvenPrice(trade.side, avg, terms);
        if (trade.side === "long" ? !(bid > newStop) : !(ask < newStop)) {
          throw new TradingError(
            `le prix (${this.price(now, terms)}) n'a pas dépassé ton break-even (${this.price(newStop, terms)}) : un stop là partirait tout de suite`,
          );
        }
        for (const l of open)
          requests.push({
            actionType: "POSITION_MODIFY",
            positionId: l.positionId,
            stopLoss: newStop,
            ...(l.target !== undefined ? { takeProfit: l.target } : {}),
          });
        break;
      }
      case "modify": {
        if (req.stop === undefined && req.target === undefined) throw new TradingError("dis le nouveau stop ou le nouvel objectif");
        newStop = req.stop;
        newTarget = req.target;
        if (newStop !== undefined && (trade.side === "long" ? !(newStop < bid) : !(newStop > ask))) {
          throw new TradingError(`un stop à ${this.price(newStop, terms)} est déjà dépassé par le prix (${this.price(now, terms)})`);
        }
        if (newTarget !== undefined && (trade.side === "long" ? !(newTarget > ask) : !(newTarget < bid))) {
          throw new TradingError(`un objectif à ${this.price(newTarget, terms)} est déjà dépassé par le prix (${this.price(now, terms)})`);
        }
        for (const l of open) {
          requests.push({
            actionType: "POSITION_MODIFY",
            positionId: l.positionId,
            stopLoss: newStop ?? trade.stop,
            ...((newTarget ?? l.target) !== undefined ? { takeProfit: newTarget ?? l.target } : {}),
          });
        }
        for (const l of pendingLegs) {
          requests.push({
            actionType: "ORDER_MODIFY",
            orderId: l.orderId,
            openPrice: trade.entry,
            stopLoss: newStop ?? trade.stop,
            ...((newTarget ?? l.target) !== undefined ? { takeProfit: newTarget ?? l.target } : {}),
          });
        }
        break;
      }
      case "close": {
        if (!open.length && !pendingLegs.length) throw new TradingError("rien d'ouvert ni en attente sur ce trade");
        for (const l of open) requests.push({ actionType: "POSITION_CLOSE_ID", positionId: l.positionId });
        for (const l of pendingLegs) requests.push({ actionType: "ORDER_CANCEL", orderId: l.orderId });
        extra.price = now;
        if (trade.profit !== undefined && open.length) extra.profit = trade.profit;
        break;
      }
      case "partial": {
        if (!open.length) throw new TradingError("pas de position ouverte à fermer en partie");
        fraction = req.fraction ?? 0.5;
        if (!(fraction > 0 && fraction < 1)) throw new TradingError("la part à fermer va de 0 à 1 (0,5 : la moitié) ; pour tout fermer, close");
        const openLots = open.reduce((s, l) => s + l.lots, 0);
        lots = floorToStep(openLots * fraction, terms.volumeStep);
        if (lots < terms.minVolume) throw new TradingError(`trop petit : ${lotsLabel(lots)}, le courtier demande ${lotsLabel(terms.minVolume)} au moins`);
        let left = lots;
        for (const l of open) {
          if (left <= 1e-9) break;
          if (l.lots <= left + 1e-9) {
            requests.push({ actionType: "POSITION_CLOSE_ID", positionId: l.positionId });
            left = floorToStep(left - l.lots, terms.volumeStep);
          } else {
            requests.push({ actionType: "POSITION_PARTIAL", positionId: l.positionId, volume: floorToStep(left, terms.volumeStep) });
            left = 0;
          }
        }
        extra.price = now;
        break;
      }
      case "cancel": {
        if (!pendingLegs.length) throw new TradingError("aucun ordre en attente sur ce trade (une position ouverte se ferme : close)");
        for (const l of pendingLegs) requests.push({ actionType: "ORDER_CANCEL", orderId: l.orderId });
        break;
      }
    }
    const base = {
      id: `tk_${randomBytes(3).toString("hex")}`,
      action: req.action,
      symbol: trade.symbol,
      name: trade.name,
      ...(trade.digits !== undefined ? { digits: trade.digits } : {}),
      side: trade.side,
      tradeId: trade.id,
      ...(trade.drawingId ? { drawingId: trade.drawingId } : {}),
      legs: [],
      ...(newStop !== undefined ? { newStop } : {}),
      ...(newTarget !== undefined ? { newTarget } : {}),
      ...(fraction !== undefined ? { fraction } : {}),
      lots,
      loss: 0,
      gain: 0,
      fees: 0,
      riskPercent: 0,
      currency: trade.currency,
      warnings: req.action === "close" || req.action === "partial" ? ["au marché : le prix d'exécution peut différer un peu"] : [],
      account: account.name,
      demo: account.demo,
      createdAt: this.now(),
      expiresAt: this.now() + TICKET_TTL_MS,
      ...(req.eraseBox && trade.drawingId ? { eraseBox: true } : {}),
    };
    const text = manageTicketText(base, trade, extra) + (base.eraseBox ? " Sa boîte s'effacera du graphique une fois que le courtier l'aura fait." : "");
    return this.hold({ ticket: { ...base, text }, requests, terms });
  }

  /** L'utilisateur renonce au ticket (ou il en prépare un autre). */
  cancelTicket(id?: string): Ticket | undefined {
    const t = this.pending?.ticket;
    if (!t || (id && t.id !== id)) return undefined;
    this.pending = undefined;
    clearTimeout(this.ticketTimer);
    this.emit("changed");
    return t;
  }

  /**
   * L'utilisateur confirme le ticket : ses ordres partent chez le courtier, un
   * par un, une seule fois. Le ticket disparaît avant l'envoi (deux clics
   * n'envoient rien de plus). Renvoie ce qui s'est passé, en une phrase.
   */
  async confirm(id: string, via: "click" | "voice"): Promise<{ ok: boolean; text: string; trade?: Trade }> {
    const p = this.pending;
    if (!p || p.ticket.id !== id) throw new TradingError("ce ticket n'existe plus : demande-le de nouveau");
    this.pending = undefined;
    clearTimeout(this.ticketTimer);
    this.emit("changed");
    if (p.ticket.expiresAt <= this.now()) throw new TradingError("le ticket a expiré : rien n'est parti, demande-le de nouveau");
    this.assertOrders();
    const quiet = via === "voice";
    if (p.ticket.action === "open") return this.sendOpen(p, quiet);
    return this.sendManage(p, quiet);
  }

  private async sendOpen(p: PendingTicket, quiet: boolean) {
    const trade = p.draft!;
    // Enregistré avant l'envoi : même après un arrêt brutal, ses ordres se retrouvent chez le courtier (clientId).
    this.saveTrade(trade);
    this.journal(trade.id, "ticket", p.ticket.text);
    // Le journal fige ici le graphique du trade (ses tracés de ce moment) et note la fiche ouverte.
    this.emit("confirmed", trade);
    const errors: string[] = [];
    for (let i = 0; i < p.requests.length; i++) {
      const leg = trade.legs[i];
      try {
        const r = await this.market.brokerTrade(p.requests[i]);
        this.journal(trade.id, r.ok ? "order" : "rejected", `${leg.clientId} : ${r.stringCode} ${r.message}`.trim());
        if (r.ok) {
          if (r.orderId) leg.orderId = r.orderId;
          if (r.positionId) leg.positionId = r.positionId;
          if (trade.execution === "market" && r.positionId) leg.state = "open";
        } else {
          leg.state = "rejected";
          errors.push(brokerMessage(r.stringCode, r.message));
        }
      } catch (e) {
        // Sans réponse, on ne sait pas : la jambe reste en attente, la relecture chez le courtier tranchera (clientId).
        errors.push((e as Error).message);
        this.journal(trade.id, "unknown", `${leg.clientId} : ${(e as Error).message}`);
      }
    }
    trade.state = tradeState(trade.legs);
    trade.updatedAt = this.now();
    if (trade.state === "open") trade.openedAt = this.now();
    this.saveTrade(trade);
    this.emit("changed");
    void this.sync();
    if (trade.state === "rejected") {
      const text = `Refusé par le courtier : ${errors[0] ?? "sans raison donnée"}. Rien n'est ouvert.`;
      this.signal({ kind: "rejected", trade, title: `${trade.name} : ordre refusé`, detail: errors[0], quiet, line: text });
      return { ok: false, text, trade };
    }
    // Un setup de l'IA repris : sa réaction est notée « pris », l'IA en apprend.
    if (trade.setupId && this.scenarios) {
      try {
        this.scenarios.feedback(trade.setupId, "taken", `ordre passé par Kopilia : ${tradeLine(trade, this.now())}`);
      } catch (e) {
        this.logger.warn(`setup ${trade.setupId} : réaction non notée (${(e as Error).message})`, "trading");
      }
    }
    const partial = errors.length
      ? ` Attention : ${errors.length} ordre${errors.length > 1 ? "s" : ""} sur ${p.requests.length} sans succès (${errors[0]}).`
      : "";
    const text = `${trade.execution === "market" ? "Ordre exécuté" : "Ordre envoyé, en attente au prix de l'entrée"} : ${tradeLine(trade, this.now())}.${partial}`;
    this.signal({ kind: "placed", trade, ...placedTexts(trade), quiet, line: text });
    return { ok: true, text, trade };
  }

  private async sendManage(p: PendingTicket, quiet: boolean) {
    const t = p.ticket;
    const trade = this.getTrade(t.tradeId!);
    if (!trade) throw new TradingError("ce trade n'existe plus");
    this.journal(trade.id, "ticket", t.text);
    const errors: string[] = [];
    let done = 0;
    for (const req of p.requests) {
      try {
        const r = await this.market.brokerTrade(req);
        this.journal(trade.id, r.ok ? "order" : "rejected", `${String(req.actionType)} : ${r.stringCode} ${r.message}`.trim());
        if (r.ok) done++;
        else errors.push(brokerMessage(r.stringCode, r.message));
      } catch (e) {
        errors.push((e as Error).message);
        this.journal(trade.id, "unknown", `${String(req.actionType)} : ${(e as Error).message}`);
      }
    }
    if (done && t.eraseBox) this.eraseOnEnd.add(trade.id);
    if (done && (t.action === "breakeven" || t.action === "modify")) {
      const quote = this.terms.get(trade.symbol);
      const price = quote ? (trade.side === "long" ? quote.bid : quote.ask) : undefined;
      const r = price !== undefined ? rAt(trade, price) : undefined;
      const moment = { at: this.now(), source: "kopilia" as const, ...(price !== undefined ? { price } : {}), ...(r !== undefined ? { r } : {}) };
      if (t.newStop !== undefined && !samePrice(t.newStop, trade.stop)) this.gesture(trade, { ...moment, kind: "stop", from: trade.stop, to: t.newStop });
      const oldTarget = trade.legs.find((l) => l.target !== undefined)?.target ?? trade.targets[0];
      if (t.newTarget !== undefined && (oldTarget === undefined || !samePrice(t.newTarget, oldTarget))) {
        this.gesture(trade, { ...moment, kind: "target", ...(oldTarget !== undefined ? { from: oldTarget } : {}), to: t.newTarget });
      }
      if (t.newStop !== undefined) trade.stop = t.newStop;
      if (t.newTarget !== undefined) {
        for (const l of trade.legs) if (l.state === "open" || l.state === "pending") l.target = t.newTarget;
        trade.targets = trade.targets.map(() => t.newTarget!);
      }
      // Le courtier peut montrer l'ancien niveau un instant : la relecture attend le nouveau avant d'y voir un geste sur la plateforme.
      this.expected.set(trade.id, { stop: t.newStop, target: t.newTarget, until: this.now() + EXPECT_MS });
      trade.protected = isProtected(trade, averageOpen(trade.legs.filter((l) => l.state === "open")));
      trade.updatedAt = this.now();
      this.saveTrade(trade);
    }
    this.emit("changed");
    void this.sync();
    const what =
      t.action === "breakeven"
        ? `stop monté à ${frenchPrice(t.newStop!, t.digits)} (break-even)`
        : t.action === "modify"
          ? "niveaux déplacés"
          : t.action === "close"
            ? "fermeture envoyée"
            : t.action === "partial"
              ? `${lotsLabel(t.lots)} fermé${t.lots >= 2 ? "s" : ""}`
              : "ordre retiré";
    if (!done) {
      const text = `Refusé par le courtier : ${errors[0] ?? "sans raison donnée"}. Rien n'a changé.`;
      this.signal({ kind: "rejected", trade, title: `${trade.name} : refusé`, detail: errors[0], quiet, line: text });
      return { ok: false, text, trade };
    }
    const text = `${trade.name} : ${what}.${errors.length ? ` Attention : ${errors.length} demande${errors.length > 1 ? "s" : ""} sans succès (${errors[0]}).` : ""}`;
    if (!quiet) this.signal({ kind: "placed", trade, title: `${trade.name} : ${what}`, quiet, line: text });
    return { ok: true, text, trade };
  }

  private hold(p: PendingTicket): Ticket {
    this.pending = p;
    clearTimeout(this.ticketTimer);
    this.ticketTimer = setTimeout(() => {
      if (this.pending === p) {
        this.pending = undefined;
        this.emit("changed");
      }
    }, TICKET_TTL_MS);
    this.ticketTimer.unref();
    this.emit("changed");
    return p.ticket;
  }

  private assertOrders() {
    if (!this.market.enabled) throw new TradingError("MetaApi n'est pas configuré : pas de compte, pas d'ordre");
    if (!this.config.tradingOrders) {
      throw new TradingError(
        "les ordres sont coupés dans Kopilia : il faut KOPILIA_TRADING_ORDERS=1 dans son fichier .env, puis le relancer. Les calculs de taille restent disponibles",
      );
    }
  }

  /** Le compte, relu, s'il accepte les ordres : pas en mot de passe investisseur, démo sauf autorisation du réel. */
  private async tradableAccount(): Promise<AccountSnapshot> {
    let account: AccountSnapshot;
    try {
      account = await this.readAccount(true);
    } catch (e) {
      throw new TradingError(e instanceof MarketError ? e.message : "compte du courtier illisible");
    }
    if (!account.tradeAllowed) {
      throw new TradingError("ce compte n'accepte pas d'ordres (mot de passe investisseur) : il faut le mot de passe principal dans l'interface MetaApi");
    }
    if (!account.demo && !this.config.tradingLive) {
      throw new TradingError(
        "par prudence, Kopilia ne passe d'ordres que sur un compte de démonstration ; pour le réel, il faut KOPILIA_TRADING_LIVE=1 dans .env",
      );
    }
    return account;
  }

  /** Les limites du compte : risque total ouvert, perte du jour et de la semaine. */
  private async checkLimits(account: AccountSnapshot, settings: MoneySettings, loss: number) {
    const capital = capitalOf(account, settings);
    if (settings.maxOpenRiskPercent !== undefined) {
      const open = this.liveTrades()
        .filter((t) => !t.protected)
        .reduce((s, t) => s + t.risk, 0);
      const total = ((open + loss) / capital) * 100;
      if (total > settings.maxOpenRiskPercent + 1e-9) {
        throw new TradingError(
          `ton risque ouvert passerait à ${percentLabel(total)} (déjà ${percentLabel((open / capital) * 100)} engagé), au-delà de ta limite de ${percentLabel(settings.maxOpenRiskPercent)}`,
        );
      }
    }
    if (settings.maxDailyLossPercent === undefined && settings.maxWeeklyLossPercent === undefined) return;
    const now = this.now();
    const day = startOfDay(now).getTime();
    const week = startOfWeek(now);
    let deals: BrokerDeal[];
    try {
      deals = await this.market.brokerDeals(Math.min(day, week), now);
    } catch (e) {
      throw new TradingError(`impossible de vérifier ta perte du jour (${(e as Error).message}) : rien n'est préparé`);
    }
    const result = (since: number) => deals.filter((d) => d.time >= since).reduce((s, d) => s + d.profit + d.commission + d.swap, 0);
    const check = (limit: number | undefined, since: number, period: string) => {
      if (limit === undefined) return;
      const lost = -result(since);
      if (lost >= (capital * limit) / 100 - 1e-9) {
        throw new TradingError(
          `ta perte ${period} atteint ${moneyLabel(lost, account.currency)}, ta limite de ${percentLabel(limit)} : plus d'ouverture ${period}`,
        );
      }
    };
    check(settings.maxDailyLossPercent, day, "du jour");
    check(settings.maxWeeklyLossPercent, week, "de la semaine");
  }

  /* ------------------------------- Trades ------------------------------- */

  getTrade(id: string): Trade | undefined {
    const row = this.db.db.prepare("SELECT * FROM trades WHERE id = ?").get(id.trim()) as TradeRow | undefined;
    return row ? parseTrade(row) : undefined;
  }

  /** Parmi ces tracés, les boîtes d'un trade en cours. */
  liveBoxes(ids: string[]): string[] {
    if (!ids.length) return [];
    const live = new Set(this.liveTrades().flatMap((t) => (t.drawingId ? [t.drawingId] : [])));
    return ids.filter((id) => live.has(id));
  }

  /**
   * Il efface la boîte d'un trade en cours : elle reste, et un ticket propose
   * de retirer l'ordre en attente (ou de fermer la position), comme une prise
   * de position. Confirmé, la boîte s'efface quand le courtier l'a fait.
   */
  async eraseBoxTicket(drawingId: string): Promise<Ticket> {
    const trade = this.liveTrades().find((t) => t.drawingId === drawingId);
    if (!trade) throw new TradingError("cette boîte n'a pas de trade en cours");
    const open = trade.legs.some((l) => l.state === "open");
    try {
      return await this.prepareManage({ action: open ? "close" : "cancel", trade: trade.id, eraseBox: true });
    } catch (e) {
      const what = open ? "une position ouverte" : "un ordre en attente";
      throw new TradingError(`ta boîte reste : elle a ${what} chez le courtier, et ${(e as Error).message}`);
    }
  }

  /**
   * Un trade en cours garde sa boîte sur le graphique : celle effacée avant
   * cette garde est redessinée à ses niveaux de départ (entrée, stop, premier
   * objectif). Au démarrage. Renvoie le nombre de boîtes redessinées.
   */
  restoreBoxes(): number {
    let n = 0;
    for (const t of this.liveTrades()) {
      if (t.drawingId && this.dashboard.drawings.get(t.drawingId)) continue;
      const target = t.targets[0] ?? t.legs.find((l) => l.target !== undefined)?.target;
      if (target === undefined) continue;
      try {
        const shape = { kind: "position", side: t.side, entry: t.entry, stop: t.initialStop, target, from: Math.floor(t.createdAt / 1000) };
        const box = this.dashboard.drawings.create(t.symbol, shape, { by: "user" });
        t.drawingId = box.id;
        t.updatedAt = this.now();
        this.saveTrade(t);
        n++;
        this.logger.log(`${t.name} : boîte du trade ${t.id} redessinée (${t.state === "pending" ? "ordre en attente" : "position ouverte"})`, "trading");
      } catch (e) {
        this.logger.warn(`${t.name} : boîte du trade ${t.id} non redessinée (${(e as Error).message})`, "trading");
      }
    }
    if (n) this.emit("changed");
    return n;
  }

  /** Les trades en cours (ordre en attente, position ouverte). */
  liveTrades(): Trade[] {
    const rows = this.db.db.prepare("SELECT * FROM trades WHERE state IN ('pending','open') ORDER BY created_at").all() as TradeRow[];
    return rows.map(parseTrade).filter((t): t is Trade => !!t);
  }

  /** Les trades d'une période (les plus récents d'abord). */
  trades(opts: { since?: number; limit?: number } = {}): Trade[] {
    const rows = this.db.db
      .prepare("SELECT * FROM trades WHERE created_at >= ? OR state IN ('pending','open') ORDER BY created_at DESC LIMIT ?")
      .all(opts.since ?? 0, opts.limit ?? 200) as TradeRow[];
    return rows.map(parseTrade).filter((t): t is Trade => !!t);
  }

  private recentTrades(): Trade[] {
    const since = this.now() - RECENT_MS;
    const live = this.liveTrades();
    const done = (
      this.db.db
        .prepare("SELECT * FROM trades WHERE state NOT IN ('pending','open') AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?")
        .all(since, RECENT_MAX) as TradeRow[]
    )
      .map(parseTrade)
      .filter((t): t is Trade => !!t);
    return [...live, ...done];
  }

  /** Le trade visé : par identifiant, par sa boîte, ou le seul en cours (du produit). */
  private findTrade(req: { trade?: string; drawingId?: string; symbol?: string }): Trade {
    if (req.trade) {
      const t = this.getTrade(req.trade);
      if (!t) throw new TradingError(`aucun trade « ${req.trade} » : liste-les (trading_status)`);
      return t;
    }
    const live = this.liveTrades().filter((t) => (req.drawingId ? t.drawingId === req.drawingId : req.symbol ? t.symbol === req.symbol : true));
    if (live.length === 1) return live[0];
    if (!live.length) throw new TradingError("aucun trade de Kopilia en cours" + (req.symbol || req.drawingId ? " sur ce produit" : ""));
    throw new TradingError(`plusieurs trades en cours : précise lequel (${live.map((t) => `${t.id} ${t.name}`).join(", ")})`);
  }

  private saveTrade(t: Trade) {
    this.db.db
      .prepare(
        "INSERT INTO trades (id, symbol, state, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, spec = excluded.spec, updated_at = excluded.updated_at",
      )
      .run(t.id, t.symbol, t.state, JSON.stringify(t), t.createdAt, t.updatedAt);
  }

  /** Le journal de chaque ordre : ce qui est parti, ce que le courtier a répondu (jamais de jeton), les gestes et les notes. */
  private journal(tradeId: string, kind: string, text: string, data?: unknown, at = this.now()) {
    this.db.db
      .prepare("INSERT INTO trade_events (id, trade_id, at, kind, text, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`te_${randomBytes(4).toString("hex")}`, tradeId, at, kind, text.slice(0, 600), data === undefined ? null : JSON.stringify(data));
  }

  /** Le journal d'un trade, du plus ancien au plus récent ; un geste porte ses données (avant, après, d'où). */
  events(tradeId: string): TradeEvent[] {
    const rows = this.db.db.prepare("SELECT at, kind, text, data FROM trade_events WHERE trade_id = ? ORDER BY at, rowid").all(tradeId) as Array<{
      at: number;
      kind: string;
      text: string;
      data: string | null;
    }>;
    return rows.map((r) => {
      const e: TradeEvent = { at: r.at, kind: r.kind, text: r.text };
      if (r.data) {
        try {
          e.data = JSON.parse(r.data) as unknown;
        } catch {
          /* illisible : le texte suffit */
        }
      }
      return e;
    });
  }

  /** Une note de l'utilisateur sur un trade, dictée pour son journal. */
  note(tradeId: string, text: string): TradeEvent {
    const trade = this.getTrade(tradeId);
    if (!trade) throw new TradingError(`aucun trade « ${tradeId} »`);
    const clean = text.trim().slice(0, 600);
    if (!clean) throw new TradingError("une note vide ne s'écrit pas");
    const at = this.now();
    this.journal(trade.id, "note", clean, { by: "user" }, at);
    this.emit("noted", trade);
    return { at, kind: "note", text: clean, data: { by: "user" } };
  }

  /** Les gestes d'un trade (stop, objectif, part fermée), dans l'ordre. */
  gestures(tradeId: string): TradeGesture[] {
    return this.events(tradeId).flatMap((e) => {
      if (e.kind !== "gesture") return [];
      const g = tradeGestureSchema.safeParse(e.data);
      return g.success ? [g.data] : [];
    });
  }

  /** Un geste noté au journal du trade, avec sa phrase. */
  private gesture(trade: Trade, g: TradeGesture) {
    this.journal(trade.id, "gesture", gestureText(g, trade), g, g.at);
  }

  private async tick() {
    if (!this.liveTrades().length) return;
    await this.sync().catch(() => undefined);
  }

  /**
   * Relit chez le courtier les trades en cours, par leur clientId : un ordre
   * exécuté devient une position, une position fermée (objectif, stop, à la
   * main sur la plateforme) donne son résultat ; le rappel de break-even part
   * une fois, au multiple de risque réglé.
   */
  async sync(): Promise<void> {
    // Une relecture à la fois : celle demandée pendant une autre passe après elle, et voit ce qui vient de changer.
    while (this.syncRun) await this.syncRun;
    this.syncRun = this.syncOnce().finally(() => (this.syncRun = undefined));
    return this.syncRun;
  }

  private async syncOnce(): Promise<void> {
    const live = this.liveTrades();
    if (!live.length || !this.market.enabled) return;
    try {
      const [positions, orders] = await Promise.all([this.market.brokerPositions(), this.market.brokerOrders()]);
      let deals: BrokerDeal[] | undefined;
      const dealsFor = async () => (deals ??= await this.market.brokerDeals(Math.min(...live.map((t) => t.createdAt)) - 60_000, this.now() + 60_000));
      let changed = false;
      for (const trade of live) {
        const before = JSON.stringify(trade);
        const wasState = trade.state;
        const exits: Array<{ leg: TradeLeg; exit: TradeExit }> = [];
        for (const leg of trade.legs) {
          if (leg.state !== "pending" && leg.state !== "open") continue;
          for (const exit of await syncLeg(leg, positions, orders, dealsFor)) exits.push({ leg, exit });
        }
        trade.state = tradeState(trade.legs);
        const open = trade.legs.filter((l) => l.state === "open");
        const avg = averageOpen(open);
        if (avg !== undefined && trade.execution === "market") trade.entry = avg;
        this.platformGestures(trade, positions, open);
        trade.protected = isProtected(trade, avg);
        // Une part sortie alors que le trade continue : une partielle (à la main, par Kopilia), ou un objectif d'une des jambes.
        if (trade.state === "open") {
          for (const { leg, exit } of exits) {
            if (exit.reason === "manual" || exit.reason === "kopilia") {
              const r = rAt(trade, exit.price);
              this.gesture(trade, {
                at: exit.at,
                kind: "partial",
                source: exit.reason === "kopilia" ? "kopilia" : "platform",
                lots: exit.lots,
                price: exit.price,
                profit: exit.profit,
                ...(r !== undefined ? { r } : {}),
              });
            } else {
              this.journal(
                trade.id,
                "exit",
                `${exitWords(exit.reason)} : ${lotsLabel(exit.lots)} à ${frenchPrice(exit.price, trade.digits)}, ${moneyLabel(exit.profit, trade.currency, { sign: true })}${leg.target !== undefined && exit.reason === "target" ? ` (objectif ${frenchPrice(leg.target, trade.digits)})` : ""}`,
                exit,
                exit.at,
              );
            }
          }
        }
        const legsProfit = trade.legs.filter((l) => l.profit !== undefined);
        if (legsProfit.length) {
          trade.profit = Math.round(legsProfit.reduce((s, l) => s + l.profit!, 0) * 100) / 100;
          trade.r = tradeR(trade.profit, trade.risk);
        }
        if (trade.state === "open" && wasState === "pending") trade.openedAt = this.now();
        if (!isLiveTrade(trade.state) && isLiveTrade(wasState)) trade.closedAt = this.now();
        if (JSON.stringify(trade) === before) {
          await this.remind(trade, positions);
          continue;
        }
        trade.updatedAt = this.now();
        this.saveTrade(trade);
        changed = true;
        // Le retrait (ou la fermeture) demandé en effaçant la boîte est fait : la boîte part maintenant.
        if (!isLiveTrade(trade.state) && this.eraseOnEnd.delete(trade.id) && trade.drawingId) this.dashboard.drawings.remove([trade.drawingId]);
        if (trade.state === "open" && wasState === "pending") {
          const line = `${trade.name} : ordre exécuté. ${tradeLine(trade, this.now())}.`;
          this.journal(trade.id, "filled", line);
          this.signal({ kind: "filled", trade, ...filledTexts(trade, avg ?? trade.entry), line });
        } else if (trade.state === "closed") {
          const line = `${trade.name} : position fermée${trade.profit !== undefined ? `, ${moneyLabel(trade.profit, trade.currency, { sign: true })}${trade.r !== undefined ? ` (${rLabel(trade.r)})` : ""}` : ""}. ${tradeLine(trade, this.now())}.`;
          this.journal(trade.id, "closed", line);
          this.signal({ kind: "closed", trade, ...closedTexts(trade), line });
        } else if (trade.state === "cancelled" && wasState !== "cancelled") {
          this.journal(trade.id, "cancelled", "ordre retiré ou expiré chez le courtier");
          this.signal({
            kind: "closed",
            trade,
            title: `${trade.name} : ordre retiré`,
            line: `${trade.name} : ordre en attente retiré (ou expiré) chez le courtier.`,
          });
        }
        await this.remind(trade, positions);
      }
      if (changed) this.emit("changed");
    } catch (e) {
      this.logger.warn(`suivi des trades : ${(e as Error).message}`, "trading");
    }
  }

  /**
   * Ce que l'utilisateur a changé sur la plateforme du courtier (ordinateur,
   * mobile) : le stop et l'objectif des positions ouvertes, relus et notés au
   * journal (avant, après, le prix et le R du moment). Juste après un geste
   * demandé à Kopilia, l'ancien niveau encore montré n'en est pas un.
   */
  private platformGestures(trade: Trade, positions: BrokerPosition[], open: TradeLeg[]) {
    const now = this.now();
    const pos = positions.find((p) => open.some((l) => l.positionId === p.id));
    // Ce que Kopilia attend du courtier : une fois le nouveau niveau vu (ou le délai passé), tout écart est un geste sur la plateforme.
    const expected = this.expected.get(trade.id);
    if (expected) {
      if (expected.stop !== undefined && pos?.stopLoss !== undefined && samePrice(pos.stopLoss, expected.stop)) delete expected.stop;
      const tps = open.map((l) => positions.find((x) => x.id === l.positionId)?.takeProfit);
      if (expected.target !== undefined && tps.length && tps.every((tp) => tp !== undefined && samePrice(tp, expected.target!))) delete expected.target;
      if (expected.until <= now || (expected.stop === undefined && expected.target === undefined)) this.expected.delete(trade.id);
    }
    const waiting = this.expected.has(trade.id);
    const price = pos?.currentPrice;
    const r = price !== undefined ? rAt(trade, price) : undefined;
    const moment = { at: now, source: "platform" as const, ...(price !== undefined ? { price } : {}), ...(r !== undefined ? { r } : {}) };
    if (pos?.stopLoss !== undefined && !samePrice(pos.stopLoss, trade.stop)) {
      const stale = waiting && expected!.stop !== undefined && !samePrice(pos.stopLoss, expected!.stop);
      if (!stale) {
        this.gesture(trade, { ...moment, kind: "stop", from: trade.stop, to: pos.stopLoss });
        trade.stop = pos.stopLoss;
      }
    }
    const seen = new Set<string>();
    for (const leg of open) {
      const p = positions.find((x) => x.id === leg.positionId);
      if (!p || (p.takeProfit === undefined && leg.target === undefined)) continue;
      if (p.takeProfit !== undefined && leg.target !== undefined && samePrice(p.takeProfit, leg.target)) continue;
      if (waiting && expected!.target !== undefined && (p.takeProfit === undefined || !samePrice(p.takeProfit, expected!.target))) continue;
      const key = `${leg.target}>${p.takeProfit}`;
      if (!seen.has(key)) {
        seen.add(key);
        this.gesture(trade, {
          ...moment,
          kind: "target",
          ...(leg.target !== undefined ? { from: leg.target } : {}),
          ...(p.takeProfit !== undefined ? { to: p.takeProfit } : {}),
        });
      }
      if (p.takeProfit === undefined) delete leg.target;
      else leg.target = p.takeProfit;
    }
    if (seen.size) trade.targets = trade.legs.flatMap((l) => (l.target !== undefined ? [l.target] : []));
  }

  /** Le rappel de break-even : une fois, quand la position atteint le multiple de risque réglé. */
  private async remind(trade: Trade, positions: BrokerPosition[]) {
    const at = this.settings().breakEvenAtR;
    if (!at || trade.state !== "open" || trade.protected || trade.reminded) return;
    const pos = positions.find((p) => trade.legs.some((l) => l.positionId === p.id && l.state === "open"));
    if (!pos?.currentPrice) return;
    const riskDist = Math.abs(pos.openPrice - trade.initialStop);
    if (!(riskDist > 0)) return;
    const r = ((trade.side === "long" ? pos.currentPrice - pos.openPrice : pos.openPrice - pos.currentPrice) / riskDist) as number;
    if (r < at) return;
    trade.reminded = true;
    trade.updatedAt = this.now();
    this.saveTrade(trade);
    const terms = this.terms.get(trade.symbol)?.value;
    const be = terms ? breakEvenPrice(trade.side, pos.openPrice, terms) : pos.openPrice;
    const texts = reminderTexts(trade, Math.round(r * 10) / 10, be);
    this.signal({
      kind: "reminder",
      trade,
      ...texts,
      line: `${trade.name} : la position atteint ${rLabel(r)}. Break-even à ${frenchPrice(be, trade.digits)}, si l'utilisateur veut y monter son stop.`,
    });
    this.emit("changed");
  }

  /* -------------------------------- Bilan -------------------------------- */

  /**
   * Le bilan des trades de Kopilia sur une période : nombre, gagnants, perdants,
   * résultat en devise et en R, par niveau de risque, et le respect du plan
   * (objectif ou stop, ou fermeture à la main).
   */
  review(days = 7): { lines: string[]; total: number; profit: number; r: number } {
    const since = this.now() - days * 86_400_000;
    const closed = this.trades({ since }).filter((t) => t.state === "closed" && t.profit !== undefined);
    if (!closed.length) return { lines: [`aucun trade de Kopilia fermé sur ${days} jour${days > 1 ? "s" : ""}`], total: 0, profit: 0, r: 0 };
    const currency = closed[0].currency;
    const profit = closed.reduce((s, t) => s + t.profit!, 0);
    const r = closed.reduce((s, t) => s + (t.r ?? 0), 0);
    const wins = closed.filter((t) => t.profit! > 0).length;
    const buckets = new Map<string, Trade[]>();
    for (const t of closed) {
      const k = t.riskPercent <= 1.05 ? "jusqu'à 1 %" : t.riskPercent <= 2.05 ? "de 1 à 2 %" : "plus de 2 %";
      buckets.set(k, [...(buckets.get(k) ?? []), t]);
    }
    const lines = [
      `${closed.length} trade${closed.length > 1 ? "s" : ""} fermé${closed.length > 1 ? "s" : ""} sur ${days} jour${days > 1 ? "s" : ""} : ${wins} gagnant${wins > 1 ? "s" : ""}, ${closed.length - wins} perdant${closed.length - wins > 1 ? "s" : ""} ; résultat ${moneyLabel(profit, currency, { sign: true })}, ${rLabel(Math.round(r * 100) / 100)} en tout, ${rLabel(Math.round((r / closed.length) * 100) / 100)} en moyenne`,
      ...[...buckets].map(([k, list]) => {
        const sum = list.reduce((s, t) => s + (t.r ?? 0), 0);
        return `risque ${k} : ${list.length} trade${list.length > 1 ? "s" : ""}, ${rLabel(Math.round(sum * 100) / 100)} en tout`;
      }),
      ...closed.slice(0, 15).map((t) => tradeLine(t, this.now())),
    ];
    return { lines, total: closed.length, profit, r };
  }

  /* ------------------------------ Utilitaires ------------------------------ */

  /** La taille d'une boîte selon l'état actuel (pour la décrire à Kopilia) ; undefined : compte ou conditions inconnus. */
  sizingText(d: Drawing): string | undefined {
    if (d.kind !== "position") return undefined;
    const t = this.terms.get(d.symbol)?.value;
    const account = this.account?.value;
    if (!t || !account) return undefined;
    const settings = this.settings();
    const s = sizePosition(d, t, capitalOf(account, settings), effectiveRisk(d.risk ?? settings.defaultRisk, settings), {
      maxRiskPercent: settings.maxRiskPercent,
      currency: account.currency,
    });
    if (s.problem && !s.lots) return `taille : ${s.problem}`;
    const which = d.risk?.tier ? `son palier ${d.risk.tier}` : d.risk ? "son risque" : "le risque par défaut";
    return `taille ${lotsLabel(s.lots)} pour ${which} ; perte au stop ${moneyLabel(s.loss, account.currency)} (${percentLabel(s.riskPercent)}), gain à l'objectif ${moneyLabel(s.gain, account.currency)}${s.problem ? ` ; ${s.problem}` : ""}`;
  }

  /** La marge d'une position (calcul du courtier) et la marge libre du compte, pour l'écran. */
  async margin(q: {
    symbol: string;
    side: "long" | "short";
    lots: number;
    price: number;
  }): Promise<{ margin?: number; freeMargin?: number; currency?: string }> {
    const account = await this.readAccount().catch(() => undefined);
    const margin = await this.market.brokerMargin({ symbol: q.symbol, side: q.side, volume: q.lots, price: q.price });
    return {
      ...(margin !== undefined ? { margin } : {}),
      ...(account?.freeMargin !== undefined ? { freeMargin: account.freeMargin } : {}),
      ...(account ? { currency: account.currency } : {}),
    };
  }

  /** Le risque d'un palier (« A+ ») ; une erreur lisible s'il n'existe pas. */
  tierRisk(name: string): Risk {
    const tiers = this.settings().tiers;
    const tier = findTier(tiers, name);
    if (!tier) throw new TradingError(`aucun palier « ${name} »${tiers.length ? ` ; les siens : ${tiers.map((t) => tierLabelShort(t)).join(", ")}` : ""}`);
    return { mode: "percent", value: tier.percent, tier: tier.name };
  }

  private productOf(symbol: string): { name: string } {
    const panel = this.dashboard.list().find((p) => p.kind === "chart" && p.symbol === symbol);
    return { name: panel?.name ?? panel?.title ?? symbol };
  }

  private price(v: number, terms: SymbolTerms): string {
    return frenchPrice(v, terms.digits);
  }

  private signal(s: TradingSignal) {
    this.emit("signal", s);
  }
}

/**
 * L'écart toléré entre l'entrée d'une boîte et le prix du moment pour un ordre
 * au marché : deux fois l'écart achat-vente, ou 15 % de la distance au stop
 * (le plus grand), au moins un tick. Au-delà, la boîte décrit un ordre en attente.
 */
export function marketTolerance(box: { entry: number; stop: number }, quote: { bid: number; ask: number }, terms: Pick<SymbolTerms, "tickSize">): number {
  return Math.max(2 * Math.abs(quote.ask - quote.bid), 0.15 * Math.abs(box.entry - box.stop), terms.tickSize);
}

/** « A+ 3 % » ; avec ses mots s'il en a. */
function tierLabelShort(t: RiskTier): string {
  return `${t.name} ${percentLabel(t.percent)}${t.when ? ` (${t.when})` : ""}`;
}

/** Le volume réparti entre les objectifs (parts égales par défaut), chaque jambe au pas et au minimum du courtier. */
export function splitLegs(lots: number, targets: number[], shares: number[] | undefined, terms: SymbolTerms): Array<{ lots: number; target: number }> {
  if (targets.length === 1) return [{ lots, target: targets[0] }];
  if (shares && shares.length !== targets.length) throw new TradingError("donne une part par objectif");
  const parts = shares ?? targets.map(() => 1 / targets.length);
  const sum = parts.reduce((a, b) => a + b, 0);
  const legs = targets.map((target, i) => ({ target, lots: floorToStep((lots * parts[i]) / sum, terms.volumeStep) }));
  // Ce que les arrondis laissent va au dernier objectif.
  const used = legs.reduce((s, l) => s + l.lots, 0);
  legs[legs.length - 1].lots = floorToStep(legs[legs.length - 1].lots + (lots - used), terms.volumeStep);
  if (legs.some((l) => l.lots < terms.minVolume - 1e-9)) {
    throw new TradingError(
      `${lotsLabel(lots)} ne se partage pas en ${targets.length} objectifs : le courtier demande ${lotsLabel(terms.minVolume)} au moins par ordre`,
    );
  }
  return legs;
}

/** L'état d'un trade d'après ses jambes. */
export function tradeState(legs: TradeLeg[]): Trade["state"] {
  if (legs.some((l) => l.state === "open")) return "open";
  if (legs.some((l) => l.state === "pending")) return "pending";
  if (legs.some((l) => l.state === "closed")) return "closed";
  if (legs.some((l) => l.state === "cancelled")) return "cancelled";
  return "rejected";
}

/** Le prix d'ouverture moyen des jambes ouvertes (pondéré par leur taille). */
function averageOpen(legs: TradeLeg[]): number | undefined {
  const priced = legs.filter((l) => l.openPrice !== undefined);
  const lots = priced.reduce((s, l) => s + l.lots, 0);
  if (!priced.length || !lots) return undefined;
  return priced.reduce((s, l) => s + l.openPrice! * l.lots, 0) / lots;
}

/** Le stop à l'entrée ou au-delà, du côté du gain : la position ne risque plus rien. */
function isProtected(trade: Trade, avgOpen: number | undefined): boolean {
  const entry = avgOpen ?? trade.entry;
  return trade.side === "long" ? trade.stop >= entry : trade.stop <= entry;
}

/**
 * Une jambe relue chez le courtier : ordre en attente, position ouverte, ou
 * terminée (ses transactions). Rend ses sorties nouvelles : une part fermée
 * (la position a rétréci), ou la sortie finale.
 */
async function syncLeg(leg: TradeLeg, positions: BrokerPosition[], orders: BrokerOrder[], dealsFor: () => Promise<BrokerDeal[]>): Promise<TradeExit[]> {
  const order = orders.find((o) => o.clientId === leg.clientId || (leg.orderId && o.id === leg.orderId));
  const position = positions.find((p) => p.clientId === leg.clientId || (leg.positionId && p.id === leg.positionId));
  if (position) {
    const shrunk = leg.state === "open" && position.volume < leg.lots - 1e-9;
    leg.state = "open";
    leg.positionId = position.id;
    leg.openPrice = position.openPrice;
    const fresh = shrunk
      ? addExits(
          leg,
          (await dealsFor()).filter((d) => d.positionId === position.id),
        )
      : [];
    leg.lots = position.volume;
    leg.profit = Math.round(position.profit * 100) / 100;
    return fresh;
  }
  if (order) {
    leg.state = "pending";
    leg.orderId = order.id;
    return [];
  }
  // Ni ordre ni position : exécuté puis fermé, ou retiré. Les transactions le disent.
  const deals = (await dealsFor()).filter((d) => d.clientId === leg.clientId || (leg.positionId && d.positionId === leg.positionId));
  const ins = deals.filter((d) => d.entryType === "DEAL_ENTRY_IN");
  const outs = deals.filter((d) => d.entryType.startsWith("DEAL_ENTRY_OUT"));
  // Les transactions de fermeture ne portent pas toujours le clientId : celles de la même position comptent.
  const positionId = leg.positionId ?? ins[0]?.positionId;
  const all = positionId ? (await dealsFor()).filter((d) => d.positionId === positionId) : deals;
  const closing = all.filter((d) => d.entryType.startsWith("DEAL_ENTRY_OUT"));
  if (closing.length || outs.length) {
    leg.state = "closed";
    if (positionId) leg.positionId = positionId;
    const opening = all.find((d) => d.entryType === "DEAL_ENTRY_IN");
    if (opening) leg.openPrice = opening.price;
    leg.closePrice = (closing.at(-1) ?? outs.at(-1))!.price;
    leg.profit = Math.round(all.reduce((s, d) => s + d.profit + d.commission + d.swap, 0) * 100) / 100;
    return addExits(leg, closing.length ? closing : outs);
  }
  if (ins.length) return []; // ouverte à l'instant, pas encore dans la liste des positions : relue au prochain passage
  leg.state = "cancelled";
  return [];
}

/** Les transactions de sortie pas encore comptées, ajoutées aux sorties de la jambe (une fois chacune). */
function addExits(leg: TradeLeg, deals: BrokerDeal[]): TradeExit[] {
  const known = new Set((leg.exits ?? []).map((e) => e.id));
  const fresh = deals
    .filter((d) => d.entryType.startsWith("DEAL_ENTRY_OUT") && !known.has(d.id))
    .sort((a, b) => a.time - b.time)
    .map((d) => ({
      id: d.id,
      at: d.time,
      price: d.price,
      lots: d.volume,
      profit: Math.round((d.profit + d.commission + d.swap) * 100) / 100,
      reason: exitReasonOf(d.reason),
    }));
  if (fresh.length) leg.exits = [...(leg.exits ?? []), ...fresh];
  return fresh;
}

/** Deux prix égaux au centième de tick près (les niveaux relus chez le courtier sont arrondis). */
function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
}

/** Où en est une position à ce prix, en multiples de son risque de départ (undefined : risque nul). */
function rAt(trade: Trade, price: number): number | undefined {
  const entry = averageOpen(trade.legs.filter((l) => l.state === "open" || l.state === "closed")) ?? trade.entry;
  const risk = Math.abs(entry - trade.initialStop);
  if (!(risk > 0)) return undefined;
  const move = trade.side === "long" ? price - entry : entry - price;
  return Math.round((move / risk) * 100) / 100;
}

/** « objectif touché », « stop touché »… : une sortie en mots. */
function exitWords(reason: TradeExit["reason"]): string {
  return reason === "target" ? "objectif touché" : reason === "stop" ? "stop touché" : reason === "stopout" ? "arrêt de marge" : "part fermée";
}

function parseTrade(row: TradeRow): Trade | undefined {
  try {
    const r = tradeSchema.safeParse(JSON.parse(row.spec));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Le lundi de la semaine en cours, à minuit (heure locale). */
function startOfWeek(now: number): number {
  const d = startOfDay(now);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** Une réponse de refus du courtier, en mots. */
function brokerMessage(code: string, message: string): string {
  const known: Record<string, string> = {
    TRADE_RETCODE_INVALID_STOPS: "stop ou objectif trop près du prix, ou du mauvais côté",
    TRADE_RETCODE_INVALID_VOLUME: "volume refusé",
    TRADE_RETCODE_NO_MONEY: "marge insuffisante",
    TRADE_RETCODE_MARKET_CLOSED: "marché fermé",
    TRADE_RETCODE_TRADE_DISABLED: "trading désactivé sur ce produit",
    TRADE_RETCODE_INVALID_PRICE: "prix refusé",
    TRADE_RETCODE_PRICE_OFF: "pas de prix en ce moment",
    TRADE_RETCODE_REQUOTE: "nouvelle cotation, le prix a bougé",
    TRADE_RETCODE_INVALID_EXPIRATION: "expiration refusée",
    TRADE_RETCODE_LIMIT_ORDERS: "trop d'ordres en attente",
    TRADE_RETCODE_INVALID: "demande refusée",
    TRADE_RETCODE_REJECT: "refusé",
  };
  return known[code] ?? (message || code || "refusé");
}
