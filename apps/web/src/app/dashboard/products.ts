/**
 * La liste de tous ses produits, comme la liste de surveillance de TradingView :
 * rangés par famille, dans l'ordre de sa liste, et ce que fait un clic sur une
 * ligne. Fonctions pures, testées.
 */
import type { ProductView } from "./views";

export type ProductFamily = "Indices" | "Matières premières" | "Devises" | "Cryptos" | "Autres";

const CURRENCIES = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "SGD",
  "HKD",
  "MXN",
  "ZAR",
  "TRY",
  "PLN",
  "CZK",
  "HUF",
  "CNH",
  "CNY",
]);
const CRYPTO = /^(BTC|ETH|LTC|XRP|SOL|ADA|DOGE|BNB|DOT|AVAX|LINK|XLM|BCH)/;
/** Métaux (XAU, XAG, XPT, XPD) et matières premières nommées. */
const COMMODITY = /^(XAU|XAG|XPT|XPD)|GOLD|SILVER|COPPER|PLATIN|PALLAD|OIL|WTI|BRENT|GAS|COFFEE|COCOA|SUGAR|COTTON|WHEAT|CORN|SOY/;
const INDEX = /\d|INDEX|VIX|DXY|^(SPX|NDX|DJI|DAX|CAC|FTSE|NIKKEI|HSI|STOXX)/;

/** La famille d'un symbole du courtier (« XAUUSD », « EURUSD.i », « NAS100 »), son suffixe de compte ignoré. */
export function productFamily(symbol: string): ProductFamily {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9].*$/, "");
  if (CRYPTO.test(s)) return "Cryptos";
  if (COMMODITY.test(s)) return "Matières premières";
  const pair = /^([A-Z]{3})([A-Z]{3})$/.exec(s);
  if (pair && CURRENCIES.has(pair[1]) && CURRENCIES.has(pair[2])) return "Devises";
  if (INDEX.test(s)) return "Indices";
  return "Autres";
}

/** Les produits rangés par famille : les familles dans l'ordre où sa liste les fait paraître, et chaque produit à son rang. */
export function groupProducts(products: ProductView[]): Array<{ family: ProductFamily; products: ProductView[] }> {
  const groups = new Map<ProductFamily, ProductView[]>();
  for (const p of products) {
    const family = productFamily(p.symbol);
    groups.set(family, [...(groups.get(family) ?? []), p]);
  }
  return [...groups].map(([family, list]) => ({ family, products: list }));
}

/** « or » -> « Or », « euro-dollar » -> « Euro-dollar » ; « S&P 500 » reste tel quel. */
export function displayName(name: string): string {
  return name ? name[0].toLocaleUpperCase("fr-FR") + name.slice(1) : name;
}

/**
 * Le libellé d'une ligne : une paire de devises par son code, comme les traders
 * la lisent (« NZD/CAD » plutôt que « dollar néo-zélandais contre dollar
 * canadien », coupé dans la ligne) ; les autres par leur nom courant (« Or »,
 * « Nasdaq 100 »).
 */
export function productLabel(p: ProductView): string {
  if (productFamily(p.symbol) !== "Devises") return displayName(p.name);
  const s = p.symbol.toUpperCase().replace(/[^A-Z0-9].*$/, "");
  return `${s.slice(0, 3)}/${s.slice(3, 6)}`;
}

export type ListClick = { action: "front"; id: string } | { action: "switch"; id: string } | { action: "open" };

/**
 * Un clic sur une ligne, comme dans TradingView, où la liste change le produit
 * du graphique :
 * - le produit a déjà son graphique à l'écran : celui-ci passe devant ;
 * - sinon, le graphique ouvert depuis la liste (`followId`), s'il est encore
 *   là, change de produit (il garde sa place, sa taille, son unité de temps) ;
 * - sinon, ou avec ⌘/Ctrl (`separate`), un nouveau graphique s'ouvre.
 */
export function listClick(symbol: string, charts: Array<{ id: string; symbol?: string }>, followId: string | null, separate: boolean): ListClick {
  const own = charts.find((c) => c.symbol === symbol);
  if (own) return { action: "front", id: own.id };
  if (!separate && followId && charts.some((c) => c.id === followId)) return { action: "switch", id: followId };
  return { action: "open" };
}
