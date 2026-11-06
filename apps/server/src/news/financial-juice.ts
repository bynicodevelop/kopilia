/*
 * Le flux RSS de FinancialJuice (https://www.financialjuice.com/feed.ashx?xy=rss),
 * lié depuis la page d'accueil du site : les 100 derniers titres, sans
 * catégorie ni importance. Ni JSON ni API. Derrière Cloudflare : deux lectures
 * trop rapprochées reçoivent « error code: 1015 » (limite de débit), d'où un
 * rythme lent et jamais de contournement. Pur, testé à plat.
 */

/** Un titre du flux, tel que publié. */
export interface FeedItem {
  /** Identifiant du site (guid), stable. */
  guid: string;
  /** Instant de publication (epoch ms). */
  at: number;
  /** Le titre sans le préfixe « FinancialJuice: ». */
  title: string;
  link?: string;
  /** Le texte, rare (quelques titres sur cent), sans balises. */
  text?: string;
}

export class FeedError extends Error {
  constructor(
    message: string,
    /** Le site limite le débit (Cloudflare 1015, 429) : attendre plus longtemps. */
    readonly limited = false,
  ) {
    super(message);
  }
}

const PREFIX = /^\s*FinancialJuice:\s*/i;

/** Les titres du flux, du plus récent au plus ancien ; un document qui n'est pas un flux RSS lève FeedError. */
export function parseRss(body: string): FeedItem[] {
  if (/error code:\s*1015/i.test(body)) throw new FeedError("limite de débit du site (1015)", true);
  if (!/<rss[\s>]/i.test(body) || !/<channel[\s>]/i.test(body)) throw new FeedError("réponse inattendue : pas un flux RSS");
  const items: FeedItem[] = [];
  for (const m of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const raw = m[1];
    const guid = tag(raw, "guid");
    const title = tag(raw, "title");
    const at = Date.parse(tag(raw, "pubDate") ?? "");
    if (!guid || !title || !Number.isFinite(at)) continue;
    const text = tag(raw, "description");
    const link = tag(raw, "link");
    items.push({
      guid: guid.trim(),
      at,
      title: decode(title).replace(PREFIX, "").replace(/\s+/g, " ").trim(),
      ...(link ? { link: decode(link).trim() } : {}),
      ...(text && plain(text) ? { text: plain(text) } : {}),
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

/** Le contenu d'une balise (CDATA compris), ou undefined. */
function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${name}>)`, "i").exec(xml);
  if (!m || m[1] === undefined) return undefined;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return cdata ? cdata[1] : m[1];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Les entités XML et HTML courantes, décodées. */
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Un texte HTML (échappé dans le flux) en texte simple : une ligne par élément de liste ou paragraphe. */
export function plain(html: string): string {
  return decode(decode(html))
    .replace(/<\s*(br|\/li|\/p|\/div)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Un chiffre publié, lu dans un titre « … Actual 189k (Forecast 196k, Previous 194k, Revised 195K) ». */
export interface ParsedFigure {
  event: string;
  actual: string;
  forecast?: string;
  previous?: string;
  revised?: string;
}

/** Le chiffre publié d'un titre, ou undefined (la plupart des titres n'en ont pas). */
export function parseFigure(title: string): ParsedFigure | undefined {
  const m = /^(.+?)\s+Actual\s+(\S+)\s*(?:\(([^)]*)\))?\s*\.?\s*$/i.exec(title.trim());
  if (!m) return undefined;
  const out: ParsedFigure = { event: m[1].trim(), actual: m[2] };
  for (const part of (m[3] ?? "").split(",")) {
    const p = /^\s*(Forecast|Previous|Revised)\s+(.+?)\s*$/i.exec(part);
    if (!p || p[2] === "-") continue;
    out[p[1].toLowerCase() as "forecast" | "previous" | "revised"] = p[2];
  }
  return out;
}

/** Les aperçus de l'offre payante du site : le titre seul, l'analyse est réservée. */
export function isElite(title: string): boolean {
  return /\bFJElite\b/i.test(title);
}

/* -------------------- Rapprochement avec le calendrier -------------------- */

/** Le pays en tête d'un indicateur (« US », « UK », « Japan ») et la devise du calendrier. */
const COUNTRIES: Array<[RegExp, string]> = [
  [/^(US|USA|U\.S\.|United States|EIA|API)\b/i, "USD"],
  [/^(EZ|EU|Eurozone|Euro Zone|German[y]?|France|French|Ital(y|ian)|Spain|Spanish|ECB)\b/i, "EUR"],
  [/^(UK|GB|Britain|British)\b/i, "GBP"],
  [/^(Japan|Japanese|JP)\b/i, "JPY"],
  [/^(Canada|Canadian|CA)\b/i, "CAD"],
  [/^(Australia|Australian|AU)\b/i, "AUD"],
  [/^(New Zealand|NZ)\b/i, "NZD"],
  [/^(China|Chinese|CN)\b/i, "CNY"],
  [/^(Swiss|Switzerland|CH)\b/i, "CHF"],
];

/** La devise de l'indicateur, d'après son début ; undefined si on ne sait pas. */
export function figureCurrency(event: string): string | undefined {
  return COUNTRIES.find(([re]) => re.test(event.trim()))?.[1];
}

/** Mots qui ne distinguent pas deux indicateurs (pays, période, révision). */
const STOP = new Set([
  "us",
  "usa",
  "uk",
  "ez",
  "eu",
  "eurozone",
  "german",
  "germany",
  "france",
  "french",
  "italy",
  "italian",
  "spain",
  "spanish",
  "japan",
  "japanese",
  "canada",
  "canadian",
  "australia",
  "australian",
  "new",
  "zealand",
  "nz",
  "china",
  "chinese",
  "swiss",
  "switzerland",
  "prelim",
  "preliminary",
  "flash",
  "final",
  "initial",
  "actual",
  "sa",
  "nsa",
  "the",
  "of",
  "rate",
  "change",
  "eia",
  "api",
  "bcf",
  "index",
  "s",
  "month",
  "monthly",
  "quarter",
  "quarterly",
  "annual",
  "annualized",
  "nonfarm",
  "non",
  "farm",
]);

/** Synonymes d'un site à l'autre (« jobless » chez FinancialJuice, « unemployment » chez Forex Factory). */
const SYNONYMS: Record<string, string> = {
  jobless: "unemployment",
  storage: "gas",
  inventories: "stocks",
  crude: "oil",
  cpi: "consumer",
  ppi: "producer",
  pmi: "pmi",
  gdp: "gdp",
  payrolls: "employment",
  nfp: "employment",
  labour: "labor",
  hpi: "house",
};

function words(title: string): Set<string> {
  const out = new Set<string>();
  // La période distingue deux annonces de la même minute (« CPI m/m » et « CPI y/y ») : gardée, sous une seule forme.
  const periods = title
    .toLowerCase()
    .replace(/\bm\/m\b|\bmom\b/g, " mm ")
    .replace(/\by\/y\b|\byoy\b/g, " yy ")
    .replace(/\bq\/q\b|\bqoq\b/g, " qq ");
  for (const raw of periods.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)) {
    if (!raw || STOP.has(raw)) continue;
    const w = SYNONYMS[raw] ?? raw;
    if (w) out.add(w);
  }
  return out;
}

/** Ressemblance de deux noms d'indicateurs (0 à 1). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** Une annonce du calendrier, ce qu'il faut pour la rapprocher. */
export interface CalendarCandidate {
  at: number;
  country: string;
  title: string;
  impact: string;
  forecast: string | null;
}

/** Écart toléré entre l'heure de l'annonce et celle de la news. */
export const MATCH_WINDOW_MS = 3 * 60_000;
const MIN_SIMILARITY = 0.3;

/**
 * Rapproche des chiffres publiés de leurs annonces : même devise, à quelques
 * minutes près, et le nom le plus ressemblant ; une annonce ne reçoit qu'un
 * chiffre (le plus ressemblant d'abord). Renvoie, pour chaque chiffre, son
 * annonce ou undefined.
 */
export function matchFigures<F extends { at: number; figure: ParsedFigure }>(figures: F[], events: CalendarCandidate[]): Array<CalendarCandidate | undefined> {
  const pairs: Array<{ f: number; e: number; score: number }> = [];
  figures.forEach((f, fi) => {
    const currency = figureCurrency(f.figure.event);
    events.forEach((e, ei) => {
      if (Math.abs(e.at - f.at) > MATCH_WINDOW_MS) return;
      if (currency && currency !== e.country) return;
      const score = similarity(f.figure.event, e.title);
      if (score >= MIN_SIMILARITY) pairs.push({ f: fi, e: ei, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const out: Array<CalendarCandidate | undefined> = figures.map(() => undefined);
  const usedEvents = new Set<number>();
  for (const p of pairs) {
    if (out[p.f] || usedEvents.has(p.e)) continue;
    out[p.f] = events[p.e];
    usedEvents.add(p.e);
  }
  return out;
}
