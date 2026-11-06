import type { AlertCondition } from "@kopilia/contracts";

/*
 * Le franchissement d'un niveau ou l'entrée dans une zone, sans état ni
 * horloge : de quel côté est le prix, ce qu'un nouveau prix franchit en
 * partant de ce côté, la bougie qui contient un instant. Toucher le niveau (le
 * bord de la zone) compte : c'est ce qu'on attend d'une alerte sur une ligne.
 */

/** Le prix est au-dessus du niveau (1), au-dessous (-1), ou dessus (0) : dans la zone, pour une zone. */
export type Side = 1 | -1 | 0;
export type Direction = "up" | "down";

/** Ce que surveille une alerte à un instant : un niveau (bas et haut égaux) ou une zone. */
export interface Band {
  lo: number;
  hi: number;
}

export function bandSide(price: number, b: Band): Side {
  return price > b.hi ? 1 : price < b.lo ? -1 : 0;
}

/**
 * Ce que franchit `price` en partant du côté `side` : la hausse depuis le
 * dessous (il atteint le bas de la zone), la baisse depuis le dessus (il
 * atteint son haut). Depuis le niveau même ou l'intérieur de la zone (0), ou
 * un côté pas encore connu (null), rien : il faut d'abord en sortir.
 */
export function bandCrossing(side: Side | null, price: number, b: Band): Direction | undefined {
  if (side === -1 && price >= b.lo) return "up";
  if (side === 1 && price <= b.hi) return "down";
  return undefined;
}

export function sideOf(price: number, level: number): Side {
  return bandSide(price, { lo: level, hi: level });
}

export function crossing(side: Side | null, price: number, level: number): Direction | undefined {
  return bandCrossing(side, price, { lo: level, hi: level });
}

/** L'alerte attend-elle ce sens ? */
export function wants(condition: AlertCondition, dir: Direction): boolean {
  return condition === "cross" || condition === dir;
}

/**
 * Le début (epoch s) de la bougie d'unité `tf` secondes qui contient `t`,
 * d'après les débuts connus `times` (triés), comme le courtier les aligne ; au
 * pas de `tf` au-delà de la dernière (ou sans bougie connue).
 */
export function barStart(times: readonly number[], t: number, tf: number): number {
  const n = times.length;
  if (!n) return Math.floor(t / tf) * tf;
  if (t >= times[n - 1]) return times[n - 1] + Math.floor((t - times[n - 1]) / tf) * tf;
  if (t < times[0]) return times[0] - Math.ceil((times[0] - t) / tf) * tf;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return times[lo];
}
