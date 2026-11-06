import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { POSITION_SIDES, type PositionSide } from "@kopilia/contracts";
import { lotsLabel, moneyLabel, percentLabel, riskLabel, tierLabel, type Risk, type TicketAction } from "@kopilia/contracts";
import { SessionGuard } from "../http/session.guard.js";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { DashboardError, DashboardService } from "../dashboard/dashboard.service.js";
import { MarketError } from "../market/metaapi.js";
import { TradingError, TradingService } from "./trading.service.js";
import { tradeLine } from "./trading-texts.js";

async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TradingError || e instanceof MarketError || e instanceof DashboardError) throw new BadRequestException(e.message);
    throw e;
  }
}

/** Pour le dialogue : une erreur attendue revient en { error }, que le modèle lit et corrige. */
async function soft<T>(fn: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TradingError || e instanceof MarketError || e instanceof DashboardError) return { error: e.message };
    throw e;
  }
}

/**
 * La prise de position vue depuis l'écran : son état, et la réponse de
 * l'utilisateur à un ticket (le confirmer l'envoie chez le courtier, le
 * refuser l'oublie). La session et son jeton, ceux du WebSocket.
 */
@Controller("api/trading")
@UseGuards(SessionGuard)
export class TradingScreenController {
  constructor(private readonly trading: TradingService) {}

  @Get()
  state() {
    return this.trading.state();
  }

  @Post("tickets/:id/confirm")
  confirm(@Param("id") id: string) {
    return guard(() => this.trading.confirm(id, "click"));
  }

  @Post("tickets/:id/cancel")
  cancel(@Param("id") id: string) {
    return { cancelled: !!this.trading.cancelTicket(id, "click") };
  }

  /** La marge d'une boîte telle qu'on la règle (« Risque… ») : le calcul du courtier, rien n'est passé. */
  @Get("margin")
  margin(@Query("symbol") symbol?: string, @Query("side") side?: string, @Query("lots") lots?: string, @Query("price") price?: string) {
    return guard(async () => {
      const s = POSITION_SIDES.find((x) => x === side) as PositionSide | undefined;
      const v = Number(lots);
      const p = Number(price);
      if (!symbol || !s || !(v > 0) || !(p > 0)) throw new TradingError("symbol, side, lots et price requis");
      return this.trading.margin({ symbol, side: s, lots: v, price: p });
    });
  }
}

/** Le risque dit par Kopilia : un pourcentage, un montant ou des lots (un seul). */
export function riskFrom(b: { risk_percent?: number; risk_amount?: number; lots?: number }): Risk | undefined {
  const given = [
    b.risk_percent !== undefined ? ({ mode: "percent", value: Number(b.risk_percent) } as const) : undefined,
    b.risk_amount !== undefined ? ({ mode: "amount", value: Number(b.risk_amount) } as const) : undefined,
    b.lots !== undefined ? ({ mode: "lots", value: Number(b.lots) } as const) : undefined,
  ].filter((r) => r !== undefined);
  if (given.length > 1) throw new TradingError("un seul risque à la fois : un pourcentage, un montant ou des lots");
  const r = given[0];
  if (r && !(r.value > 0 && Number.isFinite(r.value))) throw new TradingError("le risque doit être un nombre positif");
  return r;
}

interface TicketBody {
  action?: string;
  box?: string;
  trade?: string;
  product?: string;
  execution?: string;
  targets?: number[];
  shares?: number[];
  risk_percent?: number;
  risk_amount?: number;
  lots?: number;
  stop?: number;
  objective?: number;
  fraction?: number;
  setup?: string;
  tier?: string;
}

interface SettingsBody {
  default_risk_percent?: number;
  default_risk_amount?: number;
  default_lots?: number;
  max_risk_percent?: number;
  max_open_risk_percent?: number | null;
  max_daily_loss_percent?: number | null;
  max_weekly_loss_percent?: number | null;
  capital_base?: string;
  breakeven_reminder_r?: number | null;
  commission_product?: string;
  commission?: number | null;
  tier_name?: string;
  tier_percent?: number;
  tier_when?: string;
  tier_remove?: string;
}

/**
 * API interne de la prise de position, pour le dialogue seulement (jamais les
 * agents) : l'état du compte et des trades, le money management, la
 * préparation d'un ticket, le bilan. Aucune route ne confirme un ticket :
 * seul l'utilisateur le fait, à l'écran ou à la voix.
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class TradingControlController {
  constructor(
    private readonly trading: TradingService,
    private readonly dashboard: DashboardService,
  ) {}

  @Get("trading")
  status() {
    return soft(async () => {
      const state = this.trading.state();
      let account = state.account;
      try {
        account = await this.trading.readAccount();
      } catch {
        /* l'erreur est dans l'état */
      }
      const s = state.settings;
      const cur = account?.currency ?? "";
      return {
        orders: state.ordersEnabled
          ? "permis, toujours sur confirmation de l'utilisateur (« je confirme » ou le bouton du ticket)"
          : "coupés dans Kopilia (KOPILIA_TRADING_ORDERS) : calculs seulement",
        ...(account
          ? {
              account: `${account.name} (${account.demo ? "démonstration" : "réel"}), solde ${moneyLabel(account.balance, cur)}, capitaux propres ${moneyLabel(account.equity, cur)}${account.tradeAllowed ? "" : ", ordres impossibles (mot de passe investisseur)"}`,
            }
          : { account: state.error ?? "compte non lu" }),
        money_management: [
          `risque par défaut ${riskLabel(s.defaultRisk, cur)}`,
          `plafond ${percentLabel(s.maxRiskPercent)} par trade`,
          s.maxOpenRiskPercent !== undefined ? `risque ouvert ${percentLabel(s.maxOpenRiskPercent)} au plus` : "risque ouvert sans limite",
          s.maxDailyLossPercent !== undefined ? `perte du jour ${percentLabel(s.maxDailyLossPercent)} au plus` : "",
          s.maxWeeklyLossPercent !== undefined ? `perte de la semaine ${percentLabel(s.maxWeeklyLossPercent)} au plus` : "",
          `calcul sur ${s.capitalBase === "equity" ? "les capitaux propres" : "le solde"}`,
          s.breakEvenAtR !== undefined ? `rappel de break-even à ${String(s.breakEvenAtR).replace(".", ",")} R` : "sans rappel de break-even",
          s.tiers.length ? `paliers : ${s.tiers.map((t) => tierLabel(t, true)).join(" ; ")}` : "aucun palier de risque",
          ...Object.entries(s.commissions).map(([sym, c]) => `commission ${sym} ${moneyLabel(c, cur)} par lot aller-retour`),
        ]
          .filter(Boolean)
          .join(" ; "),
        trades: this.trading.trades({ since: Date.now() - 86_400_000, limit: 20 }).map((t) => tradeLine(t)),
        ...(state.ticket ? { ticket: `${state.ticket.id} en attente de sa confirmation : ${state.ticket.text}` } : {}),
      };
    });
  }

  @Post("trading/settings")
  settings(@Body() b: SettingsBody) {
    return soft(async () => {
      const risk = riskFrom({ risk_percent: b.default_risk_percent, risk_amount: b.default_risk_amount, lots: b.default_lots });
      let commission: { symbol: string; value: number | null } | undefined;
      if (b.commission !== undefined) {
        if (!b.commission_product) throw new TradingError("dis de quel produit est la commission (commission_product)");
        const product = await this.dashboard.drawingProduct(b.commission_product);
        commission = { symbol: product.symbol, value: b.commission };
      }
      const base = b.capital_base === "equity" || b.capital_base === "balance" ? b.capital_base : undefined;
      if (b.capital_base !== undefined && !base) throw new TradingError("capital_base : balance (le solde) ou equity (les capitaux propres)");
      let tier: { name: string; percent: number; when?: string } | undefined;
      if (b.tier_name !== undefined || b.tier_percent !== undefined) {
        if (!b.tier_name?.trim() || !(Number(b.tier_percent) > 0)) throw new TradingError("un palier a un nom (tier_name) et un pourcentage (tier_percent)");
        tier = {
          name: b.tier_name.trim().slice(0, 20),
          percent: Number(b.tier_percent),
          ...(b.tier_when?.trim() ? { when: b.tier_when.trim().slice(0, 200) } : {}),
        };
      }
      const s = this.trading.updateSettings({
        ...(tier ? { tier } : {}),
        ...(b.tier_remove ? { removeTier: b.tier_remove } : {}),
        ...(risk ? { defaultRisk: risk } : {}),
        ...(b.max_risk_percent !== undefined ? { maxRiskPercent: b.max_risk_percent } : {}),
        ...(b.max_open_risk_percent !== undefined ? { maxOpenRiskPercent: b.max_open_risk_percent } : {}),
        ...(b.max_daily_loss_percent !== undefined ? { maxDailyLossPercent: b.max_daily_loss_percent } : {}),
        ...(b.max_weekly_loss_percent !== undefined ? { maxWeeklyLossPercent: b.max_weekly_loss_percent } : {}),
        ...(base ? { capitalBase: base } : {}),
        ...(b.breakeven_reminder_r !== undefined ? { breakEvenAtR: b.breakeven_reminder_r } : {}),
        ...(commission ? { commission } : {}),
      });
      return { saved: true, settings: s };
    });
  }

  /**
   * Prépare un ticket : ouvrir depuis une boîte (box), ou gérer un trade en
   * cours (trade, ou la boîte, ou le produit). Il s'affiche et attend la
   * confirmation de l'utilisateur ; Kopilia le lui relit.
   */
  @Post("trading/ticket")
  ticket(@Body() b: TicketBody) {
    return soft(async () => {
      const action = (b.action ?? "open") as TicketAction;
      const risk = riskFrom(b);
      if (action === "open") {
        if (!b.box) throw new TradingError("dis de quelle boîte de trade partir (box, son identifiant d_…) ; pose-la d'abord avec chart_draw si besoin");
        const ticket = await this.trading.prepareOpen({
          drawingId: b.box,
          execution: b.execution === "market" ? "market" : "pending",
          ...(b.targets?.length ? { targets: b.targets.map(Number) } : {}),
          ...(b.shares?.length ? { shares: b.shares.map(Number) } : {}),
          ...(risk ? { risk } : {}),
          ...(b.setup ? { setupId: b.setup } : {}),
          ...(b.tier ? { tier: b.tier } : {}),
        });
        return this.ticketReply(ticket);
      }
      if (!["breakeven", "modify", "close", "partial", "cancel"].includes(action)) {
        throw new TradingError("action : open, breakeven, modify, close, partial ou cancel");
      }
      let symbol: string | undefined;
      if (b.product) symbol = (await this.dashboard.drawingProduct(b.product)).symbol;
      const ticket = await this.trading.prepareManage({
        action: action as Exclude<TicketAction, "open">,
        ...(b.trade ? { trade: b.trade } : {}),
        ...(b.box ? { drawingId: b.box } : {}),
        ...(symbol ? { symbol } : {}),
        ...(b.stop !== undefined ? { stop: Number(b.stop) } : {}),
        ...(b.objective !== undefined ? { target: Number(b.objective) } : {}),
        ...(b.fraction !== undefined ? { fraction: Number(b.fraction) } : {}),
      });
      return this.ticketReply(ticket);
    });
  }

  @Post("trading/ticket/cancel")
  cancelTicket() {
    const t = this.trading.cancelTicket();
    return t ? { cancelled: t.id } : { note: "aucun ticket en attente" };
  }

  @Get("trading/review")
  review(@Query("days") days?: string) {
    const n = Math.min(365, Math.max(1, Math.round(Number(days) || 7)));
    return this.trading.review(n);
  }

  private ticketReply(ticket: { id: string; action: string; text: string; warnings: string[]; lots: number; expiresAt: number; tier?: string }) {
    // Ses paliers, s'il en a et n'en a pas choisi : Kopilia les lui rappelle, sans choisir pour lui.
    const tiers = this.trading.settings().tiers;
    const remind =
      ticket.action === "open" && !ticket.tier && tiers.length
        ? `Ses paliers : ${tiers.map((t) => tierLabel(t, true)).join(" ; ")}. Rappelle-les-lui en une phrase : s'il en veut un, prépare un nouveau ticket avec tier. Ne choisis pas pour lui.`
        : undefined;
    return {
      ticket: ticket.id,
      readback: ticket.text,
      ...(ticket.warnings.length ? { warnings: ticket.warnings } : {}),
      ...(remind ? { tiers: remind } : {}),
      size: lotsLabel(ticket.lots),
      note: "Rien n'est parti. Relis le ticket à l'utilisateur en une phrase courte (readback, et les avertissements), puis demande « tu confirmes ? ». Ne lui explique pas comment confirmer : le ticket est à l'écran avec ses boutons, il le sait. L'ordre ne part que s'il dit « je confirme » ou s'il clique, dans les 90 secondes : tu ne peux pas le confirmer toi-même. « Annule » ou « non » le retire ; un clic sur le ticket te coupe.",
    };
  }
}
