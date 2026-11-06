import { dayLabel, startOfDay, timeLabel, timeZoneLabel, updatedLabel } from "../common/dates.js";
/**
 * Calendrier économique Forex Factory : lecture du flux officiel (semaine en
 * cours, heures de New York) et mise en forme pour Kopilia, dans le fuseau du
 * Mac (heure de Paris). Fonctions pures, testées sans réseau.
 */

export type Impact = "high" | "medium" | "low" | "holiday";
/** Filtre d'impact demandé : « medium » garde aussi les annonces fortes. */
export type ImpactFilter = "high" | "medium" | "all";
export type Period = "today" | "tomorrow" | "yesterday" | "week";

export interface CalendarEvent {
  /** Instant UTC (ms). */
  at: number;
  /** Devise concernée (USD, EUR…), comme l'affiche Forex Factory. */
  country: string;
  title: string;
  impact: Impact;
  forecast: string | null;
  previous: string | null;
  /** Le chiffre publié, lu dans les news (FinancialJuice) ; absent tant qu'il n'est pas connu. */
  actual?: string | null;
}

export interface ParsedFeed {
  events: CalendarEvent[];
  /** Semaine couverte par le flux : du dimanche 0 h (heure de New York) au suivant. */
  week: { start: number; end: number };
  skipped: number;
}

/** Réponse inexploitable (Forex Factory renvoie une page HTML quand on l'interroge trop souvent). */
export class FeedError extends Error {}

const DAY_MS = 86_400_000;
const IMPACTS: Record<string, Impact> = { high: "high", medium: "medium", low: "low", holiday: "holiday" };
const IMPACT_LABEL: Record<Impact, string> = { high: "fort", medium: "moyen", low: "faible", holiday: "férié" };
const KEPT: Record<ImpactFilter, Impact[]> = {
  high: ["high", "holiday"],
  medium: ["high", "medium", "holiday"],
  all: ["high", "medium", "low", "holiday"],
};

export function impactsFor(filter: ImpactFilter): Impact[] {
  return KEPT[filter];
}

/** Lit le flux JSON (`ff_calendar_thisweek.json`) ; les entrées incomplètes sont écartées. */
export function parseFeed(body: string): ParsedFeed {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new FeedError("réponse non JSON (limite de requêtes Forex Factory atteinte ?)");
  }
  if (!Array.isArray(raw)) throw new FeedError("réponse inattendue (pas une liste d'événements)");
  const events: CalendarEvent[] = [];
  let skipped = 0;
  let first: { date: string; at: number } | undefined;
  for (const entry of raw as Array<Record<string, unknown>>) {
    const { title, country, date } = entry ?? {};
    const at = typeof date === "string" ? Date.parse(date) : NaN;
    if (typeof title !== "string" || typeof country !== "string" || Number.isNaN(at)) {
      skipped++;
      continue;
    }
    if (!first || at < first.at) first = { date: date as string, at };
    events.push({
      at,
      country: country.trim(),
      title: title.trim(),
      impact:
        IMPACTS[
          String(entry.impact ?? "")
            .trim()
            .toLowerCase()
        ] ?? "low",
      forecast: valueOrNull(entry.forecast),
      previous: valueOrNull(entry.previous),
    });
  }
  if (!first) throw new FeedError("aucun événement exploitable");
  events.sort((a, b) => a.at - b.at);
  const start = weekStart(first.date) ?? first.at;
  return { events, week: { start, end: Math.max(start + 7 * DAY_MS, events.at(-1)!.at + 1) }, skipped };
}

function valueOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Dimanche 0 h de la semaine d'une date du flux, dans le fuseau de cette date
 * (« 2026-11-03T10:00:00-05:00 » -> dimanche 1er novembre, 0 h à New York).
 */
function weekStart(date: string): number | undefined {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(Z|([+-])(\d{2}):?(\d{2}))$/);
  if (!m) return undefined;
  const offsetMin = m[4] === "Z" ? 0 : (m[5] === "-" ? -1 : 1) * (Number(m[6]) * 60 + Number(m[7]));
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const sunday = day - new Date(day).getUTCDay() * DAY_MS;
  return sunday - offsetMin * 60_000;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export interface Range {
  start: number;
  end: number;
  /** « lundi 2 novembre » ou « semaine du lundi 2 au dimanche 8 novembre ». */
  label: string;
  multiDay: boolean;
}

/**
 * Période demandée, en jours du Mac : une date « AAAA-MM-JJ » l'emporte sur
 * `period` (aujourd'hui par défaut) ; la semaine va du lundi au dimanche.
 */
export function periodRange(period: Period | undefined, date: string | undefined, now: Date): Range {
  const ymd = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return { start: d.getTime(), end: addDays(d, 1).getTime(), label: dayLabel(d), multiDay: false };
  }
  const today = startOfDay(now);
  if (period === "week") {
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    const sunday = addDays(monday, 6);
    return {
      start: monday.getTime(),
      end: addDays(monday, 7).getTime(),
      label: `semaine du ${dayLabel(monday)} au ${dayLabel(sunday)}`,
      multiDay: true,
    };
  }
  const shift = period === "tomorrow" ? 1 : period === "yesterday" ? -1 : 0;
  const d = addDays(today, shift);
  return { start: d.getTime(), end: addDays(d, 1).getTime(), label: dayLabel(d), multiDay: false };
}

/** « 16:00 · USD · ISM Manufacturing PMI · impact fort · prévision 49.5 · précédent 49.1 » */
export function formatEvent(e: CalendarEvent): string {
  if (e.impact === "holiday") return `journée · ${e.country} · ${e.title} · férié ou jour particulier`;
  const parts = [timeLabel(new Date(e.at)), e.country, e.title, `impact ${IMPACT_LABEL[e.impact]}`];
  if (e.actual) parts.push(`publié ${e.actual}`);
  if (e.forecast) parts.push(`prévision ${e.forecast}`);
  if (e.previous) parts.push(`précédent ${e.previous}`);
  return parts.join(" · ");
}

/** Événements regroupés par jour (heure du Mac), dans l'ordre. */
export function groupByDay(events: CalendarEvent[]): Array<{ day: string; events: string[] }> {
  const days: Array<{ day: string; events: string[] }> = [];
  for (const e of events) {
    const day = dayLabel(new Date(e.at));
    if (days.at(-1)?.day !== day) days.push({ day, events: [] });
    days.at(-1)!.events.push(formatEvent(e));
  }
  return days;
}

/** Calendrier complet de la semaine, en Markdown, lu par les agents. */
export function renderWeek(events: CalendarEvent[], fetchedAt: number, now: Date): string {
  const span = events.length ? ` — du ${dayLabel(new Date(events[0].at))} au ${dayLabel(new Date(events.at(-1)!.at))}` : "";
  const lines = [
    `# Calendrier économique Forex Factory${span}`,
    "",
    `Mis à jour ${updatedLabel(fetchedAt, now)}. Heures en ${timeZoneLabel()}. Pour chaque annonce : heure, devise, événement, impact, prévision (consensus) et chiffre précédent. Le chiffre publié n'y figure pas : il se cherche sur le web.`,
  ];
  for (const { day, events: list } of groupByDay(events)) {
    lines.push("", `## ${day}`, ...list.map((l) => `- ${l}`));
  }
  return lines.join("\n") + "\n";
}
