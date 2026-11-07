/**
 * Quand le compte MetaApi peut dormir : marchés fermés (le week-end) et, en
 * option, la nuit. MetaApi facture chaque heure où le compte est déployé
 * (0,0126 $ en haute fiabilité), même marchés fermés ; un rallumage coûte
 * environ 6 h 30 de compte allumé. Fonctions pures, testées sans horloge.
 *
 * Le week-end suit l'heure de New York, comme la semaine du forex : il
 * commence le vendredi à 17 h 05 (cinq minutes après la clôture) et finit le
 * dimanche à 16 h 30, une demi-heure avant la réouverture. À Paris, c'est
 * vendredi 23 h 05 → dimanche 22 h 30, sauf les semaines où les deux pays
 * n'ont pas encore changé d'heure ensemble (une heure plus tôt).
 *
 * La nuit, à Paris, de 23 h à 5 h. Avec elle, le week-end va jusqu'au lundi
 * 5 h : rallumer le dimanche à 22 h 30 pour éteindre à 23 h coûterait un
 * rallumage pour rien.
 */

/** Ce qui fait dormir le compte. */
export type PauseWindow = "weekend" | "night";

export interface PauseRules {
  weekend: boolean;
  nights: boolean;
}

/** Jour (0 = dimanche … 6 = samedi), heure et minute d'un instant dans un fuseau. */
export interface ZonedClock {
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formats = new Map<string, Intl.DateTimeFormat>();

export function zonedClock(at: number, timeZone: string): ZonedClock {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formats.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { weekday: WEEKDAYS[parts.weekday] ?? 0, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

const NEW_YORK = "America/New_York";
const PARIS = "Europe/Paris";
/** Vendredi 17 h 05 et dimanche 16 h 30, heure de New York (en minutes depuis minuit). */
const FRIDAY_PAUSE = 17 * 60 + 5;
const SUNDAY_WAKE = 16 * 60 + 30;
/** La nuit à Paris : de 23 h à 5 h. */
const NIGHT_START = 23;
const NIGHT_END = 5;
/** Matin de semaine où une pause demandée à la main prend fin au plus tard (6 h 30 à Paris, avant le wrap de 7 h). */
const MORNING = 6 * 60 + 30;

/** Le week-end des marchés : du vendredi 17 h 05 au dimanche 16 h 30, heure de New York. */
export function inWeekend(at: number): boolean {
  const ny = zonedClock(at, NEW_YORK);
  const m = ny.hour * 60 + ny.minute;
  return (ny.weekday === 5 && m >= FRIDAY_PAUSE) || ny.weekday === 6 || (ny.weekday === 0 && m < SUNDAY_WAKE);
}

/** La nuit à Paris, de 23 h à 5 h. */
export function inNight(at: number): boolean {
  const h = zonedClock(at, PARIS).hour;
  return h >= NIGHT_START || h < NIGHT_END;
}

/** La fenêtre de pause où tombe cet instant d'après les règles, s'il y en a une. */
export function pauseWindow(at: number, rules: PauseRules): PauseWindow | undefined {
  if (rules.weekend && (inWeekend(at) || (rules.nights && zonedClock(at, PARIS).weekday === 0))) return "weekend";
  if (!rules.nights || !inNight(at)) return undefined;
  const p = zonedClock(at, PARIS);
  // Le lundi avant 5 h, c'est la fin du week-end allongé.
  return rules.weekend && p.weekday === 1 && p.hour < NIGHT_END ? "weekend" : "night";
}

const STEP_MS = 5 * 60_000;
const HORIZON_MS = 8 * 86_400_000;

/**
 * Le prochain instant (après `at`) où l'on entre dans une fenêtre de pause ou
 * où l'on en sort ; undefined sans changement d'ici huit jours. Les limites
 * tombent toutes sur des multiples de cinq minutes.
 */
export function nextChange(at: number, rules: PauseRules): number | undefined {
  const inside = pauseWindow(at, rules) !== undefined;
  let t = Math.floor(at / STEP_MS) * STEP_MS + STEP_MS;
  for (const end = at + HORIZON_MS; t <= end; t += STEP_MS) {
    if ((pauseWindow(t, rules) !== undefined) !== inside) return t;
  }
  return undefined;
}

/** Le prochain matin de semaine à 6 h 30, heure de Paris, après `at`. */
export function nextWeekdayMorning(at: number): number {
  let t = Math.floor(at / STEP_MS) * STEP_MS + STEP_MS;
  for (const end = at + HORIZON_MS; t <= end; t += STEP_MS) {
    const p = zonedClock(t, PARIS);
    if (p.weekday >= 1 && p.weekday <= 5 && p.hour * 60 + p.minute === MORNING) return t;
  }
  return at + 86_400_000;
}

/**
 * La fin d'une pause demandée à la main : la fin de la fenêtre où l'on est,
 * ou, hors fenêtre, le prochain matin de semaine (ou la prochaine fin de
 * fenêtre, si elle vient avant). Le compte ne reste jamais éteint un matin de
 * semaine sans qu'on le redemande.
 */
export function manualPauseEnd(at: number, rules: PauseRules): number {
  const morning = nextWeekdayMorning(at);
  let t = at;
  // La sortie de la fenêtre en cours, ou de la suivante si l'on est hors fenêtre.
  for (let i = 0; i < 2; i++) {
    const change = nextChange(t, rules);
    if (change === undefined) break;
    if (pauseWindow(change, rules) === undefined) return Math.min(change, morning);
    t = change;
  }
  return morning;
}

const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** « 22 h 30 », « 5 h » : l'heure de Paris d'un instant, à dire. */
export function parisTime(at: number): string {
  const p = zonedClock(at, PARIS);
  return p.minute ? `${p.hour} h ${String(p.minute).padStart(2, "0")}` : `${p.hour} h`;
}

/** « aujourd'hui à 22 h 30 », « demain à 5 h », « lundi à 6 h 30 » : un instant proche, heure de Paris. */
export function whenLabel(at: number, now: number): string {
  const day = (t: number) => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: PARIS, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
    return Date.parse(`${p}T00:00:00Z`);
  };
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  const name = days === 0 ? "aujourd'hui" : days === 1 ? "demain" : DAY_NAMES[zonedClock(at, PARIS).weekday];
  return `${name} à ${parisTime(at)}`;
}
