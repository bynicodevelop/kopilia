/**
 * Cours en direct via MetaApi : retrouver chez le courtier le symbole d'un
 * produit demandé à la voix (« le Nasdaq », « l'or », « EURUSD »), et mettre
 * le prix en forme pour Kopilia. Fonctions pures, testées sans réseau.
 */

/** Erreur lisible renvoyée telle quelle à Kopilia (jeton refusé, compte non déployé…). */
/** Ce qui permet de réagir à une erreur sans dépendre de son texte (fait pour être dit). */
export type MarketErrorCode = "rate_limited";

export class MarketError extends Error {
  constructor(
    message: string,
    readonly code?: MarketErrorCode,
  ) {
    super(message);
  }
}

interface Alias {
  /** Nom courant, à dire à voix haute. */
  name: string;
  /** Façons de le demander (normalisées : majuscules, sans accent ni séparateur). */
  keys: string[];
  /** Symboles possibles chez les courtiers, du plus courant au plus rare. */
  roots: string[];
}

/** Indices, matières premières et cryptos : chaque courtier les nomme à sa façon. */
const ALIASES: Alias[] = [
  {
    name: "Nasdaq 100",
    keys: ["NASDAQ", "NASDAQ100", "NAS", "NAS100", "US100", "USTEC", "USTECH", "NDX", "NDX100", "NQ", "MNQ", "NQ100"],
    roots: ["NAS100", "US100", "USTEC", "USTECH", "NDX100", "NQ100", "NASDAQ100", "NDX", "NASDAQ", "US100CASH"],
  },
  {
    name: "Dow Jones",
    keys: ["DOW", "DOWJONES", "DJ", "DJI", "DJIA", "DJ30", "US30", "WS30", "YM", "MYM", "USA30"],
    roots: ["US30", "DJ30", "WS30", "DJI30", "USA30", "DOWJONES", "DJIA", "US30CASH"],
  },
  {
    name: "S&P 500",
    keys: ["SP500", "SP", "SNP500", "SANDP500", "SPX", "SPX500", "US500", "ES", "MES", "USA500"],
    roots: ["US500", "SPX500", "SP500", "USA500", "SPX", "US500CASH"],
  },
  {
    name: "Russell 2000",
    keys: ["RUSSELL", "RUSSELL2000", "RUT", "US2000", "RTY", "M2K"],
    roots: ["US2000", "RUSSELL2000", "RUT", "US2000CASH"],
  },
  { name: "or", keys: ["OR", "GOLD", "XAU", "XAUUSD", "GC", "MGC"], roots: ["XAUUSD", "GOLD"] },
  { name: "argent", keys: ["ARGENT", "SILVER", "XAG", "XAGUSD", "SI"], roots: ["XAGUSD", "SILVER"] },
  { name: "platine", keys: ["PLATINE", "PLATINUM", "XPT", "XPTUSD"], roots: ["XPTUSD", "PLATINUM"] },
  { name: "palladium", keys: ["PALLADIUM", "XPD", "XPDUSD"], roots: ["XPDUSD", "PALLADIUM"] },
  { name: "cuivre", keys: ["CUIVRE", "COPPER", "XCU", "XCUUSD", "HG"], roots: ["COPPER", "XCUUSD", "USCOPPER"] },
  {
    name: "pétrole WTI",
    keys: ["PETROLE", "PETROLEWTI", "WTI", "OIL", "USOIL", "USWTI", "CRUDE", "CL", "MCL", "XTIUSD"],
    roots: ["USOIL", "USWTI", "WTI", "XTIUSD", "USOUSD", "CRUDE", "CRUDEOIL", "OILUSD", "SPOTCRUDE", "WTICOUSD"],
  },
  {
    name: "pétrole Brent",
    keys: ["BRENT", "PETROLEBRENT", "UKOIL", "UKBRENT", "XBRUSD"],
    roots: ["UKOIL", "UKBRENT", "BRENT", "XBRUSD", "UKOUSD", "BRENTOIL", "SPOTBRENT", "BCOUSD"],
  },
  {
    name: "gaz naturel",
    keys: ["GAZ", "GAZNATUREL", "GAS", "NATGAS", "NGAS", "NG", "XNGUSD"],
    roots: ["XNGUSD", "NATGAS", "NGAS", "USGAS", "NATURALGAS", "GAS"],
  },
  {
    name: "DAX",
    keys: ["DAX", "DAX40", "GER40", "DE40", "GER30", "DE30", "GERMANY40"],
    roots: ["GER40", "DE40", "DAX40", "GER30", "DE30", "GERMANY40", "DAX"],
  },
  { name: "CAC 40", keys: ["CAC", "CAC40", "FRA40", "FR40", "F40", "FRANCE40"], roots: ["FRA40", "FR40", "CAC40", "FRANCE40", "F40"] },
  {
    name: "Euro Stoxx 50",
    keys: ["EUROSTOXX", "EUROSTOXX50", "STOXX", "STOXX50", "EU50", "ESTX50", "SX5E"],
    roots: ["EU50", "EUSTX50", "STOXX50", "EUROSTOXX50", "ESTX50", "STOXX50E"],
  },
  { name: "FTSE 100", keys: ["FTSE", "FTSE100", "UK100", "FOOTSIE"], roots: ["UK100", "FTSE100", "FTSE"] },
  { name: "Nikkei 225", keys: ["NIKKEI", "NIKKEI225", "JPN225", "JP225", "N225"], roots: ["JPN225", "JP225", "NIKKEI225", "N225", "NIKKEI"] },
  { name: "Hang Seng", keys: ["HANGSENG", "HSI", "HK50", "HK33"], roots: ["HK50", "HSI", "HK33", "HKG33"] },
  { name: "China A50", keys: ["CHINA50", "CHINAA50", "CN50", "A50"], roots: ["CHINA50", "CN50", "CHINAA50", "CHN50"] },
  { name: "ASX 200", keys: ["ASX", "ASX200", "AU200", "AUS200"], roots: ["AUS200", "AU200", "ASX200"] },
  { name: "IBEX 35", keys: ["IBEX", "IBEX35", "ES35", "ESP35", "SPA35"], roots: ["ESP35", "ES35", "SPA35", "IBEX35"] },
  { name: "SMI", keys: ["SMI", "SMI20", "SWISS20", "SUI20", "CH20"], roots: ["SWI20", "SWISS20", "SUI20", "CH20", "SMI20", "SMI"] },
  { name: "AEX", keys: ["AEX", "AEX25", "NETH25", "NED25", "NL25"], roots: ["NETH25", "NED25", "NL25", "AEX25", "AEX"] },
  {
    name: "indice dollar",
    keys: ["DXY", "USDX", "DX", "INDICEDOLLAR", "DOLLARINDEX", "USDINDEX"],
    roots: ["DXY", "USDX", "USDINDEX", "DOLLARINDEX"],
  },
  { name: "VIX", keys: ["VIX", "VOLATILITE", "VIXINDEX"], roots: ["VIX", "VIXINDEX", "VIXX", "VOLX", "VIXUSD"] },
  { name: "bitcoin", keys: ["BITCOIN", "BTC", "BTCUSD", "XBT"], roots: ["BTCUSD", "BTCUSDT", "XBTUSD", "BITCOIN"] },
  { name: "ether", keys: ["ETHER", "ETHEREUM", "ETH", "ETHUSD"], roots: ["ETHUSD", "ETHUSDT", "ETHEREUM"] },
  // Paires de devises, telles qu'on les dit (« l'euro-dollar ») ; le code reste accepté.
  { name: "euro-dollar", keys: ["EURODOLLAR", "EUROUSD", "EURUSD"], roots: ["EURUSD"] },
  { name: "livre-dollar", keys: ["LIVREDOLLAR", "LIVREUSD", "CABLE", "GBPUSD"], roots: ["GBPUSD"] },
  { name: "dollar-yen", keys: ["DOLLARYEN", "USDYEN", "USDJPY"], roots: ["USDJPY"] },
  { name: "dollar-franc suisse", keys: ["DOLLARFRANCSUISSE", "DOLLARFRANC", "USDCHF"], roots: ["USDCHF"] },
  { name: "dollar australien", keys: ["DOLLARAUSTRALIEN", "AUSSIE", "AUDUSD"], roots: ["AUDUSD"] },
  { name: "dollar canadien", keys: ["DOLLARCANADIEN", "LOONIE", "USDCAD"], roots: ["USDCAD"] },
  { name: "dollar néo-zélandais", keys: ["DOLLARNEOZELANDAIS", "KIWI", "NZDUSD"], roots: ["NZDUSD"] },
  { name: "euro-livre", keys: ["EUROLIVRE", "EURGBP"], roots: ["EURGBP"] },
  { name: "euro-yen", keys: ["EUROYEN", "EURJPY"], roots: ["EURJPY"] },
  { name: "livre-yen", keys: ["LIVREYEN", "GBPJPY"], roots: ["GBPJPY"] },
];

/** « l'or », « le Nasdaq », « EUR/USD » -> « OR », « NASDAQ », « EURUSD ». */
export function normalize(query: string): string {
  return query
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .replace(/^(?:(?:le|la|les|du|des|de la)\s+|(?:de\s+)?l['’]\s*)/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Places boursières en suffixe : « CL.NYS » est l'action Colgate, « NG.LSE » National Grid. */
const EXCHANGE_SUFFIXES = new Set([
  "NYS",
  "NYSE",
  "XNYS",
  "NAS",
  "NASDAQ",
  "NSDQ",
  "XNMS",
  "OQ",
  "US",
  "ARC",
  "ARCX",
  "BATS",
  "LSE",
  "LON",
  "UK",
  "ETR",
  "XETRA",
  "DE",
  "PA",
  "PAR",
  "EPA",
  "AS",
  "AMS",
  "BME",
  "MIL",
  "MI",
  "SWX",
  "SW",
  "WAR",
  "ASX",
  "AX",
  "TSX",
  "TO",
  "HK",
  "HKG",
  "TSE",
  "JP",
]);

/**
 * Le symbole du courtier correspond-il à `root` ? Exactement (« US30 »,
 * « #US30 »), avec un suffixe séparé (« US30.cash », « EURUSD_i ») ou, pour un
 * nom assez long ou finissant par un chiffre, un suffixe collé (« EURUSDm »,
 * « US30m »). Jamais « CLX » pour « CL » : un ticker court reste exact.
 * Pour un indice ou une matière première (`instrument`), jamais une action :
 * un nom court reste exact (« GAS », pas « GAS.NYS ») et le suffixe d'une
 * place boursière est écarté (« GOLD.NYS » est Barrick Gold, pas l'or).
 * Renvoie la longueur du suffixe (0 = exact), ou -1.
 */
function matchRoot(symbol: string, root: string, instrument: boolean): number {
  const core = normalize(symbol);
  if (core === root) return 0;
  if (instrument && root.length <= 3) return -1;
  const raw = symbol.toUpperCase().replace(/^[^A-Z0-9]+/, "");
  if (!raw.startsWith(root) || raw.length === root.length) return -1;
  const next = raw[root.length];
  if (!/[A-Z0-9]/.test(next)) {
    const suffix = raw.slice(root.length).replace(/[^A-Z0-9]/g, "");
    return instrument && EXCHANGE_SUFFIXES.has(suffix) ? -1 : core.length - root.length;
  }
  if (/[A-Z]/.test(next) && (root.length >= 5 || /\d$/.test(root))) return core.length - root.length;
  return -1;
}

/** Meilleur symbole du courtier pour des racines données, dans leur ordre de préférence. */
function bestMatch(symbols: string[], roots: string[], instrument: boolean): string | undefined {
  for (const root of roots) {
    const found = symbols
      .map((s) => ({ s, extra: matchRoot(s, root, instrument) }))
      .filter((m) => m.extra >= 0)
      .sort((a, b) => a.extra - b.extra || a.s.length - b.s.length || a.s.localeCompare(b.s));
    if (found.length) return found[0].s;
  }
  return undefined;
}

export type Resolution = { symbol: string; name?: string } | { suggestions: string[] };

/**
 * Symbole du courtier pour une demande : nom courant d'un indice ou d'une
 * matière première (« Nasdaq » -> NAS100, US100 ou USTEC selon le courtier),
 * sinon code usuel ou ticker (« EURUSD » -> EURUSD.m), sinon symbole exact.
 * Introuvable : les symboles les plus proches, pour proposer ou réessayer.
 */
export function resolveSymbol(query: string, symbols: string[]): Resolution {
  const q = normalize(query);
  if (!q) return { suggestions: [] };
  const alias = ALIASES.find((a) => a.keys.includes(q));
  if (alias) {
    // La demande elle-même en dernier recours (« MNQ » chez un courtier de futures).
    const symbol = bestMatch(symbols, [...alias.roots, q], true);
    if (symbol) return { symbol, name: alias.name };
  }
  const pair = pairName(q);
  const named = (symbol: string) => (pair ? { symbol, name: pair } : { symbol });
  const exact = symbols.find((s) => s.toUpperCase() === query.trim().toUpperCase());
  if (exact) return named(exact);
  // Un nom d'indice ou de matière première introuvable n'est pas un ticker : « CL » n'est pas Colgate.
  const symbol = alias ? undefined : bestMatch(symbols, [q], false);
  if (symbol) return named(symbol);
  return { suggestions: suggest(q, symbols) };
}

/** Les devises telles qu'on les dit, pour nommer les paires croisées. */
const CURRENCIES: Record<string, string> = {
  EUR: "euro",
  USD: "dollar",
  GBP: "livre",
  JPY: "yen",
  CHF: "franc suisse",
  AUD: "dollar australien",
  NZD: "dollar néo-zélandais",
  CAD: "dollar canadien",
};

/** « EURCAD » -> « euro contre dollar canadien » (plutôt que le nom anglais du courtier) ; undefined hors paire connue. */
export function pairName(code: string): string | undefined {
  const m = /^([A-Z]{3})([A-Z]{3})$/.exec(code);
  const base = m && CURRENCIES[m[1]];
  const quote = m && CURRENCIES[m[2]];
  return base && quote && m[1] !== m[2] ? `${base} contre ${quote}` : undefined;
}

/** Symboles proches : contenant la demande, ou commençant comme elle. */
function suggest(q: string, symbols: string[]): string[] {
  const head = q.slice(0, 3);
  return symbols
    .filter((s) => {
      const core = normalize(s);
      return core.includes(q) || (head.length === 3 && core.startsWith(head));
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 8);
}

/** 21540.25 -> « 21 540,25 » ; 1.08345 -> « 1,08345 » (avec les décimales du symbole). */
export function frenchPrice(value: number, digits?: number): string {
  const d = digits ?? Math.min(decimals(value), 8);
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
}

/** Décimales écrites d'un nombre (1.08345 -> 5), quand le courtier ne les donne pas. */
export function decimals(n: number): number {
  const s = String(n);
  return s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
}

/** Âge d'une cotation : « à l'instant », « il y a 40 s », « il y a 3 min », « il y a 2 h ». */
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} jours`;
}
