/**
 * Formateurs français partagés, créés une fois : un Intl.NumberFormat ou
 * DateTimeFormat coûte cher à construire, et le graphique formate des prix à
 * chaque image pendant un survol ou un glissement.
 */

const decimals = new Map<number, Intl.NumberFormat>();

/** Nombres à `digits` décimales exactement (« 1,08342 », « 28 093,51 »). */
export function decimalFormat(digits: number): Intl.NumberFormat {
  let f = decimals.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    decimals.set(digits, f);
  }
  return f;
}

const dates = new Map<string, Intl.DateTimeFormat>();

/** Un format de date mis en cache (fuseau du navigateur, figé à la première utilisation). */
export function dateFormat(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = dates.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("fr-FR", options);
    dates.set(key, f);
  }
  return f;
}

/** « lun. 2 nov., 07:04 » : la date d'un brief, d'une relecture, d'un souvenir. */
export function formatDateTime(ms: number): string {
  return dateFormat("dateTime", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}
