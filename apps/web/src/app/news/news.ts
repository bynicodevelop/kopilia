import type { NewsFigure, NewsItem, NewsReaction } from "@kopilia/contracts";

/** L'encart garde au plus ce nombre de news (les plus récentes). */
export const MAX_NEWS = 150;

/**
 * Les news lues sur le serveur, complétées par celles qui arrivent en direct
 * (une news déjà là est remplacée : traduction, réaction du marché), les plus
 * récentes d'abord ; filtrées sur un produit s'il y en a un.
 */
export function mergeNews(current: readonly NewsItem[], incoming: readonly NewsItem[], symbol?: string, max = MAX_NEWS): NewsItem[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  for (const n of incoming) byId.set(n.id, n);
  return [...byId.values()]
    .filter((n) => !symbol || n.symbols.includes(symbol) || n.reaction?.symbol === symbol)
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, max);
}

/** « +0,42 % ». */
export function pct(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

/** « Or +0,42 % en 2 min ». */
export function reactionText(r: NewsReaction): string {
  return `${r.name.charAt(0).toUpperCase()}${r.name.slice(1)} ${pct(r.changePct)} en ${r.minutes} min`;
}

/** « Publié 189k · attendu 196k · précédent 194k (révisé 195K) · calendrier : Unemployment Claims, impact fort, consensus 197K ». */
export function figureText(f: NewsFigure): string {
  const parts = [`Publié ${f.actual}`];
  if (f.forecast) parts.push(`attendu ${f.forecast}`);
  if (f.previous) parts.push(`précédent ${f.previous}${f.revised ? ` (révisé ${f.revised})` : ""}`);
  if (f.calendar) {
    const impact = f.calendar.impact === "high" ? "fort" : f.calendar.impact === "medium" ? "moyen" : "faible";
    parts.push(`calendrier : ${f.calendar.title}, impact ${impact}${f.calendar.forecast ? `, consensus ${f.calendar.forecast}` : ""}`);
  }
  return parts.join(" · ");
}
