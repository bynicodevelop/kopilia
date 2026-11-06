import { Scenario, rewardRisk } from "@kopilia/contracts";
import type { ChartCandle } from "../market/market.service.js";

/*
 * Le suivi d'un setup proposé, sur les bougies qui ont suivi la proposition :
 * l'entrée est-elle atteinte, puis le stop ou le premier objectif ? Pur, testé
 * à plat. Prudent : quand une même bougie touche le stop et l'objectif, on ne
 * sait pas lequel est venu d'abord, et c'est le stop qui compte.
 */

export interface TrackedOutcome {
  /** Entrée atteinte (epoch ms). */
  enteredAt?: number;
  /** Stop ou objectif atteint après l'entrée. */
  result?: "target" | "stop";
  /** Quand (epoch ms). */
  at?: number;
  /** Multiple de risque : celui du premier objectif, ou −1 au stop. */
  r?: number;
}

/**
 * Ce que les bougies (`tf` secondes, les plus anciennes d'abord) disent d'un
 * setup proposé : celles qui commencent avant la proposition ne comptent pas,
 * l'entrée déjà constatée (`enteredAt`) n'est pas recherchée de nouveau.
 */
export function trackOutcome(
  s: Pick<Scenario, "direction" | "entry" | "stop" | "targets" | "proposedAt" | "outcome">,
  candles: readonly ChartCandle[],
  tf: number,
): TrackedOutcome {
  const { entry, stop } = s;
  const target = s.targets[0];
  if (entry === undefined || stop === undefined || target === undefined || !s.proposedAt) return {};
  let enteredAt = s.outcome?.enteredAt;
  const from = Math.floor(s.proposedAt / 1000 / tf) * tf;
  for (const c of candles) {
    if (c.t < from) continue;
    const at = c.t * 1000;
    if (enteredAt === undefined) {
      if (c.l <= entry && entry <= c.h) enteredAt = Math.max(at, s.proposedAt);
      else continue;
    } else if (at + tf * 1000 <= enteredAt) {
      continue;
    }
    const hitStop = s.direction === "long" ? c.l <= stop : c.h >= stop;
    const hitTarget = s.direction === "long" ? c.h >= target : c.l <= target;
    if (hitStop) return { enteredAt, result: "stop", at: Math.max(at, enteredAt), r: -1 };
    if (hitTarget) return { enteredAt, result: "target", at: Math.max(at, enteredAt), r: rewardRisk(s) };
  }
  return enteredAt !== undefined ? { enteredAt } : {};
}
