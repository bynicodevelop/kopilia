import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import {
  journalReviewSchema,
  exitLabel,
  tradeExits,
  tradeOutcome,
  type AnalysisEntry,
  type AnalysisView,
  type Drawing,
  type Indicator,
  type Journal,
  type JournalGroup,
  type JournalItem,
  type BilanPeriod,
  type ClaudeContentBlock,
  type JournalBilan,
  type JournalFact,
  type JournalLine,
  type JournalReview,
  type JournalTrade,
  type Trade,
} from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { rasterize } from "../channels/chart-image.service.js";
import type { ChartCandle } from "../market/market.service.js";
import { invalidationPrice, replayIdea, replayPlan, replayTimeframe } from "./replay.js";
import { afterFact, ideaFact, ideaZone, planFact, untakenLine, wasManaged } from "./replay-facts.js";
import { claudeReviewer, parseReview, reviewStats, reviewTurn, type ReviewFn } from "./journal-review.js";
import { bilanRange, computeBilan, dateKey, type BilanTrade } from "./journal-bilan.js";
import { AppLogger } from "../common/logger.js";
import { DatabaseService } from "../db/database.service.js";
import { AnalysisService } from "../analyses/analysis.service.js";
import { DashboardService } from "../dashboard/dashboard.service.js";
import { MarketService } from "../market/market.service.js";
import { CHART_TIMEFRAMES, TIMEFRAME_SECONDS, isChartTimeframe, type ChartTimeframe } from "../market/timeframes.js";
import { CHART_BARS, chartSvg, type TradeOverlay } from "../channels/chart-svg.js";
import { TradingService } from "../trading/trading.service.js";
import { durationOf, fidelityOf, firstIdea, ideaWords, journalFacts, type FicheAtTicket } from "./journal-facts.js";

/** Le graphique figé d'un trade : ce qui était posé sur le produit à la confirmation du ticket. */
export interface TradeSnapshot {
  at: number;
  timeframe: ChartTimeframe;
  drawings: Drawing[];
  indicators: Indicator[];
  /** La fiche ouverte au ticket, et son état d'alors. */
  fiche?: { id: string; view: AnalysisView };
}

/** Erreur lisible du journal, dite telle quelle. */
export class JournalError extends Error {}

/** Le journal montre par défaut les trades de cette période. */
export const JOURNAL_DAYS = 30;
/** Avant le ticket, le fil reprend au plus ces dernières entrées de la fiche. */
const FICHE_BEFORE = 12;
/** Bougies au plus pour la durée du trade sur son graphique figé (le reste : avant et après). */
const TRADE_BARS = 70;
/** Bougies montrées après la sortie, pour juger la sortie, et avant le ticket, pour voir d'où il part. */
const AFTER_BARS = 15;
const BEFORE_BARS = 30;
/** Bougies montrées au moins sur le graphique figé. */
const MIN_BARS = 48;
/** Bougies de plus pour amorcer les moyennes. */
const WARMUP = 200;
/** Un rejeu encore ouvert (ni objectif ni stop, idée en cours) est refait après ce délai ; un rejeu tranché est gardé. */
const REPLAY_TTL_MS = 10 * 60_000;
/** L'analyse lit au plus ces trades (les plus récents), et voit au plus ces graphiques figés. */
const REVIEW_TRADES = 30;
const REVIEW_IMAGES = 6;
/** Un bilan relit les rejeux (bougies) de ses trades jusqu'à ce nombre ; au-delà, seulement ceux déjà faits. */
const BILAN_FETCH_MAX = 10;
/** Un trade fermé dans la période peut avoir été ouvert avant : on remonte d'autant. */
const BILAN_LOOKBACK_MS = 90 * 86_400_000;

/** Les réglages du journal : l'heure du bilan du soir (aucune : pas de bilan du soir), le jour du dernier envoyé. */
export interface JournalSettings {
  evening?: string;
  lastEvening?: string;
}

/**
 * Le journal de trading : chaque trade passé par Kopilia rattaché à la fiche
 * d'analyse ouverte au ticket, son graphique figé à la confirmation (ses tracés
 * de ce moment, jamais ceux posés après), ses gestes, ses sorties, son
 * résultat, ses notes dictées et les faits qu'en tire le serveur. Rangé par
 * fiche ; ne passe aucun ordre.
 */
@Injectable()
export class JournalService
  extends EventEmitter<{
    changed: [string | undefined];
    show: [string];
    showReview: [string];
    showCalendar: [string];
    reviewed: [JournalReview];
    reviewFailed: [string];
    evening: [JournalBilan];
  }>
  implements OnModuleInit, OnModuleDestroy
{
  now: () => number = () => Date.now();
  /** Qui fait l'analyse (Sonnet, sans outils) ; remplaçable en test. */
  reviewer?: ReviewFn;
  private reviewing = false;
  private readonly replays = new Map<string, { at: number; final: boolean; value: unknown }>();
  private ticker?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly trading: TradingService,
    private readonly analyses: AnalysisService,
    private readonly dashboard: DashboardService,
    private readonly market: MarketService,
    private readonly logger: AppLogger,
    @Optional() private readonly config?: ConfigService,
  ) {
    super();
  }

  onModuleInit() {
    this.trading.on("confirmed", (t) => {
      try {
        this.freeze(t);
      } catch (e) {
        this.logger.warn(`journal : graphique de ${t.id} non figé (${(e as Error).message})`, "journal");
      }
    });
    this.trading.on("changed", () => this.emit("changed", undefined));
    this.trading.on("noted", (t) => this.emit("changed", t.id));
    this.analyses.on("changed", () => this.emit("changed", undefined));
    // Le bilan du soir : vérifié à la minute (une minuterie unique ne voit pas l'heure passer pendant la veille du Mac).
    this.ticker = setInterval(() => void this.eveningTick(), 60_000);
    this.ticker.unref();
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
  }

  /* ------------------------------ Figer ------------------------------ */

  /**
   * Fige le graphique d'un trade à la confirmation du ticket : une copie des
   * tracés du produit, l'unité de temps et les indicateurs de son graphique,
   * la fiche ouverte et son état. Une fois seulement.
   */
  freeze(trade: Trade): void {
    const panel = this.dashboard.list().find((p) => p.kind === "chart" && p.symbol === trade.symbol);
    const timeframe: ChartTimeframe = isChartTimeframe(panel?.timeframe) ? panel.timeframe : "15m";
    const fiche = this.analyses.open(trade.symbol);
    const snap: TradeSnapshot = {
      at: this.now(),
      timeframe,
      drawings: structuredClone(this.dashboard.drawings.list([trade.symbol])),
      indicators: structuredClone(panel?.indicators ?? this.dashboard.indicatorsFor(trade.symbol)),
      ...(fiche ? { fiche: { id: fiche.id, view: structuredClone(fiche.view) } } : {}),
    };
    this.db.db
      .prepare("INSERT OR IGNORE INTO trade_snapshots (trade_id, symbol, analysis_id, at, data) VALUES (?, ?, ?, ?, ?)")
      .run(trade.id, trade.symbol, fiche?.id ?? null, snap.at, JSON.stringify(snap));
  }

  /** Le graphique figé d'un trade (undefined : trade d'avant le journal). */
  snapshot(tradeId: string): TradeSnapshot | undefined {
    const row = this.db.db.prepare("SELECT data FROM trade_snapshots WHERE trade_id = ?").get(tradeId) as { data: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.data) as TradeSnapshot;
    } catch {
      return undefined;
    }
  }

  /* ------------------------------ Lire ------------------------------ */

  /** La fiche du trade telle qu'elle était au ticket : celle notée au ticket, sinon celle ouverte alors. */
  fiche(trade: Trade, snap = this.snapshot(trade.id)): FicheAtTicket | undefined {
    const ticketAt = snap?.at ?? trade.createdAt;
    const analysis = snap?.fiche ? this.analyses.get(snap.fiche.id) : this.analyses.at(trade.symbol, ticketAt);
    if (!analysis) return undefined;
    const entries = this.analyses.entries(analysis.id, 400).filter((e) => e.at <= ticketAt);
    const lastView = [...entries].reverse().find((e) => e.kind === "view" && e.view)?.view;
    return { id: analysis.id, createdAt: analysis.createdAt, view: snap?.fiche?.view ?? lastView ?? analysis.view, entries };
  }

  /** La page d'un trade : son résultat, ses faits, ses gestes, ses notes, et le fil de sa fiche et du trade mêlés. */
  page(tradeId: string): JournalTrade {
    const trade = this.trading.getTrade(tradeId);
    if (!trade) throw new JournalError(`aucun trade « ${tradeId} » dans le journal`);
    const snap = this.snapshot(trade.id);
    const fiche = this.fiche(trade, snap);
    const events = this.trading.events(trade.id);
    const gestures = this.trading.gestures(trade.id);
    const now = this.now();
    const ticketAt = snap?.at ?? trade.createdAt;
    const outcome = tradeOutcome(trade);
    const exit = exitLabel(trade);
    const duration = durationOf(trade, now);
    return {
      trade,
      ...(outcome ? { outcome } : {}),
      ...(exit ? { exit } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(fiche ? { analysisId: fiche.id } : {}),
      fidelity: fidelityOf(trade, fiche),
      frozen: !!snap,
      ...(snap ? { frozenAt: snap.at, timeframe: snap.timeframe } : {}),
      facts: journalFacts(trade, { ...(fiche ? { fiche } : {}), gestures, frozen: !!snap, ticketAt, now }),
      gestures,
      notes: events.filter((e) => e.kind === "note").map((e) => ({ at: e.at, text: e.text })),
      thread: this.thread(trade, fiche, events, ticketAt),
    };
  }

  /** Le fil d'un trade : les dernières entrées de sa fiche avant le ticket, puis la fiche et le trade mêlés jusqu'à la fin. */
  private thread(trade: Trade, fiche: FicheAtTicket | undefined, events: ReturnType<TradingService["events"]>, ticketAt: number): JournalItem[] {
    const end = trade.closedAt ?? this.now();
    const items: JournalItem[] = [];
    if (fiche) {
      const all = this.analyses.entries(fiche.id, 400).filter((e) => e.at <= end);
      const before = all.filter((e) => e.at <= ticketAt).slice(-FICHE_BEFORE);
      const during = all.filter((e) => e.at > ticketAt);
      for (const e of [...before, ...during]) items.push(ficheItem(e));
    }
    for (const e of events) {
      const kind = TRADE_ITEM[e.kind];
      if (!kind) continue;
      items.push({ at: e.at, kind, by: kind === "note" ? "user" : kind === "ticket" ? "kopilia" : "system", text: e.text });
    }
    return items.sort((a, b) => a.at - b.at);
  }

  /**
   * Le journal par fiche : les fiches qui ont des trades sur la période (les
   * plus récents d'abord), les trades sans fiche, puis les fiches ouvertes
   * sans trade encore.
   */
  list(days = JOURNAL_DAYS): Journal {
    const now = this.now();
    const since = now - days * 86_400_000;
    const trades = this.trading.trades({ since, limit: 500 }).filter((t) => t.state !== "rejected");
    const byFiche = new Map<string, Trade[]>();
    const loose: Trade[] = [];
    const fidelity = new Map<string, JournalLine["fidelity"]>();
    for (const t of trades) {
      const fiche = this.fiche(t);
      fidelity.set(t.id, fidelityOf(t, fiche));
      if (!fiche) loose.push(t);
      else byFiche.set(fiche.id, [...(byFiche.get(fiche.id) ?? []), t]);
    }
    const line = (t: Trade): JournalLine => this.line(t, fidelity.get(t.id) ?? "none");
    const groups: JournalGroup[] = [];
    for (const [id, list] of byFiche) {
      const a = this.analyses.get(id);
      if (!a) continue;
      groups.push({ ...this.ficheHeader(id), trades: list.map(line), r: sumR(list) });
    }
    groups.sort((a, b) => (b.trades[0]?.at ?? 0) - (a.trades[0]?.at ?? 0));
    if (loose.length) groups.push({ name: "Sans fiche", trades: loose.map(line), r: sumR(loose) });
    for (const a of this.analyses.list()) {
      if (a.state !== "open" || byFiche.has(a.id)) continue;
      groups.push({ ...this.ficheHeader(a.id), trades: [], r: 0 });
    }
    const closed = trades.filter((t) => tradeOutcome(t));
    return {
      since,
      groups,
      totals: {
        count: closed.length,
        wins: closed.filter((t) => tradeOutcome(t) === "win").length,
        losses: closed.filter((t) => tradeOutcome(t) === "loss").length,
        neutral: closed.filter((t) => tradeOutcome(t) === "neutral").length,
        r: sumR(closed),
      },
    };
  }

  /** L'en-tête d'une fiche dans le journal : son produit, son idée, et l'idée de départ si elle a changé de sens. */
  private ficheHeader(id: string): Omit<JournalGroup, "trades" | "r"> {
    const a = this.analyses.get(id)!;
    const first = firstIdea(this.analyses.entries(id, 400));
    const changed = first && a.view.idea && a.view.idea.side !== "none" && first.view.idea!.side !== a.view.idea.side;
    const idea = ideaWords(a.view, a.digits);
    return {
      analysisId: a.id,
      symbol: a.symbol,
      name: a.name,
      state: a.state,
      openedAt: a.createdAt,
      ...(a.closedAt ? { closedAt: a.closedAt } : {}),
      ...(idea ? { idea } : {}),
      ...(changed ? { firstIdea: ideaWords(first.view, a.digits) } : {}),
    };
  }

  private line(t: Trade, fidelity: JournalLine["fidelity"]): JournalLine {
    const outcome = tradeOutcome(t);
    const notes = this.trading.events(t.id).filter((e) => e.kind === "note");
    const remark =
      t.state === "closed"
        ? exitLabel(t)
        : t.state === "open"
          ? "en cours"
          : t.state === "pending"
            ? "ordre en attente"
            : t.state === "cancelled"
              ? "ordre retiré"
              : undefined;
    return {
      id: t.id,
      symbol: t.symbol,
      name: t.name,
      side: t.side,
      state: t.state,
      ...(outcome ? { outcome } : {}),
      ...(t.r !== undefined ? { r: t.r } : {}),
      ...(t.profit !== undefined ? { profit: t.profit } : {}),
      currency: t.currency,
      at: t.closedAt ?? t.openedAt ?? t.createdAt,
      fidelity,
      ...(remark ? { remark } : {}),
      ...(notes.length ? { note: notes.at(-1)!.text } : {}),
      demo: t.demo,
    };
  }

  /**
   * Le trade visé : par identifiant, sinon le dernier d'un produit (nom
   * courant ou symbole), sinon le dernier fermé (ou le seul en cours).
   */
  find(ref: { trade?: string; product?: string } = {}): Trade {
    if (ref.trade?.trim()) {
      const t = this.trading.getTrade(ref.trade.trim());
      if (!t) throw new JournalError(`aucun trade « ${ref.trade} » : demande le journal pour la liste`);
      return t;
    }
    const recent = this.trading.trades({ since: this.now() - 365 * 86_400_000, limit: 500 }).filter((t) => t.state !== "rejected");
    if (ref.product?.trim()) {
      const q = fold(ref.product);
      const hit = recent.find((t) => fold(t.symbol).includes(q) || fold(t.name).includes(q) || q.includes(fold(t.name)));
      if (!hit) throw new JournalError(`aucun trade sur « ${ref.product} » dans le journal`);
      return hit;
    }
    const live = recent.filter((t) => t.state === "open" || t.state === "pending");
    const lastClosed = recent.filter((t) => t.state === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0];
    const pick = lastClosed ?? (live.length === 1 ? live[0] : undefined);
    if (!pick) throw new JournalError(live.length ? "plusieurs trades en cours : précise lequel" : "aucun trade dans le journal pour l'instant");
    return pick;
  }

  /** Une note dictée sur un trade (le dernier fermé par défaut). */
  note(text: string, ref: { trade?: string; product?: string } = {}): { trade: Trade; at: number } {
    const trade = this.find(ref);
    const e = this.trading.note(trade.id, text);
    return { trade, at: e.at };
  }

  /** Ouvre la page d'un trade sur les écrans. */
  show(ref: { trade?: string; product?: string } = {}): Trade {
    const trade = this.find(ref);
    this.emit("show", trade.id);
    return trade;
  }

  /* ------------------------------ Les rejeux ------------------------------ */

  /** Les bougies d'un produit sur une période, dans l'unité la plus fine qui la tient. */
  private async bars(symbol: string, from: number, to: number): Promise<{ bars: ChartCandle[]; tf: number } | undefined> {
    const timeframe = replayTimeframe(to - from);
    const tf = TIMEFRAME_SECONDS[timeframe];
    const r = await this.market.chartCandles(symbol, timeframe, {
      before: Math.floor(to / 1000),
      limit: Math.min(1000, Math.ceil((to - from) / 1000 / tf) + 4),
    });
    return "error" in r ? undefined : { bars: r.candles, tf };
  }

  /** Un rejeu gardé : tranché pour toujours, encore ouvert quelques minutes. */
  private async cached<T>(key: string, compute: () => Promise<{ value: T; final: boolean } | undefined>, fetch = true): Promise<T | undefined> {
    const known = this.replays.get(key);
    if (known && (known.final || this.now() - known.at < REPLAY_TTL_MS || !fetch)) return known.value as T;
    if (!fetch) return undefined;
    const r = await compute().catch((e: Error) => {
      this.logger.warn(`journal : rejeu ${key} impossible (${e.message})`, "journal");
      return undefined;
    });
    if (r) this.replays.set(key, { at: this.now(), final: r.final, value: r.value });
    return r?.value;
  }

  /**
   * Les faits des rejeux d'un trade : le plan du ticket laissé tel quel contre
   * ce qu'il a géré, ce qu'a fait le prix après sa sortie, et l'idée qu'il a
   * abandonnée (son idée de départ, ou celle de la fiche s'il a pris l'autre sens).
   */
  async replayFacts(page: JournalTrade, fetch = true): Promise<JournalFact[]> {
    const trade = page.trade;
    const now = this.now();
    const facts: JournalFact[] = [];
    const target = this.initialTarget(trade);
    const entry = averageFill(trade) ?? trade.entry;
    const managed = wasManaged(trade, page.gestures.length);
    if (trade.openedAt && managed) {
      const plan = await this.cached(
        `plan:${trade.id}:${trade.updatedAt}`,
        async () => {
          const b = await this.bars(trade.symbol, trade.openedAt!, now);
          const value = b && replayPlan({ side: trade.side, entry, stop: trade.initialStop, target, from: trade.openedAt! }, b.bars, b.tf);
          return value ? { value, final: value.result !== "open" } : undefined;
        },
        fetch,
      );
      if (plan) facts.push(planFact({ ...trade, entry }, plan, { target, now }));
      if (trade.state === "closed" && trade.closedAt) {
        const after = await this.cached(
          `after:${trade.id}`,
          async () => {
            const b = await this.bars(trade.symbol, trade.closedAt!, now);
            const value = b && replayPlan({ side: trade.side, entry, stop: trade.initialStop, target, from: trade.closedAt! }, b.bars, b.tf);
            return value ? { value, final: value.result !== "open" } : undefined;
          },
          fetch,
        );
        const f = after && afterFact(trade, after, { target, now });
        if (f) facts.push(f);
      }
    }
    // L'idée abandonnée : celle du départ (changement d'avis), ou celle de la fiche (trade dans l'autre sens).
    const fiche = page.analysisId ? this.fiche(trade) : undefined;
    if (fiche) {
      const changed = page.facts.some((f) => f.key === "changed-mind");
      const against = page.facts.some((f) => f.key === "against-idea");
      const first = firstIdea(fiche.entries);
      const abandoned =
        changed && first
          ? { what: "Ton idée de départ", view: first.view, at: first.at }
          : against
            ? { what: "L'idée de ta fiche", view: fiche.view, at: ideaSince(fiche) }
            : undefined;
      const zone = abandoned && ideaZone(abandoned.view);
      const side = abandoned?.view.idea?.side;
      if (abandoned && zone && (side === "buy" || side === "sell")) {
        const invalidation = invalidationPrice(abandoned.view.invalidation, zone);
        const r = await this.cached(
          `idea:${fiche.id}:${abandoned.at}`,
          async () => {
            const b = await this.bars(trade.symbol, abandoned.at, now);
            if (!b) return undefined;
            const value = replayIdea({ side, ...zone, ...(invalidation !== undefined ? { invalidation } : {}), from: abandoned.at }, b.bars, b.tf);
            return { value, final: value.invalidatedAt !== undefined };
          },
          fetch,
        );
        if (r)
          facts.push(
            ideaFact(abandoned.what, abandoned.view, abandoned.at, r, {
              digits: trade.digits,
              now,
              key: "idea-replay",
              ...(invalidation !== undefined ? { invalidation } : {}),
            }),
          );
      }
    }
    return facts;
  }

  /** La page d'un trade avec les faits de ses rejeux, rangés après ceux qu'ils complètent. */
  async fullPage(tradeId: string, fetch = true): Promise<JournalTrade> {
    const page = this.page(tradeId);
    const extra = await this.replayFacts(page, fetch);
    if (!extra.length) return page;
    const facts = [...page.facts];
    const insert = (f: JournalFact, after: string[]) => {
      const i = Math.max(...after.map((k) => facts.findIndex((x) => x.key === k)));
      facts.splice(i >= 0 ? i + 1 : facts.length, 0, f);
    };
    for (const f of extra) {
      if (f.key === "idea-replay") insert(f, ["changed-mind", "against-idea"]);
      else insert(f, ["outcome", "plan"]);
    }
    return { ...page, facts };
  }

  /** Une fiche sans trade : son idée rejouée sur les cours, en une ligne (undefined : pas d'idée chiffrée). */
  async untaken(analysisId: string): Promise<string | undefined> {
    const a = this.analyses.get(analysisId);
    const side = a?.view.idea?.side;
    const zone = ideaZone(a?.view);
    if (!a || !zone || (side !== "buy" && side !== "sell")) return undefined;
    const since = ideaSince({ id: a.id, createdAt: a.createdAt, view: a.view, entries: this.analyses.entries(a.id, 400) });
    const until = a.closedAt ?? this.now();
    const invalidation = invalidationPrice(a.view.invalidation, zone);
    const r = await this.cached(`untaken:${a.id}:${since}:${a.updatedAt}`, async () => {
      const b = await this.bars(a.symbol, since, until);
      if (!b) return undefined;
      const value = replayIdea({ side, ...zone, ...(invalidation !== undefined ? { invalidation } : {}), from: since }, b.bars, b.tf);
      return { value, final: a.state === "closed" || value.invalidatedAt !== undefined };
    });
    return r ? untakenLine(r, { digits: a.digits, now: this.now() }) : undefined;
  }

  /** Le journal par fiche, avec l'idée rejouée des fiches sans trade, et sa dernière analyse. */
  async listFull(days = JOURNAL_DAYS): Promise<Journal> {
    const j = this.list(days);
    for (const g of j.groups) {
      if (!g.analysisId || g.trades.length) continue;
      const line = await this.untaken(g.analysisId);
      if (line) g.untaken = line;
    }
    const last = this.latestReview();
    return {
      ...j,
      ...(last ? { review: { id: last.id, createdAt: last.createdAt, days: last.days, summary: last.summary } } : {}),
      ...(this.reviewing ? { reviewing: true } : {}),
    };
  }

  /* ------------------------------ L'analyse ------------------------------ */

  /** Une analyse est en cours. */
  get busy(): boolean {
    return this.reviewing;
  }

  /**
   * Lance l'analyse de son trading sur une période, en arrière-plan : les
   * chiffres du serveur, ses trades (faits, rejeux, fil de la fiche, notes),
   * ses idées non prises et quelques graphiques figés, lus par l'IA. Rend
   * tout de suite ce qui sera lu ; le résultat arrive par « reviewed ».
   */
  review(days = 7): { trades: number; untaken: number } {
    if (this.reviewing) throw new JournalError("une analyse de ton trading est déjà en cours");
    const reviewer =
      this.reviewer ??
      (this.config
        ? claudeReviewer({ bin: this.config.claudeBin, model: this.config.setupModel, dataDir: this.config.dataDir, logger: this.logger })
        : undefined);
    if (!reviewer) throw new JournalError("l'analyse n'est pas disponible ici (pas de modèle configuré)");
    const j = this.list(days);
    const ids = j.groups.flatMap((g) => g.trades.map((l) => l.id)).slice(0, REVIEW_TRADES);
    const empty = j.groups.filter((g) => g.analysisId && !g.trades.length);
    if (!ids.length) throw new JournalError(`aucun trade dans ton journal sur ${days} jour${days > 1 ? "s" : ""} : rien à analyser`);
    this.reviewing = true;
    this.emit("changed", undefined);
    void this.runReview(
      days,
      ids,
      empty.map((g) => ({ id: g.analysisId!, name: g.name })),
      reviewer,
    ).finally(() => {
      this.reviewing = false;
      this.emit("changed", undefined);
    });
    return { trades: ids.length, untaken: empty.length };
  }

  private async runReview(days: number, ids: string[], fiches: Array<{ id: string; name: string }>, reviewer: ReviewFn) {
    try {
      const now = this.now();
      // Une page après l'autre : MetaApi n'aime pas trop de lectures de bougies à la fois.
      const pages: JournalTrade[] = [];
      for (const id of ids) pages.push(await this.fullPage(id));
      const untaken: Array<{ name: string; line: string }> = [];
      for (const f of fiches) {
        const line = await this.untaken(f.id);
        if (line) untaken.push({ name: f.name, line });
      }
      const stats = reviewStats(pages, untaken);
      const content: ClaudeContentBlock[] = [{ type: "text", text: reviewTurn({ days, stats, pages, untaken, now }) }];
      // Les graphiques figés qui comptent le plus : les pertes, contre la fiche, les changements d'avis, puis les plus grands écarts.
      const weight = (p: JournalTrade) =>
        (p.outcome === "loss" ? 4 : 0) +
        (p.fidelity === "against" ? 3 : 0) +
        (p.facts.some((f) => f.key === "changed-mind") ? 2 : 0) +
        Math.abs(p.trade.r ?? 0);
      for (const p of [...pages]
        .filter((x) => x.trade.openedAt)
        .sort((a, b) => weight(b) - weight(a))
        .slice(0, REVIEW_IMAGES)) {
        const svg = await this.chart(p.trade.id);
        if (typeof svg !== "string") continue;
        content.push({ type: "text", text: `Graphique figé de ${p.trade.id} (${p.trade.name}) :` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: rasterize(svg).toString("base64") } });
      }
      const reply = await reviewer(content);
      const parsed = parseReview(reply, ids);
      if (!parsed) throw new Error("réponse de l'IA illisible");
      const review = journalReviewSchema.parse({
        id: `jr_${randomBytes(4).toString("hex")}`,
        createdAt: this.now(),
        days,
        since: now - days * 86_400_000,
        stats,
        ...parsed,
        tradeIds: ids,
      });
      this.db.db
        .prepare("INSERT INTO journal_reviews (id, created_at, days, data) VALUES (?, ?, ?, ?)")
        .run(review.id, review.createdAt, review.days, JSON.stringify(review));
      this.emit("reviewed", review);
    } catch (e) {
      this.logger.warn(`journal : analyse impossible (${(e as Error).message})`, "journal");
      this.emit("reviewFailed", (e as Error).message);
    }
  }

  /** La dernière analyse de son trading. */
  latestReview(): JournalReview | undefined {
    const row = this.db.db.prepare("SELECT data FROM journal_reviews ORDER BY created_at DESC LIMIT 1").get() as { data: string } | undefined;
    return row ? parseStored(row.data) : undefined;
  }

  getReview(id: string): JournalReview | undefined {
    const row = this.db.db.prepare("SELECT data FROM journal_reviews WHERE id = ?").get(id.trim()) as { data: string } | undefined;
    return row ? parseStored(row.data) : undefined;
  }

  /** Ouvre l'analyse (la dernière par défaut) sur les écrans. */
  showReview(id?: string): JournalReview {
    const r = id ? this.getReview(id) : this.latestReview();
    if (!r) throw new JournalError(id ? `aucune analyse « ${id} »` : "aucune analyse de ton trading pour l'instant : demande-la");
    this.emit("showReview", r.id);
    return r;
  }

  /* ------------------------------ Les bilans ------------------------------ */

  /**
   * Le bilan de ses trades fermés sur une période : le jour, la semaine (du
   * lundi), le mois (`date` : AAAA-MM-JJ ou AAAA-MM, aujourd'hui par défaut),
   * ou les N derniers jours. Les rejeux sont relus pour une dizaine de trades
   * au plus ; au-delà, seuls ceux déjà faits comptent.
   */
  async bilan(period: BilanPeriod, opts: { date?: string; days?: number; fetch?: boolean } = {}): Promise<JournalBilan> {
    const ref = opts.date ? parseDate(opts.date) : new Date(this.now());
    if (!ref) throw new JournalError(`date illisible « ${opts.date} » : AAAA-MM-JJ, ou AAAA-MM pour un mois`);
    const range = bilanRange(period, ref, opts.days ?? JOURNAL_DAYS);
    const trades = this.trading
      .trades({ since: range.from - BILAN_LOOKBACK_MS, limit: 2000 })
      .filter((t) => t.state === "closed" && t.closedAt !== undefined && t.closedAt >= range.from && t.closedAt < range.to);
    const fetch = opts.fetch ?? trades.length <= BILAN_FETCH_MAX;
    const items: BilanTrade[] = [];
    for (const t of trades) {
      const page = await this.fullPage(t.id, fetch);
      const events = this.trading.events(t.id);
      const ticket = events.find((e) => e.kind === "ticket")?.text ?? "";
      const tier = t.tier ?? ticket.match(/palier ([^),.]+)/)?.[1]?.trim();
      const horizon = this.fiche(t)?.view.idea?.horizon;
      items.push({
        page,
        line: this.line(t, page.fidelity),
        ...(horizon ? { horizon } : {}),
        ...(tier ? { tier } : {}),
        noted: events.some((e) => e.kind === "note"),
      });
    }
    return computeBilan(items, { period, ...range, live: this.trading.liveTrades().length });
  }

  /** Ouvre le calendrier du journal sur les écrans : un mois (AAAA-MM) ou un jour (AAAA-MM-JJ) ; le mois en cours par défaut. */
  showCalendar(date?: string): string {
    const key = date?.trim() || dateKey(this.now()).slice(0, 7);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key) || !parseDate(key)) throw new JournalError(`date illisible « ${date} » : AAAA-MM ou AAAA-MM-JJ`);
    this.emit("showCalendar", key);
    return key;
  }

  /* ---------------------------- Le bilan du soir ---------------------------- */

  settings(): JournalSettings {
    const row = this.db.db.prepare("SELECT value FROM trading_settings WHERE key = 'journal'").get() as { value: string } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.value) as JournalSettings;
    } catch {
      return {};
    }
  }

  private saveSettings(s: JournalSettings) {
    this.db.db
      .prepare(
        "INSERT INTO trading_settings (key, value, updated_at) VALUES ('journal', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(s), this.now());
  }

  /**
   * Règle l'heure du bilan du soir (« 22:30 ») ou l'arrête (null). Une heure
   * déjà passée aujourd'hui commence demain : rien ne part à l'instant.
   */
  setEvening(time: string | null): JournalSettings {
    const current = this.settings();
    if (time === null) {
      const { evening: _drop, ...rest } = current;
      this.saveSettings(rest);
      return rest;
    }
    const m = time.trim().match(/^(\d{1,2})(?::|h|\s*h\s*)?(\d{2})?$/i);
    const hour = m ? Number(m[1]) : NaN;
    const minute = m?.[2] ? Number(m[2]) : 0;
    if (!m || hour > 23 || minute > 59) throw new JournalError(`heure illisible « ${time} » : HH:MM (22:30)`);
    const evening = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const now = new Date(this.now());
    const passed = now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
    const next: JournalSettings = { ...current, evening, ...(passed ? { lastEvening: dateKey(now.getTime()) } : {}) };
    this.saveSettings(next);
    return next;
  }

  /**
   * Le bilan du soir s'il est dû : son heure passée, pas encore fait
   * aujourd'hui. Part seulement si des trades ont été fermés dans la journée.
   * Renvoie le bilan envoyé.
   */
  async eveningTick(): Promise<JournalBilan | undefined> {
    const s = this.settings();
    if (!s.evening) return undefined;
    const now = new Date(this.now());
    const today = dateKey(now.getTime());
    const [h, m] = s.evening.split(":").map(Number);
    if (s.lastEvening === today || now.getHours() * 60 + now.getMinutes() < h * 60 + m) return undefined;
    // Noté avant le calcul : une seule fois par jour, même si le calcul échoue.
    this.saveSettings({ ...s, lastEvening: today });
    try {
      const b = await this.bilan("day", { date: today });
      if (!b.totals.count) return undefined;
      this.emit("evening", b);
      return b;
    } catch (e) {
      this.logger.warn(`journal : bilan du soir impossible (${(e as Error).message})`, "journal");
      return undefined;
    }
  }

  /* --------------------------- Le graphique figé --------------------------- */

  /**
   * Le graphique figé d'un trade, en SVG : les bougies de sa période (un peu
   * avant le ticket, jusqu'à quelques bougies après la sortie), les tracés et
   * les indicateurs de la confirmation du ticket (jamais ceux d'après), sa
   * boîte, son stop et son objectif marche par marche, son entrée et ses sorties.
   */
  async chart(tradeId: string): Promise<string | { error: string }> {
    const trade = this.trading.getTrade(tradeId);
    if (!trade) return { error: `aucun trade « ${tradeId} »` };
    const snap = this.snapshot(trade.id);
    const now = this.now();
    const start = trade.createdAt;
    const end = trade.closedAt ?? (trade.state === "open" || trade.state === "pending" ? now : trade.updatedAt);
    const timeframe = fitTimeframe(snap?.timeframe ?? "15m", end - start);
    const tf = TIMEFRAME_SECONDS[timeframe];
    const until = Math.min(now, end + AFTER_BARS * tf * 1000);
    const r = await this.market.chartCandles(trade.symbol, timeframe, { before: Math.floor(until / 1000), limit: CHART_BARS + WARMUP });
    if ("error" in r) return { error: r.error ?? "bougies indisponibles" };
    const endS = Math.floor(end / 1000);
    const box = snap?.drawings.find((d) => d.id === trade.drawingId && d.kind === "position");
    const others = (snap?.drawings ?? []).filter((d) => d !== box);
    // Sa boîte s'arrête à sa sortie ; sans graphique figé, elle est refaite à ses niveaux du ticket.
    const tradeBox: Drawing =
      box && box.kind === "position"
        ? { ...box, ...(trade.closedAt ? { to: endS } : {}) }
        : ({
            id: `box_${trade.id}`,
            symbol: trade.symbol,
            kind: "position",
            side: trade.side,
            entry: trade.entry,
            stop: trade.initialStop,
            target: this.initialTarget(trade),
            from: Math.floor(start / 1000),
            ...(trade.closedAt ? { to: endS } : {}),
            createdBy: "user",
            createdAt: start,
            updatedAt: start,
          } as Drawing);
    return chartSvg({
      name: trade.name,
      symbol: trade.symbol,
      timeframe,
      ...(trade.digits !== undefined ? { digits: trade.digits } : {}),
      candles: r.candles,
      drawings: [...others, tradeBox],
      indicators: snap?.indicators ?? [],
      caption: snap ? `figé au ticket, ${shortMoment(snap.at)}` : `trade d'avant le journal, ${shortMoment(start)}`,
      hideLast: !(trade.state === "open" || trade.state === "pending"),
      trade: this.overlay(trade, end),
      // Le trade au milieu : un peu avant le ticket, sa durée, et ce qui suit sa sortie.
      bars: Math.min(CHART_BARS, Math.max(MIN_BARS, BEFORE_BARS + Math.ceil((until - start) / 1000 / tf))),
    });
  }

  /** L'objectif du ticket : le premier noté avant tout déplacement. */
  private initialTarget(trade: Trade): number {
    const first = this.trading.gestures(trade.id).find((g) => g.kind === "target");
    return first?.from ?? trade.targets[0] ?? trade.legs.find((l) => l.target !== undefined)?.target ?? trade.entry;
  }

  /** Ce que le graphique dessine du trade : le stop et l'objectif marche par marche, l'entrée, les sorties. */
  private overlay(trade: Trade, end: number): TradeOverlay {
    const s = (ms: number) => Math.floor(ms / 1000);
    const start = trade.openedAt ?? trade.createdAt;
    const gestures = this.trading.gestures(trade.id);
    const stops = [{ t: s(start), price: trade.initialStop }];
    const targets = [{ t: s(start), price: this.initialTarget(trade) }];
    for (const g of gestures) {
      if (g.to === undefined) continue;
      if (g.kind === "stop") stops.push({ t: s(g.at), price: g.to });
      if (g.kind === "target") targets.push({ t: s(g.at), price: g.to });
    }
    const fills = trade.legs.filter((l) => l.openPrice !== undefined && trade.openedAt).map((l) => ({ t: s(trade.openedAt!), price: l.openPrice! }));
    // Un trade d'avant le journal n'a pas ses sorties : son prix de fermeture, à sa fermeture.
    const exits = tradeExits(trade).length
      ? tradeExits(trade).map((e) => ({ t: s(e.at), price: e.price, gain: e.profit >= 0 }))
      : trade.closedAt
        ? trade.legs.filter((l) => l.closePrice !== undefined).map((l) => ({ t: s(trade.closedAt!), price: l.closePrice!, gain: (l.profit ?? 0) >= 0 }))
        : [];
    return { stops, targets, fills: dedupe(fills), exits, end: s(end) };
  }
}

/** Le fil d'une fiche, dans les mots du journal. */
function ficheItem(e: AnalysisEntry): JournalItem {
  const kind = e.kind === "view" ? "view" : e.kind === "why" ? "why" : e.kind === "challenge" ? "challenge" : "fiche";
  return { at: e.at, kind, by: e.by, text: e.text };
}

/** Les événements d'un trade qui vont au fil (les envois d'ordres techniques restent au journal de l'ordre). */
const TRADE_ITEM: Record<string, JournalItem["kind"] | undefined> = {
  ticket: "ticket",
  filled: "filled",
  gesture: "gesture",
  exit: "exit",
  closed: "closed",
  cancelled: "cancelled",
  rejected: "rejected",
  note: "note",
};

/** L'unité de temps du graphique figé : celle du ticket, ou plus grande si le trade ne tient pas dans le graphique. */
export function fitTimeframe(base: ChartTimeframe, spanMs: number): ChartTimeframe {
  const from = CHART_TIMEFRAMES.indexOf(base);
  for (let i = Math.max(0, from); i < CHART_TIMEFRAMES.length; i++) {
    const tf = CHART_TIMEFRAMES[i];
    if (spanMs / 1000 / TIMEFRAME_SECONDS[tf] <= TRADE_BARS) return tf;
  }
  return CHART_TIMEFRAMES.at(-1)!;
}

/** « 2026-11-06 » ou « 2026-11 » (le premier du mois) -> une date locale ; undefined si illisible. */
function parseDate(s: string): Date | undefined {
  const m = s.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1, 12);
  return d.getMonth() === Number(m[2]) - 1 ? d : undefined;
}

/** Le prix d'exécution moyen des jambes (pondéré par leur taille), s'il est connu. */
function averageFill(trade: Trade): number | undefined {
  const legs = trade.legs.filter((l) => l.openPrice !== undefined);
  const lots = legs.reduce((s, l) => s + l.lots, 0);
  return legs.length && lots ? legs.reduce((s, l) => s + l.openPrice! * l.lots, 0) / lots : undefined;
}

/** Depuis quand vaut l'idée de la fiche : la première lecture qui lui a donné ce sens et cette zone. */
function ideaSince(f: FicheAtTicket): number {
  const idea = f.view.idea;
  const same = f.entries.find(
    (e) => e.kind === "view" && e.view?.idea?.side === idea?.side && JSON.stringify(e.view?.idea?.zone ?? null) === JSON.stringify(idea?.zone ?? null),
  );
  return same?.at ?? f.createdAt;
}

function parseStored(data: string): JournalReview | undefined {
  try {
    const r = journalReviewSchema.safeParse(JSON.parse(data));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

function sumR(trades: Trade[]): number {
  return Math.round(trades.reduce((s, t) => s + (t.state === "closed" ? (t.r ?? 0) : 0), 0) * 100) / 100;
}

function dedupe<T extends { t: number; price: number }>(pts: T[]): T[] {
  return pts.filter((p, i) => pts.findIndex((q) => q.t === p.t && q.price === p.price) === i);
}

/** « ven. 6 nov., 09:12 ». */
function shortMoment(at: number): string {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
}

/** Sans accents ni casse ni espaces, pour reconnaître un produit dit. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}
