/**
 * Outils d'action sur Kopilia, partagés par le serveur MCP du dialogue
 * (« kopilia ») et celui des agents d'action (« kopilia ») : tracés d'un produit,
 * alertes, et indicateurs de plusieurs graphiques d'un coup. Aucun ne touche à
 * l'écran (les encarts restent au dialogue) : un agent de fond travaille sans
 * rien ouvrir ni fermer.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALERT_CONDITIONS,
  ALERT_TRIGGERS,
  DRAWING_KINDS,
  INDICATOR_COLORS,
  MA_TYPES,
  MAX_ALERT_MESSAGE,
  POSITION_SIDES,
  PRICE_SOURCES,
} from "@kopilia/contracts";
import { CHART_TIMEFRAMES } from "../market/timeframes.js";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export const MA_HELP = "sma simple (MM), ema exponentielle (MME), wma pondérée (MMP), smma lissée de Wilder (MML), hma de Hull";
export const SETTINGS = {
  type: z.enum(MA_TYPES).optional().describe(`Moyenne : son type (${MA_HELP}) ; sma par défaut`),
  period: z.number().int().optional().describe("Longueur en bougies ; sans : 20 (sma, wma), 21 (ema), 14 (smma, rsi), 9 (hma)"),
  source: z.enum(PRICE_SOURCES).optional().describe("Prix de chaque bougie : close (défaut), open, high, low, hl2, hlc3, ohlc4"),
  overbought: z.number().optional().describe("RSI : seuil de surachat (70 par défaut)"),
  oversold: z.number().optional().describe("RSI : seuil de survente (30 par défaut)"),
  signal: z
    .object({ type: z.enum(MA_TYPES), period: z.number().int() })
    .nullable()
    .optional()
    .describe("RSI : sa moyenne (ligne de signal), ex. sma 14 ; null la retire"),
  color: z.enum(INDICATOR_COLORS).optional(),
  width: z.number().int().min(1).max(4).optional().describe("Épaisseur du trait, de 1 à 4"),
  hidden: z.boolean().optional().describe("true : masqué sans être retiré ; false : de nouveau affiché"),
};
export const INDICATOR = z.object({
  kind: z.enum(["ma", "rsi", ...MA_TYPES]).describe(`ma : moyenne mobile (type : ${MA_HELP}) ; rsi : RSI de Wilder ; sma, ema… : la moyenne de ce type`),
  ...SETTINGS,
});

// Analyse technique : tracés d'un produit (lignes, zones, obliques, Fibonacci), gardés d'un graphique à l'autre.
const DRAW_TARGET = "Le graphique (identifiant p_…) ou le produit (or, Nasdaq, EURUSD) ; un produit non affiché garde le tracé pour son graphique";
const MOMENT = "Instant AAAA-MM-JJ HH:MM, heure de Paris (celle d'une bougie : un plus haut, un plus bas)";
const POINT = z.object({ time: z.string().describe(MOMENT), price: z.number() });
const SHAPE = {
  price: z.number().optional().describe("hline : le prix de la ligne"),
  top: z.number().optional().describe("zone : le prix du haut"),
  bottom: z.number().optional().describe("zone : le prix du bas"),
  from: z.string().optional().describe(`zone : début (${MOMENT}) ; sans : depuis le début du graphique ; position : la bougie d'entrée (sans : maintenant)`),
  to: z
    .string()
    .optional()
    .describe(
      `zone : fin (${MOMENT}) ; sans : jusqu'à maintenant et au-delà ; « none » retire une fin ; position : son bord droit (sans : le bord droit du graphique)`,
    ),
  side: z.enum(POSITION_SIDES).optional().describe("position : long (achat) ou short (vente) ; sans : déduit du stop (sous l'entrée : un achat)"),
  entry: z.number().optional().describe("position : le prix d'entrée"),
  stop: z.number().optional().describe("position : le prix du stop (sous l'entrée pour un achat, au-dessus pour une vente)"),
  objective: z.number().optional().describe("position : le prix de l'objectif (take profit ; au-dessus de l'entrée pour un achat, dessous pour une vente)"),
  risk_percent: z
    .number()
    .positive()
    .optional()
    .describe("position : son risque en % du capital (sa taille se calcule) ; sans : le risque par défaut de l'utilisateur"),
  risk_amount: z.number().positive().optional().describe("position : ou son risque en montant, devise du compte"),
  lots: z.number().positive().optional().describe("position : ou sa taille en lots"),
  risk_reset: z.boolean().optional().describe("position : true la remet au risque par défaut"),
  risk_tier: z.string().optional().describe("position : ou un palier de risque de l'utilisateur (« A+ »), qu'il a nommé"),
  start: POINT.optional().describe("trendline : premier point ; fib : début du mouvement (niveau 1) ; fibext : début de l'impulsion"),
  end: POINT.optional().describe("trendline : second point ; fib : fin du mouvement (niveau 0) ; fibext : fin de l'impulsion"),
  projection: POINT.optional().describe("fibext : troisième point, la fin du repli, d'où les niveaux sont projetés"),
  extend: z
    .boolean()
    .optional()
    .describe(
      "trendline : prolongée vers la droite au-delà du second point (oui par défaut) ; fib, fibext : niveaux prolongés vers la droite (non par défaut)",
    ),
  label: z.string().max(40).optional().describe("Nom court affiché à côté (« résistance », « support hebdo »)"),
};

// Alertes : à un prix ou sur une ligne tracée, surveillées par le serveur même écran fermé.
const ALERT_SETTINGS = {
  condition: z
    .enum(ALERT_CONDITIONS)
    .optional()
    .describe(
      "cross : franchissement dans les deux sens ; up : à la hausse ; down : à la baisse. Sans : un prix au-dessus du cours attend la hausse, au-dessous la baisse ; une ligne, les deux sens",
    ),
  trigger: z
    .enum(ALERT_TRIGGERS)
    .optional()
    .describe(
      "once : une seule fois, puis elle s'arrête (par défaut) ; bar : au plus une fois par bougie ; close : seulement quand une bougie clôture au-delà (les mèches ne comptent pas) ; touch_close : au contact, elle attend la clôture de la bougie (timeframe) qui a touché, puis part une fois avec cette bougie et ce qu'elle montre (rejet, clôture dans la zone, cassure), pour qui attend une bougie de rejet",
    ),
  timeframe: z
    .enum(CHART_TIMEFRAMES)
    .optional()
    .describe(
      "Unité des bougies pour bar, close et touch_close (jusqu'à 1w : pas en mensuel), et de calcul d'une oblique ; sans : celle du graphique affiché, sinon 15m",
    ),
  message: z
    .string()
    .max(MAX_ALERT_MESSAGE)
    .optional()
    .describe("Consigne à suivre quand elle part (« regarde le RSI 1 heure et dis-moi si la cassure tient ») ; vide : aucune"),
};

/** Un indicateur à retirer : par genre (et longueur ; sans, tous ceux du genre). */
const REMOVAL = z.object({
  kind: z.enum(["ma", "rsi", ...MA_TYPES]).describe("ma : toutes les moyennes ; rsi ; sma, ema… : les moyennes de ce type"),
  period: z.number().int().optional().describe("Sa longueur ; sans : toutes celles du genre"),
});

export function registerActionTools(server: McpServer, api: Api) {
  server.tool(
    "chart_indicators",
    "Pose ou retire des indicateurs (moyennes mobiles, RSI) sur plusieurs graphiques d'un coup, ouverts ou non, sans rien ouvrir à l'écran : tous les graphiques (all : « mets les exponentielles 20, 50 et 200 sur tous les graphiques », « retire le RSI partout ») ou des produits nommés (« sur l'or et l'argent »). Ils restent : un graphique fermé puis rouvert les retrouve, dans toutes les unités de temps. all change le modèle commun (que suivent les produits sans réglages propres) et chaque produit qui a les siens. Sans add ni remove : l'état (le modèle commun, et les produits qui ont leurs propres indicateurs). Pour un seul graphique affiché et ses réglages fins (couleur, épaisseur, masquer), panel_update.",
    {
      all: z.boolean().optional().describe("true : tous les graphiques"),
      products: z.array(z.string()).max(60).optional().describe("Ou : les produits concernés (nom courant ou code : or, Nasdaq, EURUSD)"),
      add: z.array(INDICATOR).optional().describe("Indicateurs à poser (un indicateur déjà là n'est pas doublé)"),
      remove: z.array(REMOVAL).optional().describe("Indicateurs à retirer"),
    },
    async (args) => text(await api("/indicators/apply", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "chart_draw",
    "Trace sur le graphique d'un produit une ligne horizontale (kind hline : un support, une résistance, un niveau), une zone de prix (kind zone : un rectangle entre deux prix, de support ou de résistance), une oblique (kind trendline : une ligne de tendance entre deux points), un retracement de Fibonacci (kind fib : start, le début du mouvement, et end, sa fin ; niveaux 0 à 1 depuis end : 0,236, 0,382, 0,5, 0,618, 0,786) ou une extension de Fibonacci (kind fibext : l'impulsion de start à end, puis projection, la fin du repli ; niveaux 0,382 à 2,618 de l'impulsion, projetés depuis projection), ou une boîte de trade (kind position, comme les positions longue et courte de TradingView : side, entry, stop et objective ; elle montre le gain, le risque et leur rapport, et sa taille selon son risque ; c'est une analyse : rien ne part chez le courtier sans la confirmation de l'utilisateur). Les points d'un Fibonacci sont des plus hauts et des plus bas pris dans market_history, jamais inventés. Renvoie la description du tracé, avec le prix de chaque niveau d'un Fibonacci, le gain, le risque, le rapport et la taille d'une boîte. Le tracé appartient au produit : il se voit dans toutes les unités de temps et reste jusqu'à ce qu'on l'efface.",
    { target: z.string().describe(DRAW_TARGET), kind: z.enum(DRAWING_KINDS), ...SHAPE },
    async (args) => text(await api("/drawings", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "chart_drawings",
    "Liste les tracés d'un produit (lignes, zones, obliques, Fibonacci avec le prix de leurs niveaux), avec leur identifiant (d_…), qui les a tracés et leur description ; sans target, ceux des graphiques affichés.",
    { target: z.string().optional().describe(DRAW_TARGET) },
    async ({ target }) => text(await api(`/drawings${target ? `?${new URLSearchParams({ target })}` : ""}`)),
  );

  server.tool(
    "chart_move",
    "Déplace ou renomme un tracé existant (son identifiant d_…) : seuls les champs donnés changent (« monte la résistance à 2 690 », « prolonge la zone jusqu'à maintenant »).",
    { id: z.string().describe("L'identifiant du tracé (d_…)"), ...SHAPE },
    async (args) => text(await api("/drawings/update", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "chart_erase",
    "Efface des tracés (ids), ou tous ceux d'un produit (all avec target). La boîte d'un trade en cours (ordre en attente, position ouverte) ne s'efface pas : un ticket de retrait (ou de fermeture) s'affiche, tu le relis, seul l'utilisateur le confirme, et elle part une fois l'ordre retiré.",
    {
      ids: z.array(z.string()).optional().describe("Identifiants des tracés (d_…)"),
      target: z.string().optional().describe(DRAW_TARGET),
      all: z.boolean().optional().describe("true : tous les tracés du produit (target)"),
    },
    async (args) => text(await api("/drawings/erase", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "alert_create",
    "Pose une alerte sur un produit : à un prix (target et price), ou sur un tracé (drawing, son identifiant d_…) : une ligne horizontale ou oblique, ou une zone, où elle part quand le prix y entre ; une zone qu'on te nomme sans qu'elle soit tracée se trace d'abord (chart_draw zone), puis l'alerte se pose dessus, une seule ; ou sur un niveau d'un Fibonacci (drawing et level, son ratio : « préviens-moi au 0,618 » ; il suit le niveau si le Fibonacci bouge, même au-delà de ses points). Le serveur la surveille même écran fermé ; quand elle part, l'écran sonne et tu reçois un message [Alerte] avec sa consigne. Une seule alerte par ligne, ou par niveau d'un Fibonacci.",
    {
      target: z.string().optional().describe(DRAW_TARGET),
      price: z.number().optional().describe("Le prix de l'alerte (avec target)"),
      drawing: z.string().optional().describe("Ou : la ligne tracée à surveiller (d_…) ; elle désigne son produit"),
      level: z
        .number()
        .optional()
        .describe("Avec drawing, sur un Fibonacci : le ratio du niveau à surveiller (0.618 ; un retracement va de 0 à 1, une extension de 0 à 2.618)"),
      ...ALERT_SETTINGS,
    },
    async (args) => text(await api("/alerts", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "alert_list",
    "Liste les alertes d'un produit (son prix ou sa ligne, sens, déclenchement, état, consigne), avec leur identifiant (a_…) ; sans target, toutes.",
    { target: z.string().optional().describe(DRAW_TARGET) },
    async ({ target }) => text(await api(`/alerts${target ? `?${new URLSearchParams({ target })}` : ""}`)),
  );

  server.tool(
    "alert_update",
    "Règle une alerte (son identifiant a_…) : seuls les champs donnés changent (« passe-la sur clôture 1 heure », « monte-la à 2 700 »). paused true la suspend, false la réactive ; une alerte déjà partie qu'on règle repart.",
    {
      id: z.string().describe("L'identifiant de l'alerte (a_…)"),
      price: z.number().optional().describe("Nouveau prix (alerte de prix seulement ; une alerte sur une ligne suit la ligne : déplace-la avec chart_move)"),
      paused: z.boolean().optional().describe("true : suspendue ; false : réactivée"),
      ...ALERT_SETTINGS,
    },
    async (args) => text(await api("/alerts/update", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "alert_delete",
    "Retire des alertes (ids), ou toutes celles d'un produit (all avec target). Effacer une ligne retire aussi son alerte.",
    {
      ids: z.array(z.string()).optional().describe("Identifiants des alertes (a_…)"),
      target: z.string().optional().describe(DRAW_TARGET),
      all: z.boolean().optional().describe("true : toutes les alertes du produit (target)"),
    },
    async (args) => text(await api("/alerts/delete", { method: "POST", body: JSON.stringify(args) })),
  );
}
