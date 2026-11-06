/**
 * Les prix que Kopilia cite, repérés dans le texte de sa réponse pour que le
 * graphique les allume au moment où ils sont dits. Fonctions pures : trouver
 * les prix écrits (« 4 072,42 », « la zone 4 141–4 150 », « entre 1,1650 et
 * 1,1700 »), en écartant ce qui n'en est pas (heures, pourcentages, longueurs
 * de moyennes, valeurs du RSI, ratios de Fibonacci) ; dire de quel graphique
 * ouvert ils parlent ; trouver, sur ce graphique, ce qui est à ce prix.
 */

/** Un prix (ou une zone de prix) cité dans la réponse. */
export interface PriceMention {
  /** Sa place dans le texte de la réponse : début inclus, fin exclue. */
  start: number;
  end: number;
  /** Le prix cité ; une zone : ses deux bornes (low ≤ high). */
  low: number;
  high: number;
  /** Décimales écrites (« 4 072,42 » : 2) : la précision du prix cité. */
  decimals: number;
  /** Le produit nommé en dernier avant lui dans la réponse (« l'or », « le Nasdaq ») : sa famille. */
  product?: string;
}

/** Un graphique ouvert, tel que le repérage le voit. */
export interface ChartRef {
  symbol: string;
  /** Sa famille (« or », « nasdaq »…), si on la connaît. */
  product?: string;
  /** Son dernier prix. */
  last: number;
  digits?: number;
}

/** Ce qui peut s'allumer sur un graphique : un prix (ligne) ou une bande (zone). */
export type SpotLevel<K> = { key: K; price: number } | { key: K; top: number; bottom: number };

/** Un prix cité reste allumé ce temps-là (ms), sur le graphique et dans le texte, puis s'éteint. */
export const SPOT_MS = 3000;

/** Un prix cité, allumé sur les graphiques de son produit. */
export interface SpokenPrice extends PriceMention {
  id: number;
  symbol: string;
  /** Quand il a été dit (Date.now). */
  at: number;
}

/** Plus loin que cela du dernier prix (en proportion), un nombre n'est pas un prix de ce graphique. */
export const MAX_GAP = 0.12;

const SP = "[ \\u00A0\\u202F]";
/** Un nombre écrit à la française : milliers séparés par une espace, décimales après une virgule (ou un point). */
const NUMBER = `\\d{1,3}(?:${SP}\\d{3})+(?![\\d])|\\d+`;
/** Ni collé à un mot (« d_06bf92 »), ni précédé d'un signe (« +65 000 » : une variation). */
const NUMBER_RE = new RegExp(`(?<![\\w,.+−-])(${NUMBER})(?:[,.](\\d+))?(?![\\w])`, "g");
/** Entre deux prix d'une zone : un tiret (« 4 141–4 150 »). */
const DASH_RE = new RegExp(`^${SP}?[–—-]${SP}?`);
/** « entre 4 056 et 4 088 ». */
const AND_RE = new RegExp(`^${SP}+et${SP}+`);
/** « la zone de 4 056 à 4 088 ». */
const TO_RE = new RegExp(`^${SP}+à${SP}+`);

const MONTHS = "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";
/** Après le nombre : ce n'est pas un prix (heure, pourcentage, durée, compte, date). */
const NOT_PRICE_AFTER = new RegExp(
  `^(?:${SP}?%|${SP}?:\\d|${SP}*(?:h\\b|h\\d|pour${SP}cent|pour${SP}\\d|pips?\\b|ticks?\\b|R\\b|fois\\b|contrats?\\b|lots?\\b|ans?\\b|jours?\\b|semaines?\\b|mois\\b|heures?\\b|minutes?\\b|min\\b|secondes?\\b|s\\b|emplois?\\b|créations?\\b|postes?\\b|attendu(?:e|s|es)?\\b|demandes?\\b|${SP}*à${SP}+\\d+${SP}?%|bougies?\\b|séances?\\b|périodes?\\b|ème\\b|e\\b|er\\b|ère\\b|(?:${MONTHS})\\b))`,
  "i",
);
/**
 * Juste avant le nombre : une longueur d'indicateur (« la moyenne simple 200 »,
 * « les exponentielles 50 et 200 », « la MME 100 »), ou le nom d'un indice
 * (« le Nasdaq 100 », « le S&P 500 »).
 */
const LENGTH_BEFORE =
  /\b(?:simples?|exponentielles?|pondérées?|lissées?|hull|moyennes?|mm[esp]?|ema|sma|wma|rsi|période|périodes|longueur|nasdaq|s&p|cac|nikkei|russell|stoxx|ftse|dax|asx|ibex|aex)(?:[\s\u00A0\u202F,]+(?:\d+|et))*[\s\u00A0\u202F]*$/i;
/** « la 200 » : la moyenne 200, pas un prix. */
const MA_LENGTHS = new Set([5, 8, 9, 10, 12, 13, 14, 20, 21, 26, 34, 50, 55, 89, 100, 144, 200]);
/** Les mots d'avant, où un oscillateur se cache (« le RSI 14 est à 68,4 »). */
const OSCILLATOR = /\b(?:rsi|stochastique|macd|adx|atr|cci)\b/i;
const MONTH_BEFORE = new RegExp(`(?:${MONTHS})${SP}+$`, "i");
/** Les ratios de Fibonacci, tels qu'on les écrit (« le 0,618 ») ; un prix s'écrit avec toutes ses décimales. */
const FIB_RATIOS = new Set([0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786, 0.886, 1.272, 1.414, 1.618, 2.618]);
/** Avant « de A à B » : une zone, et non un trajet (« monté de 4 000 à 4 120 »). */
const ZONE_WORDS = /\b(?:zone|range|bande|fourchette|canal)\b/i;

/** Les familles de produits, pour savoir de quoi parle la phrase (« l'or », « le Nasdaq ») ; `sym` : leurs symboles chez les courtiers. */
const PRODUCTS: Array<{ key: string; text: RegExp; sym: RegExp }> = [
  { key: "or", text: /\bl['’]or\b|\bgold\b|\bxau(?:usd)?\b|\bmgc\b/i, sym: /^(?:XAU|GOLD)/i },
  { key: "argent", text: /\bl['’]argent\b|\bsilver\b|\bxag(?:usd)?\b/i, sym: /^(?:XAG|SILVER)/i },
  { key: "platine", text: /\bplatine\b|\bplatinum\b/i, sym: /^(?:XPT|PLATINUM)/i },
  { key: "cuivre", text: /\bcuivre\b|\bcopper\b/i, sym: /^(?:XCU|COPPER|USCOPPER)/i },
  { key: "nasdaq", text: /\bnasdaq\b|\bnas100\b|\bus100\b|\bustec\b|\bmnq\b|\bnq\b/i, sym: /^(?:NAS|US100|USTEC|NDX|NQ)/i },
  { key: "dow", text: /\bdow\b|\bdj30\b|\bus30\b|\bym\b|\bmym\b/i, sym: /^(?:US30|DJ|WS30|USA30)/i },
  { key: "sp", text: /\bs\s?&\s?p\b|\bspx\b|\bus500\b/i, sym: /^(?:US500|SPX|SP500|USA500)/i },
  { key: "russell", text: /\brussell\b|\bus2000\b/i, sym: /^(?:US2000|RUSSELL|RUT)/i },
  { key: "dax", text: /\bdax\b|\bger40\b/i, sym: /^(?:GER|DE[34]0|DAX)/i },
  { key: "cac", text: /\bcac\b/i, sym: /^(?:FRA40|FR40|CAC|F40)/i },
  { key: "stoxx", text: /\bstoxx\b|\beu50\b/i, sym: /^(?:EU50|EUSTX|STOXX|ESTX)/i },
  { key: "ftse", text: /\bftse\b|\buk100\b/i, sym: /^(?:UK100|FTSE)/i },
  { key: "nikkei", text: /\bnikkei\b|\bjp225\b|\bjpn225\b/i, sym: /^(?:JPN225|JP225|NIKKEI|N225)/i },
  { key: "petrole", text: /\bp[ée]trole\b|\bwti\b|\bbrent\b|\bbaril\b|\busoil\b|\bukoil\b/i, sym: /^(?:USOIL|UKOIL|USWTI|UKBRENT|WTI|XTI|XBR|BRENT|CRUDE)/i },
  { key: "gaz", text: /\bgaz\b|\bnatgas\b/i, sym: /^(?:XNG|NATGAS|NGAS|USGAS|NATURALGAS)/i },
  { key: "dxy", text: /\bindice dollar\b|\bdxy\b/i, sym: /^(?:DXY|USDX|USDINDEX|DOLLARINDEX)/i },
  { key: "bitcoin", text: /\bbitcoin\b|\bbtc\b/i, sym: /^(?:BTC|XBT|BITCOIN)/i },
  { key: "ether", text: /\bether(?:eum)?\b|\beth\b/i, sym: /^(?:ETH)/i },
  { key: "eurusd", text: /\beuro[- ]dollar\b|\beur\/?usd\b/i, sym: /^EURUSD/i },
  { key: "gbpusd", text: /\blivre[- ]dollar\b|\bcable\b|\bgbp\/?usd\b/i, sym: /^GBPUSD/i },
  { key: "usdjpy", text: /\bdollar[- ]yen\b|\busd\/?jpy\b/i, sym: /^USDJPY/i },
  { key: "usdchf", text: /\bdollar[- ]franc\b|\busd\/?chf\b/i, sym: /^USDCHF/i },
  { key: "audusd", text: /\bdollar australien\b|\baussie\b|\baud\/?usd\b/i, sym: /^AUDUSD/i },
  { key: "usdcad", text: /\bdollar canadien\b|\bloonie\b|\busd\/?cad\b/i, sym: /^USDCAD/i },
  { key: "nzdusd", text: /\bdollar néo-zélandais\b|\bkiwi\b|\bnzd\/?usd\b/i, sym: /^NZDUSD/i },
  { key: "eurgbp", text: /\beuro[- ]livre\b|\beur\/?gbp\b/i, sym: /^EURGBP/i },
  { key: "eurjpy", text: /\beuro[- ]yen\b|\beur\/?jpy\b/i, sym: /^EURJPY/i },
  { key: "gbpjpy", text: /\blivre[- ]yen\b|\bgbp\/?jpy\b/i, sym: /^GBPJPY/i },
];

/** La famille d'un produit affiché, d'après son symbole chez le courtier. */
export function productOf(symbol: string): string | undefined {
  return PRODUCTS.find((p) => p.sym.test(symbol))?.key;
}

/** Les produits nommés dans le texte, dans l'ordre : leur place et leur famille. */
function namedProducts(text: string): Array<{ at: number; key: string }> {
  const out: Array<{ at: number; key: string }> = [];
  for (const p of PRODUCTS) {
    const re = new RegExp(p.text.source, "gi");
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ at: m.index + m[0].length, key: p.key });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** « 4 072,42 » -> 4072.42 et ses décimales. */
function parseNumber(int: string, dec: string | undefined): { value: number; decimals: number } {
  const digits = int.replace(/[ \u00A0\u202F]/g, "");
  return { value: Number(dec ? `${digits}.${dec}` : digits), decimals: dec ? dec.length : 0 };
}

/** « 4 141–50 » : la seconde borne abrégée, complétée avec le début de la première (4 150). */
function completeBound(a: number, b: number, bDecimals: number): number {
  if (b >= a || bDecimals) return b;
  const len = String(Math.trunc(b)).length;
  if (len >= String(Math.trunc(a)).length) return b;
  const unit = 10 ** len;
  let full = Math.floor(a / unit) * unit + b;
  if (full < a) full += unit;
  return full;
}

/** Ce nombre, à cette place, n'est pas un prix (heure, durée, longueur d'indicateur, valeur d'oscillateur, ratio). */
function notAPrice(text: string, start: number, end: number, value: number, decimals: number): boolean {
  if (NOT_PRICE_AFTER.test(text.slice(end))) return true;
  const before = text.slice(Math.max(0, start - 40), start);
  if (!decimals && LENGTH_BEFORE.test(before)) return true;
  if (!decimals && MA_LENGTHS.has(value) && /\bla[\s\u00A0\u202F]+$/i.test(before)) return true;
  if (MONTH_BEFORE.test(before)) return true;
  // Les minutes d'une heure (« 18 h 15 », « 11:43:04 »), le second terme d'un rapport (« 2 pour 1 »).
  if (/\d[\s\u00A0\u202F]?h[\s\u00A0\u202F]?$|:$|\d[\s\u00A0\u202F]+pour[\s\u00A0\u202F]+$/i.test(before)) return true;
  // Un oscillateur dans les cinq mots d'avant, sans ponctuation entre eux : sa longueur ou sa valeur (« le RSI 14 est à 68,4 »).
  const clause = before.split(/[.;:!?,](?=[\s\u00A0\u202F])/).pop() ?? "";
  const words = clause
    .split(/[\s\u00A0\u202F]+/)
    .filter(Boolean)
    .slice(-5)
    .join(" ");
  if (OSCILLATOR.test(words)) return true;
  if (decimals > 0 && decimals <= 3 && FIB_RATIOS.has(value)) return true;
  return false;
}

/**
 * Les prix cités dans `text` (le texte de la réponse reçu jusqu'ici). Une
 * citation qui touche la fin du texte pourrait continuer (« 4 141– » attend sa
 * seconde borne) : tant que `final` est faux, elle attend.
 */
export function findPrices(text: string, final = true): PriceMention[] {
  const out: PriceMention[] = [];
  const names = namedProducts(text);
  const re = new RegExp(NUMBER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    let end = start + m[0].length;
    const a = parseNumber(m[1], m[2]);
    let low = a.value;
    let high = a.value;
    let decimals = a.decimals;
    // Une zone : « A–B », « entre A et B », « la zone de A à B ».
    const rest = text.slice(end);
    const before = text.slice(Math.max(0, start - 40), start);
    const link =
      DASH_RE.exec(rest) ??
      (/\bentre[\s\u00A0\u202F]+$/i.test(before) ? AND_RE.exec(rest) : null) ??
      (ZONE_WORDS.test(
        before
          .split(/[\s\u00A0\u202F]+/)
          .slice(-5)
          .join(" "),
      ) && /\bde[\s\u00A0\u202F]+$/i.test(before)
        ? TO_RE.exec(rest)
        : null);
    if (link) {
      const second = new RegExp(`^(?:${NUMBER})(?:[,.](\\d+))?(?![\\d])`).exec(rest.slice(link[0].length));
      if (second) {
        const int = second[0].replace(/[,.]\d+$/, "");
        const b = parseNumber(int, second[1]);
        const bound = completeBound(a.value, b.value, b.decimals);
        low = Math.min(a.value, bound);
        high = Math.max(a.value, bound);
        decimals = Math.max(decimals, b.decimals);
        end += link[0].length + second[0].length;
        re.lastIndex = end;
      }
    }
    // Au bout du texte reçu, la citation peut continuer (« 4 1 » avant « 4 141 », « 4 141– » avant sa seconde borne).
    // « 3 919,92, » est complet : une virgule suivie d'une espace n'annonce pas de décimales.
    if (!final && /^(?:[,.]\d*|[\s\u00A0\u202F]*(?:[–—-]|et?|à)?[\s\u00A0\u202F]*\d*)$/.test(text.slice(end))) break;
    if (notAPrice(text, start, end, a.value, a.decimals)) continue;
    const product = names.filter((n) => n.at <= start).pop()?.key;
    out.push({ start, end, low, high, decimals, ...(product ? { product } : {}) });
  }
  return out;
}

/** Écart (en proportion) entre une citation et le dernier prix : 0 s'il est dedans. */
function gap(m: Pick<PriceMention, "low" | "high">, last: number): number {
  if (!(last > 0)) return Infinity;
  if (m.low > last) return m.low / last - 1;
  if (m.high < last) return 1 - m.high / last;
  return 0;
}

/**
 * Le graphique ouvert dont parle ce prix : celui du produit nommé, ou le plus
 * proche par le prix ; aucun s'il est trop loin de tous (« 44 dollars de
 * risque » n'est pas un prix de l'or), ou si la phrase nomme un produit qui
 * n'est pas affiché.
 */
export function chartFor(m: PriceMention, charts: readonly ChartRef[]): string | undefined {
  let best: { symbol: string; gap: number } | undefined;
  for (const c of charts) {
    if (m.product && c.product && c.product !== m.product) continue;
    if (c.digits !== undefined && m.decimals > c.digits + 1) continue;
    const g = gap(m, c.last);
    if (g > MAX_GAP) continue;
    if (!best || g < best.gap) best = { symbol: c.symbol, gap: g };
  }
  return best?.symbol;
}

/** La tolérance d'un prix cité : un prix rond (« vers 4 010 ») est approché, un prix à décimales est exact. */
export function spotTolerance(price: number, decimals: number): number {
  return Math.max(Math.abs(price) * (decimals > 0 ? 0.0004 : 0.0012), 0.5 * 10 ** -decimals);
}

/**
 * Ce qui, sur le graphique, est au prix cité : la ligne la plus proche, la
 * zone dont c'est un bord (ou qui le contient, faute de mieux) ; pour une zone
 * citée, la zone tracée qui a les mêmes bornes. Rien s'il n'y a rien à ce prix
 * (le graphique tracera alors une ligne temporaire). À égalité, le premier de
 * la liste.
 */
export function matchLevel<K>(m: Pick<PriceMention, "low" | "high" | "decimals">, levels: ReadonlyArray<SpotLevel<K>>): SpotLevel<K> | undefined {
  const range = m.high > m.low;
  const tol = spotTolerance((m.low + m.high) / 2, m.decimals);
  let best: { level: SpotLevel<K>; score: number } | undefined;
  for (const l of levels) {
    let score: number | undefined;
    if ("price" in l) {
      if (!range && Math.abs(m.low - l.price) <= tol) score = Math.abs(m.low - l.price);
    } else if (range) {
      const d = Math.max(Math.abs(m.low - l.bottom), Math.abs(m.high - l.top));
      if (d <= tol * 1.5) score = d;
    } else {
      const edge = Math.min(Math.abs(m.low - l.top), Math.abs(m.low - l.bottom));
      if (edge <= tol) score = edge;
      else if (m.low > l.bottom && m.low < l.top) score = tol * 0.95;
    }
    if (score !== undefined && (!best || score < best.score)) best = { level: l, score };
  }
  return best?.level;
}

/**
 * Le suivi d'une réponse : à chaque progrès de l'affichage, les prix qui
 * viennent d'apparaître (une seule fois chacun). Le texte complet sert à lire
 * une citation entière dès son premier chiffre affiché (la voix la dit à ce
 * moment-là).
 */
export class PriceTracker {
  private readonly seen = new Set<number>();

  reset(): void {
    this.seen.clear();
  }

  /** Les prix dont le début vient d'apparaître dans `visible` (début de `full`) ; `final` : la réponse est entière. */
  feed(visible: string, full: string, final: boolean): PriceMention[] {
    const out: PriceMention[] = [];
    for (const m of findPrices(full, final)) {
      if (m.start >= visible.length) break;
      if (this.seen.has(m.start)) continue;
      this.seen.add(m.start);
      out.push(m);
    }
    return out;
  }

  /** Tout est affiché d'un coup (coupure, fin sans voix) : rien de ce qui reste ne s'allume. */
  skip(full: string): void {
    for (const m of findPrices(full, true)) this.seen.add(m.start);
  }
}
