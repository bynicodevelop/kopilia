/*
 * Le rythme de lecture du flux : lent, parce que le site limite le débit
 * (deux lectures à 29 s d'écart ont reçu « error code: 1015 »), et calé sur
 * les annonces fortes du calendrier pour lire leur chiffre 10 s après, sans
 * jamais lire plus souvent qu'au rythme normal. Pur, testé à plat.
 */

/** Une lecture toutes les 2 minutes quand les marchés sont ouverts : le flux garde ~3 h de titres, rien n'est perdu. */
export const READ_MS = 2 * 60_000;
/** Marchés fermés (week-end) : une lecture toutes les 10 minutes. */
export const QUIET_READ_MS = 10 * 60_000;
/** Après une limite de débit : 4, 8 puis 15 minutes au plus. */
export const LIMITED_MIN_MS = 4 * 60_000;
export const LIMITED_MAX_MS = 15 * 60_000;
/** Une autre erreur (réseau, réponse inattendue) : on réessaie à ce rythme. */
export const ERROR_RETRY_MS = 5 * 60_000;
/** La lecture qui suit une annonce forte : le temps que le site publie le chiffre (13:30:01 pour 13:30). */
export const RELEASE_DELAY_MS = 10_000;
/** On ne se cale que sur les annonces de ce futur proche. */
export const RELEASE_LOOKAHEAD_MS = 12 * 60_000;

/**
 * Marchés ouverts : du dimanche 22 h au vendredi 22 h UTC (le forex et les
 * futures), à une heure près selon l'heure d'été, ce qui suffit pour un rythme.
 */
export function marketsOpen(now: number): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5) return hour < 22;
  if (day === 0) return hour >= 22;
  return true;
}

/**
 * L'instant de la prochaine lecture après celle de `last`. Si une annonce
 * forte tombe bientôt, les lectures se resserrent un peu (jamais sous
 * `interval`) pour que l'une d'elles tombe 10 s après elle ; une annonce trop
 * proche de la dernière lecture est lue à la suivante, au plus 2 min après.
 */
export function nextReadAt(o: { last: number; now: number; interval: number; releases: number[] }): number {
  const regular = Math.max(o.now, o.last + o.interval);
  const targets = o.releases
    .map((r) => r + RELEASE_DELAY_MS)
    .filter((t) => t >= o.last + o.interval && t >= o.now && t - o.now <= RELEASE_LOOKAHEAD_MS)
    .sort((a, b) => a - b);
  const target = targets[0];
  if (target === undefined) return regular;
  const gap = target - o.last;
  const steps = Math.max(1, Math.floor(gap / o.interval));
  return Math.max(o.now, Math.round(o.last + gap / steps));
}

/** L'attente après une limite de débit : le double de la précédente, entre 4 et 15 minutes. */
export function limitedBackoff(previous: number | undefined): number {
  if (!previous || previous < LIMITED_MIN_MS) return LIMITED_MIN_MS;
  return Math.min(LIMITED_MAX_MS, previous * 2);
}
