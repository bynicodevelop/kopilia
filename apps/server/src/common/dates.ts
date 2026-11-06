/**
 * Dates et heures dites ou écrites en français, dans le fuseau du Mac (celui
 * de l'utilisateur : heure de Paris). Les jours « AAAA-MM-JJ » de l'historique
 * des cours, eux, ont leurs propres fonctions (market/history.ts).
 */

/** Minuit (heure locale) du jour de `at`. */
export function startOfDay(at: Date | number): Date {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Fuseau d'affichage : celui du Mac. */
export function timeZoneLabel(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz === "Europe/Paris" ? "heure de Paris" : `heure locale (${tz})`;
}

/** « lundi 2 novembre ». */
export function dayLabel(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(d);
}

/** « 06:02 ». */
export function timeLabel(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(d);
}

/** « aujourd'hui à 06:02 » ou « dimanche 1 novembre à 06:02 ». */
export function updatedLabel(at: number, now: Date): string {
  const d = new Date(at);
  const day = startOfDay(d).getTime() === startOfDay(now).getTime() ? "aujourd'hui" : dayLabel(d);
  return `${day} à ${timeLabel(d)}`;
}

/** « lundi 2 novembre 2026 ». */
export function todayFr(now = new Date()): string {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
}

/** « vendredi 30 octobre à 21:38 ». */
export function momentFr(at: number | Date): string {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(at);
}

/** { hour: 7, minute: 30 } -> « 7 h 30 » ; { hour: 23, minute: 0 } -> « 23 h » (à dire à voix haute). */
export function clockLabel(t: { hour: number; minute: number }): string {
  return t.minute ? `${t.hour} h ${String(t.minute).padStart(2, "0")}` : `${t.hour} h`;
}

/** Heure locale d'un instant, à dire : « 15 h 30 », « 23 h ». */
export function clock(at: number): string {
  const d = new Date(at);
  return clockLabel({ hour: d.getHours(), minute: d.getMinutes() });
}

/**
 * Un instant donné par un modèle : « 2026-11-03 14:30 » (heure locale du Mac,
 * celle de l'utilisateur) ou ISO avec fuseau -> epoch ms ; undefined s'il est
 * illisible.
 */
export function localMoment(s: string): number | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  const at = local ? new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +(local[6] ?? 0)).getTime() : Date.parse(s);
  return Number.isFinite(at) ? at : undefined;
}
