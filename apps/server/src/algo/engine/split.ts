import { VERDICT_RULES } from "@kopilia/contracts";
import type { TradeRecord } from "./types.js";

/*
 * La coupe de l'historique : les derniers mois sont réservés (jamais montrés
 * en détail à l'agent qui cherche), le reste se partage entre apprentissage
 * (ce que l'agent voit) et vérification (chiffres seulement). Le robot joue
 * toute la série d'un trait, pour garder la continuité de ses indicateurs ;
 * ce sont ses trades qui sont rangés par leur instant d'entrée.
 */

export interface Split {
  /** Bornes (epoch s) : [from, inEnd) apprentissage, [inEnd, outEnd) vérification, [outEnd, to] réservé. */
  from: number;
  inEnd: number;
  outEnd: number;
  to: number;
}

const MONTH = 30.4375 * 86_400;

export function splitPeriod(from: number, to: number, rules = VERDICT_RULES): Split {
  const outEnd = Math.max(from, to - rules.reservedMonths * MONTH);
  const inEnd = from + (outEnd - from) * rules.inSampleRatio;
  return { from, inEnd, outEnd, to };
}

export interface SplitTrades {
  inSample: TradeRecord[];
  outOfSample: TradeRecord[];
  reserved: TradeRecord[];
}

export function splitTrades(trades: readonly TradeRecord[], split: Split): SplitTrades {
  const out: SplitTrades = { inSample: [], outOfSample: [], reserved: [] };
  for (const t of trades) {
    if (t.entryAt < split.inEnd) out.inSample.push(t);
    else if (t.entryAt < split.outEnd) out.outOfSample.push(t);
    else out.reserved.push(t);
  }
  return out;
}
