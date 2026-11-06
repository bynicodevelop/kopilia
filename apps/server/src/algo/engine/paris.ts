import type { Clock, SessionName } from "./types.js";

/*
 * L'heure de Paris d'un instant, sans dépendance : un format Intl par heure
 * d'horloge, en cache, pour que deux ans de bougies de 15 minutes ne coûtent
 * presque rien. Les séances sont celles du trader : Asie de 1 h à 9 h, Londres
 * de 9 h à 15 h 30, New York de 15 h 30 à 22 h, le reste hors séance.
 */

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Paris",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface HourParts {
  date: string;
  hour: number;
  weekday: number;
}

const cache = new Map<number, HourParts>();

function hourParts(epochSec: number): HourParts {
  const key = Math.floor(epochSec / 3600);
  const known = cache.get(key);
  if (known) return known;
  const parts = fmt.formatToParts(new Date(key * 3600 * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const value: HourParts = {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
  if (cache.size > 100_000) cache.clear();
  cache.set(key, value);
  return value;
}

export function sessionOf(hour: number, minute: number): SessionName {
  const m = hour * 60 + minute;
  if (m >= 60 && m < 9 * 60) return "asia";
  if (m >= 9 * 60 && m < 15 * 60 + 30) return "london";
  if (m >= 15 * 60 + 30 && m < 22 * 60) return "new_york";
  return "off";
}

/** L'heure de Paris et la séance d'un instant (epoch secondes). */
export function parisClock(epochSec: number): Clock {
  const h = hourParts(epochSec);
  const minute = Math.floor((epochSec % 3600) / 60);
  return { date: h.date, hour: h.hour, minute, weekday: h.weekday, session: sessionOf(h.hour, minute) };
}

export const SESSION_LABELS: Record<SessionName, string> = { asia: "Asie", london: "Londres", new_york: "New York", off: "hors séance" };
export const WEEKDAY_LABELS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
