/**
 * Historique des prix (outil market_history) : quel jour, quelle semaine ou
 * quelle séance est demandée, et ce qu'en disent les bougies du courtier
 * (ouverture, plus haut, plus bas, clôture, variation). Fonctions pures,
 * testées sans réseau ; les heures sont celles du Mac (heure de Paris).
 */
import { MarketError, frenchPrice } from "./metaapi.js";
import { clock } from "../common/dates.js";

/** Bougie MetaApi : `time` en UTC, `brokerTime` à l'heure du serveur du courtier. */
export interface Candle {
  time: string;
  brokerTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Period = "today" | "yesterday" | "week" | "last_week" | "month" | "last_month";
export type Session = "asia" | "london" | "new_york";

export interface HistoryQuery {
  period?: Period;
  /** Jour précis AAAA-MM-JJ. */
  date?: string;
  /** Plage de jours AAAA-MM-JJ, bornes comprises. */
  from?: string;
  to?: string;
  session?: Session;
}

/** Un jour (le dernier jour de cotation jusqu'à `target`) ou une plage de jours. */
export type Span = { single: true; target: string } | { single: false; from: string; to: string; label: string };

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
/** Détail jour par jour rendu au plus (une analyse sur trois mois tient dedans). */
const MAX_DAY_DETAIL = 70;

/**
 * Séances, dans le fuseau de leur place : Asie, de l'ouverture de Tokyo à celle
 * de Londres ; Londres, de 8 h à 16 h 30 ; New York, l'ouverture de Wall
 * Street (9 h 30) à sa clôture (16 h). Changements d'heure compris.
 */
const SESSIONS: Record<Session, { label: string; start: [string, string]; end: [string, string] }> = {
  asia: { label: "séance asiatique", start: ["Asia/Tokyo", "09:00"], end: ["Europe/London", "08:00"] },
  london: { label: "séance de Londres", start: ["Europe/London", "08:00"], end: ["Europe/London", "16:30"] },
  new_york: { label: "séance de New York", start: ["America/New_York", "09:30"], end: ["America/New_York", "16:00"] },
};

// --- Dates (jours AAAA-MM-JJ du calendrier, fuseau du Mac) ---

export function localDay(at: number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** 0 = dimanche … 6 = samedi. */
function weekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

function validDay(day: string | undefined, what: string): string | undefined {
  if (day === undefined || day === "") return undefined;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;
  if (!ok) throw new MarketError(`${what} invalide (« ${day} ») : format AAAA-MM-JJ attendu`);
  return day;
}

/** « 2026-10-30 » -> « vendredi 30 octobre », « dimanche 1er novembre » (avec l'année si ce n'est pas celle en cours). */
export function frenchDay(day: string, now = new Date()): string {
  const sameYear = day.slice(0, 4) === String(now.getFullYear());
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  })
    .format(new Date(`${day}T12:00:00Z`))
    .replace(/ 1 /, " 1er ");
}

/** Heure locale moins UTC (ms) dans le fuseau `tz` à l'instant `at`. */
function tzOffset(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

/** « 2026-11-02 » à « 09:30 » à New York -> instant UTC (ms). */
export function zonedTime(day: string, time: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
}

// --- Ce qui est demandé ---

/** Jour ou plage demandés ; aujourd'hui par défaut. Hier = la veille du calendrier (le vendredi, un lundi). */
export function resolveSpan(q: HistoryQuery, now = new Date()): Span {
  const today = localDay(now);
  const from = validDay(q.from, "début de plage");
  const to = validDay(q.to, "fin de plage");
  const date = validDay(q.date, "date");
  if (from || to) {
    const start = from ?? to!;
    const end = to && to < today ? to : today;
    if (start > end) throw new MarketError("plage vide : le début est après la fin (ou dans le futur)");
    if (daysBetween(start, end) > MAX_RANGE_DAYS) throw new MarketError(`plage trop longue : ${MAX_RANGE_DAYS} jours au plus`);
    return { single: false, from: start, to: end, label: `du ${frenchDay(start, now)} au ${frenchDay(end, now)}` };
  }
  if (date) {
    if (date > today) throw new MarketError(`le ${frenchDay(date, now)} est dans le futur`);
    return { single: true, target: date };
  }
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  const firstOfMonth = `${today.slice(0, 8)}01`;
  switch (q.period ?? "today") {
    case "today":
      return { single: true, target: today };
    case "yesterday":
      return { single: true, target: addDays(today, -1) };
    case "week":
      return { single: false, from: monday, to: today, label: `cette semaine (depuis le ${frenchDay(monday, now)})` };
    case "last_week":
      return {
        single: false,
        from: addDays(monday, -7),
        to: addDays(monday, -1),
        label: `la semaine dernière (du ${frenchDay(addDays(monday, -7), now)} au ${frenchDay(addDays(monday, -1), now)})`,
      };
    case "month":
      return { single: false, from: firstOfMonth, to: today, label: `ce mois-ci (depuis le ${frenchDay(firstOfMonth, now)})` };
    case "last_month": {
      const end = addDays(firstOfMonth, -1);
      const start = `${end.slice(0, 8)}01`;
      return { single: false, from: start, to: end, label: `le mois dernier (du ${frenchDay(start, now)} au ${frenchDay(end, now)})` };
    }
  }
}

/** Requête de bougies quotidiennes qui couvre la demande et la séance d'avant (fins de semaine et fériés compris). */
export function dailyRequest(span: Span): { startTime: string; limit: number } {
  const to = span.single ? span.target : span.to;
  const days = span.single ? 0 : daysBetween(span.from, span.to);
  // Midi UTC : après le début de la journée `to` du courtier, avant le début de la suivante (fuseaux de -12 h à +12 h).
  return { startTime: `${to}T12:00:00.000Z`, limit: days + 8 };
}

/** Fenêtre d'une séance un jour donné (UTC), avec son libellé en heure de Paris. */
export function sessionWindow(session: Session, day: string, now = new Date()) {
  const s = SESSIONS[session];
  const start = zonedTime(day, s.start[1], s.start[0]);
  const end = zonedTime(day, s.end[1], s.end[0]);
  return { start, end, label: `${s.label} du ${frenchDay(day, now)} (${clock(start)} – ${clock(end)}, heure de Paris)` };
}

/**
 * Jour de la séance demandée : le jour même, ou la dernière veille de semaine
 * (une séance demandée un dimanche est celle du vendredi).
 */
export function sessionDay(span: Span): string {
  if (!span.single) throw new MarketError("une séance se demande pour un seul jour (période ou date, pas une plage)");
  let day = span.target;
  while (weekday(day) === 0 || weekday(day) === 6) day = addDays(day, -1);
  return day;
}

// --- Ce qu'en disent les bougies ---

export function brokerDay(c: Candle): string {
  return c.brokerTime.slice(0, 10);
}

/** Bougies triées, une par instant (MetaApi peut renvoyer la bougie en cours deux fois). */
export function cleanCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new MarketError("bougies du courtier illisibles");
  const byTime = new Map<string, Candle>();
  for (const c of raw as Candle[]) {
    if (typeof c?.time !== "string" || typeof c.brokerTime !== "string") continue;
    if (![c.open, c.high, c.low, c.close].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/**
 * Séances quotidiennes demandées, et celle d'avant (pour la variation). Un jour
 * sans séance (fin de semaine, férié) donne la dernière séance avant lui.
 */
export function pickDays(candles: Candle[], span: Span, now = new Date()): { days: Candle[]; previous?: Candle; note?: string } {
  if (span.single) {
    let i = candles.length - 1;
    while (i >= 0 && brokerDay(candles[i]) > span.target) i--;
    if (i < 0) throw new MarketError(`aucune séance connue jusqu'au ${frenchDay(span.target, now)}`);
    const day = brokerDay(candles[i]);
    const note = day === span.target ? undefined : `pas de séance le ${frenchDay(span.target, now)} : voici la dernière avant, le ${frenchDay(day, now)}`;
    return { days: [candles[i]], previous: candles[i - 1], ...(note ? { note } : {}) };
  }
  const first = candles.findIndex((c) => brokerDay(c) >= span.from);
  const days = first < 0 ? [] : candles.slice(first).filter((c) => brokerDay(c) <= span.to);
  if (!days.length) throw new MarketError(`aucune séance ${span.label}`);
  return { days, previous: candles[first - 1] };
}

interface Range {
  open: number;
  high: number;
  low: number;
  close: number;
  highCandle: Candle;
  lowCandle: Candle;
}

function range(candles: Candle[]): Range {
  let highCandle = candles[0];
  let lowCandle = candles[0];
  for (const c of candles) {
    if (c.high > highCandle.high) highCandle = c;
    if (c.low < lowCandle.low) lowCandle = c;
  }
  return { open: candles[0].open, high: highCandle.high, low: lowCandle.low, close: candles.at(-1)!.close, highCandle, lowCandle };
}

/** +12,30 (+0,04 %) ; -0,00200 (-0,18 %). */
export function frenchChange(from: number, to: number, digits: number): string {
  const diff = to - from;
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
  const pct = from ? (diff / from) * 100 : 0;
  const pctText = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(pct));
  return `${sign}${frenchPrice(Math.abs(diff), digits)} (${sign}${pctText} %)`;
}

interface Product {
  query: string;
  symbol: string;
  name: string;
  digits: number;
}

/**
 * Journée(s) du courtier : ouverture, extrêmes (avec l'heure, si les bougies de
 * 5 minutes de la journée sont là ; le jour, sur plusieurs séances), clôture ou
 * dernier prix, variation depuis la clôture d'avant.
 */
export function dayReport(p: Product, span: Span, picked: ReturnType<typeof pickDays>, intraday: Candle[] = [], now = new Date()) {
  const { days, previous, note } = picked;
  const r = range(days);
  const price = (v: number) => frenchPrice(v, p.digits);
  const start = Date.parse(days[0].time);
  const last = days.at(-1)!;
  const ongoing = Date.parse(last.time) + DAY_MS > now.getTime();
  const reference = `journée du courtier, comme les bougies quotidiennes de MetaTrader : de ${clock(start)} la veille à ${clock(start + DAY_MS)}, heure de Paris`;
  const times = span.single && intraday.length ? range(intraday) : undefined;
  // La journée du courtier commence la veille au soir (heure de Paris) : « 23 h 10 la veille ».
  const at = (c: Candle) => `${clock(Date.parse(c.time))}${localDay(Date.parse(c.time)) < brokerDay(days[0]) ? " la veille" : ""}`;
  return {
    query: p.query,
    symbol: p.symbol,
    name: p.name,
    period: span.single ? frenchDay(brokerDay(days[0]), now) : span.label,
    reference,
    open: price(r.open),
    high: price(r.high),
    ...(times ? { highAt: at(times.highCandle) } : {}),
    ...(!span.single ? { highDay: frenchDay(brokerDay(r.highCandle), now) } : {}),
    low: price(r.low),
    ...(times ? { lowAt: at(times.lowCandle) } : {}),
    ...(!span.single ? { lowDay: frenchDay(brokerDay(r.lowCandle), now) } : {}),
    close: price(r.close),
    ...(previous ? { previousClose: price(previous.close), change: frenchChange(previous.close, r.close, p.digits) } : {}),
    state: ongoing ? "en cours : close est le dernier prix" : "clôturée",
    ...(note ? { note } : {}),
    ...(!span.single
      ? days.length <= MAX_DAY_DETAIL
        ? {
            days: days.map((c) => ({ day: frenchDay(brokerDay(c), now), open: price(c.open), high: price(c.high), low: price(c.low), close: price(c.close) })),
          }
        : { detail: `détail jour par jour omis au-delà de ${MAX_DAY_DETAIL} séances : demande une plage plus courte` }
      : {}),
  };
}

/** Séance d'un jour, à partir des bougies de 5 minutes : variation depuis son ouverture. */
export function sessionReport(p: Product, window: ReturnType<typeof sessionWindow>, candles: Candle[], now = new Date()) {
  const inside = candles.filter((c) => {
    const t = Date.parse(c.time);
    return t >= window.start && t < window.end;
  });
  if (!inside.length) throw new MarketError(`aucune cotation pendant la ${window.label} (jour férié ?)`);
  const r = range(inside);
  const price = (v: number) => frenchPrice(v, p.digits);
  return {
    query: p.query,
    symbol: p.symbol,
    name: p.name,
    period: window.label,
    open: price(r.open),
    high: price(r.high),
    highAt: clock(Date.parse(r.highCandle.time)),
    low: price(r.low),
    lowAt: clock(Date.parse(r.lowCandle.time)),
    close: price(r.close),
    change: `${frenchChange(r.open, r.close, p.digits)} depuis l'ouverture de la séance`,
    state: window.end > now.getTime() ? "en cours : close est le dernier prix" : "clôturée",
  };
}
