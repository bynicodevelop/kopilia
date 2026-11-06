import { z } from "zod";

/*
 * Laboratoire de stratégies (trading algo) : les robots écrits par Kopilia à
 * partir d'une idée de l'utilisateur, leurs backtests et leur verdict, tels que
 * l'écran les montre. Le robot est du code TypeScript ; ce que l'écran voit, ce
 * sont sa fiche et ses chiffres. Les règles du verdict sont ici, dans le code,
 * hors de portée de l'agent qui cherche : l'IA cherche, le code juge.
 */

/** Où en est un robot : une idée, en test, jugé (prometteur, fragile, rejeté), en papier, en automatique. */
export const ROBOT_STATUSES = ["idea", "testing", "promising", "fragile", "rejected", "paper", "auto"] as const;
export type RobotStatus = (typeof ROBOT_STATUSES)[number];

export const ROBOT_STATUS_NAMES: Record<RobotStatus, string> = {
  idea: "idée",
  testing: "en test",
  promising: "prometteur",
  fragile: "fragile",
  rejected: "rejeté",
  paper: "en papier",
  auto: "en automatique",
};

/** Le verdict d'un backtest, calculé par le code (voir VERDICT_RULES). */
export const VERDICTS = ["promising", "fragile", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_NAMES: Record<Verdict, string> = { promising: "prometteur", fragile: "fragile", rejected: "rejeté" };

/**
 * Les règles du verdict, fixées dans le code et dites à l'utilisateur :
 * assez de trades, une espérance positive hors apprentissage, une majorité de
 * fenêtres positives. Les mois réservés ne servent jamais à chercher : ils ne
 * sont vus qu'au verdict, en chiffres seulement.
 */
export const VERDICT_RULES = {
  /** Trades au moins, apprentissage et vérification confondus. */
  minTrades: 100,
  /** Part des fenêtres (trimestres) à espérance positive. */
  minPositiveWindows: 0.6,
  /** Part de l'historique qui sert à chercher ; le reste vérifie. */
  inSampleRatio: 0.7,
  /** Derniers mois réservés, jamais montrés en détail à l'agent. */
  reservedMonths: 3,
} as const;

/** Les mesures d'un jeu de trades, en R (une unité de risque = la distance au stop à l'entrée). */
export const backtestMetricsSchema = z.object({
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  /** Part des trades gagnants (0 à 1). */
  winRate: z.number(),
  /** Espérance : R moyen par trade. */
  avgR: z.number(),
  totalR: z.number(),
  /** Somme des gains sur somme des pertes (en R) ; absent sans perte. */
  profitFactor: z.number().optional(),
  /** Plus forte baisse de la courbe en R. */
  maxDrawdownR: z.number(),
  longestLosingStreak: z.number().int().nonnegative(),
  /** Durée moyenne d'un trade, en bougies. */
  avgBars: z.number(),
  /** Part des fenêtres (trimestres) à espérance positive, et leur nombre. */
  positiveWindows: z.number(),
  windows: z.number().int().nonnegative(),
});
export type BacktestMetrics = z.infer<typeof backtestMetricsSchema>;

/** Les mesures par tranche : séance, jour de semaine, année, sens. */
export const metricsBreakdownSchema = z.record(z.string(), backtestMetricsSchema.pick({ trades: true, winRate: true, avgR: true, totalR: true }));
export type MetricsBreakdown = z.infer<typeof metricsBreakdownSchema>;

/** Un trade d'un backtest, pour le graphique et la discussion. */
export const backtestTradeSchema = z.object({
  side: z.enum(["long", "short"]),
  /** Instants epoch secondes de la bougie d'entrée et de sortie. */
  entryAt: z.number().int(),
  exitAt: z.number().int(),
  entry: z.number(),
  exit: z.number(),
  stop: z.number(),
  target: z.number().optional(),
  r: z.number(),
  /** Pourquoi la sortie : stop, objectif, signal, heure, fin. */
  reason: z.string(),
  /** Pire excursion et meilleure excursion pendant le trade, en R. */
  mae: z.number().optional(),
  mfe: z.number().optional(),
  symbol: z.string(),
});
export type BacktestTrade = z.infer<typeof backtestTradeSchema>;

/** Un backtest : un robot, une version, un univers, une période, et ses chiffres par tranche d'historique. */
export const backtestSummarySchema = z.object({
  id: z.string(),
  robotId: z.string(),
  version: z.number().int().positive(),
  products: z.array(z.string()),
  timeframe: z.string(),
  /** Période couverte (epoch secondes). */
  from: z.number().int(),
  to: z.number().int(),
  /** Source des bougies (« broker » : le courtier via MetaApi ; « dukascopy » plus tard). */
  source: z.string(),
  /** Paramètres donnés au robot, s'il en prend. */
  params: z.record(z.string(), z.unknown()).optional(),
  /** Bornes de la coupe (epoch secondes) : apprentissage avant inEnd, vérification avant outEnd, réservé après. */
  inEnd: z.number().int().optional(),
  outEnd: z.number().int().optional(),
  /** Les coûts appliqués, en unités de prix : écart, commission d'un aller-retour, glissement. */
  costs: z.object({ spread: z.number(), commission: z.number(), slippage: z.number() }).optional(),
  /** Unités de contexte chargées, et minute utilisée pour départager stop et objectif. */
  contexts: z.array(z.string()).optional(),
  minute: z.boolean().optional(),
  /** Apprentissage (ce que l'agent voit en détail), vérification, mois réservés. */
  inSample: backtestMetricsSchema,
  outOfSample: backtestMetricsSchema.optional(),
  reserved: backtestMetricsSchema.optional(),
  breakdown: metricsBreakdownSchema.optional(),
  verdict: z.enum(VERDICTS),
  verdictReasons: z.array(z.string()),
  /** Rang de cet essai dans la recherche du robot (le compteur d'essais). */
  trial: z.number().int().positive(),
  /** Courbe en R de la période d'apprentissage (un point par trade), allégée. */
  equity: z.array(z.number()).optional(),
  note: z.string().optional(),
  createdAt: z.number().int(),
});
export type BacktestSummary = z.infer<typeof backtestSummarySchema>;

/** Ce que l'encart Robots montre d'un robot : sa fiche en une ligne et son meilleur backtest. */
export const robotSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** L'idée, dans les mots de l'utilisateur. */
  idea: z.string(),
  status: z.enum(ROBOT_STATUSES),
  products: z.array(z.string()),
  timeframe: z.string().optional(),
  version: z.number().int().nonnegative(),
  trials: z.number().int().nonnegative(),
  best: backtestSummarySchema.optional(),
  /** Une recherche est en cours sur ce robot (identifiant du travail). */
  jobId: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type RobotSummary = z.infer<typeof robotSummarySchema>;

/** Ce qui arrive au fil d'une fiche de robot. */
export const ROBOT_NOTE_KINDS = ["idea", "hypothesis", "plan", "decision", "result", "lesson", "user", "verdict", "error"] as const;
export type RobotNoteKind = (typeof ROBOT_NOTE_KINDS)[number];

export const robotNoteSchema = z.object({
  at: z.number().int(),
  kind: z.enum(ROBOT_NOTE_KINDS),
  text: z.string(),
  /** Le backtest dont parle la note, s'il y en a un. */
  backtestId: z.string().optional(),
});
export type RobotNote = z.infer<typeof robotNoteSchema>;

/** La fiche complète d'un robot : résumé, plan lisible, code courant, backtests, fil. */
export const robotSheetSchema = robotSummarySchema.extend({
  /** L'hypothèse préenregistrée : ce que « ça marche » voudra dire, écrit avant tout essai. */
  hypothesis: z.string().optional(),
  /** Les règles exactes en français, générées à partir du code et relues. */
  plan: z.string().optional(),
  code: z.string().optional(),
  backtests: z.array(backtestSummarySchema),
  notes: z.array(robotNoteSchema),
  /** Les robots sur lesquels il s'appuie. */
  parents: z.array(z.string()),
});
export type RobotSheet = z.infer<typeof robotSheetSchema>;

/** Une leçon du carnet du laboratoire : réutilisable, avec sa preuve. */
export const labLessonSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** Portée : produits et unité de temps où elle a été vue. */
  products: z.array(z.string()),
  timeframe: z.string().optional(),
  robotId: z.string().optional(),
  backtestId: z.string().optional(),
  createdAt: z.number().int(),
});
export type LabLesson = z.infer<typeof labLessonSchema>;

/** Le verdict d'un backtest à partir de ses mesures : les règles de VERDICT_RULES, et leurs raisons en français. */
export function judge(m: { inSample: BacktestMetrics; outOfSample?: BacktestMetrics; reserved?: BacktestMetrics }): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  const all = m.inSample.trades + (m.outOfSample?.trades ?? 0);
  let fails = 0;
  let soft = 0;
  if (all < VERDICT_RULES.minTrades) {
    reasons.push(`${all} trades : il en faut au moins ${VERDICT_RULES.minTrades} pour conclure`);
    soft++;
  } else reasons.push(`${all} trades`);
  if (m.inSample.avgR <= 0) {
    reasons.push(`espérance négative en apprentissage (${fmtR(m.inSample.avgR)} par trade)`);
    fails++;
  }
  if (m.outOfSample) {
    if (m.outOfSample.trades === 0) {
      reasons.push("aucun trade en vérification");
      soft++;
    } else if (m.outOfSample.avgR <= 0) {
      reasons.push(`espérance négative en vérification (${fmtR(m.outOfSample.avgR)} par trade)`);
      fails++;
    } else reasons.push(`vérification : ${fmtR(m.outOfSample.avgR)} par trade sur ${m.outOfSample.trades} trades`);
  } else {
    reasons.push("pas de période de vérification");
    soft++;
  }
  const windows = m.inSample.windows + (m.outOfSample?.windows ?? 0);
  if (windows >= 3) {
    const positive = m.inSample.positiveWindows * m.inSample.windows + (m.outOfSample ? m.outOfSample.positiveWindows * m.outOfSample.windows : 0);
    const share = positive / windows;
    if (share < VERDICT_RULES.minPositiveWindows) {
      reasons.push(`${Math.round(positive)} trimestres positifs sur ${windows} : trop irrégulier`);
      soft++;
    } else reasons.push(`${Math.round(positive)} trimestres positifs sur ${windows}`);
  }
  if (m.reserved && m.reserved.trades > 0) {
    reasons.push(`mois réservés : ${fmtR(m.reserved.avgR)} par trade sur ${m.reserved.trades} trades`);
    if (m.reserved.avgR <= 0) soft++;
  }
  const verdict: Verdict = fails > 0 ? "rejected" : soft > 0 ? "fragile" : "promising";
  return { verdict, reasons };
}

function fmtR(v: number): string {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
  return `${v > 0 ? "+" : ""}${s} R`;
}

/** L'état du laboratoire a changé (robot, backtest, fil) : la liste des robots pour l'encart. */
export const robotsUpdatedSchema = z.object({
  robots: z.array(robotSummarySchema),
});
export type RobotsUpdated = z.infer<typeof robotsUpdatedSchema>;
