import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Injectable } from "@nestjs/common";
import { AutoMap, AutoTrendline, AutoZone, Drawing, SAME_LEVEL_ATR, autoMap } from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { DatabaseService } from "../db/database.service.js";
import { DrawingService, describeDrawing, shortMoment } from "../dashboard/drawing.service.js";
import { AlertService } from "../alerts/alert.service.js";
import { describeAlert } from "../alerts/alert-texts.js";
import { MarketService, Product } from "../market/market.service.js";
import { ChartTimeframe, TIMEFRAME_SECONDS, isChartTimeframe } from "../market/timeframes.js";
import { SetupError } from "./scenario.service.js";
import { sameLevelIn } from "./overlap.js";

/** Bougies lues pour la carte : assez pour des zones de plusieurs semaines en 1 heure. */
const MAP_BARS = 300;
/** Une carte calculée sert ce temps-là (les bougies ne changent qu'à la clôture). */
const CACHE_MS = 60_000;
/** Une correction ne déplace pas une zone de plus d'un ATR, ni ne l'épaissit au-delà de deux ATR (ou du double de sa largeur). */
const MAX_SHIFT_ATR = 1;
const MAX_WIDTH_ATR = 2;
/** Cartes calculées en même temps lors d'un tour d'horizon (le reste du serveur interroge aussi le courtier). */
const SCAN_PARALLEL = 3;
/** Les corrections plus anciennes ne s'appliquent plus (la carte a changé). */
const ADJUSTMENT_LIFE_MS = 14 * 86_400_000;

interface AdjustmentRow {
  id: string;
  symbol: string;
  timeframe: string;
  key: string;
  action: "adjust" | "remove";
  top: number | null;
  bottom: number | null;
  reason: string;
  job_id: string | null;
  created_at: number;
}

/** Une zone de la carte, corrigée s'il le faut : `corrected` dit pourquoi, et `auto` garde l'estimation de l'algorithme. */
export interface MapZone extends AutoZone {
  corrected?: string;
  auto?: { top: number; bottom: number };
}

/** La carte automatique d'un produit dans une unité de temps, avec les corrections de l'IA. */
export interface CorrectedMap {
  symbol: string;
  timeframe: string;
  atr: number | null;
  /** Dernière clôture. */
  price?: number;
  zones: MapZone[];
  trendlines: AutoTrendline[];
  divergences: AutoMap["divergences"];
  /** Ce que l'IA a écarté, et pourquoi. */
  removed: Array<{ key: string; reason: string }>;
  /**
   * Ce qui s'efface derrière un tracé (de l'utilisateur, ou un niveau de
   * l'IA) au même endroit : ce que l'algorithme en dit se rattache au tracé.
   */
  absorbed: Array<{ key: string; drawingId: string; touches: number; last: number }>;
}

/**
 * La carte technique automatique (zones, obliques, divergences RSI) calculée
 * sur les bougies du courtier, et les corrections de l'IA : une zone ajustée
 * (pour reprendre les mèches que l'algorithme coupe) ou un élément écarté,
 * chacun avec sa raison. Une correction est bornée : elle ne remplace pas
 * l'algorithme, elle le rectifie. Les tracés passent avant : un élément de la
 * carte au même endroit qu'un tracé s'efface derrière lui.
 */
@Injectable()
export class MapService {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();
  /** Pause avant de redemander une carte refusée pendant un tour d'horizon ; réduite en test. */
  scanRetryMs = 2_000;
  private readonly cache = new Map<string, Computed>();

  constructor(
    private readonly db: DatabaseService,
    private readonly market: MarketService,
    private readonly drawings: DrawingService,
    private readonly alerts: AlertService,
    private readonly logger: AppLogger,
  ) {}

  /** La carte de ce symbole exact, corrigée. */
  async view(symbol: string, timeframe: string): Promise<CorrectedMap | { error: string }> {
    if (!isChartTimeframe(timeframe)) return { error: `unité de temps inconnue (« ${timeframe} »)` };
    const raw = await this.compute(symbol, timeframe);
    if ("error" in raw) return raw;
    const adjustments = this.adjustments(symbol, timeframe);
    const removed: CorrectedMap["removed"] = [];
    const zones: MapZone[] = [];
    for (const z of raw.map.zones) {
      const a = adjustments.get(z.key);
      if (a?.action === "remove") removed.push({ key: z.key, reason: a.reason });
      else if (a && a.top !== null && a.bottom !== null)
        zones.push({ ...z, top: a.top, bottom: a.bottom, corrected: a.reason, auto: { top: z.top, bottom: z.bottom } });
      else zones.push(z);
    }
    const kept = raw.map.trendlines.filter((t) => {
      const a = adjustments.get(t.key);
      if (a?.action === "remove") removed.push({ key: t.key, reason: a.reason });
      return a?.action !== "remove";
    });
    // Les tracés passent avant : ce qui est au même endroit s'efface derrière eux.
    const absorbed: CorrectedMap["absorbed"] = [];
    const atr = raw.map.atr;
    const drawings = this.drawings.list([symbol]);
    const ctx = { tol: SAME_LEVEL_ATR * atr, times: raw.times, tf: TIMEFRAME_SECONDS[timeframe], nowS: this.now() / 1000 };
    const covered = (key: string, touches: number, last: number, d: Drawing | undefined) => {
      if (d) absorbed.push({ key, drawingId: d.id, touches, last });
      return d !== undefined;
    };
    const free = Number.isFinite(atr) && drawings.length > 0;
    return {
      symbol,
      timeframe,
      atr: Number.isFinite(atr) ? atr : null,
      ...(raw.price !== undefined ? { price: raw.price } : {}),
      zones: free ? zones.filter((z) => !covered(z.key, z.touches, z.last, sameLevelIn({ band: { lo: z.bottom, hi: z.top } }, drawings, ctx))) : zones,
      trendlines: free ? kept.filter((t) => !covered(t.key, t.touches, t.last, sameLevelIn({ line: { a: t.a, b: t.b } }, drawings, ctx))) : kept,
      divergences: raw.map.divergences,
      removed,
      absorbed,
    };
  }

  /** L'ATR, la dernière clôture et les instants des bougies d'un symbole dans une unité : de quoi comparer des niveaux. */
  async context(symbol: string, timeframe: ChartTimeframe): Promise<{ atr: number; price?: number; times: number[] } | { error: string }> {
    const raw = await this.compute(symbol, timeframe);
    if ("error" in raw) return raw;
    if (!Number.isFinite(raw.map.atr)) return { error: "pas assez de bougies pour mesurer l'ATR" };
    return { atr: raw.map.atr, ...(raw.price !== undefined ? { price: raw.price } : {}), times: raw.times };
  }

  /**
   * La carte d'un produit pour un agent ou le dialogue : ses tracés à lui
   * d'abord (avec ce que l'algorithme en dit quand il a trouvé le même
   * niveau), les niveaux de travail de l'IA, puis la carte automatique
   * corrigée et les alertes de l'IA, en mots et en prix arrondis à ses
   * décimales.
   */
  async levels(product: Product, timeframe: string) {
    const map = await this.view(product.symbol, timeframe);
    const p = (v: number) => round(v, product.digits);
    const all = this.drawings.list([product.symbol]);
    const user = all.filter((d) => d.createdBy !== "ia");
    const levels = all.filter((d) => d.createdBy === "ia");
    const ai = this.alerts.list([product.symbol]).filter((a) => a.scenarioId && (a.state === "active" || a.state === "paused"));
    const algo = (id: string) => {
      const hits = "error" in map ? [] : map.absorbed.filter((x) => x.drawingId === id);
      if (!hits.length) return {};
      const touches = Math.max(...hits.map((x) => x.touches));
      const last = Math.max(...hits.map((x) => x.last));
      return { algorithm: `l'algorithme trouve le même niveau en ${timeframe} : ${touches} contacts, le dernier ${shortMoment(last)}` };
    };
    return {
      product: product.name,
      symbol: product.symbol,
      timeframe,
      userDrawings: user.length
        ? user.map((d) => ({
            drawingId: d.id,
            kind: d.kind,
            description: describeDrawing(d, product.digits),
            by: d.createdBy === "user" ? "utilisateur" : "Kopilia",
            ...algo(d.id),
          }))
        : "aucun tracé de l'utilisateur sur ce produit",
      ...(levels.length
        ? {
            aiLevels: levels.map((d) => ({
              drawingId: d.id,
              kind: d.kind,
              description: describeDrawing(d, product.digits),
              scenario: d.scenarioId,
              reason: d.reason,
            })),
          }
        : {}),
      ...("error" in map
        ? { autoMap: { error: map.error } }
        : {
            autoMap: {
              atr: map.atr === null ? null : p(map.atr),
              lastClose: map.price === undefined ? undefined : p(map.price),
              zones: map.zones.map((z) => ({
                key: z.key,
                bottom: p(z.bottom),
                top: p(z.top),
                wickBottom: p(z.wickBottom),
                wickTop: p(z.wickTop),
                role: z.role,
                touches: z.touches,
                lastTouch: shortMoment(z.last),
                ...(z.corrected ? { corrected: z.corrected, algorithm: { bottom: p(z.auto!.bottom), top: p(z.auto!.top) } } : {}),
              })),
              trendlines: map.trendlines.map((t) => ({
                key: t.key,
                kind: t.kind,
                priceNow: p(t.priceNow),
                touches: t.touches,
                from: { time: shortMoment(t.a.t), price: p(t.a.price) },
                to: { time: shortMoment(t.b.t), price: p(t.b.price) },
                slopePerBar: round(t.slope, (product.digits ?? 2) + 2),
              })),
              divergences: map.divergences.slice(0, 4).map((d) => ({
                kind: d.kind === "bullish" ? "haussière" : "baissière",
                from: { time: shortMoment(d.from.t), price: p(d.from.price), rsi: round(d.from.rsi, 1) },
                to: { time: shortMoment(d.to.t), price: p(d.to.price), rsi: round(d.to.rsi, 1) },
              })),
              ...(map.removed.length ? { removedByAi: map.removed } : {}),
            },
          }),
      ...(ai.length ? { aiAlerts: ai.map((a) => ({ alertId: a.id, scenario: a.scenarioId, description: describeAlert(a, this.alerts.lineOf(a)) })) } : {}),
      note: "Les tracés de l'utilisateur passent avant tout : la carte automatique (une estimation de l'algorithme, corrigée par l'IA quand c'est indiqué) s'efface là où il a tracé. aiLevels : les niveaux de travail des scénarios de l'IA.",
    };
  }

  /** Les cartes de plusieurs symboles, quelques-uns à la fois (le courtier limite les demandes de bougies). */
  async scan(symbols: string[], timeframe: string): Promise<Array<CorrectedMap | { error: string }>> {
    const out: Array<CorrectedMap | { error: string }> = new Array(symbols.length);
    let next = 0;
    const worker = async () => {
      while (next < symbols.length) {
        const i = next++;
        out[i] = await this.view(symbols[i], timeframe);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_PARALLEL, symbols.length) }, worker));
    // Un produit refusé (le courtier limite les demandes) est redemandé une fois, seul, après une pause.
    for (let i = 0; i < symbols.length; i++) {
      if (!("error" in out[i])) continue;
      await sleep(this.scanRetryMs);
      out[i] = await this.view(symbols[i], timeframe);
    }
    return out;
  }

  /**
   * Corrige un élément de la carte : ajuste les bornes d'une zone, ou écarte
   * une zone ou une oblique. L'élément doit exister sur la carte du moment ;
   * l'ajustement est borné autour de l'estimation (un ATR, deux ATR de large).
   */
  async adjust(
    symbol: string,
    timeframe: string,
    input: { key: string; action: string; top?: number; bottom?: number; reason: string },
    jobId?: string,
  ): Promise<MapZone | { key: string; removed: true }> {
    if (!isChartTimeframe(timeframe)) throw new SetupError(`unité de temps inconnue (« ${timeframe} »)`);
    const reason = input.reason?.trim();
    if (!reason) throw new SetupError("dis pourquoi tu corriges la carte (reason)");
    const raw = await this.compute(symbol, timeframe);
    if ("error" in raw) throw new SetupError(raw.error);
    const zone = raw.map.zones.find((z) => z.key === input.key);
    const line = raw.map.trendlines.find((t) => t.key === input.key);
    if (!zone && !line) throw new SetupError(`aucun élément « ${input.key} » sur la carte ${timeframe} du moment : relis-la (market_levels)`);
    if (input.action !== "adjust" && input.action !== "remove") throw new SetupError("action : adjust (bornes d'une zone) ou remove");
    let top: number | null = null;
    let bottom: number | null = null;
    if (input.action === "adjust") {
      if (!zone) throw new SetupError("seules les zones s'ajustent ; une oblique fausse s'écarte (remove)");
      const atr = raw.map.atr;
      top = input.top ?? zone.top;
      bottom = input.bottom ?? zone.bottom;
      if (!(Number.isFinite(top) && Number.isFinite(bottom) && top > bottom && bottom > 0))
        throw new SetupError("le haut de la zone au-dessus de son bas, deux prix positifs");
      if (Number.isFinite(atr)) {
        const shift = Math.max(Math.abs(top - zone.top), Math.abs(bottom - zone.bottom));
        if (shift > MAX_SHIFT_ATR * atr + 1e-9)
          throw new SetupError(`une correction déplace une borne d'un ATR au plus (${round(atr, 4)}) : au-delà, c'est une autre zone`);
        if (top - bottom > Math.max(MAX_WIDTH_ATR * atr, 2 * (zone.top - zone.bottom)) + 1e-9)
          throw new SetupError("une zone corrigée reste de deux ATR de large au plus");
      }
    }
    this.db.db
      .prepare(
        `INSERT INTO map_adjustments (id, symbol, timeframe, key, action, top, bottom, reason, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, timeframe, key) DO UPDATE SET action = excluded.action, top = excluded.top, bottom = excluded.bottom,
           reason = excluded.reason, job_id = excluded.job_id, created_at = excluded.created_at`,
      )
      .run(`ma_${randomBytes(4).toString("hex")}`, symbol, timeframe, input.key, input.action, top, bottom, reason, jobId ?? null, this.now());
    this.logger.log(`carte ${symbol} ${timeframe} : ${input.key} ${input.action} (${reason})`, "setups");
    if (input.action === "remove") return { key: input.key, removed: true };
    return { ...zone!, top: top!, bottom: bottom!, corrected: reason, auto: { top: zone!.top, bottom: zone!.bottom } };
  }

  private adjustments(symbol: string, timeframe: string): Map<string, AdjustmentRow> {
    const rows = this.db.db
      .prepare("SELECT * FROM map_adjustments WHERE symbol = ? AND timeframe = ? AND created_at >= ?")
      .all(symbol, timeframe, this.now() - ADJUSTMENT_LIFE_MS) as AdjustmentRow[];
    return new Map(rows.map((r) => [r.key, r]));
  }

  private async compute(symbol: string, timeframe: ChartTimeframe): Promise<Computed | { error: string }> {
    const key = `${symbol}|${timeframe}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit;
    const r = await this.market.chartCandles(symbol, timeframe, { limit: MAP_BARS });
    if ("error" in r) return { error: r.error ?? "bougies indisponibles" };
    const entry: Computed = { at: this.now(), map: autoMap(r.candles), price: r.candles.at(-1)?.c, times: r.candles.map((c) => c.t) };
    this.cache.set(key, entry);
    return entry;
  }
}

/** Une carte calculée, gardée une minute. */
interface Computed {
  at: number;
  map: AutoMap;
  price?: number;
  /** Instants des bougies (epoch s) : les positions des obliques. */
  times: number[];
}

function round(v: number, digits = 2): number {
  const f = 10 ** Math.min(8, Math.max(0, digits));
  return Math.round(v * f) / f;
}
