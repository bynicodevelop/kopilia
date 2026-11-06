import { z } from "zod";

/*
 * Les vues : des encarts que Kopilia compose lui-même à partir d'un catalogue de
 * blocs, comme un client MCP combine les outils d'un serveur. Une vue ne
 * contient que des données et des références à des sources vivantes, jamais
 * de HTML ni de code : l'écran la dessine avec ses propres composants, et tout
 * texte reste du texte (un texte lu sur le web ne peut rien exécuter).
 *
 * Deux formes : celle que Kopilia envoie (les produits par leur nom, « or »,
 * « Nasdaq ») et celle gardée en base (les produits résolus chez le courtier).
 */

/** Blocs d'une vue, au plus. */
export const MAX_VIEW_BLOCKS = 12;
/** Un texte écrit par Kopilia, au plus. */
export const MAX_VIEW_TEXT = 600;
export const MAX_TABLE_COLUMNS = 6;
export const MAX_TABLE_ROWS = 15;
export const MAX_LIST_ITEMS = 15;
/** Produits d'un bloc de cours, au plus. */
export const MAX_VIEW_QUOTES = 8;
/** Unités de temps d'une courbe (celles des graphiques). */
export const VIEW_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;

/** Un produit du courtier, tel que gardé dans une vue. */
export const viewProductSchema = z.object({ symbol: z.string().min(1), name: z.string(), digits: z.number().int().nonnegative().optional() });
export type ViewProduct = z.infer<typeof viewProductSchema>;

const tone = z.enum(["normal", "muted", "warn"]);
const trend = z.enum(["up", "down", "flat"]);
const impact = z.enum(["high", "medium", "all"]);
const setupStates = z.array(z.enum(["waiting", "triggered"])).max(2);
const currencies = z.array(z.string().regex(/^[A-Za-z]{3}$/)).max(8);
const table = {
  columns: z.array(z.string().min(1).max(30)).min(1).max(MAX_TABLE_COLUMNS),
  rows: z
    .array(z.array(z.string().max(60)))
    .min(1)
    .max(MAX_TABLE_ROWS),
};
const listItems = z
  .array(z.object({ text: z.string().min(1).max(120), detail: z.string().max(160).optional(), tag: z.string().max(20).optional() }))
  .min(1)
  .max(MAX_LIST_ITEMS);

/**
 * Le catalogue : chaque genre de bloc, ce qu'il montre, et s'il est vivant
 * (tenu à jour par l'écran) ou écrit (il garde ce que Kopilia y a mis).
 */
export const VIEW_CATALOG = {
  heading: { live: false, label: "titre de section", description: "Un titre de section, pour regrouper les blocs qui suivent." },
  text: {
    live: false,
    label: "texte",
    description: "Un paragraphe écrit par Kopilia (analyse, rappel, consigne) ; tone muted ou warn pour l'atténuer ou le signaler.",
  },
  stat: {
    live: false,
    label: "chiffre",
    description:
      "Un chiffre écrit par Kopilia, avec son libellé (« Prochain CPI », « 14 h 30 ») ; jamais un prix : pour un prix, le bloc quotes, qui reste à jour.",
  },
  table: {
    live: false,
    label: "tableau",
    description: `Un tableau écrit par Kopilia : ${MAX_TABLE_COLUMNS} colonnes et ${MAX_TABLE_ROWS} lignes au plus, autant de cases par ligne que de colonnes.`,
  },
  list: {
    live: false,
    label: "liste",
    description: `Une liste écrite par Kopilia (${MAX_LIST_ITEMS} lignes au plus), chaque ligne avec un détail et une étiquette facultatifs.`,
  },
  quotes: {
    live: true,
    label: "cours",
    description: `Les prix en direct de produits (${MAX_VIEW_QUOTES} au plus) et leur variation du jour, comme la liste de surveillance.`,
  },
  sparkline: {
    live: true,
    label: "courbe",
    description: "La courbe des clôtures d'un produit sur ses dernières bougies, avec la variation sur la période ; un clic ouvre son graphique.",
  },
  calendar: {
    live: true,
    label: "calendrier",
    description: "Les annonces du calendrier économique à venir, filtrées par devise et par impact : aujourd'hui, et jusqu'à 7 jours suivants.",
  },
  setups: { live: true, label: "setups", description: "Les setups de l'IA (en attente, déclenchés), d'un produit ou de tous ; un clic ouvre le graphique." },
  hypotheses: { live: true, label: "hypothèses", description: "Les hypothèses actives (les siennes et celles de l'IA), d'un produit ou de toutes." },
  brief: { live: true, label: "brief", description: "Le dernier brief (wrap) : son titre et son résumé ; un clic l'ouvre en entier." },
} as const;
export type ViewBlockType = keyof typeof VIEW_CATALOG;
const d = (type: ViewBlockType) => VIEW_CATALOG[type].description;

/* ------------------------------ Forme gardée ------------------------------ */

const storedBlocks = [
  z.object({ type: z.literal("heading"), text: z.string().min(1).max(80) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(MAX_VIEW_TEXT), tone: tone.optional() }),
  z.object({
    type: z.literal("stat"),
    label: z.string().min(1).max(40),
    value: z.string().min(1).max(40),
    detail: z.string().max(80).optional(),
    trend: trend.optional(),
  }),
  z.object({ type: z.literal("table"), ...table }),
  z.object({ type: z.literal("list"), items: listItems }),
  z.object({ type: z.literal("quotes"), products: z.array(viewProductSchema).min(1).max(MAX_VIEW_QUOTES) }),
  z.object({ type: z.literal("sparkline"), product: viewProductSchema, timeframe: z.enum(VIEW_TIMEFRAMES), bars: z.number().int().min(10).max(300) }),
  z.object({ type: z.literal("calendar"), currencies: currencies.optional(), impact: impact.optional(), days: z.number().int().min(0).max(7).optional() }),
  z.object({ type: z.literal("setups"), product: viewProductSchema.optional(), states: setupStates.optional() }),
  z.object({ type: z.literal("hypotheses"), product: viewProductSchema.optional() }),
  z.object({ type: z.literal("brief") }),
] as const;

export const viewBlockSchema = z.discriminatedUnion("type", [...storedBlocks]).superRefine((b, ctx) => {
  if (b.type === "table") tableShape(b, ctx);
});
export type ViewBlock = z.infer<typeof viewBlockSchema>;

export const viewSpecSchema = z.object({ blocks: z.array(viewBlockSchema).min(1).max(MAX_VIEW_BLOCKS) });
export type ViewSpec = z.infer<typeof viewSpecSchema>;

/* ------------------------------ Forme envoyée ------------------------------ */

const PRODUCT = "Nom courant ou code du produit (or, Nasdaq, EURUSD)";

/** Un bloc tel que Kopilia l'envoie : le catalogue, décrit pour lui (c'est le schéma de ses outils). */
export const viewBlockInputSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("heading"), text: z.string().min(1).max(80) }).describe(d("heading")),
    z.object({ type: z.literal("text"), text: z.string().min(1).max(MAX_VIEW_TEXT), tone: tone.optional() }).describe(d("text")),
    z
      .object({
        type: z.literal("stat"),
        label: z.string().min(1).max(40),
        value: z.string().min(1).max(40),
        detail: z.string().max(80).optional(),
        trend: trend.optional().describe("Flèche : up, down ou flat"),
      })
      .describe(d("stat")),
    z.object({ type: z.literal("table"), ...table }).describe(d("table")),
    z.object({ type: z.literal("list"), items: listItems }).describe(d("list")),
    z.object({ type: z.literal("quotes"), symbols: z.array(z.string().min(1)).min(1).max(MAX_VIEW_QUOTES).describe(PRODUCT) }).describe(d("quotes")),
    z
      .object({
        type: z.literal("sparkline"),
        symbol: z.string().min(1).describe(PRODUCT),
        timeframe: z.enum(VIEW_TIMEFRAMES).optional().describe("Unité des bougies ; 1h par défaut"),
        bars: z.number().int().min(10).max(300).optional().describe("Nombre de bougies ; 48 par défaut"),
      })
      .describe(d("sparkline")),
    z
      .object({
        type: z.literal("calendar"),
        currencies: currencies.optional().describe('Devises à garder (["USD", "EUR"]) ; toutes si omis'),
        impact: impact.optional().describe("high : fortes ; medium : moyennes et fortes (défaut) ; all : tout"),
        days: z
          .number()
          .int()
          .min(0)
          .max(7)
          .optional()
          .describe("0 : aujourd'hui seulement ; N : aujourd'hui et les N jours suivants (« les deux prochains jours » : 2) ; 1 par défaut"),
      })
      .describe(d("calendar")),
    z
      .object({
        type: z.literal("setups"),
        symbol: z.string().optional().describe(`${PRODUCT} ; tous si omis`),
        states: setupStates.optional().describe("waiting (en attente), triggered (déclenchés) ; les deux si omis"),
      })
      .describe(d("setups")),
    z.object({ type: z.literal("hypotheses"), symbol: z.string().optional().describe(`${PRODUCT} ; toutes si omis`) }).describe(d("hypotheses")),
    z.object({ type: z.literal("brief") }).describe(d("brief")),
  ])
  .superRefine((b, ctx) => {
    if (b.type === "table") tableShape(b, ctx);
  });
export type ViewBlockInput = z.infer<typeof viewBlockInputSchema>;

/** Chaque ligne d'un tableau a autant de cases que de colonnes. */
function tableShape(b: { columns: string[]; rows: string[][] }, ctx: z.RefinementCtx) {
  b.rows.forEach((r, i) => {
    if (r.length !== b.columns.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows", i],
        message: `${r.length} case${r.length > 1 ? "s" : ""} pour ${b.columns.length} colonne${b.columns.length > 1 ? "s" : ""}`,
      });
  });
}

/** Le résumé d'un bloc, pour dire ce qu'une vue montre : « cours de or, argent », « tableau 3 × 4 ». */
export function viewBlockSummary(b: ViewBlock): string {
  switch (b.type) {
    case "heading":
      return `titre « ${b.text} »`;
    case "text":
      return "texte";
    case "stat":
      return `chiffre « ${b.label} »`;
    case "table":
      return `tableau ${b.columns.length} × ${b.rows.length}`;
    case "list":
      return `liste de ${b.items.length}`;
    case "quotes":
      return `cours de ${b.products.map((p) => p.name).join(", ")}`;
    case "sparkline":
      return `courbe ${b.product.name} ${b.timeframe}`;
    case "calendar":
      return `calendrier${b.currencies?.length ? ` ${b.currencies.join(", ").toUpperCase()}` : ""}`;
    case "setups":
      return `setups${b.product ? ` de ${b.product.name}` : ""}`;
    case "hypotheses":
      return `hypothèses${b.product ? ` de ${b.product.name}` : ""}`;
    case "brief":
      return "dernier brief";
  }
}

/** Les produits suivis en direct par une vue (cours et courbes). */
export function viewSymbols(spec: ViewSpec): string[] {
  return spec.blocks.flatMap((b) => (b.type === "quotes" ? b.products.map((p) => p.symbol) : b.type === "sparkline" ? [b.product.symbol] : []));
}

/* ------------------------- Données servies par le serveur ------------------------- */

/** Une annonce du calendrier, telle que l'écran la montre (instant epoch ms). */
export const viewCalendarEventSchema = z.object({
  at: z.number(),
  country: z.string(),
  title: z.string(),
  impact: z.string(),
  forecast: z.string().nullable(),
  previous: z.string().nullable(),
});
export type ViewCalendarEvent = z.infer<typeof viewCalendarEventSchema>;

/** Ce que le serveur sert aux blocs qui ne vivent pas déjà à l'écran : le calendrier, le brief. Par position du bloc. */
export interface ViewData {
  blocks: Record<number, { events: ViewCalendarEvent[] } | { brief: { briefId: string; title: string; spoken: string; createdAt: number } | null }>;
}
