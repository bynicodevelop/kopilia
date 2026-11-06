import { z } from "zod";
import { HORIZONS, HYPOTHESIS_BIASES } from "./setups.js";

/*
 * Fiches d'analyse : l'analyse de l'utilisateur sur un produit, telle qu'il la
 * dicte (le matin après le wrap, puis au fil des jours). Une fiche par produit
 * continue d'un jour à l'autre ; chaque chose dite ou arrivée s'ajoute à son
 * fil, daté, sans jamais rien effacer. Kopilia y joue le contradicteur : il
 * confronte ce que l'utilisateur dit à ce qu'il disait avant, au wrap et aux
 * setups du système, sans jamais décider à sa place.
 */

/** Le sens d'un biais (fondamental ou technique) : haussier, baissier, neutre. */
export const ANALYSIS_BIASES = HYPOTHESIS_BIASES;
export type AnalysisBias = (typeof ANALYSIS_BIASES)[number];

/** L'idée de trade : un achat, une vente, ou rien pour l'instant. */
export const ANALYSIS_SIDES = ["buy", "sell", "none"] as const;
export type AnalysisSide = (typeof ANALYSIS_SIDES)[number];

/** Ouverte (elle continue d'un jour à l'autre) ou fermée (par lui, ou sur sa confirmation). */
export const ANALYSIS_STATES = ["open", "closed"] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

/** Qui a ouvert la fiche : l'utilisateur, ou Kopilia (un setup sur un produit qu'il n'a pas analysé). */
export const ANALYSIS_AUTHORS = ["user", "kopilia"] as const;

/** Ce qui arrive au fil d'une fiche. */
export const ANALYSIS_ENTRY_KINDS = [
  /** Sa lecture : ce qu'il a dit (biais, idée, invalidation). */
  "view",
  /** Sa réponse à une objection, ou la raison d'un changement. */
  "why",
  /** L'objection du contradicteur : ce qu'il a relevé. */
  "challenge",
  /** Un setup du système sur ce produit (en attente, déclenché, abandonné). */
  "setup",
  /** Sa zone, atteinte ou non. */
  "zone",
  /** L'invalidation a été touchée. */
  "invalidated",
  /** Kopilia propose de fermer la fiche. */
  "close_proposed",
  /** Fermée, et pourquoi. */
  "closed",
] as const;
export type AnalysisEntryKind = (typeof ANALYSIS_ENTRY_KINDS)[number];

const biasSchema = z.object({ bias: z.enum(ANALYSIS_BIASES), reason: z.string().optional() });

/** La zone de son idée : des prix, son tracé (d_…), et ce qu'il en a dit (« la zone des 2 600 »). */
export const analysisZoneSchema = z.object({
  low: z.number().optional(),
  high: z.number().optional(),
  drawingId: z.string().optional(),
  text: z.string().optional(),
});
export type AnalysisZone = z.infer<typeof analysisZoneSchema>;

export const analysisIdeaSchema = z.object({
  side: z.enum(ANALYSIS_SIDES),
  zone: analysisZoneSchema.optional(),
  /** Ce qu'il attend pour entrer (« une bougie de rejet en 15 minutes »). */
  trigger: z.string().optional(),
  horizon: z.enum(HORIZONS).optional(),
  /** Unité de temps de l'entrée (« 15m », « 4h »). */
  timeframe: z.string().optional(),
});
export type AnalysisIdea = z.infer<typeof analysisIdeaSchema>;

/** L'état d'une fiche : ce qu'il pense en ce moment du produit, champ par champ. */
export const analysisViewSchema = z.object({
  /** Sa lecture en une phrase, avec ses mots. */
  summary: z.string().optional(),
  fundamental: biasSchema.optional(),
  technical: biasSchema.optional(),
  idea: analysisIdeaSchema.optional(),
  /** Ce qui invaliderait son idée. */
  invalidation: z.string().optional(),
  /** Ce qui peut la faire bouger (« CPI 14 h 30 »). */
  catalysts: z.string().optional(),
});
export type AnalysisView = z.infer<typeof analysisViewSchema>;

export const analysisEntrySchema = z.object({
  id: z.string().min(1),
  at: z.number().int().positive(),
  kind: z.enum(ANALYSIS_ENTRY_KINDS),
  by: z.enum(["user", "kopilia", "system"]),
  /** Ce qui s'est passé, lisible tel quel. */
  text: z.string(),
  /** Après une lecture (« view ») : l'état complet de la fiche. */
  view: analysisViewSchema.optional(),
  /** Après une objection (« challenge ») : ce qui a été relevé, pour ne pas le relever deux fois. */
  keys: z.array(z.string()).optional(),
});
export type AnalysisEntry = z.infer<typeof analysisEntrySchema>;

export const analysisSchema = z.object({
  /** Identifiant stable (an_…). */
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string(),
  digits: z.number().int().nonnegative().optional(),
  author: z.enum(ANALYSIS_AUTHORS),
  view: analysisViewSchema,
  state: z.enum(ANALYSIS_STATES),
  closeReason: z.string().optional(),
  closedBy: z.enum(["user", "kopilia"]).optional(),
  /** Kopilia a proposé de la fermer : elle attend sa réponse. */
  closeProposedAt: z.number().int().positive().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  closedAt: z.number().int().positive().optional(),
});
export type Analysis = z.infer<typeof analysisSchema>;

/** Une fiche fermée depuis moins longtemps que ça est encore rappelée quand il en ouvre une nouvelle sur le même produit. */
export const ANALYSIS_MEMORY_MS = 14 * 86_400_000;
