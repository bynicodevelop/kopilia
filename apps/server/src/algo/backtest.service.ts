import { Injectable } from "@nestjs/common";
import { type BacktestSummary, type BacktestTrade, judge } from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { MarketService, type Product } from "../market/market.service.js";
import { type ChartTimeframe, TIMEFRAME_SECONDS, isChartTimeframe } from "../market/timeframes.js";
import { BROKER_SOURCE, CandleStore, type Coverage } from "./candle-store.js";
import { DEFAULT_DEPTH_DAYS, type LoadReport } from "./candle-loader.js";
import { CandleLoaderService } from "./candle-loader.service.js";
import { breakdown, equityCurve, metrics, thinCurve } from "./engine/metrics.js";
import { splitPeriod, splitTrades } from "./engine/split.js";
import type { Costs, RunInput, TradeRecord } from "./engine/types.js";
import { compileRobot, runRobot } from "./sandbox.js";
import { RobotError, RobotService } from "./robot.service.js";

/*
 * Un backtest de bout en bout : les produits résolus chez le courtier, les
 * bougies garanties dans la réserve, les coûts du courtier, le code compilé et
 * joué dans le bac à sable, les trades coupés en apprentissage, vérification et
 * réservé, les mesures, le verdict du code, le tout enregistré dans la fiche du
 * robot. L'agent ne reçoit en détail que l'apprentissage ; le reste, en
 * chiffres. Un seul backtest à la fois (le worker prend un cœur), et un budget
 * d'essais par recherche.
 */

/** Essais au plus par recherche (un travail de l'agent). */
export const MAX_TRIALS_PER_JOB = 30;
/** Bougies au moins pour qu'un backtest ait un sens. */
const MIN_BARS = 200;
/** Délai d'un run dans le bac à sable. */
const RUN_TIMEOUT_MS = 120_000;
/** Produits au plus par backtest. */
const MAX_PRODUCTS = 6;
/** L'écart achat-vente relu chez le courtier est gardé ce temps-là. */
const SPREAD_TTL_MS = 10 * 60_000;

export interface RunRequest {
  robotId: string;
  version?: number;
  /** Noms courants ou symboles ; défaut : les produits du robot. */
  products?: string[];
  timeframe?: string;
  /** Unités de contexte à charger (« 1h », « 4h », « 1d »). */
  contexts?: string[];
  /** Charger la minute pour départager stop et objectif dans une même bougie (lourd). */
  minute?: boolean;
  depthDays?: number;
  params?: Record<string, unknown>;
  /** Coûts imposés (un test de résistance), sinon ceux du courtier. */
  costs?: Partial<Costs>;
  note?: string;
  jobId?: string;
}

export interface RunResult {
  summary: BacktestSummary;
  /** Les notes du robot (ctx.log), les premières. */
  logs: string[];
  warnings: string[];
  /** Les produits joués, avec leur couverture. */
  coverage: Array<{ symbol: string; name: string; bars: number; from: number; to: number }>;
}

@Injectable()
export class BacktestService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly spreads = new Map<string, { at: number; value: number }>();
  private readonly compiled = new Map<string, string>();
  now: () => number = () => Date.now();

  constructor(
    private readonly market: MarketService,
    private readonly store: CandleStore,
    private readonly loader: CandleLoaderService,
    private readonly robots: RobotService,
    private readonly logger: AppLogger,
  ) {}

  /** Lance un backtest ; les demandes se succèdent. */
  run(req: RunRequest): Promise<RunResult> {
    const job = this.queue.then(() => this.execute(req));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async execute(req: RunRequest): Promise<RunResult> {
    const robot = this.robots.summary(req.robotId);
    if (!robot) throw new RobotError(`robot ${req.robotId} inconnu`);
    if (req.jobId && this.robots.trialsOf(req.jobId) >= MAX_TRIALS_PER_JOB) {
      throw new RobotError(
        `budget d'essais épuisé (${MAX_TRIALS_PER_JOB} pour cette recherche) : conclus avec ce que tu as, note les leçons, et dis à l'utilisateur ce qu'il resterait à tester`,
      );
    }
    const tfRaw = req.timeframe ?? robot.timeframe ?? "15m";
    if (!isChartTimeframe(tfRaw)) throw new RobotError(`unité de temps inconnue : ${tfRaw}`);
    const timeframe: ChartTimeframe = tfRaw;
    if (timeframe === "1mn") throw new RobotError("pas de backtest en bougies mensuelles : trop peu de bougies");
    const contexts: ChartTimeframe[] = [];
    for (const c of req.contexts ?? []) {
      if (!isChartTimeframe(c)) throw new RobotError(`unité de contexte inconnue : ${c}`);
      if (TIMEFRAME_SECONDS[c] <= TIMEFRAME_SECONDS[timeframe]) throw new RobotError(`l'unité de contexte ${c} doit être plus grande que ${timeframe}`);
      contexts.push(c);
    }
    const version = this.robots.version(req.robotId, req.version);
    const js = await this.compile(req.robotId, version.version, version.code);
    const queries = (req.products?.length ? req.products : robot.products).slice(0, MAX_PRODUCTS);
    if (!queries.length) throw new RobotError("aucun produit : dis sur quels produits jouer le robot");
    const warnings: string[] = [];
    const products: Product[] = [];
    for (const q of queries) {
      const r = await this.market.resolve(q);
      if ("error" in r) warnings.push(r.error);
      else if (!products.some((p) => p.symbol === r.symbol)) products.push(r);
    }
    if (!products.length) throw new RobotError(`aucun produit reconnu : ${warnings.join(" ; ")}`);
    const depthDays = Math.max(30, Math.min(3650, Math.floor(req.depthDays ?? DEFAULT_DEPTH_DAYS)));
    const inputs: RunInput[] = [];
    const coverage: RunResult["coverage"] = [];
    const seconds: Record<string, number> = { [timeframe]: TIMEFRAME_SECONDS[timeframe], "1m": 60 };
    for (const c of contexts) seconds[c] = TIMEFRAME_SECONDS[c];
    const from = Math.floor(this.now() / 1000) - depthDays * 86_400;
    for (const p of products) {
      const report = await this.loader.ensure(p.symbol, timeframe, { depthDays });
      if (report.error) warnings.push(`${p.name} : chargement interrompu (${report.error})`);
      const bars = this.store.range(BROKER_SOURCE, p.symbol, timeframe, from);
      if (bars.length < MIN_BARS) {
        warnings.push(`${p.name} : seulement ${bars.length} bougies en ${timeframe}, pas de backtest`);
        continue;
      }
      const context: Record<string, RunInput["bars"]> = {};
      for (const c of contexts) {
        const r = await this.loader.ensure(p.symbol, c, { depthDays });
        if (r.error) warnings.push(`${p.name} ${c} : ${r.error}`);
        // Le contexte commence avant pour que ses indicateurs soient stabilisés.
        context[c] = this.store.range(BROKER_SOURCE, p.symbol, c, from - 400 * TIMEFRAME_SECONDS[c]);
      }
      let minute: RunInput["bars"] | undefined;
      if (req.minute) {
        const r: LoadReport = await this.loader.ensure(p.symbol, "1m", { depthDays });
        if (r.error) warnings.push(`${p.name} minute : ${r.error}`);
        minute = this.store.range(BROKER_SOURCE, p.symbol, "1m", from);
        if (!minute.length) {
          warnings.push(`${p.name} : pas de bougies d'une minute, le stop l'emporte quand stop et objectif sont touchés dans la même bougie`);
          minute = undefined;
        }
      }
      const costs = await this.costsFor(p, req.costs, warnings);
      inputs.push({
        symbol: p.symbol,
        timeframe,
        bars,
        ...(Object.keys(context).length ? { context } : {}),
        ...(minute ? { minute } : {}),
        costs,
        params: req.params,
        seconds,
      });
      coverage.push({ symbol: p.symbol, name: p.name, bars: bars.length, from: bars[0].t, to: bars[bars.length - 1].t });
    }
    if (!inputs.length) throw new RobotError(`aucun produit avec assez de bougies : ${warnings.join(" ; ")}`);
    const outputs = await runRobot(js, inputs, { timeoutMs: RUN_TIMEOUT_MS });
    const trades: TradeRecord[] = [];
    const logs: string[] = [];
    for (const o of outputs) {
      if (o.error) warnings.push(`${o.symbol} : le robot s'est arrêté : ${o.error}`);
      trades.push(...o.trades);
      logs.push(...o.logs.slice(0, 40).map((l) => `${o.symbol} : ${l}`));
    }
    if (outputs.every((o) => o.error) && outputs.length) {
      throw new RobotError(`le robot a planté sur tous les produits : ${outputs.map((o) => o.error).join(" ; ")}`);
    }
    const start = Math.min(...coverage.map((c) => c.from));
    const end = Math.max(...coverage.map((c) => c.to));
    const split = splitPeriod(start, end);
    const parts = splitTrades(trades, split);
    const inSample = metrics(parts.inSample);
    const outOfSample = metrics(parts.outOfSample);
    const reserved = metrics(parts.reserved);
    const { verdict, reasons } = judge({ inSample, outOfSample, reserved });
    const costs = inputs[0].costs;
    const summary = this.robots.recordBacktest(
      req.robotId,
      {
        version: version.version,
        products: inputs.map((i) => i.symbol),
        timeframe,
        from: start,
        to: end,
        source: BROKER_SOURCE,
        ...(req.params && Object.keys(req.params).length ? { params: req.params } : {}),
        inEnd: Math.floor(split.inEnd),
        outEnd: Math.floor(split.outEnd),
        costs,
        ...(contexts.length ? { contexts } : {}),
        minute: inputs.some((i) => i.minute),
        inSample,
        outOfSample,
        reserved,
        breakdown: breakdown(parts.inSample),
        verdict,
        verdictReasons: reasons,
        equity: thinCurve(equityCurve(parts.inSample)),
        ...(req.note ? { note: req.note } : {}),
      },
      trades.map(toTrade),
      req.jobId,
    );
    this.logger.log(`backtest ${summary.id} (${robot.name}, essai ${summary.trial}) : ${inSample.trades} trades, ${verdict}`, "algo");
    return { summary, logs, warnings, coverage };
  }

  private async compile(robotId: string, version: number, code: string): Promise<string> {
    const key = `${robotId}@${version}`;
    const known = this.compiled.get(key);
    if (known) return known;
    const r = await compileRobot(code);
    if ("error" in r) throw new RobotError(`le code ne compile pas : ${r.error}`);
    if (this.compiled.size > 50) this.compiled.clear();
    this.compiled.set(key, r.js);
    return r.js;
  }

  /** Les coûts d'un produit : l'écart du moment chez le courtier (gardé dix minutes), commission et glissement nuls sauf demande. */
  private async costsFor(p: Product, override: Partial<Costs> | undefined, warnings: string[]): Promise<Costs> {
    let spread = override?.spread;
    if (spread === undefined) {
      const known = this.spreads.get(p.symbol);
      if (known && this.now() - known.at < SPREAD_TTL_MS) spread = known.value;
      else {
        try {
          const t = await this.market.brokerTerms(p.symbol);
          // Arrondi aux décimales du produit : l'écart du courtier est un nombre de ticks, pas un flottant bruité.
          const scale = 10 ** (p.digits ?? 5);
          spread = Math.round(Math.max(0, t.ask - t.bid) * scale) / scale;
          this.spreads.set(p.symbol, { at: this.now(), value: spread });
        } catch (e) {
          warnings.push(`${p.name} : écart du courtier indisponible (${(e as Error).message}), compté à 0`);
          spread = 0;
        }
      }
    }
    return { spread, commission: override?.commission ?? 0, slippage: override?.slippage ?? 0 };
  }

  /** Vérifie que le code compile, sans rien jouer : pour l'enregistrement d'une version. */
  async check(code: string): Promise<string | undefined> {
    const r = await compileRobot(code);
    return "error" in r ? r.error : undefined;
  }

  /** La couverture de la réserve, lisible : par produit et unité. */
  coverages(): Coverage[] {
    return this.store.coverages(BROKER_SOURCE);
  }

  /** Charge (ou complète) la réserve d'un produit dans une unité, en fond. */
  async load(query: string, timeframe: string, depthDays?: number): Promise<{ product: Product; report: LoadReport }> {
    if (!isChartTimeframe(timeframe) || timeframe === "1mn") throw new RobotError(`unité de temps inconnue ou inutile : ${timeframe}`);
    const r = await this.market.resolve(query);
    if ("error" in r) throw new RobotError(r.error);
    const report = await this.loader.ensure(r.symbol, timeframe, { depthDays });
    return { product: r, report };
  }

  isLoading(symbol: string, timeframe: string): boolean {
    return this.loader.isLoading(symbol, timeframe);
  }
}

function toTrade(t: TradeRecord): BacktestTrade {
  return {
    side: t.side,
    entryAt: t.entryAt,
    exitAt: t.exitAt,
    entry: t.entry,
    exit: t.exit,
    stop: t.stop,
    ...(t.target !== undefined ? { target: t.target } : {}),
    r: Math.round(t.r * 1000) / 1000,
    reason: t.reason,
    mae: Math.round(t.mae * 100) / 100,
    mfe: Math.round(t.mfe * 100) / 100,
    symbol: t.symbol,
  };
}
