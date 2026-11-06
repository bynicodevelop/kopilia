import { dateFormat, decimalFormat } from "../format";
/**
 * Bougies d'un graphique : celles du courtier (chargées par le serveur), puis
 * la bougie en cours animée par les cotations en direct, en phase avec les
 * bougies reçues. Fonctions pures, testées sans écran.
 */

export interface Candle {
  /** Instant d'ouverture, en secondes (epoch, UTC). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export const CHART_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mn"] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

/** Durée d'une bougie ; le mois, faute de durée fixe, compte 30 jours (échelles), sa bougie suit le calendrier (applyQuote). */
export const TIMEFRAME_SECONDS: Record<string, number> = {
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

/** Étiquette courte des boutons d'unité de temps. */
export const TIMEFRAME_SHORT: Record<string, string> = {
  "1m": "1 min",
  "5m": "5 min",
  "15m": "15 min",
  "30m": "30 min",
  "1h": "1 h",
  "4h": "4 h",
  "1d": "1 j",
  "1w": "1 sem.",
  "1mn": "1 mois",
};

/** Les boutons d'unité, serrés comme sur un graphique de trading (« 15m », « 1h », « 1J », « 1S » la semaine, « 1M » le mois). */
export const TIMEFRAME_CHIP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1J",
  "1w": "1S",
  "1mn": "1M",
};

/** En toutes lettres, pour la bulle d'un bouton d'unité. */
export const TIMEFRAME_NAMES: Record<string, string> = {
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

/** Étiquette de l'en-tête (« Graphique · 15 min »). */
export function timeframeLabel(tf: string | undefined): string {
  return (tf && TIMEFRAME_SHORT[tf]) || tf || "";
}

/**
 * Applique une cotation à la dernière bougie : elle la prolonge (plus haut,
 * plus bas, dernier prix) ou en ouvre une nouvelle, calée sur les bougies du
 * courtier (dont les journées et les 4 heures ne sont pas alignées sur UTC) :
 * la nouvelle s'ouvre un nombre entier de bougies après la dernière. Une
 * cotation plus ancienne que la bougie en cours ne change rien.
 */
export function applyQuote(candles: Candle[], bid: number, timeMs: number, tfSeconds: number, monthly = false): { candle: Candle; isNew: boolean } | undefined {
  const t = Math.floor(timeMs / 1000);
  const last = candles[candles.length - 1];
  const fresh = (start: number) => ({ candle: { t: start, o: bid, h: bid, l: bid, c: bid }, isNew: true });
  if (!last) {
    if (!monthly) return fresh(t - (t % tfSeconds));
    const d = new Date(t * 1000);
    return fresh(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }
  if (t < last.t) return undefined;
  let start = last.t;
  if (monthly) {
    // Les mois n'ont pas la même durée : la bougie suivante s'ouvre au même moment du mois suivant.
    while (t >= nextMonthStart(start)) start = nextMonthStart(start);
  } else start += Math.floor((t - last.t) / tfSeconds) * tfSeconds;
  if (start === last.t) return { candle: { ...last, h: Math.max(last.h, bid), l: Math.min(last.l, bid), c: bid }, isNew: false };
  return fresh(start);
}

/**
 * Le début de la bougie mensuelle qui suit celle ouverte à `t` (epoch s) : au
 * même écart du 1er du mois que celle-ci, le courtier ne comptant pas ses
 * journées en heure UTC (le 1er à 0 h chez lui, la veille à 22 h en UTC).
 */
export function nextMonthStart(t: number): number {
  // Deux jours plus tard, on est sûrement dans le mois de la bougie, quel que soit le décalage du courtier.
  const d = new Date((t + 2 * 86_400) * 1000);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 + (t - first);
}

/** Fusionne des bougies (anciennes chargées en remontant le temps, ou recalage sur le courtier) : une par instant, triées. */
export function mergeCandles(current: Candle[], incoming: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of current) byTime.set(c.t, c);
  for (const c of incoming) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * Les dernières bougies relues chez le courtier remplacent celles de l'écran
 * sur leur plage : une bougie ouverte par les cotations au mauvais moment (un
 * changement d'heure du courtier décale ses journées et ses mois d'une heure)
 * ne reste pas en double. Plus récentes que les siennes, celles de l'écran
 * restent (le courtier ne les a pas encore).
 */
export function resyncCandles(current: Candle[], broker: Candle[]): Candle[] {
  if (!broker.length) return current;
  const sorted = [...broker].sort((a, b) => a.t - b.t);
  const first = sorted[0].t;
  const last = sorted[sorted.length - 1].t;
  return [...current.filter((c) => c.t < first), ...sorted, ...current.filter((c) => c.t > last)];
}

/** 1.08342 -> « 1,08342 » ; 28093.51 -> « 28 093,51 » (avec les décimales du produit). */
export function formatPrice(value: number, digits?: number): string {
  const d = digits ?? Math.min(decimals(value), 8);
  return decimalFormat(d).format(value);
}

function decimals(n: number): number {
  const s = String(n);
  return s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
}

/** Variation depuis l'ouverture du jour : « +0,12 % », signée pour la couleur. */
export function changeSince(open: number | undefined, last: number): { text: string; sign: -1 | 0 | 1 } | undefined {
  if (open === undefined || !open) return undefined;
  const pct = ((last - open) / open) * 100;
  const sign: -1 | 0 | 1 = pct > 0 ? 1 : pct < 0 ? -1 : 0;
  const text = `${sign > 0 ? "+" : sign < 0 ? "−" : ""}${decimalFormat(2).format(Math.abs(pct))} %`;
  return { text, sign };
}

/** Au-delà, la cotation n'est plus en direct : marché fermé ou à l'arrêt. */
export const STALE_MS = 5 * 60_000;

/** Vrai quand la dernière cotation est trop ancienne pour être en direct (marché fermé). */
export function isStale(quoteTime: number, now: number): boolean {
  return now - quoteTime > STALE_MS;
}

/**
 * Fin de la bougie en cours (epoch s) à l'instant `nowMs`, calée sur la
 * dernière bougie reçue, comme `applyQuote` : les journées et les 4 heures du
 * courtier ne sont pas alignées sur UTC. Sans cotation depuis la fin de la
 * dernière, c'est la fin de celle qui s'ouvrira sur sa grille.
 *
 * La semaine et le mois finissent à la clôture du vendredi (17 h à New York,
 * 23 h à Paris), comme sur TradingView, quand le courtier compte ses journées
 * depuis la clôture de New York (`nyAnchored`) : changement d'heure compris,
 * et un mois qui finit un week-end se termine le vendredi d'avant. Sinon, le
 * mois suit le calendrier (`nextMonthStart`) et la semaine dure 7 jours.
 */
export function candleEnd(lastT: number, nowMs: number, tfSeconds: number, monthly = false): number {
  const now = nowMs / 1000;
  if ((monthly || tfSeconds === TIMEFRAME_SECONDS["1w"]) && nyAnchored(lastT)) return monthly ? monthClose(lastT, now) : weekClose(lastT, now);
  if (monthly) {
    let end = nextMonthStart(lastT);
    while (end <= now) end = nextMonthStart(end);
    return end;
  }
  return lastT + (Math.max(0, Math.floor((now - lastT) / tfSeconds)) + 1) * tfSeconds;
}

/** L'heure de clôture de New York : le courtier y fait commencer ses journées (minuit chez lui, à UTC+2 ou UTC+3). */
const CLOSE_HOUR = 17;
const DAY = 86_400;
let nyFormat: Intl.DateTimeFormat | undefined;

/** L'heure qu'affiche New York à l'instant `t` (epoch s), écrite comme une heure UTC : ses champs se lisent par getUTC…(). */
function nyWall(t: number): number {
  nyFormat ??= new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p = Object.fromEntries(nyFormat.formatToParts(Math.floor(t) * 1000).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
}

/** L'instant (epoch s) où New York affiche l'heure `wall` (écrite comme une heure UTC). */
function fromNyWall(wall: number): number {
  let t = wall + 5 * 3600;
  for (let i = 0; i < 2; i++) t += wall - nyWall(t);
  return t;
}

/** Vrai quand la bougie s'ouvre à 17 h à New York : le courtier compte ses journées depuis la clôture de New York. */
export function nyAnchored(t: number): boolean {
  return nyWall(t) % DAY === CLOSE_HOUR * 3600;
}

/** Clôture de la semaine en cours : le vendredi à 17 h à New York, après l'ouverture de la bougie (samedi ou dimanche 17 h, minuit chez le courtier). */
function weekClose(lastT: number, now: number): number {
  let start = nyWall(lastT);
  // Pas encore de bougie pour cette semaine : la suivante, à la même heure de New York (le changement d'heure tombe un week-end).
  while (fromNyWall(start + 7 * DAY) <= now) start += 7 * DAY;
  const toFriday = (5 - new Date(start * 1000).getUTCDay() + 7) % 7 || 7;
  return fromNyWall(start + toFriday * DAY);
}

/** Clôture du mois en cours : son dernier jour à 17 h à New York (minuit du 1er chez le courtier), ramenée au vendredi s'il tombe un week-end. */
function monthClose(lastT: number, now: number): number {
  // Le mois de la bougie chez le courtier, 7 heures après New York : le 1er à minuit.
  const open = new Date((nyWall(lastT) + 7 * 3600) * 1000);
  const year = open.getUTCFullYear();
  let month = open.getUTCMonth();
  const lastDay = (m: number) => Date.UTC(year, m + 1, 0, CLOSE_HOUR) / 1000;
  while (fromNyWall(lastDay(month)) <= now) month++;
  let end = lastDay(month);
  // Samedi ou dimanche chez le courtier : rien ne cote, le mois a fermé le vendredi.
  const weekday = new Date(end * 1000).getUTCDay();
  if (weekday === 6) end -= DAY;
  else if (weekday === 0) end -= 2 * DAY;
  return fromNyWall(end);
}

/**
 * Secondes entières restantes avant la clôture de la bougie en cours, de
 * « durée − 1 » à 0, comme une horloge ; undefined sans cotation ou marché
 * fermé (dernière cotation trop ancienne) : pas de compte à rebours dans le vide.
 */
export function candleTimeLeft(lastT: number, quoteTimeMs: number | undefined, nowMs: number, tfSeconds: number, monthly = false): number | undefined {
  if (quoteTimeMs === undefined || isStale(quoteTimeMs, nowMs)) return undefined;
  const left = Math.floor((candleEnd(lastT, nowMs, tfSeconds, monthly) * 1000 - nowMs - 1) / 1000);
  // Une horloge en retard sur le courtier ne fait pas dépasser la durée de la bougie.
  return Math.max(0, monthly ? left : Math.min(left, tfSeconds - 1));
}

/**
 * Le temps restant, court et de largeur stable sur toute la bougie :
 * « 12:34 » jusqu'à l'heure, « 03:12:45 » pour les 4 heures et la journée
 * (même à moins d'une heure de la fin), « 2 j 05:12 » au-delà d'un jour
 * (semaine, mois), sans les secondes.
 */
export function formatTimeLeft(seconds: number, tfSeconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} j ${two(h)}:${two(m)}`;
  if (h > 0 || tfSeconds > 3600) return `${two(h)}:${two(m)}:${two(s % 60)}`;
  return `${two(m)}:${two(s % 60)}`;
}

/** Date et heure d'une cotation ancienne (« 31 oct. 22:59 »), en heure locale. */
export function quoteDate(ms: number): string {
  return dateFormat("quoteDate", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}
