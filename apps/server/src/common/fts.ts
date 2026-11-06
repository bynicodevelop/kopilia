/**
 * Requête plein texte (FTS5) tirée d'une phrase libre : mots d'au moins trois
 * lettres, ponctuation retirée, reliés par OU. Sert à la mémoire et à la
 * recherche dans les conversations.
 */
export function sanitizeFts(q: string): string {
  const terms = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return terms.map((t) => `"${t}"`).join(" OR ");
}
