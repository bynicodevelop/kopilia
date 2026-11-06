import { z } from "zod";
import { POSITION_SIDES } from "./technical.js";
import { ORDER_EXECUTIONS, TRADE_STATES, tradeSchema, type Trade, type TradeExit } from "./trading.js";

/*
 * Journal de trading : chaque trade passé par Kopilia, rattaché à la fiche
 * d'analyse du produit ouverte au moment du ticket, avec ce qui est arrivé
 * (exécution, gestes de gestion, sorties), son résultat (gagnant, perdant ou
 * neutre), ses notes dictées, et les faits que le serveur en tire sans modèle
 * (contre la fiche, objection relevée avant, stop élargi…). Le graphique du
 * trade est figé à la confirmation du ticket : les tracés posés après n'y
 * viennent jamais. Ce n'est pas le carnet de trader, qui garde ses règles.
 */

/** Sous ce multiple du risque (en valeur absolue), un trade fermé est neutre : ni gagné ni perdu. */
export const NEUTRAL_R = 0.1;

export const TRADE_OUTCOMES = ["win", "loss", "neutral"] as const;
export type TradeOutcome = (typeof TRADE_OUTCOMES)[number];
export const OUTCOME_LABELS: Record<TradeOutcome, string> = { win: "gagnant", loss: "perdant", neutral: "neutre" };

/** Le résultat d'un trade fermé ; undefined : pas fermé, ou résultat inconnu. */
export function tradeOutcome(t: Pick<Trade, "state" | "r">): TradeOutcome | undefined {
  if (t.state !== "closed" || t.r === undefined) return undefined;
  if (Math.abs(t.r) < NEUTRAL_R - 1e-9) return "neutral";
  return t.r > 0 ? "win" : "loss";
}

/** Toutes les sorties d'un trade, de la plus ancienne à la plus récente. */
export function tradeExits(t: Pick<Trade, "legs">): TradeExit[] {
  return t.legs.flatMap((l) => l.exits ?? []).sort((a, b) => a.at - b.at);
}

/**
 * Comment le trade est sorti, en mots, d'après sa dernière sortie : « à
 * l'objectif », « au stop », « au stop remonté » (stop à l'entrée ou au-delà),
 * « au stop déplacé », « à la main, sur la plateforme », « fermé par Kopilia ».
 */
export function exitLabel(t: Pick<Trade, "legs" | "stop" | "initialStop" | "protected" | "state">): string | undefined {
  const last = tradeExits(t).at(-1);
  if (!last) return undefined;
  switch (last.reason) {
    case "target":
      return "à l'objectif";
    case "stop":
      return t.protected ? "au stop remonté" : Math.abs(t.stop - t.initialStop) > 1e-9 ? "au stop déplacé" : "au stop";
    case "manual":
      return "à la main, sur la plateforme";
    case "kopilia":
      return "fermé par Kopilia, à ta demande";
    case "stopout":
      return "arrêt de marge du courtier";
    default:
      return "sortie lue chez le courtier";
  }
}

/** Ce que l'utilisateur change pendant un trade : son stop, son objectif, une part fermée. */
export const GESTURE_KINDS = ["stop", "target", "partial"] as const;
export type GestureKind = (typeof GESTURE_KINDS)[number];
/** D'où vient le geste : une demande confirmée à Kopilia, ou la plateforme du courtier (ordinateur, mobile). */
export const GESTURE_SOURCES = ["kopilia", "platform"] as const;
export type GestureSource = (typeof GESTURE_SOURCES)[number];
export const GESTURE_SOURCE_LABELS: Record<GestureSource, string> = { kopilia: "à ta demande", platform: "sur la plateforme" };

export const tradeGestureSchema = z.object({
  at: z.number().int().positive(),
  kind: z.enum(GESTURE_KINDS),
  source: z.enum(GESTURE_SOURCES),
  /** Le niveau d'avant et le nouveau (stop, objectif). */
  from: z.number().optional(),
  to: z.number().optional(),
  /** Une part fermée : sa taille, son prix, son résultat. */
  lots: z.number().optional(),
  profit: z.number().optional(),
  /** Le prix du moment, et où en était la position, en multiples du risque de départ. */
  price: z.number().optional(),
  r: z.number().optional(),
});
export type TradeGesture = z.infer<typeof tradeGestureSchema>;

/** Le stop s'éloigne du gain (vers plus de risque) : contre le plan du ticket. */
export function widensStop(side: Trade["side"], from: number, to: number): boolean {
  return side === "long" ? to < from - 1e-9 : to > from + 1e-9;
}

/** Un fait du journal : ce que le serveur constate, sans modèle ; `warn` quand c'est contre la fiche ou le plan. */
export const journalFactSchema = z.object({
  key: z.string().min(1),
  text: z.string().min(1),
  tone: z.enum(["ok", "warn", "info"]),
});
export type JournalFact = z.infer<typeof journalFactSchema>;

/** Le trade et sa fiche : dans le sens de la fiche, contre elle, ou sans fiche. */
export const FICHE_FIDELITIES = ["with", "against", "none"] as const;
export type FicheFidelity = (typeof FICHE_FIDELITIES)[number];
export const FIDELITY_LABELS: Record<FicheFidelity, string> = { with: "fidèle à la fiche", against: "contre la fiche", none: "sans fiche" };

/** Ce qui s'est passé, fiche et trade mêlés, dans l'ordre. */
export const JOURNAL_ITEM_KINDS = [
  "view",
  "why",
  "challenge",
  "fiche",
  "ticket",
  "filled",
  "gesture",
  "exit",
  "closed",
  "cancelled",
  "rejected",
  "note",
] as const;
export const journalItemSchema = z.object({
  at: z.number().int().positive(),
  kind: z.enum(JOURNAL_ITEM_KINDS),
  by: z.enum(["user", "kopilia", "system"]),
  text: z.string().min(1),
});
export type JournalItem = z.infer<typeof journalItemSchema>;

/** La page d'un trade du journal. */
export const journalTradeSchema = z.object({
  trade: tradeSchema,
  outcome: z.enum(TRADE_OUTCOMES).optional(),
  exit: z.string().optional(),
  /** De l'exécution à la dernière sortie (ou à maintenant). */
  durationMs: z.number().nonnegative().optional(),
  /** La fiche du produit ouverte au ticket. */
  analysisId: z.string().optional(),
  fidelity: z.enum(FICHE_FIDELITIES),
  /** Le graphique a été figé au ticket (sinon : un trade d'avant le journal, sans ses tracés). */
  frozen: z.boolean(),
  frozenAt: z.number().int().positive().optional(),
  timeframe: z.string().optional(),
  facts: z.array(journalFactSchema),
  gestures: z.array(tradeGestureSchema),
  notes: z.array(z.object({ at: z.number().int().positive(), text: z.string() })),
  thread: z.array(journalItemSchema),
});
export type JournalTrade = z.infer<typeof journalTradeSchema>;

/** Un trade dans la liste du journal. */
export const journalLineSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string(),
  side: z.enum(POSITION_SIDES),
  state: z.enum(TRADE_STATES),
  outcome: z.enum(TRADE_OUTCOMES).optional(),
  r: z.number().optional(),
  profit: z.number().optional(),
  currency: z.string(),
  /** La fermeture, sinon l'exécution, sinon le ticket. */
  at: z.number().int().positive(),
  fidelity: z.enum(FICHE_FIDELITIES),
  /** Ce qui le résume en quelques mots (« sorti avant l'objectif », « essai »). */
  remark: z.string().optional(),
  /** Sa dernière note dictée. */
  note: z.string().optional(),
  demo: z.boolean(),
  /** Ses niveaux, pour l'écran d'un trade en cours : l'entrée, le stop (à jour et de départ), le premier objectif. */
  entry: z.number().optional(),
  stop: z.number().optional(),
  initialStop: z.number().optional(),
  target: z.number().optional(),
  lots: z.number().optional(),
  /** Le risque engagé (perte au stop de départ), dans la devise du compte. */
  risk: z.number().optional(),
  execution: z.enum(ORDER_EXECUTIONS).optional(),
  digits: z.number().int().nonnegative().optional(),
  /** Le ticket, et l'exécution s'il y en a eu une. */
  createdAt: z.number().int().positive().optional(),
  openedAt: z.number().int().positive().optional(),
});
export type JournalLine = z.infer<typeof journalLineSchema>;

/** Une fiche et ses trades (ou les trades sans fiche). */
export const journalGroupSchema = z.object({
  analysisId: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string(),
  state: z.enum(["open", "closed"]).optional(),
  openedAt: z.number().int().positive().optional(),
  closedAt: z.number().int().positive().optional(),
  /** Son idée en quelques mots (« achat 26 600 – 26 650 »), et l'idée de départ si elle a changé de sens. */
  idea: z.string().optional(),
  firstIdea: z.string().optional(),
  trades: z.array(journalLineSchema),
  /** Le total en R de ses trades fermés. */
  r: z.number(),
  /** Une fiche sans trade : son idée rejouée sur les cours (« zone touchée mer. 10:15, +1,8 R au mieux »). */
  untaken: z.string().optional(),
});
export type JournalGroup = z.infer<typeof journalGroupSchema>;

export const journalSchema = z.object({
  since: z.number().int().nonnegative(),
  groups: z.array(journalGroupSchema),
  totals: z.object({ count: z.number().int(), wins: z.number().int(), losses: z.number().int(), neutral: z.number().int(), r: z.number() }),
  /** La dernière analyse de son trading, et si une est en cours. */
  review: z.object({ id: z.string(), createdAt: z.number().int().positive(), days: z.number().int().positive(), summary: z.string() }).optional(),
  reviewing: z.boolean().optional(),
});
export type Journal = z.infer<typeof journalSchema>;

/* ------------------------- L'analyse de son trading ------------------------- */

/** Un chiffre compté par le serveur pour l'analyse (« Contre la fiche : 1 trade », « −1 R »). */
export const journalStatSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
  tone: z.enum(["ok", "warn", "info"]),
});
export type JournalStat = z.infer<typeof journalStatSchema>;

/** Un constat de l'IA : ce que les faits montrent, avec les trades qui le montrent. */
export const journalFindingSchema = z.object({
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(700),
  trades: z.array(z.string()).max(12),
});
export type JournalFinding = z.infer<typeof journalFindingSchema>;

/**
 * L'analyse de son trading sur une période, à sa demande : les chiffres
 * comptés par le serveur, puis ce qu'en tire l'IA (Sonnet) à partir des faits,
 * de ses notes, de ses fiches et des graphiques figés. Gardée, datée.
 */
export const journalReviewSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().positive(),
  days: z.number().int().positive(),
  since: z.number().int().nonnegative(),
  stats: z.array(journalStatSchema),
  /** Ce que Kopilia en dit, en une ou deux phrases. */
  summary: z.string().min(1),
  findings: z.array(journalFindingSchema),
  /** Une règle tirée de ses notes, avec ses mots, que Kopilia lui propose d'écrire au carnet (jamais sans lui). */
  carnet: z.string().optional(),
  tradeIds: z.array(z.string()),
});
export type JournalReview = z.infer<typeof journalReviewSchema>;

/* ------------------------- Les bilans de son trading ------------------------- */

/** La période d'un bilan : un jour, une semaine (du lundi), un mois, ou les N derniers jours. */
export const BILAN_PERIODS = ["day", "week", "month", "days"] as const;
export type BilanPeriod = (typeof BILAN_PERIODS)[number];

/** Une ligne d'une répartition : son nom, ses trades, leur total en R. */
export const bilanRowSchema = z.object({
  label: z.string().min(1),
  count: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  r: z.number(),
});
export type BilanRow = z.infer<typeof bilanRowSchema>;

export const BILAN_BREAKDOWNS = ["fidelity", "horizon", "tier", "product", "session"] as const;

/**
 * Le bilan de ses trades fermés sur une période, compté par le serveur sans
 * modèle : le résultat, les répartitions (fiche, horizon, palier, produit,
 * séance), ce qui revient (contre la fiche, changement d'avis, stop élargi…),
 * les jours (pour le calendrier) et les trades eux-mêmes.
 */
export const journalBilanSchema = z.object({
  period: z.enum(BILAN_PERIODS),
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  /** « vendredi 6 novembre », « semaine du 2 novembre », « novembre 2026 », « 30 derniers jours ». */
  label: z.string().min(1),
  totals: z.object({
    count: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    neutral: z.number().int().nonnegative(),
    r: z.number(),
    /** R moyen par trade, et en moyenne sur les gagnants et les perdants. */
    avgR: z.number(),
    avgWin: z.number().optional(),
    avgLoss: z.number().optional(),
    profit: z.number(),
    currency: z.string(),
  }),
  best: journalLineSchema.optional(),
  worst: journalLineSchema.optional(),
  /** La plus longue série de pertes de la période, et la série en cours (positive : gains, négative : pertes). */
  streak: z.object({ maxLosses: z.number().int().nonnegative(), current: z.number().int() }),
  breakdowns: z.array(z.object({ key: z.enum(BILAN_BREAKDOWNS), label: z.string(), rows: z.array(bilanRowSchema) })),
  /** Ce qui revient, d'après les faits de ses trades. */
  patterns: z.array(bilanRowSchema.extend({ key: z.string().min(1) })),
  /** Chaque jour de bourse qui a des trades fermés (AAAA-MM-JJ, heure de Paris). */
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int(), r: z.number() })),
  /** Ses trades fermés, du plus récent au plus ancien, et ceux qui n'ont pas de note. */
  trades: z.array(journalLineSchema),
  missingNotes: z.array(z.string()),
  /** Trades encore en cours ou en attente (non comptés). */
  live: z.number().int().nonnegative(),
});
export type JournalBilan = z.infer<typeof journalBilanSchema>;
