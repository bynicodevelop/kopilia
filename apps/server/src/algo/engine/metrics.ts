import type { BacktestMetrics, MetricsBreakdown } from "@kopilia/contracts";
import { SESSION_LABELS, WEEKDAY_LABELS, parisClock } from "./paris.js";
import type { TradeRecord } from "./types.js";

/*
 * Les mesures d'un jeu de trades, en R : espérance, pourcentage de gagnants,
 * facteur de profit, drawdown, pire série, régularité par trimestre ; et les
 * tranches (séance, jour, année, sens) qui disent où ça gagne et où ça perd.
 * Pur, sans arrondi : les textes arrondissent.
 */

const EMPTY: BacktestMetrics = {
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  avgR: 0,
  totalR: 0,
  maxDrawdownR: 0,
  longestLosingStreak: 0,
  avgBars: 0,
  positiveWindows: 0,
  windows: 0,
};

/** Le trimestre d'un instant (epoch s), « 2025-T3 ». */
export function quarterOf(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getUTCFullYear()}-T${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export function metrics(trades: readonly TradeRecord[]): BacktestMetrics {
  if (!trades.length) return { ...EMPTY };
  const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  let wins = 0;
  let losses = 0;
  let gains = 0;
  let pains = 0;
  let total = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  let bars = 0;
  const byQuarter = new Map<string, number>();
  for (const t of sorted) {
    total += t.r;
    bars += t.bars;
    if (t.r > 0) {
      wins++;
      gains += t.r;
      streak = 0;
    } else {
      if (t.r < 0) losses++;
      pains += -t.r;
      streak++;
      longest = Math.max(longest, streak);
    }
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, peak - total);
    const q = quarterOf(t.entryAt);
    byQuarter.set(q, (byQuarter.get(q) ?? 0) + t.r);
  }
  const positive = [...byQuarter.values()].filter((v) => v > 0).length;
  return {
    trades: sorted.length,
    wins,
    losses,
    winRate: wins / sorted.length,
    avgR: total / sorted.length,
    totalR: total,
    ...(pains > 0 ? { profitFactor: gains / pains } : {}),
    maxDrawdownR: -maxDd,
    longestLosingStreak: longest,
    avgBars: bars / sorted.length,
    positiveWindows: byQuarter.size ? positive / byQuarter.size : 0,
    windows: byQuarter.size,
  };
}

/** La courbe en R : un point par trade, dans l'ordre des sorties. */
export function equityCurve(trades: readonly TradeRecord[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const t of [...trades].sort((a, b) => a.exitAt - b.exitAt)) {
    acc += t.r;
    out.push(Math.round(acc * 100) / 100);
  }
  return out;
}

/** La courbe allégée à `max` points au plus (le dernier toujours gardé). */
export function thinCurve(curve: readonly number[], max = 120): number[] {
  if (curve.length <= max) return [...curve];
  const step = curve.length / max;
  const out: number[] = [];
  for (let k = 0; k < max - 1; k++) out.push(curve[Math.floor(k * step)]);
  out.push(curve[curve.length - 1]);
  return out;
}

function slice(trades: readonly TradeRecord[]): MetricsBreakdown[string] {
  const m = metrics(trades);
  return { trades: m.trades, winRate: m.winRate, avgR: m.avgR, totalR: m.totalR };
}

/** Les tranches : par séance d'entrée, jour de semaine, année, sens, raison de sortie. */
export function breakdown(trades: readonly TradeRecord[]): MetricsBreakdown {
  const groups = new Map<string, TradeRecord[]>();
  const add = (key: string, t: TradeRecord) => {
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  };
  for (const t of trades) {
    const c = parisClock(t.entryAt);
    add(`séance : ${SESSION_LABELS[c.session]}`, t);
    add(`jour : ${WEEKDAY_LABELS[c.weekday]}`, t);
    add(`année : ${c.date.slice(0, 4)}`, t);
    add(`sens : ${t.side === "long" ? "achat" : "vente"}`, t);
    add(`sortie : ${t.reason}`, t);
  }
  const out: MetricsBreakdown = {};
  for (const [key, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "fr"))) out[key] = slice(list);
  return out;
}
