import type { ChartCandle } from "../market/market.service.js";

/*
 * Les rejeux du journal, sur les bougies du courtier (les plus anciennes
 * d'abord, `tf` secondes) : le plan du ticket sans aucun geste, ce qu'a fait
 * le prix après la sortie, l'idée d'une fiche (sa zone atteinte, puis son
 * invalidation, ou jusqu'où le prix est allé). Prudents comme le suivi des
 * setups : quand une même bougie touche le stop et l'objectif, le stop compte.
 * Purs, testés à plat.
 */

export type Side = "long" | "short";

/** Ce qu'aurait donné un plan (entrée, stop, objectif) laissé tel quel depuis un instant. */
export interface PlanReplay {
  /** L'objectif ou le stop touché d'abord ; « open » : ni l'un ni l'autre à ce jour. */
  result: "target" | "stop" | "open";
  /** Quand (epoch ms). */
  at?: number;
  /** En multiples du risque : celui de l'objectif, −1 au stop, ou à la dernière clôture. */
  r: number;
  /** Le mieux atteint avant la fin, en R. */
  best: number;
  /** La même bougie touchait aussi l'autre niveau. */
  ambiguous?: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Les bougies qui finissent après cet instant (celle en cours à l'instant compte). */
function after(bars: readonly ChartCandle[], from: number, tf: number): ChartCandle[] {
  return bars.filter((c) => (c.t + tf) * 1000 > from);
}

/** Le plan du ticket rejoué depuis `from` (epoch ms) : l'objectif ou le stop, d'abord. */
export function replayPlan(
  p: { side: Side; entry: number; stop: number; target: number; from: number },
  bars: readonly ChartCandle[],
  tf: number,
): PlanReplay | undefined {
  const risk = Math.abs(p.entry - p.stop);
  if (!(risk > 0)) return undefined;
  const long = p.side === "long";
  const rOf = (price: number) => round2((long ? price - p.entry : p.entry - price) / risk);
  const rr = rOf(p.target);
  const seen = after(bars, p.from, tf);
  if (!seen.length) return undefined;
  let best = -Infinity;
  for (const c of seen) {
    const at = Math.max(c.t * 1000, p.from);
    const hitStop = long ? c.l <= p.stop : c.h >= p.stop;
    const hitTarget = long ? c.h >= p.target : c.l <= p.target;
    if (hitStop) return { result: "stop", at, r: -1, best: round2(Math.max(best, -1)), ...(hitTarget ? { ambiguous: true } : {}) };
    if (hitTarget) return { result: "target", at, r: rr, best: rr };
    best = Math.max(best, rOf(long ? c.h : c.l));
  }
  return { result: "open", r: rOf(seen.at(-1)!.c), best: round2(best) };
}

/** Ce que l'idée d'une fiche a donné sur les cours. */
export interface IdeaReplay {
  /** La zone touchée (epoch ms) et le prix d'entrée retenu (son bord : le haut pour un achat, le bas pour une vente). */
  touchedAt?: number;
  entry?: number;
  /** L'invalidation touchée après la zone (epoch ms). */
  invalidatedAt?: number;
  /** Le meilleur prix atteint après la zone (avant l'invalidation), et la dernière clôture. */
  bestPrice?: number;
  last?: number;
  /** En R, quand l'invalidation a un prix : au mieux, et à ce jour (−1 si invalidée). */
  bestR?: number;
  nowR?: number;
}

/**
 * L'idée d'une fiche rejouée depuis `from` : la zone est-elle atteinte (entrée
 * à son bord), puis l'invalidation (quand elle a un prix), et jusqu'où le prix
 * est-il allé dans le sens de l'idée.
 */
export function replayIdea(
  p: { side: "buy" | "sell"; low: number; high: number; invalidation?: number; from: number },
  bars: readonly ChartCandle[],
  tf: number,
): IdeaReplay {
  const buy = p.side === "buy";
  const low = Math.min(p.low, p.high);
  const high = Math.max(p.low, p.high);
  const out: IdeaReplay = {};
  const seen = after(bars, p.from, tf);
  if (seen.length) out.last = seen.at(-1)!.c;
  let best: number | undefined;
  for (const c of seen) {
    if (out.touchedAt === undefined) {
      if (!(c.l <= high && c.h >= low)) continue;
      out.touchedAt = Math.max(c.t * 1000, p.from);
      // Le bord de la zone, ou l'ouverture si le prix y saute par-dessus.
      out.entry = buy ? Math.min(high, c.o) : Math.max(low, c.o);
    }
    if (p.invalidation !== undefined && (buy ? c.l <= p.invalidation : c.h >= p.invalidation)) {
      out.invalidatedAt = Math.max(c.t * 1000, out.touchedAt);
      break;
    }
    const favorable = buy ? c.h : c.l;
    best = best === undefined ? favorable : buy ? Math.max(best, favorable) : Math.min(best, favorable);
  }
  if (out.entry === undefined) return out;
  if (best !== undefined) out.bestPrice = best;
  if (p.invalidation !== undefined) {
    const risk = Math.abs(out.entry - p.invalidation);
    if (risk > 0) {
      const rOf = (price: number) => round2((buy ? price - out.entry! : out.entry! - price) / risk);
      if (best !== undefined) out.bestR = rOf(best);
      out.nowR = out.invalidatedAt ? -1 : out.last !== undefined ? rOf(out.last) : undefined;
    }
  }
  return out;
}

/**
 * Le prix d'une invalidation dite avec des mots (« clôture 4 h sous 2 585 »,
 * « invalidé sous 26 520 ») : le nombre du texte le plus proche de la zone,
 * à moins de 10 % d'elle ; undefined s'il n'y en a pas.
 */
export function invalidationPrice(text: string | undefined, zone: { low: number; high: number }): number | undefined {
  if (!text) return undefined;
  const mid = (zone.low + zone.high) / 2;
  const numbers = [...text.matchAll(/\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)].map((m) =>
    Number(m[0].replace(/[ \u00a0\u202f]/g, "").replace(",", ".")),
  );
  const near = numbers.filter((n) => Number.isFinite(n) && n > 0 && Math.abs(n - mid) / mid <= 0.1);
  if (!near.length) return undefined;
  return near.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
}

/**
 * Les prix d'une zone dite avec des mots (« la zone des 88, 88,064 – 88,222, avec
 * la moyenne mobile 50 derrière ») : les nombres à décimales (ou à trois chiffres
 * et plus), groupés à moins de 3 % de leur médiane ; undefined sans prix.
 */
export function zoneFromText(text: string | undefined): { low: number; high: number } | undefined {
  if (!text) return undefined;
  const found = [...text.matchAll(/\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)].map((m) => m[0]);
  const values = found.map((n) => ({ v: Number(n.replace(/[ \u00a0\u202f]/g, "").replace(",", ".")), decimals: /[.,]/.test(n) }));
  const priced = values.filter((x) => Number.isFinite(x.v) && x.v > 0 && (x.decimals || x.v >= 100)).map((x) => x.v);
  if (!priced.length) return undefined;
  const sorted = [...priced].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const near = sorted.filter((v) => Math.abs(v - mid) / mid <= 0.03);
  return { low: near[0], high: near[near.length - 1] };
}

/** L'unité de temps d'un rejeu : la plus fine qui tient la période en 900 bougies au plus (5 minutes au moins). */
export function replayTimeframe(spanMs: number): "5m" | "15m" | "1h" | "4h" | "1d" {
  const choices = [
    ["5m", 300],
    ["15m", 900],
    ["1h", 3600],
    ["4h", 14_400],
  ] as const;
  for (const [tf, s] of choices) if (spanMs / 1000 / s <= 900) return tf;
  return "1d";
}
