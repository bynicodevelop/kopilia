import type { ChartCandlesResult } from "../market/market.service.js";
import type { ChartTimeframe } from "../market/timeframes.js";
import { TIMEFRAME_SECONDS } from "../market/timeframes.js";
import type { AppLogger } from "../common/logger.js";
import { BROKER_SOURCE, CandleStore, Coverage, StoredCandle } from "./candle-store.js";

/*
 * Le chargeur de la réserve : il remplit les bougies d'un produit chez le
 * courtier (MetaApi, par paquets de 1 000 au plus, vers le passé), puis les
 * complète jusqu'à maintenant. Bridé : une demande à la fois pour tout le
 * laboratoire et une pause entre deux, car le compte est partagé avec le Kopilia
 * de l'utilisateur et ses graphiques. Une erreur arrête le chargement là où il
 * est : ce qui est écrit reste, et la couverture le dit.
 */

/** Deux ans par défaut : ce que couvre un premier backtest. */
export const DEFAULT_DEPTH_DAYS = 730;
/** Paquet MetaApi le plus grand. */
const PAGE = 1000;
/** Garde-fou : jamais plus de requêtes que cela pour une seule demande. */
const MAX_REQUESTS = 2000;

/** Ce que le chargeur demande au marché : les bougies jusqu'à `before` (epoch s), les plus anciennes d'abord. */
export type CandleSource = (symbol: string, timeframe: ChartTimeframe, opts: { before?: number; limit: number }) => Promise<ChartCandlesResult>;

export interface LoadReport {
  coverage?: Coverage;
  /** Bougies écrites par cette demande, et requêtes faites. */
  loaded: number;
  requests: number;
  error?: string;
}

export class CandleLoader {
  /** La file : une demande de chargement à la fois. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly loading = new Set<string>();
  now: () => number = () => Date.now();

  constructor(
    private readonly source: CandleSource,
    private readonly store: CandleStore,
    private readonly logger?: AppLogger,
    private readonly pauseMs = 250,
  ) {}

  /** Un chargement est en cours pour ce produit et cette unité. */
  isLoading(symbol: string, timeframe: string): boolean {
    return this.loading.has(`${symbol}|${timeframe}`);
  }

  /**
   * Garantit `depthDays` de bougies closes jusqu'à maintenant : complète vers
   * le présent, puis creuse le passé jusqu'à la profondeur voulue ou jusqu'à
   * ce que le courtier n'ait plus rien. Les demandes se succèdent, jamais en parallèle.
   */
  ensure(symbol: string, timeframe: ChartTimeframe, opts: { depthDays?: number } = {}): Promise<LoadReport> {
    const key = `${symbol}|${timeframe}`;
    const run = this.queue.then(async () => {
      this.loading.add(key);
      try {
        return await this.load(symbol, timeframe, opts.depthDays ?? DEFAULT_DEPTH_DAYS);
      } finally {
        this.loading.delete(key);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(symbol: string, timeframe: ChartTimeframe, depthDays: number): Promise<LoadReport> {
    const tf = TIMEFRAME_SECONDS[timeframe];
    const nowSec = Math.floor(this.now() / 1000);
    // La bougie en cours n'est pas close : on s'arrête à la précédente.
    const lastClosed = Math.floor(nowSec / tf) * tf - tf;
    const target = nowSec - depthDays * 86_400;
    let loaded = 0;
    let requests = 0;
    const page = async (before: number): Promise<StoredCandle[] | string> => {
      if (requests > 0) await sleep(this.pauseMs);
      requests++;
      const r = await this.source(symbol, timeframe, { before, limit: PAGE });
      if ("error" in r) return r.error ?? "bougies indisponibles";
      return r.candles.filter((c) => c.t <= lastClosed).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
    };
    let coverage = this.store.coverage(BROKER_SOURCE, symbol, timeframe);
    try {
      // 1. Vers le présent : de la dernière bougie connue jusqu'à la dernière close.
      if (coverage && coverage.last < lastClosed) {
        let before = lastClosed + tf - 1;
        while (requests < MAX_REQUESTS) {
          const rows = await page(before);
          if (typeof rows === "string") return { coverage, loaded, requests, error: rows };
          const fresh = rows.filter((c) => c.t > coverage!.last);
          loaded += this.store.insert(BROKER_SOURCE, symbol, timeframe, fresh, this.now());
          if (!rows.length || fresh.length < rows.length || rows.length < PAGE) break;
          before = rows[0].t - 1;
        }
        coverage = this.store.coverage(BROKER_SOURCE, symbol, timeframe);
      }
      // 2. Vers le passé : de la première bougie connue (ou de maintenant) jusqu'à la profondeur voulue.
      let before = coverage ? coverage.first - 1 : lastClosed + tf - 1;
      while (!coverage?.complete && (!coverage || coverage.first > target) && requests < MAX_REQUESTS) {
        const rows = await page(before);
        if (typeof rows === "string") return { coverage, loaded, requests, error: rows };
        loaded += this.store.insert(BROKER_SOURCE, symbol, timeframe, rows, this.now());
        coverage = this.store.coverage(BROKER_SOURCE, symbol, timeframe);
        if (rows.length < PAGE) {
          // Un paquet court : le courtier n'a rien avant.
          if (coverage) this.store.markComplete(BROKER_SOURCE, symbol, timeframe, true, this.now());
          coverage = this.store.coverage(BROKER_SOURCE, symbol, timeframe);
          break;
        }
        before = rows[0].t - 1;
      }
      this.logger?.log(
        `${symbol} ${timeframe} : ${loaded} bougies écrites en ${requests} requête(s)${coverage ? `, couverture ${coverage.count} bougies` : ""}`,
        "algo",
      );
      return { coverage, loaded, requests };
    } catch (e) {
      return { coverage, loaded, requests, error: (e as Error).message };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
