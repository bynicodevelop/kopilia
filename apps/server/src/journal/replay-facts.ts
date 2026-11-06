import { exitLabel, tradeExits, type AnalysisView, type JournalFact, type Trade } from "@kopilia/contracts";
import { frenchPrice } from "../market/metaapi.js";
import { relativeMoment } from "../analyses/analysis-texts.js";
import { rLabel } from "../trading/trading-texts.js";
import { ideaWords } from "./journal-facts.js";
import { zoneFromText, type IdeaReplay, type PlanReplay } from "./replay.js";

/*
 * Ce que les rejeux disent d'un trade, en phrases : le plan du ticket laissé
 * tel quel contre ce qu'il a géré, ce qu'a fait le prix après sa sortie, et
 * l'idée qu'il a abandonnée. Des faits, sans conseil. Pur, testé à plat.
 */

/** Le trade a été géré (un geste, ou une sortie qui n'est ni l'objectif ni le stop du ticket). */
export function wasManaged(trade: Trade, gestures: number): boolean {
  const last = tradeExits(trade).at(-1);
  return gestures > 0 || (last !== undefined && last.reason !== "target" && last.reason !== "stop") || Math.abs(trade.stop - trade.initialStop) > 1e-9;
}

/** Prévu au ticket contre géré : le même trade, rejoué sans rien toucher. */
export function planFact(trade: Trade, plan: PlanReplay, o: { target: number; now: number }): JournalFact {
  const p = (v: number) => frenchPrice(v, trade.digits);
  const head = `Prévu au ticket (stop ${p(trade.initialStop)}, objectif ${p(o.target)}, rien de touché)`;
  if (plan.result === "open" || trade.state !== "closed" || trade.r === undefined) {
    const where =
      plan.result === "target"
        ? `objectif touché ${relativeMoment(plan.at!, o.now)}, ${rLabel(plan.r)}`
        : plan.result === "stop"
          ? `stop touché ${relativeMoment(plan.at!, o.now)}, −1 R`
          : `ni l'objectif ni le stop à ce jour (${rLabel(plan.r)} à la dernière clôture)`;
    return { key: "plan", tone: "info", text: `${head} : ${where}.` };
  }
  const diff = Math.round((trade.r - plan.r) * 100) / 100;
  const what =
    plan.result === "target" ? `objectif touché ${relativeMoment(plan.at!, o.now)}, ${rLabel(plan.r)}` : `stop touché ${relativeMoment(plan.at!, o.now)}, −1 R`;
  const gap = Math.abs(diff) < 0.05 ? "autant que le plan" : `${rLabel(diff)} par rapport au plan`;
  return {
    key: "plan",
    tone: diff <= -0.1 ? "warn" : diff >= 0.1 ? "ok" : "info",
    text: `${head} : ${what}${plan.ambiguous ? " (stop et objectif dans la même bougie : le stop compte)" : ""}. Géré : ${rLabel(trade.r)}, ${gap}.`,
  };
}

/** Après sa sortie : l'objectif ou le stop du ticket touché ensuite, ou ni l'un ni l'autre. */
export function afterFact(trade: Trade, after: PlanReplay, o: { target: number; now: number }): JournalFact | undefined {
  if (trade.state !== "closed" || trade.r === undefined || !trade.closedAt) return undefined;
  const p = (v: number) => frenchPrice(v, trade.digits);
  const exit = exitLabel(trade);
  if (after.result === "target") {
    const left = Math.round((after.r - trade.r) * 100) / 100;
    return {
      key: "after",
      tone: left > 0.05 ? "warn" : "info",
      text: `Après ta sortie (${exit ?? "fermé"}), l'objectif du ticket (${p(o.target)}) a été touché ${relativeMoment(after.at!, o.now)}${left > 0.05 ? ` : ${rLabel(left).replace("+", "")} laissés` : ""}.`,
    };
  }
  if (after.result === "stop") {
    const saved = Math.round((trade.r + 1) * 100) / 100;
    return {
      key: "after",
      tone: "ok",
      text: `Après ta sortie (${exit ?? "fermé"}), le stop du ticket (${p(trade.initialStop)}) a été touché ${relativeMoment(after.at!, o.now)}${saved > 0.05 ? ` : ta sortie t'a gardé ${rLabel(saved).replace("+", "")} de plus que le stop` : ""}.`,
    };
  }
  return { key: "after", tone: "info", text: `Depuis ta sortie, ni l'objectif ni le stop du ticket ; au mieux ${rLabel(after.best)} sur le plan.` };
}

/** L'idée rejouée : sa zone, son invalidation, jusqu'où le prix est allé. `what` : « Ton idée de départ », « L'idée de ta fiche ». */
export function ideaFact(
  what: string,
  view: AnalysisView,
  at: number,
  r: IdeaReplay,
  o: { digits?: number; now: number; key: string; invalidation?: number },
): JournalFact {
  const p = (v: number) => frenchPrice(v, o.digits);
  const head = `${what} (${ideaWords(view, o.digits)}, ${relativeMoment(at, o.now)}), rejouée sur les cours`;
  if (r.touchedAt === undefined) return { key: o.key, tone: "info", text: `${head} : zone pas touchée depuis.` };
  const inv = o.invalidation;
  const touched = `zone touchée ${relativeMoment(r.touchedAt, o.now)}`;
  if (r.invalidatedAt) {
    return {
      key: o.key,
      tone: "ok",
      text: `${head} : ${touched}, puis invalidation${inv !== undefined ? ` (${p(inv)})` : ""} touchée ${relativeMoment(r.invalidatedAt, o.now)}, −1 R${r.bestR !== undefined && r.bestR > 0 ? ` après ${rLabel(r.bestR)} au mieux` : ""}.`,
    };
  }
  if (r.nowR !== undefined) {
    return {
      key: o.key,
      tone: r.nowR > 0 ? "warn" : "info",
      text: `${head} : ${touched}${inv !== undefined ? `, invalidation (${p(inv)}) jamais touchée` : ""} ; ${rLabel(r.nowR)} à ce jour${r.bestR !== undefined ? `, ${rLabel(r.bestR)} au mieux` : ""}.`,
    };
  }
  // Sans prix d'invalidation : le chemin en points.
  const move = r.bestPrice !== undefined && r.entry !== undefined ? Math.abs(r.bestPrice - r.entry) : undefined;
  return {
    key: o.key,
    tone: "info",
    text: `${head} : ${touched} vers ${p(r.entry!)}${move !== undefined ? `, puis jusqu'à ${p(r.bestPrice!)} dans son sens (${frenchPrice(move, o.digits)} d'écart)` : ""} ; pas de prix d'invalidation pour la compter en R.`,
  };
}

/** Une idée non prise, en une ligne pour l'encart. */
export function untakenLine(r: IdeaReplay, o: { digits?: number; now: number }): string {
  if (r.touchedAt === undefined) return "Idée non prise : zone pas encore touchée.";
  const touched = `zone touchée ${relativeMoment(r.touchedAt, o.now)}`;
  if (r.invalidatedAt) return `Idée non prise : ${touched}, puis invalidée.`;
  if (r.nowR !== undefined) return `Idée non prise : ${touched} ; ${rLabel(r.nowR)} à ce jour${r.bestR !== undefined ? `, ${rLabel(r.bestR)} au mieux` : ""}.`;
  return `Idée non prise : ${touched}${r.bestPrice !== undefined ? `, puis jusqu'à ${frenchPrice(r.bestPrice, o.digits)}` : ""}.`;
}

/** La zone d'une idée, avec ses deux bornes en prix (lues dans ses mots s'il n'a pas dit de prix) ; undefined sans prix. */
export function ideaZone(view: AnalysisView | undefined): { low: number; high: number } | undefined {
  const z = view?.idea?.zone;
  if (!z) return undefined;
  if (z.low === undefined && z.high === undefined) return zoneFromText(z.text);
  const low = Math.min(z.low ?? z.high!, z.high ?? z.low!);
  const high = Math.max(z.low ?? z.high!, z.high ?? z.low!);
  return { low, high };
}
