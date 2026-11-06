import type { AnalysisBias, AnalysisSide, AnalysisView, Direction, Horizon, ScenarioState } from "@kopilia/contracts";
import { BIAS, SIDE, type SaidView, ideaLabel, inline, relativeMoment } from "./analysis-texts.js";

/*
 * Le contradicteur, côté serveur : des règles sûres, sans modèle, qui relèvent
 * ce qui ne tient pas ensemble dans une fiche (son idée contre son biais, un
 * changement de sens depuis la veille, un setup du système dans l'autre sens,
 * une fiche fermée récemment dans l'autre sens). Le dialogue en fait une
 * question de trader à trader ; le wrap, lui, il le juge lui-même.
 */

/** Un setup ouvert du système sur le même produit. */
export interface SystemSetup {
  id: string;
  direction: Direction;
  state: ScenarioState;
  horizon: Horizon;
  timeframe: string;
  title: string;
}

export interface ConfrontInput {
  /** L'état de la fiche avant ce qu'il vient de dire, et quand il l'avait dit (absent : fiche neuve). */
  before?: { view: AnalysisView; at: number };
  /** L'état après. */
  after: AnalysisView;
  /** Ce qu'il vient de dire, seulement (une raison nouvelle justifie un changement). */
  said: SaidView;
  /** Pour une fiche neuve : la précédente sur ce produit, fermée récemment. */
  closed?: { view: AnalysisView; closedAt: number; reason?: string };
  /** Les setups ouverts du système sur ce produit. */
  setups: SystemSetup[];
  /** Ce qui a déjà été relevé sur cette fiche (clés des objections passées) : on ne le redit pas. */
  raised?: ReadonlySet<string>;
  digits?: number;
  now: number;
}

/**
 * Un point à confronter : `key` l'identifie (une même incohérence n'est
 * relevée qu'une fois par fiche) ; `covers` : les autres points qu'il dit déjà.
 */
export interface Point {
  key: string;
  text: string;
  covers?: string[];
}

export interface Confrontation {
  /** Du plus important au moins important : le dialogue n'en dit qu'un à la fois. */
  points: Point[];
  /** Ce qui manque à la fiche et qu'il faut lui demander. */
  missing: string[];
}

const SIDE_OF_BIAS: Record<AnalysisBias, AnalysisSide | undefined> = { up: "buy", down: "sell", neutral: undefined };
const SIDE_OF_DIRECTION: Record<Direction, AnalysisSide> = { long: "buy", short: "sell" };
const opposite = (a: AnalysisSide | undefined, b: AnalysisSide | undefined) => !!a && !!b && a !== "none" && b !== "none" && a !== b;
const sideOf = (v: AnalysisView | undefined): AnalysisSide | undefined => (v?.idea?.side === "buy" || v?.idea?.side === "sell" ? v.idea.side : undefined);
const STATE: Partial<Record<ScenarioState, string>> = { watching: "en attente", proposed: "déclenché" };

/** Ce que le contradicteur relève, et ce qu'il faut demander. */
export function confront(c: ConfrontInput): Confrontation {
  const raised = c.raised ?? new Set<string>();
  const points: Point[] = [];
  const said = (key: string) => raised.has(key) || points.some((p) => p.key === key || p.covers?.includes(key));
  const add = (key: string, text: string, covers?: string[]) => {
    if (!said(key)) points.push({ key, text, ...(covers?.length ? { covers } : {}) });
  };
  const after = sideOf(c.after);
  const before = sideOf(c.before?.view);
  const fund = c.after.fundamental;
  const fundBefore = c.before?.view.fundamental;
  const tech = c.after.technical;

  // 1. Il a changé de sens depuis sa dernière lecture.
  const turned = !!c.before && opposite(before, after);
  if (turned) {
    const was = ideaLabel(c.before!.view, c.digits);
    const now = ideaLabel(c.after, c.digits);
    const fundNote = !fund
      ? ""
      : fundBefore && fundBefore.bias !== fund.bias
        ? `, et son biais fondamental passe de ${BIAS[fundBefore.bias]} à ${BIAS[fund.bias]}${c.said.fundamental?.reason ? "" : " sans raison donnée"}`
        : SIDE_OF_BIAS[fund.bias] === before
          ? `, alors que son biais fondamental n'a pas changé (${BIAS[fund.bias]}${fund.reason ? ` : ${inline(fund.reason)}` : ""})`
          : "";
    const againstFund = !!fund && opposite(after, SIDE_OF_BIAS[fund.bias]);
    add(
      `turned:${c.before!.at}:${after}`,
      `${relativeMoment(c.before!.at, c.now)}, il voyait ${was} ; maintenant ${now}${fundNote}. Qu'est-ce qui a changé ?`,
      againstFund && fundNote.includes("n'a pas changé") ? [`against_fundamental:${after}:${fund!.bias}`] : [],
    );
  }

  // 2. Son idée va contre son biais fondamental (déjà dit au point 1 si c'est ce changement qui l'y mène).
  if (fund && opposite(after, SIDE_OF_BIAS[fund.bias])) {
    add(
      `against_fundamental:${after}:${fund.bias}`,
      `Son idée (${SIDE[after!]}) va contre son biais fondamental (${BIAS[fund.bias]}${fund.reason ? ` : ${inline(fund.reason)}` : ""}) : un trade contre le fond, qu'est-ce qui le justifie ?`,
    );
  }

  // 3. Son biais fondamental change sans raison nouvelle (hors changement de sens, déjà relevé).
  if (!turned && fund && fundBefore && fund.bias !== fundBefore.bias && !c.said.fundamental?.reason) {
    add(
      `fundamental_changed:${c.before!.at}:${fund.bias}`,
      `Son biais fondamental passe de ${BIAS[fundBefore.bias]} à ${BIAS[fund.bias]} sans raison donnée : une annonce, le wrap ?`,
    );
  }

  // 4. Son idée va contre son biais technique.
  if (tech && opposite(after, SIDE_OF_BIAS[tech.bias])) {
    add(
      `against_technical:${after}:${tech.bias}`,
      `Son idée (${SIDE[after!]}) va contre sa propre lecture technique (${BIAS[tech.bias]}${tech.reason ? ` : ${inline(tech.reason)}` : ""}).`,
    );
  }

  // 5. Un setup du système dans l'autre sens (que son idée, ou à défaut que son biais fondamental).
  const reference = after ?? (fund ? SIDE_OF_BIAS[fund.bias] : undefined);
  for (const s of c.setups) {
    const side = SIDE_OF_DIRECTION[s.direction];
    if (!opposite(side, reference)) continue;
    const against = after ? `son idée (${SIDE[after]})` : `son biais fondamental (${BIAS[fund!.bias]})`;
    add(
      `setup:${s.id}:${reference}`,
      `Le système a un setup ${STATE[s.state] ?? s.state} ${side === "buy" ? "à l'achat" : "à la vente"} (${s.horizon}, ${s.timeframe}) : « ${s.title} » (${s.id}), contre ${against}. Les deux peuvent tenir (un repli avant sa zone, par exemple) : à confronter.`,
    );
  }

  // 6. Une fiche neuve dans l'autre sens que celle qu'il vient de fermer.
  if (c.closed) {
    const was = sideOf(c.closed.view);
    const fundWas = c.closed.view.fundamental;
    const turnedSide = opposite(was, after);
    const turnedFund = !!fund && !!fundWas && fund.bias !== fundWas.bias && fund.bias !== "neutral" && fundWas.bias !== "neutral";
    if (turnedSide || turnedFund) {
      const what = [turnedSide ? `voyait ${ideaLabel(c.closed.view, c.digits)}` : "", turnedFund ? `avait un biais fondamental ${BIAS[fundWas!.bias]}` : ""]
        .filter(Boolean)
        .join(" et ");
      add(
        `reopened:${c.closed.closedAt}`,
        `Sa fiche précédente sur ce produit, fermée ${relativeMoment(c.closed.closedAt, c.now)}${c.closed.reason ? ` (${inline(c.closed.reason)})` : ""}, ${what} : qu'est-ce qui a changé ?`,
      );
    }
  }

  const missing: string[] = [];
  if (after && !c.after.invalidation) missing.push("ce qui invaliderait son idée (il ne l'a pas dit)");
  const rank = (p: Point) => PRIORITY.indexOf(p.key.split(":")[0]);
  return { points: points.sort((a, b) => rank(a) - rank(b)), missing };
}

/** Le plus important d'abord : ce qui a changé depuis, puis ce qui ne tient pas dans la fiche, puis le système. */
const PRIORITY = ["turned", "reopened", "against_fundamental", "fundamental_changed", "setup", "against_technical"];
