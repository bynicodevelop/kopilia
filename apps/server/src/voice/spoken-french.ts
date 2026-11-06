/**
 * Transcription pour l'oral : ce que la synthèse vocale (Kokoro, phonèmes
 * espeak) lit mal est réécrit juste avant d'être dit. L'écran garde le texte
 * écrit. Chaque règle corrige une erreur constatée sur les phonèmes, par
 * exemple « 16h » lu « seize ache », « 4,85 % » lu sans « virgule », « -0,3 »
 * sans « moins », « PMI » lu comme un mot, « 2e » lu « deux e », un émoji
 * lu par son nom.
 */

const NB = "(?<![\\p{L}\\d])"; // début de mot
const NA = "(?![\\p{L}\\d])"; // fin de mot
const SP = "[ \\u00a0\\u202f]"; // espace, y compris insécables (typographie française)
const NUM = "\\d+(?:[.,]\\d+)?";

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Devises : forme parlée au singulier et au pluriel. */
const CURRENCIES: Record<string, [string, string]> = {
  USD: ["dollar", "dollars"],
  EUR: ["euro", "euros"],
  GBP: ["livre sterling", "livres sterling"],
  JPY: ["yen", "yens"],
  CHF: ["franc suisse", "francs suisses"],
  CAD: ["dollar canadien", "dollars canadiens"],
  AUD: ["dollar australien", "dollars australiens"],
  NZD: ["dollar néo-zélandais", "dollars néo-zélandais"],
  CNY: ["yuan", "yuans"],
};
const CODES = Object.keys(CURRENCIES).join("|");

/** Sigles qui se disent comme des mots (les autres sont épelés). */
const SAID_AS_WORDS: Record<string, string> = {
  OPEP: "OPEP",
  OTAN: "OTAN",
  ONU: "ONU",
  DAX: "DAX",
  CAC: "CAC",
  NASA: "NASA",
  UNESCO: "UNESCO",
  UNICEF: "UNICEF",
  SMIC: "SMIC",
  BRICS: "BRICS",
  COVID: "COVID",
  OVNI: "OVNI",
  ASEAN: "ASEAN",
  FIFA: "FIFA",
  UEFA: "UEFA",
  MEDEF: "MEDEF",
  URSSAF: "URSSAF",
  CNIL: "CNIL",
  SICAV: "SICAV",
  INSEE: "Insé",
  NASDAQ: "Nasdaq",
};

// --- Nombres en toutes lettres (ordinaux, accords au féminin) ---

const UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize"];
const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];

function below100(n: number): string {
  if (n <= 16) return UNITS[n];
  if (n < 20) return `dix-${UNITS[n - 10]}`;
  if (n < 70) {
    const tens = TENS[Math.floor(n / 10)];
    const u = n % 10;
    return u === 0 ? tens : u === 1 ? `${tens} et un` : `${tens}-${UNITS[u]}`;
  }
  if (n < 80) return n === 71 ? "soixante et onze" : `soixante-${below100(n - 60)}`;
  return n === 80 ? "quatre-vingts" : `quatre-vingt-${below100(n - 80)}`;
}

/** 0 à 999 en toutes lettres (« soixante et onze », « deux cents »). */
export function frenchNumber(n: number): string {
  if (n < 100) return below100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h === 1 ? "cent" : `${UNITS[h]} cent${r ? "" : "s"}`;
  return r ? `${head} ${below100(r)}` : head;
}

/** 2 -> « deuxième », 21 -> « vingt et unième » (espeak lit « 2e » « deux e »). */
export function frenchOrdinal(n: number, feminine = false): string {
  if (n === 1) return feminine ? "première" : "premier";
  const w = frenchNumber(n)
    .replace(/vingts$/, "vingt")
    .replace(/cents$/, "cent");
  if (w.endsWith("cinq")) return `${w}uième`;
  if (w.endsWith("neuf")) return `${w.slice(0, -1)}vième`;
  if (w.endsWith("e")) return `${w.slice(0, -1)}ième`;
  return `${w}ième`;
}

/**
 * « 16 heures », « une heure », « vingt et une minutes » : espeak accorde
 * les chiffres au masculin (« un heure »), on écrit en lettres ceux qui
 * finissent par « un ».
 */
export function femaleCount(n: number, singular: string, plural: string): string {
  if (n < 2) return `${n === 1 ? "une" : "0"} ${singular}`;
  const words = n < 1000 ? frenchNumber(n) : "";
  return words.endsWith(" un") || words.endsWith("-un") ? `${words}e ${plural}` : `${n} ${plural}`;
}

/** 16 h 30 -> « 16 heures 30 » ; minutes sans zéro initial (« 16 heures 5 »). */
export function spokenHour(hours: number, minutes = 0): string {
  const h = femaleCount(hours, "heure", "heures");
  return minutes ? `${h} ${minutes}` : h;
}

function romanValue(roman: string): number {
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const cur = v[roman[i]];
    const next = v[roman[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/** Singulier en dessous de 2 (« 1,5 milliard », « 2 milliards »). */
function agree(amount: string, singular: string, plural: string): string {
  return Math.abs(parseFloat(amount.replace(",", "."))) < 2 ? singular : plural;
}

function spellLetters(sigle: string): string {
  return sigle.split("").join(" ");
}

type Rule = [RegExp, (substring: string, ...groups: string[]) => string];
const rule = (src: string, fn: Rule[1], flags = "gu"): Rule => [new RegExp(src, flags), fn];

/** Règles, dans l'ordre : les plus spécifiques d'abord, l'épellation des sigles en dernier. */
const RULES: Rule[] = [
  // Émojis : espeak les lit par leur nom (« visage avec un léger sourire »).
  rule("\\p{Extended_Pictographic}\\uFE0F?", () => ""),

  // 24h/24, 7j/7.
  rule(`${NB}(\\d{1,2})${SP}?h${SP}?\\/${SP}?(\\d{1,2})${NA}`, (_, a, b) => `${a} heures sur ${b}`, "giu"),
  rule(`${NB}(\\d)${SP}?j${SP}?\\/${SP}?(\\d)${NA}`, (_, a, b) => `${a} jours sur ${b}`, "giu"),

  // Paires de devises : EUR/USD -> « euro dollar ».
  rule(`${NB}(${CODES})${SP}?\\/${SP}?(${CODES})${NA}`, (_, a, b) => `${CURRENCIES[a][0]} ${CURRENCIES[b][0]}`),

  // Variations des indicateurs : m/m, y/y, q/q.
  rule(`${NB}(?:m\\/m|MoM)${NA}`, () => "sur un mois", "giu"),
  rule(`${NB}(?:y\\/y|a\\/a|YoY)${NA}`, () => "sur un an", "giu"),
  rule(`${NB}(?:q\\/q|t\\/t|QoQ)${NA}`, () => "sur un trimestre", "giu"),

  // Unités.
  rule(`(\\d)${SP}?km\\/h${NA}`, (_, d) => `${d} kilomètres heure`),
  rule(`(\\d)${SP}?km²`, (_, d) => `${d} kilomètres carrés`),
  rule(`(\\d)${SP}?m²`, (_, d) => `${d} mètres carrés`),
  rule(`(\\d)${SP}?m³`, (_, d) => `${d} mètres cubes`),
  rule(`(\\d)${SP}?kWh${NA}`, (_, d) => `${d} kilowattheures`),
  rule(`(\\d)${SP}?°${SP}?C${NA}`, (_, d) => `${d} degrés`),
  rule(`(\\d)${SP}?°${SP}?F${NA}`, (_, d) => `${d} degrés Fahrenheit`),

  // Dates : 02/11/2026 -> « 2 novembre 2026 » ; « le 2/11 » -> « le 2 novembre ».
  rule(`${NB}(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}|\\d{2})${NA}`, (all, d, m, y) =>
    Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12 ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.length === 2 ? `20${y}` : y}` : all,
  ),
  rule(
    `(${NB}(?:le|du|au|dès le|depuis le|jusqu'au)${SP})(\\d{1,2})\\/(\\d{1,2})${NA}`,
    (all, lead, d, m) => (Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12 ? `${lead}${Number(d)} ${MONTHS[Number(m) - 1]}` : all),
    "giu",
  ),
  // Fractions et notes : 1/2 -> « un demi », 4/5 -> « 4 sur 5 ».
  rule(`${NB}(\\d{1,3})${SP}?\\/${SP}?(\\d{1,3})${NA}`, (all, a, b) => {
    const fractions: Record<string, string> = { "1/2": "un demi", "1/3": "un tiers", "2/3": "deux tiers", "1/4": "un quart", "3/4": "trois quarts" };
    if (fractions[`${a}/${b}`]) return fractions[`${a}/${b}`];
    return Number(a) < Number(b) && Number(b) <= 100 ? `${a} sur ${b}` : all;
  }),

  // Heures : 16h, 16 h 30, 16:00 -> « 16 heures », « 16 heures 30 ». Pas « km/h ».
  rule(
    `(?<![\\p{L}\\d/:.,])(\\d{1,2})${SP}?h(?:${SP}?(\\d{2}))?${NA}`,
    (all, h, m) => (m && Number(m) > 59 ? all : spokenHour(Number(h), Number(m ?? 0))),
    "giu",
  ),
  rule(`(?<![\\p{L}\\d:.,])(\\d{1,2}):(\\d{2})(?![\\d:])`, (all, h, m) => (Number(h) > 23 || Number(m) > 59 ? all : spokenHour(Number(h), Number(m)))),
  // Heure d'une cotation à la seconde : 11:43:04 -> « 11 heures 43 et 4 secondes ».
  rule(`(?<![\\p{L}\\d:.,])(\\d{1,2}):(\\d{2}):(\\d{2})(?![\\d:])`, (all, h, m, s) => {
    if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) return all;
    const hour = spokenHour(Number(h), Number(m));
    return Number(s) ? `${hour} et ${femaleCount(Number(s), "seconde", "secondes")}` : hour;
  }),
  // 9 heures-17 heures -> « 9 heures à 17 heures ».
  rule(`(heures?(?: \\d{1,2})?)${SP}?[-–]${SP}?(?=\\d|une heure|vingt et une)`, (_, a) => `${a} à `),

  // Montants : 1,2 Md€, 300 M$, 50 k€.
  rule(`(${NUM})${SP}?(k|K|M|Mds?|Mrds?)${SP}?(€|\\$)`, (_, n, mag, cur) => {
    const euro = cur === "€";
    if (/^k$/i.test(mag)) return `${n} mille ${euro ? "euros" : "dollars"}`;
    const word = mag === "M" ? agree(n, "million", "millions") : agree(n, "milliard", "milliards");
    return `${n} ${word} ${euro ? "d'euros" : "de dollars"}`;
  }),
  rule(`(${NUM})${SP}?(?:Mds|Mrds?)${NA}`, (_, n) => `${n} ${agree(n, "milliard", "milliards")}`),
  // 4,50 € -> « 4 euros 50 » (espeak tait la virgule).
  rule(`(\\d+)[.,](\\d{2})${SP}?(€|\\$)`, (_, units, cents, cur) => {
    const [s, p] = cur === "€" ? ["euro", "euros"] : ["dollar", "dollars"];
    return `${units} ${agree(units, s, p)} ${Number(cents)}`;
  }),
  // $75, €12, £5 -> « 75 dollars », « 12 euros », « 5 livres ».
  rule(
    `([$€£])${SP}?(${NUM})`,
    (_, cur, n) => `${n} ${cur === "$" ? agree(n, "dollar", "dollars") : cur === "€" ? agree(n, "euro", "euros") : agree(n, "livre", "livres")}`,
  ),
  // 75 USD -> « 75 dollars ».
  rule(`(${NUM})${SP}?(${CODES})${NA}`, (_, n, code) => `${n} ${agree(n, CURRENCIES[code][0], CURRENCIES[code][1])}`),

  // Ordres de grandeur du calendrier économique : 63K, 7.11M, -56.2B, 3.26T.
  rule(`(?<![\\p{L}\\d.,])(${NUM})([kKMBT])${NA}`, (_, n, s) => {
    if (s === "k" || s === "K") return `${n} mille`;
    if (s === "M") return `${n} ${agree(n, "million", "millions")}`;
    if (s === "B") return `${n} ${agree(n, "milliard", "milliards")}`;
    return `${n} mille milliards`;
  }),

  // Points de base, points, minutes.
  rule(`(${NUM})${SP}?(?:pb|pdb|bps|bp)${NA}`, (_, n) => `${n} ${agree(n, "point de base", "points de base")}`),
  rule(`(${NUM})${SP}?pts?${NA}`, (_, n) => `${n} ${agree(n, "point", "points")}`),
  rule(`(\\d+)${SP}?(?:min|mn)${NA}`, (_, n) => femaleCount(Number(n), "minute", "minutes")),
  // … et ses secondes : « 11 h 49 min 50 s » (espeak lirait la lettre « s »).
  rule(`(minutes?${SP})(\\d{1,2})${SP}?s${NA}`, (_, min, n) => `${min}${femaleCount(Number(n), "seconde", "secondes")}`),

  // Trimestres et semestres : T3 2026, Q3, S1 2026.
  rule(`${NB}[QT]([1-4])${SP}(\\d{4})${NA}`, (_, q, y) => `${frenchOrdinal(Number(q))} trimestre ${y}`),
  rule(`${NB}Q([1-4])${NA}`, (_, q) => `${frenchOrdinal(Number(q))} trimestre`),
  rule(`${NB}[SH]([12])${SP}(\\d{4})${NA}`, (_, s, y) => `${frenchOrdinal(Number(s))} semestre ${y}`),

  // Ordinaux : 2e, 3ème, XXe siècle (espeak lit « deux e », « iksgze »).
  rule(`${NB}1(?:re|ère)${NA}`, () => "première"),
  rule(`${NB}1er${NA}`, () => "premier"),
  rule(`${NB}2(?:nde?)${NA}`, (s) => (s.endsWith("e") ? "seconde" : "second")),
  rule(`${NB}(\\d{1,3})(?:e|ème|eme|è|ᵉ)${NA}`, (all, n) => (Number(n) >= 2 ? frenchOrdinal(Number(n)) : all)),
  rule(`${NB}([IVXLC]{2,}|[IVXLC](?=(?:e|ème)${SP}(?:siècle|République|arrondissement)))(?:e|ème)${NA}`, (_, r) => frenchOrdinal(romanValue(r))),
  // « le 1 novembre » -> « le 1er novembre » (espeak dirait « un »).
  rule(`${NB}1${SP}(?=(?:${MONTHS.join("|")})${NA})`, () => "premier "),

  // Signes : espeak tait le « - » de « -0,3 % ».
  rule(`(^|[\\s(\\[:;,/])[-−](?=\\d)`, (_, lead) => `${lead}moins `),
  rule(`(^|[\\s(\\[:;,/])\\+(?=\\d)`, (_, lead) => `${lead}plus `),

  // Milliers séparés par une espace insécable (« 21 540 » d'Intl en fr-FR) : espeak
  // y lirait « vingt et un cinq cent quarante » ; avec une espace simple, « vingt et un mille… ».
  rule(`(?<=\\d)[\\u00a0\\u202f](?=\\d{3}(?!\\d))`, () => " "),

  // Décimales : 4,85 et 4.85 -> « 4 virgule 85 » (pas 02.11.2026 ni 1.2.3). Au-delà de
  // trois chiffres, chiffre par chiffre, comme on lit un cours à l'écran : 1,34144 ->
  // « 1 virgule 3 4 1 4 4 » (espeak dirait « trente-quatre mille cent quarante-quatre »).
  rule(`(?<![\\d.,])(\\d+)[.,](\\d+)(?!\\d|[.,]\\d)`, (_, a, b) => `${a} virgule ${b.length > 3 ? b.split("").join(" ") : b}`),

  // Multiplications : x2 -> « multiplié par 2 ».
  rule(`${NB}[x×](\\d+(?:[.,]\\d+)?)${NA}`, (_, n) => `multiplié par ${n}`),

  // Abréviations.
  rule(`${NB}vs\\.?${NA}`, () => "contre", "giu"),
  rule(`${NB}[nN]°${SP}?`, () => "numéro "),
  rule(`${NB}MM\\.${SP}`, () => "messieurs "),
  rule(`${NB}M\\.${SP}(?=\\p{Lu})`, () => "monsieur "),
  rule(`${NB}p\\.${SP}?ex\\.`, () => "par exemple"),
  rule(`${NB}env\\.(?=${SP}?\\d)`, () => "environ", "giu"),

  // Sigles : épelés (espeak lit « PMI » comme un mot), sauf ceux qui se disent comme des mots.
  rule(`${NB}Bo([EJ])${NA}`, (_, l) => `B O ${l}`),
  // (pas un mot composé en capitales comme « ÉTATS-UNIS »)
  rule(`(?<![\\p{L}\\d]|\\p{L}-)([A-Z]{2,6})(s?)(?![\\p{L}\\d]|-\\p{L})`, (_, sigle) => SAID_AS_WORDS[sigle] ?? spellLetters(sigle)),
  // « L'I S M » se lirait « L apostrophe I » : « l'I S M ».
  rule(`${NB}L'(?=\\p{Lu}(?:\\s|$))`, () => "l'"),
];

export function spokenFrench(text: string): string {
  let out = text;
  for (const [re, fn] of RULES) out = out.replace(re, fn as (substring: string, ...args: unknown[]) => string);
  return out.replace(/[ \t]{2,}/g, " ").trim();
}
