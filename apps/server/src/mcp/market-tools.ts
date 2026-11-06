/**
 * Outils de cours (MetaApi), partagés par le serveur MCP du dialogue (« kopilia »)
 * et celui des agents (« marche ») : seul le serveur Nest parle à MetaApi, avec
 * le jeton ; les processus Claude ne font que demander.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHART_TIMEFRAMES } from "../market/timeframes.js";

type Api = (path: string) => Promise<unknown>;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const SYMBOLS_HELP =
  "Code usuel ou ticker (EURUSD, USDJPY, XAUUSD, AAPL) ou nom courant (Nasdaq, Dow Jones, S&P 500, DAX, or, pétrole, bitcoin) ; le symbole exact du courtier est retrouvé automatiquement";

export function registerMarketTools(server: McpServer, api: Api) {
  server.tool(
    "market_price",
    "Dernier prix d'un ou plusieurs produits financiers, en direct du compte MetaTrader de l'utilisateur (MetaApi) : paires de devises, indices, matières premières, cryptos, actions de son courtier. Répond en quelques secondes, avec l'heure de la cotation ; signale un marché fermé.",
    { symbols: z.array(z.string()).min(1).max(6).describe(SYMBOLS_HELP) },
    async ({ symbols }) => text(await api(`/prices?${new URLSearchParams({ symbols: symbols.join(",") })}`)),
  );

  server.tool(
    "market_indicators",
    "Valeurs d'indicateurs techniques d'un produit dans une unité de temps, calculées sur les bougies du compte MetaTrader comme sur le graphique de Kopilia : moyennes mobiles simple (sma) et exponentielle (ema), avec la position du prix, et RSI de Wilder (rsi), avec sa zone (surachat au-dessus de 70, survente au-dessous de 30). Valeur sur la bougie en cours et sur la dernière close.",
    {
      symbol: z.string().describe(SYMBOLS_HELP),
      timeframe: z.enum(CHART_TIMEFRAMES).optional().describe("Unité de temps des bougies (1w : la semaine, 1mn : le mois) ; 15m par défaut"),
      indicators: z
        .array(z.string())
        .min(1)
        .max(6)
        .describe("Genre et période : sma50, sma200, ema21, rsi14 ; sans période, celle d'usage (sma 20, ema 21, rsi 14)"),
    },
    async ({ symbol, timeframe, indicators }) =>
      text(await api(`/indicators?${new URLSearchParams({ symbol, timeframe: timeframe ?? "15m", list: indicators.join(",") })}`)),
  );

  server.tool(
    "market_candles",
    "Les dernières bougies d'un produit dans une unité de temps (ouverture, plus haut, plus bas, clôture, heure de Paris), la bougie en cours marquée : pour juger une mèche, un rejet, une clôture, une structure récente. 60 au plus.",
    {
      symbol: z.string().describe(SYMBOLS_HELP),
      timeframe: z.enum(CHART_TIMEFRAMES).describe("Unité de temps des bougies (1w : la semaine, 1mn : le mois)"),
      count: z.number().int().min(1).max(60).optional().describe("Nombre de bougies, les plus récentes ; 12 par défaut"),
    },
    async ({ symbol, timeframe, count }) => text(await api(`/candles?${new URLSearchParams({ symbol, timeframe, count: String(count ?? 12) })}`)),
  );

  server.tool(
    "market_levels",
    "Carte technique d'un produit dans une unité de temps : les tracés de l'utilisateur (lignes, obliques, zones, avec leur identifiant d_…), puis la carte automatique calculée sur les bougies du courtier (zones de support et de résistance avec leurs contacts et leurs mèches brutes, obliques à trois contacts au moins, divergences RSI), avec les corrections déjà faites par l'IA, et l'ATR. La carte automatique est une estimation : elle peut couper des mèches ou rater un niveau, les tracés de l'utilisateur passent avant.",
    {
      symbol: z.string().describe(SYMBOLS_HELP),
      timeframe: z.enum(["5m", "15m", "30m", "1h", "4h", "1d"]).optional().describe("Unité de temps des bougies de la carte automatique ; 1h par défaut"),
    },
    async ({ symbol, timeframe }) => text(await api(`/levels?${new URLSearchParams({ symbol, timeframe: timeframe ?? "1h" })}`)),
  );

  server.tool(
    "market_scan",
    "Tour d'horizon des produits que suit l'utilisateur (sa liste), en un appel : pour chacun, le prix face à sa carte (zone qui le contient, zones de part et d'autre, oblique la plus proche, divergence RSI récente, son tracé le plus proche, ses dossiers ouverts), avec les distances en ATR, du produit le plus près d'un niveau au plus loin. Pour choisir ceux à creuser avec market_levels et market_candles.",
    {
      timeframe: z.enum(["15m", "30m", "1h", "4h", "1d"]).optional().describe("Unité de temps des cartes ; 1h par défaut"),
      symbols: z.array(z.string()).max(40).optional().describe(`Autres produits que sa liste, si on en demande d'autres. ${SYMBOLS_HELP}`),
    },
    async ({ timeframe, symbols }) =>
      text(await api(`/scan?${new URLSearchParams({ timeframe: timeframe ?? "1h", ...(symbols?.length ? { symbols: symbols.join(",") } : {}) })}`)),
  );

  server.tool(
    "market_history",
    "Historique des prix depuis le compte MetaTrader de l'utilisateur (MetaApi) : ouverture, plus haut, plus bas, clôture (ou dernier prix) et variation d'un jour, d'une semaine, d'un mois, d'une plage de jours, ou d'une séance (Asie, Londres, New York). Un jour est la journée du courtier, comme les bougies quotidiennes de MetaTrader (chez la plupart des courtiers, de 23 h la veille à 23 h, heure de Paris) ; pour un jour seul, l'heure du plus haut et du plus bas ; sur plusieurs jours, le détail jour par jour.",
    {
      symbols: z.array(z.string()).min(1).max(4).describe(SYMBOLS_HELP),
      period: z
        .enum(["today", "yesterday", "week", "last_week", "month", "last_month"])
        .optional()
        .describe("Aujourd'hui par défaut ; yesterday = la veille (un lundi, c'est la séance du vendredi) ; week = depuis lundi ; month = depuis le 1er"),
      date: z.string().optional().describe("Jour précis AAAA-MM-JJ, à la place de period (ex. vendredi dernier)"),
      from: z.string().optional().describe("Début d'une plage de jours AAAA-MM-JJ (incluse), pour une analyse sur plusieurs jours ; 366 jours au plus"),
      to: z.string().optional().describe("Fin de la plage AAAA-MM-JJ (incluse) ; aujourd'hui si omis"),
      session: z
        .enum(["asia", "london", "new_york"])
        .optional()
        .describe(
          "Une séance du jour demandé : asia (Tokyo jusqu'à l'ouverture de Londres), london (8 h – 16 h 30 à Londres), new_york (9 h 30 – 16 h à New York : l'ouverture de Wall Street)",
        ),
    },
    async ({ symbols, period, date, from, to, session }) => {
      const q = new URLSearchParams({ symbols: symbols.join(",") });
      for (const [key, value] of Object.entries({ period, date, from, to, session })) if (value) q.set(key, value);
      return text(await api(`/history?${q}`));
    },
  );
}
