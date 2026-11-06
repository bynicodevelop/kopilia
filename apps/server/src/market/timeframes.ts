/**
 * Unités de temps d'un graphique : celles des bougies MetaApi, de la minute au
 * mois (« 1mn » chez MetaApi). Module sans dépendance, partagé par le serveur
 * Nest et le serveur MCP de coordination (qui tourne dans son propre processus).
 */
export const CHART_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mn"] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

/**
 * Durée d'une bougie, en secondes. Le mois n'a pas de durée fixe : 30 jours, une
 * moyenne pour les échelles et les nombres de bougies ; jamais pour dire
 * qu'une bougie mensuelle est close (voir MONTHLY).
 */
export const TIMEFRAME_SECONDS: Record<ChartTimeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
  "1w": 604_800,
  "1mn": 2_592_000,
};

/** L'unité dont les bougies n'ont pas toutes la même durée. */
export const MONTHLY: ChartTimeframe = "1mn";

/**
 * L'unité d'une alerte prise sur un graphique : la sienne, sauf le mois, dont on
 * ne sait pas dire quand la bougie est close ; une alerte d'un graphique
 * mensuel se cale sur la semaine.
 */
export function alertTimeframeOf(chart: string | undefined): string | undefined {
  return chart === MONTHLY ? "1w" : chart;
}

/** « 15 minutes », « 1 heure », « 1 jour », « 1 semaine », « 1 mois » : à dire à voix haute. */
export const TIMEFRAME_LABELS: Record<ChartTimeframe, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1h": "1 heure",
  "4h": "4 heures",
  "1d": "1 jour",
  "1w": "1 semaine",
  "1mn": "1 mois",
};

export function isChartTimeframe(v: unknown): v is ChartTimeframe {
  return typeof v === "string" && (CHART_TIMEFRAMES as readonly string[]).includes(v);
}
