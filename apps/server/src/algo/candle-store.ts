import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../db/database.service.js";

/*
 * La réserve de bougies du laboratoire : les bougies closes gardées en base,
 * par source (« broker » : le courtier de l'utilisateur via MetaApi ; d'autres
 * plus tard), produit et unité de temps, pour que les backtests relisent la
 * base et non le compte MetaApi à chaque essai. La couverture (première et
 * dernière bougie, nombre, historique épuisé) est tenue à jour à chaque
 * insertion.
 */

/** La source par défaut : le compte du courtier de l'utilisateur, via MetaApi. */
export const BROKER_SOURCE = "broker";

export interface StoredCandle {
  /** Ouverture de la bougie, epoch secondes. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume de ticks, si la source le donne. */
  v?: number;
}

export interface Coverage {
  source: string;
  symbol: string;
  timeframe: string;
  first: number;
  last: number;
  count: number;
  /** Le passé est épuisé : le courtier n'a rien avant `first`. */
  complete: boolean;
  updatedAt: number;
}

interface CoverageRow {
  source: string;
  symbol: string;
  timeframe: string;
  first_t: number;
  last_t: number;
  count: number;
  complete: number;
  updated_at: number;
}

const toCoverage = (r: CoverageRow): Coverage => ({
  source: r.source,
  symbol: r.symbol,
  timeframe: r.timeframe,
  first: r.first_t,
  last: r.last_t,
  count: r.count,
  complete: r.complete === 1,
  updatedAt: r.updated_at,
});

@Injectable()
export class CandleStore {
  constructor(private readonly db: DatabaseService) {}

  /** Ajoute ou remplace des bougies, et met la couverture à jour ; renvoie le nombre écrit. */
  insert(source: string, symbol: string, timeframe: string, rows: readonly StoredCandle[], now = Date.now()): number {
    if (!rows.length) return 0;
    const ins = this.db.db.prepare("INSERT OR REPLACE INTO candles (source, symbol, timeframe, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const tx = this.db.db.transaction((list: readonly StoredCandle[]) => {
      for (const c of list) ins.run(source, symbol, timeframe, c.t, c.o, c.h, c.l, c.c, c.v ?? null);
      const agg = this.db.db
        .prepare("SELECT MIN(t) AS first_t, MAX(t) AS last_t, COUNT(*) AS count FROM candles WHERE source = ? AND symbol = ? AND timeframe = ?")
        .get(source, symbol, timeframe) as { first_t: number; last_t: number; count: number };
      this.db.db
        .prepare(
          `INSERT INTO candle_coverage (source, symbol, timeframe, first_t, last_t, count, complete, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(source, symbol, timeframe) DO UPDATE SET first_t = excluded.first_t, last_t = excluded.last_t, count = excluded.count, updated_at = excluded.updated_at`,
        )
        .run(source, symbol, timeframe, agg.first_t, agg.last_t, agg.count, now);
    });
    tx(rows);
    return rows.length;
  }

  /** Le passé est épuisé (ou ne l'est plus) pour ce produit et cette unité. */
  markComplete(source: string, symbol: string, timeframe: string, complete: boolean, now = Date.now()): void {
    this.db.db
      .prepare("UPDATE candle_coverage SET complete = ?, updated_at = ? WHERE source = ? AND symbol = ? AND timeframe = ?")
      .run(complete ? 1 : 0, now, source, symbol, timeframe);
  }

  /** Les bougies, les plus anciennes d'abord, entre `from` et `to` compris (epoch secondes). */
  range(source: string, symbol: string, timeframe: string, from?: number, to?: number): StoredCandle[] {
    const rows = this.db.db
      .prepare("SELECT t, o, h, l, c, v FROM candles WHERE source = ? AND symbol = ? AND timeframe = ? AND t >= ? AND t <= ? ORDER BY t")
      .all(source, symbol, timeframe, from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as Array<{
      t: number;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number | null;
    }>;
    return rows.map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, ...(r.v === null ? {} : { v: r.v }) }));
  }

  coverage(source: string, symbol: string, timeframe: string): Coverage | undefined {
    const row = this.db.db.prepare("SELECT * FROM candle_coverage WHERE source = ? AND symbol = ? AND timeframe = ?").get(source, symbol, timeframe) as
      CoverageRow | undefined;
    return row ? toCoverage(row) : undefined;
  }

  /** Toutes les couvertures d'une source (ou de toutes), par produit puis unité. */
  coverages(source?: string): Coverage[] {
    const rows = (
      source
        ? this.db.db.prepare("SELECT * FROM candle_coverage WHERE source = ? ORDER BY symbol, timeframe").all(source)
        : this.db.db.prepare("SELECT * FROM candle_coverage ORDER BY source, symbol, timeframe").all()
    ) as CoverageRow[];
    return rows.map(toCoverage);
  }
}
