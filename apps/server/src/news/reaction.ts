/*
 * La réaction du marché à une news : ce qu'a fait un produit dans les minutes
 * qui suivent, comparé à l'amplitude habituelle de ses bougies d'une minute
 * juste avant. Un mouvement de plusieurs fois cette amplitude, c'est que la
 * news a compté. Pur, testé à plat.
 */

/** Bougie d'une minute : instant en secondes (epoch), comme le graphique les reçoit. */
export interface MinuteCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** La fenêtre regardée après la news, en minutes (la minute de la news comprise en plus). */
export const REACTION_MINUTES = 2;
/** Bougies d'avant la news qui donnent l'amplitude habituelle. */
const BASELINE_CANDLES = 60;
const MIN_BASELINE_CANDLES = 20;
/** Un mouvement d'au moins ce multiple de l'amplitude habituelle est une réaction. */
export const REACTION_STRENGTH = 4;

export interface Reaction {
  /** Variation en %, du prix d'avant la news au plus loin atteint ensuite (signée). */
  changePct: number;
  /** Le mouvement en multiples de l'amplitude moyenne d'une minute avant la news. */
  strength: number;
}

/**
 * Le mouvement le plus grand, depuis l'ouverture de la minute de la news,
 * pendant cette minute et les `minutes` suivantes ; undefined s'il manque des
 * bougies (marché fermé, historique trop court).
 */
export function measureReaction(candles: MinuteCandle[], at: number, minutes = REACTION_MINUTES): Reaction | undefined {
  const start = Math.floor(at / 60_000) * 60;
  const end = start + (minutes + 1) * 60;
  const before = candles.filter((c) => c.t < start).slice(-BASELINE_CANDLES);
  const after = candles.filter((c) => c.t >= start && c.t < end);
  if (before.length < MIN_BASELINE_CANDLES || !after.length) return undefined;
  const range = before.reduce((s, c) => s + (c.h - c.l), 0) / before.length;
  const ref = after[0].o;
  if (!(range > 0) || !(ref > 0)) return undefined;
  const up = Math.max(...after.map((c) => c.h)) - ref;
  const down = ref - Math.min(...after.map((c) => c.l));
  const move = up >= down ? up : -down;
  return { changePct: (move / ref) * 100, strength: Math.abs(move) / range };
}

/** Le mouvement est assez net pour dire que le marché a réagi. */
export function reacted(r: Reaction | undefined): r is Reaction {
  return !!r && r.strength >= REACTION_STRENGTH && Math.abs(r.changePct) >= 0.03;
}
