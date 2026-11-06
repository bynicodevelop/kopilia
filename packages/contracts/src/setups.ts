import { z } from "zod";

/*
 * Recherche d'opportunités. Trois sortes d'objets, gardés par le serveur :
 * - les hypothèses : dans quel sens, et pourquoi (celles de l'IA, tirées du
 *   wrap et du calendrier, et celles de l'utilisateur, qui peuvent la
 *   contredire) ;
 * - les scénarios : le dossier que l'IA ouvre sur un produit (pourquoi, ce
 *   qu'elle voyait, son plan « si… alors… », ce qui l'invaliderait, ce dont il
 *   dépend, et le fil de ses décisions). Ses alertes et ses rendez-vous y sont
 *   rattachés : à chaque réveil, l'agent relit le dossier et ce qui a changé
 *   depuis, et vérifie d'abord que le pourquoi tient encore ;
 * - leurs résultats, une fois proposés : objectif, stop, ou entrée jamais
 *   atteinte.
 */

/** Le sens attendu par une hypothèse. */
export const HYPOTHESIS_BIASES = ["up", "down", "neutral"] as const;
export type HypothesisBias = (typeof HYPOTHESIS_BIASES)[number];

/** L'horizon d'une hypothèse ou d'un scénario : la séance (15 minutes), ou plusieurs jours (4 heures). */
export const HORIZONS = ["intraday", "swing"] as const;
export type Horizon = (typeof HORIZONS)[number];

/** Active ; confirmée ou invalidée (par l'IA, par l'utilisateur ou par une donnée) ; arrivée à échéance. */
export const HYPOTHESIS_STATES = ["active", "confirmed", "invalidated", "expired"] as const;
export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];

/** Qui l'a émise : l'utilisateur, ou l'IA. */
export const AUTHORS = ["user", "kopilia"] as const;
export type Author = (typeof AUTHORS)[number];

/** Un produit tel qu'on le désigne : symbole exact du courtier et nom courant. */
const productSchema = z.object({ symbol: z.string().min(1), name: z.string() });

export const hypothesisSchema = z.object({
  /** Identifiant stable (h_…). */
  id: z.string().min(1),
  author: z.enum(AUTHORS),
  /** « Le dollar reprend avant le CPI ». */
  statement: z.string().min(1),
  /** Les produits concernés (vide : le marché en général). */
  products: z.array(productSchema),
  bias: z.enum(HYPOTHESIS_BIASES),
  horizon: z.enum(HORIZONS),
  /** Ce qui la confirmera ou la cassera (« CPI 14 h 30 », « discours de Powell »). */
  catalysts: z.string().optional(),
  /** Ce qui l'invaliderait : toujours dit. */
  invalidation: z.string().min(1),
  /** D'où elle vient (« wrap de 7 h », « conversation »). */
  source: z.string().optional(),
  state: z.enum(HYPOTHESIS_STATES),
  /** Pourquoi elle a changé d'état. */
  stateReason: z.string().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

/** Le sens d'un scénario. */
export const DIRECTIONS = ["long", "short"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * En surveillance (« setup en attente » pour l'utilisateur : repéré, son
 * déclencheur n'est pas encore arrivé) ; proposé (« setup déclenché » : il est
 * en place, l'utilisateur est prévenu) ; abandonné (scénario invalidé) ; arrivé
 * à échéance sans se produire ; clos (le suivi d'un setup proposé est terminé).
 */
export const SCENARIO_STATES = ["watching", "proposed", "invalidated", "expired", "closed"] as const;
export type ScenarioState = (typeof SCENARIO_STATES)[number];

/** Un scénario ouvert : surveillé ou proposé (son suivi n'est pas fini). */
export function isOpenScenario(state: ScenarioState): boolean {
  return state === "watching" || state === "proposed";
}

/** Une annonce du calendrier dont dépend un scénario (« CPI » de 14 h 30, USD). */
const calendarRefSchema = z.object({ at: z.number().int().positive(), country: z.string(), title: z.string() });
export type CalendarRef = z.infer<typeof calendarRefSchema>;

/** Ce dont dépend un scénario : quand l'une de ces choses change, il est revu sans attendre son alerte. */
export const scenarioDependsSchema = z.object({
  hypotheses: z.array(z.string()),
  drawings: z.array(z.string()),
  events: z.array(calendarRefSchema),
});
export type ScenarioDepends = z.infer<typeof scenarioDependsSchema>;

/** Ce que l'utilisateur a fait d'un setup proposé : pris, pas pour lui, modifié (« stop plus haut »), ou simple remarque. */
export const FEEDBACK_REACTIONS = ["taken", "declined", "modified", "comment"] as const;
export type FeedbackReaction = (typeof FEEDBACK_REACTIONS)[number];

/** Le résultat d'un setup proposé : objectif atteint, stop touché, entrée jamais atteinte, ou encore en cours. */
export const OUTCOMES = ["target", "stop", "missed", "open"] as const;
export type OutcomeResult = (typeof OUTCOMES)[number];

export const scenarioOutcomeSchema = z.object({
  result: z.enum(OUTCOMES),
  /** Gain ou perte en multiples du risque (objectif : distance à l'entrée / distance au stop). */
  r: z.number().optional(),
  /** Entrée atteinte (epoch ms). */
  enteredAt: z.number().int().positive().optional(),
  /** Résultat constaté (epoch ms). */
  at: z.number().int().positive().optional(),
});
export type ScenarioOutcome = z.infer<typeof scenarioOutcomeSchema>;

/** Ce qui arrive au fil d'un scénario. */
export const SCENARIO_EVENT_KINDS = [
  /** Ouvert : le pourquoi, le plan. */
  "opened",
  /** Alerte posée, déplacée ou retirée. */
  "alert",
  /** Rendez-vous pris (« à la clôture de 10 h 45 »). */
  "rendezvous",
  /** Réveillé : par quoi (alerte partie, rendez-vous, changement de contexte). */
  "wake",
  /** Ce que l'agent a conclu, et pourquoi. */
  "decision",
  /** Changement de contexte constaté (hypothèse invalidée, zone retirée, news publiée). */
  "context",
  /** Remarque ou réaction de l'utilisateur. */
  "feedback",
  /** Dossier mis à jour (plan, niveaux, échéance). */
  "update",
  /** Note libre de l'agent. */
  "note",
  /** Setup confirmé, proposé à l'utilisateur. */
  "proposed",
  /** Abandonné, expiré, ou suivi terminé. */
  "closed",
] as const;
export type ScenarioEventKind = (typeof SCENARIO_EVENT_KINDS)[number];

export const scenarioEventSchema = z.object({
  id: z.string().min(1),
  at: z.number().int().positive(),
  kind: z.enum(SCENARIO_EVENT_KINDS),
  text: z.string(),
  /** L'agent (IA), l'utilisateur, ou le serveur (expiration, alerte partie). */
  by: z.enum(["agent", "user", "system"]),
});
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;

export const scenarioSchema = z.object({
  /** Identifiant stable (sc_…). */
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string(),
  digits: z.number().int().nonnegative().optional(),
  direction: z.enum(DIRECTIONS),
  horizon: z.enum(HORIZONS),
  /** Unité de temps de l'entrée (« 15m »), et celle du contexte (« 4h »). */
  timeframe: z.string().min(1),
  contextTimeframe: z.string().optional(),
  /** « Or : rejet de la résistance 4 h ». */
  title: z.string().min(1),
  /** Pourquoi : les hypothèses, les niveaux, la façon de trader de l'utilisateur. */
  why: z.string().min(1),
  /** Ce que l'IA voyait en l'ouvrant : prix, distances, indicateurs, agenda. */
  snapshot: z.string(),
  /** Le plan « si… alors… ». */
  plan: z.string().min(1),
  /** Ce qui l'invaliderait. */
  invalidation: z.string().min(1),
  depends: scenarioDependsSchema,
  entry: z.number().optional(),
  stop: z.number().optional(),
  targets: z.array(z.number()),
  state: z.enum(SCENARIO_STATES),
  stateReason: z.string().optional(),
  /** À revoir : une dépendance a changé depuis la dernière lecture (et pourquoi). */
  review: z.string().optional(),
  /** Prochain rendez-vous de l'agent (epoch ms) et ce qu'il y vérifiera. */
  wakeAt: z.number().int().positive().optional(),
  wakeReason: z.string().optional(),
  feedback: z.object({ reaction: z.enum(FEEDBACK_REACTIONS), note: z.string().optional(), at: z.number().int().positive() }).optional(),
  outcome: scenarioOutcomeSchema.optional(),
  /** Dernière fois que l'IA a relu le dossier : le point de départ de « ce qui a changé depuis ». */
  checkedAt: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  proposedAt: z.number().int().positive().optional(),
  /** L'utilisateur a été prévenu (proposé à l'oral ou à l'écran) : un abandon lui sera dit aussi. */
  toldAt: z.number().int().positive().optional(),
  closedAt: z.number().int().positive().optional(),
  /** Le fil, du plus ancien au plus récent (envoyé à l'écran pour les scénarios affichés). */
  events: z.array(scenarioEventSchema).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

/** Scénarios ouverts au plus : au total, et sur un produit. */
export const MAX_OPEN_SCENARIOS = 12;
export const MAX_SCENARIOS_PER_PRODUCT = 4;
/** Hypothèses actives au plus. */
export const MAX_ACTIVE_HYPOTHESES = 20;
/** Niveaux de travail de l'IA (ses tracés) au plus, sur un produit. */
export const MAX_AI_LEVELS = 12;
/**
 * Deux niveaux plus proches que ce nombre d'ATR (ou qui se chevauchent) sont
 * le même niveau : celui de l'utilisateur l'emporte, l'IA s'appuie dessus et
 * la carte automatique s'efface derrière lui.
 */
export const SAME_LEVEL_ATR = 0.25;

/** Une suggestion de l'IA sur un tracé de l'utilisateur : elle ne le modifie pas, elle le lui signale. */
export const drawingSuggestionSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  drawingId: z.string().min(1),
  scenarioId: z.string().optional(),
  /** « Ta zone coupe les mèches de 28 070 : la descendre à 28 065 ? » */
  text: z.string(),
  createdAt: z.number().int().positive(),
});
export type DrawingSuggestion = z.infer<typeof drawingSuggestionSchema>;

/** Une ligne de statistiques des setups proposés : par unité de temps, par auteur de l'hypothèse, pris ou non. */
export const setupStatsRowSchema = z.object({
  label: z.string(),
  proposed: z.number().int().nonnegative(),
  target: z.number().int().nonnegative(),
  stop: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  /** Somme des multiples de risque des setups terminés. */
  r: z.number(),
});
export type SetupStatsRow = z.infer<typeof setupStatsRowSchema>;

export const STATE_NAMES: Record<ScenarioState, string> = {
  watching: "en attente",
  proposed: "déclenché",
  invalidated: "abandonné",
  expired: "expiré",
  closed: "clos",
};

export const OUTCOME_NAMES: Record<OutcomeResult, string> = {
  target: "objectif atteint",
  stop: "stop touché",
  missed: "entrée jamais atteinte",
  open: "en cours",
};

export const REACTION_NAMES: Record<FeedbackReaction, string> = {
  taken: "pris",
  declined: "pas pour moi",
  modified: "modifié",
  comment: "remarque",
};

/** Le multiple de risque d'un setup : ce qu'il rapporte au premier objectif, en unités de risque (undefined sans niveaux cohérents). */
export function rewardRisk(s: Pick<Scenario, "direction" | "entry" | "stop" | "targets">): number | undefined {
  const { entry, stop } = s;
  const target = s.targets[0];
  if (entry === undefined || stop === undefined || target === undefined) return undefined;
  const risk = s.direction === "long" ? entry - stop : stop - entry;
  const reward = s.direction === "long" ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return undefined;
  return reward / risk;
}
