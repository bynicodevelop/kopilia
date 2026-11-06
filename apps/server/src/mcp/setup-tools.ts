/**
 * Outils des agents de la recherche d'opportunités (passes et réveils), sur le
 * serveur MCP des agents (« kopilia ») : hypothèses, dossiers de scénarios, leurs
 * alertes et rendez-vous, correction de la carte automatique, leurs niveaux de
 * travail tracés et leurs suggestions sur les tracés de l'utilisateur. Seul le serveur
 * Nest écrit en base ; l'agent ne fait que demander, avec un jeton qui n'ouvre
 * que ces outils et les lectures des agents.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const post = (api: Api, path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

const MOMENT = "« AAAA-MM-JJ HH:MM », heure de Paris";
const PRODUCT = "Nom courant ou code du produit (Nasdaq, Dow Jones, or, EURUSD) ; le symbole exact du courtier est retrouvé";
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
const SCENARIO = z.string().describe("Identifiant du scénario (sc_…)");

/** Les champs d'un dossier, communs à l'ouverture et à la mise à jour. */
const dossier = {
  horizon: z
    .enum(["intraday", "swing"])
    .describe(
      "intraday : la séance ; swing : plusieurs jours. Ses unités de temps sont celles de sa façon de trader ; s'il n'en dit rien, entrée en 15 minutes pour l'intraday, en 1 heure ou 4 heures pour le swing",
    ),
  timeframe: z.enum(TIMEFRAMES).describe("Unité de temps de l'entrée"),
  context_timeframe: z.enum(TIMEFRAMES).optional().describe("Unité de temps du contexte (zones, tendance)"),
  title: z.string().describe("Titre court, lisible à voix haute (« Or : rejet de la résistance 4 h »)"),
  why: z
    .string()
    .describe(
      "Pourquoi ce scénario : les hypothèses (identifiants h_…), les niveaux (tracés d_… ou zones de la carte), la façon de trader de l'utilisateur qu'il suit",
    ),
  snapshot: z
    .string()
    .describe(
      "Ce que tu vois maintenant, chiffré : prix et heure, distance aux niveaux, indicateurs, agenda à venir. Ton toi futur le comparera à ce qu'il verra",
    ),
  plan: z
    .string()
    .describe(
      "Le plan « si… alors… » : ce qui doit se passer, dans quel ordre, ce que tu feras à chaque cas (attendre une clôture, proposer, abandonner). Écris pour l'agent qui se réveillera sans rien savoir d'autre",
    ),
  invalidation: z.string().describe("Ce qui invaliderait le scénario (prix, clôture, donnée, heure limite)"),
  hypotheses: z.array(z.string()).optional().describe("Hypothèses dont il dépend (h_…) : si l'une change, il sera revu"),
  drawings: z.array(z.string()).optional().describe("Tracés de l'utilisateur dont il dépend (d_…) : s'il les déplace ou les efface, il sera revu"),
  events: z
    .array(
      z.object({
        time: z.string().describe(MOMENT),
        currency: z.string().describe("USD, EUR…"),
        title: z.string().describe("Titre de l'annonce (Forex Factory)"),
      }),
    )
    .optional()
    .describe("Annonces du calendrier dont il dépend : à leur publication, il sera revu"),
  entry: z.number().optional().describe("Prix d'entrée envisagé"),
  stop: z.number().optional().describe("Stop envisagé"),
  targets: z.array(z.number()).max(3).optional().describe("Objectifs envisagés, le premier d'abord"),
  expires: z
    .string()
    .describe(`Échéance du scénario, ${MOMENT} : passée, il se ferme avec ses alertes (fin de séance, avant une news, quelques jours pour un swing)`),
};

export function registerSetupTools(server: McpServer, api: Api) {
  server.tool(
    "hypothesis_set",
    "Émet une hypothèse de l'IA (sans id) ou met à jour l'une des tiennes (avec id) : énoncé, produits, sens, horizon, catalyseurs, invalidation, échéance ; ou change son état (confirmed, invalidated) en disant pourquoi. Les hypothèses de l'utilisateur ne se modifient pas : si tu n'es pas d'accord, émets la tienne. Les scénarios qui en dépendent seront revus.",
    {
      id: z.string().optional().describe("Hypothèse à mettre à jour (h_…) ; omis pour en émettre une"),
      statement: z.string().optional().describe("L'hypothèse, en une phrase (« le dollar reprend avant le CPI »)"),
      products: z.array(z.string()).max(6).optional().describe(PRODUCT),
      bias: z.enum(["up", "down", "neutral"]).optional().describe("Sens attendu pour ces produits"),
      horizon: z.enum(["intraday", "swing"]).optional(),
      catalysts: z.string().optional().describe("Ce qui la confirmera ou la cassera (annonces, discours), avec l'heure"),
      invalidation: z.string().optional().describe("Ce qui l'invaliderait : toujours dit"),
      source: z.string().optional().describe("D'où elle vient (« wrap de 7 h », « calendrier »)"),
      expires: z.string().optional().describe(`Échéance, ${MOMENT} ; par défaut la fin de séance (intraday) ou cinq jours (swing)`),
      state: z.enum(["active", "confirmed", "invalidated"]).optional(),
      reason: z.string().optional().describe("Pourquoi elle change d'état (le fait, chiffré)"),
    },
    async (args) => text(await post(api, "/setups/hypotheses", args)),
  );

  server.tool(
    "scenario_open",
    "Ouvre un dossier de scénario sur un produit. Le dossier est la seule mémoire de l'agent qui se réveillera quand une de ses alertes partira : écris-le pour lui, chiffré et complet (pourquoi, ce que tu vois, plan « si… alors… », invalidation, dépendances, échéance). Pose ensuite ses alertes (scenario_watch) ou un rendez-vous (scenario_rendezvous).",
    {
      product: z.string().describe(PRODUCT),
      direction: z.enum(["long", "short"]),
      ...dossier,
    },
    async (args) => text(await post(api, "/setups/scenarios", args)),
  );

  server.tool(
    "scenario_view",
    "Relit un dossier : pourquoi, photo, plan, invalidation, dépendances, niveaux, alertes, rendez-vous, et son fil (ce qui lui est arrivé, avec les décisions et leurs raisons).",
    { id: SCENARIO },
    async ({ id }) => text(await api(`/setups/scenarios/${encodeURIComponent(id)}`)),
  );

  server.tool(
    "scenario_update",
    "Met à jour un dossier ouvert (plan, photo, niveaux, dépendances, échéance…) : seuls les champs donnés changent, et la raison est écrite dans son fil.",
    {
      id: SCENARIO,
      reason: z.string().describe("Pourquoi tu le mets à jour"),
      ...Object.fromEntries(Object.entries(dossier).map(([k, v]) => [k, v.optional()])),
    },
    async (args) => text(await post(api, `/setups/scenarios/${encodeURIComponent(String(args.id))}/update`, args)),
  );

  server.tool(
    "scenario_note",
    "Écrit au fil d'un dossier : ta décision et sa raison (« j'attends la clôture de 10 h 45 : la mèche n'a pas encore rejeté »), un constat, un changement de contexte. Une décision sans action (attendre) s'écrit ici.",
    {
      id: SCENARIO,
      kind: z.enum(["decision", "context", "note"]).optional().describe("decision par défaut"),
      text: z.string(),
    },
    async ({ id, kind, text: note }) => text(await post(api, `/setups/scenarios/${encodeURIComponent(id)}/note`, { kind: kind ?? "decision", text: note })),
  );

  server.tool(
    "scenario_watch",
    "Pose une alerte de l'IA pour ce scénario : à un prix (price), sur un tracé de l'utilisateur (drawing, d_… : ligne, oblique ou zone) ou sur une bande de prix (zone_top et zone_bottom, une zone de la carte automatique par exemple). Le serveur la surveille sans IA ; quand elle part, un agent se réveille avec le dossier et ton intention. Sur une zone, elle part quand le prix y entre. trigger close : seulement quand une bougie de l'unité timeframe clôture au-delà (pour attendre un rejet ou une cassure confirmée) ; once : au premier contact.",
    {
      id: SCENARIO,
      price: z.number().optional(),
      drawing: z.string().optional(),
      zone_top: z.number().optional(),
      zone_bottom: z.number().optional(),
      condition: z.enum(["cross", "up", "down"]).optional().describe("Sens : up (par-dessous, à la hausse), down (par-dessus, à la baisse), cross (les deux)"),
      trigger: z.enum(["once", "bar", "close"]).optional().describe("once par défaut"),
      timeframe: z.enum(TIMEFRAMES).optional().describe("Unité de la clôture (trigger close) ; celle du scénario par défaut"),
      intention: z
        .string()
        .describe("Ce que tu vérifieras quand elle partira (« vérifier que la bougie 15 min rejette la zone : mèche haute, clôture dedans »)"),
      expires: z.string().optional().describe(`Échéance de l'alerte, ${MOMENT} ; celle du scénario au plus tard`),
    },
    async (args) => text(await post(api, `/setups/scenarios/${encodeURIComponent(args.id)}/watch`, args)),
  );

  server.tool(
    "scenario_unwatch",
    "Retire des alertes de ce scénario (a_…), en disant pourquoi.",
    { id: SCENARIO, alerts: z.array(z.string()).min(1), reason: z.string() },
    async (args) => text(await post(api, `/setups/scenarios/${encodeURIComponent(args.id)}/unwatch`, args)),
  );

  server.tool(
    "scenario_rendezvous",
    "Prend un rendez-vous : un agent se réveillera à cette heure avec le dossier (un seul rendez-vous par scénario, le nouveau remplace l'ancien). at : un instant, ou « next_close » pour la clôture de la bougie en cours dans timeframe (le serveur compte quelques secondes de plus, le temps que la bougie close soit lisible).",
    {
      id: SCENARIO,
      at: z.string().describe(`${MOMENT}, ou next_close`),
      timeframe: z.enum(TIMEFRAMES).optional().describe("Avec next_close : l'unité de la bougie ; celle du scénario par défaut"),
      reason: z.string().describe("Ce que tu vérifieras à ce rendez-vous"),
    },
    async (args) => text(await post(api, `/setups/scenarios/${encodeURIComponent(args.id)}/rendezvous`, args)),
  );

  server.tool(
    "scenario_propose",
    "Le setup est en place : propose-le à l'utilisateur, avec l'entrée, le stop et les objectifs (le serveur vérifie leur cohérence). Kopilia le lui dira ; son résultat sera suivi. Seulement quand le plan du dossier est réalisé et que le pourquoi tient : sinon, attends ou abandonne.",
    {
      id: SCENARIO,
      summary: z
        .string()
        .describe("Ce que Kopilia dira, en deux ou trois phrases parlées : le produit, le sens, ce qui vient de se passer, pourquoi maintenant, les niveaux"),
      entry: z.number(),
      stop: z.number(),
      targets: z.array(z.number()).min(1).max(3),
    },
    async (args) => text(await post(api, `/setups/scenarios/${encodeURIComponent(args.id)}/propose`, args)),
  );

  server.tool(
    "scenario_abandon",
    "Abandonne un scénario (son pourquoi ne tient plus, il est invalidé, ou un scénario concurrent s'est confirmé) : ses alertes et son rendez-vous sont retirés, la raison reste au fil.",
    { id: SCENARIO, reason: z.string().describe("La raison, chiffrée (« clôture 15 min à 2 663, au-dessus de la zone »)") },
    async (args) => text(await post(api, `/setups/scenarios/${encodeURIComponent(args.id)}/abandon`, args)),
  );

  server.tool(
    "map_adjust",
    "Corrige un élément de la carte automatique (zone z:… ou oblique s:/r:…, par sa clé, telle que market_levels la donne) : ajuste les bornes d'une zone (par exemple pour reprendre les mèches qu'elle coupe), ou l'écarte s'il n'a pas de sens. La correction est bornée (une zone ne bouge pas de plus d'un ATR) et gardée avec sa raison ; les tracés de l'utilisateur ne se corrigent pas ici.",
    {
      symbol: z.string().describe(PRODUCT),
      timeframe: z.enum(["5m", "15m", "30m", "1h", "4h", "1d"]),
      key: z.string(),
      action: z.enum(["adjust", "remove"]),
      top: z.number().optional(),
      bottom: z.number().optional(),
      reason: z.string(),
    },
    async (args) => text(await post(api, "/setups/map-adjustments", args)),
  );

  const point = z.object({ time: z.string().describe(MOMENT), price: z.number() });
  server.tool(
    "level_draw",
    "Trace un niveau de travail d'un scénario sur le graphique, pour que l'utilisateur voie ce que tu as travaillé et fasse le contrôle final à l'œil : un candidat de la carte automatique que tu as contrôlé (from : sa clé z:…, s:… ou r:…, avec la même unité de temps ; tu peux corriger les bornes d'une zone d'un ATR au plus), ou ton propre niveau (kind zone, line ou trendline). Jamais là où l'utilisateur a déjà tracé : appuie-toi alors sur son tracé (dépendances du dossier). Un niveau de l'IA déjà au même endroit est partagé. Le niveau part avec le dossier ; l'utilisateur peut le garder (il devient le sien) ou le retirer.",
    {
      scenario_id: SCENARIO,
      from: z.string().optional().describe("Clé d'un candidat de la carte automatique (market_levels), à adopter après contrôle"),
      timeframe: z.enum(["5m", "15m", "30m", "1h", "4h", "1d"]).optional().describe("Unité de la carte du candidat (celle du contexte du dossier par défaut)"),
      kind: z.enum(["zone", "line", "trendline"]).optional().describe("Sans candidat : zone (top, bottom), ligne horizontale (price), oblique (a, b)"),
      top: z.number().optional(),
      bottom: z.number().optional(),
      price: z.number().optional(),
      a: point.optional().describe("Premier point d'une oblique"),
      b: point.optional().describe("Second point d'une oblique (elle est prolongée vers la droite)"),
      label: z.string().max(40).describe("Nom court affiché sur le graphique (« support 1h », « oblique de résistance »)"),
      reason: z.string().describe("Pourquoi ce niveau compte pour le dossier (contacts, rôle, ce qu'il en attend)"),
    },
    async ({ scenario_id, ...rest }) => text(await post(api, `/setups/scenarios/${encodeURIComponent(scenario_id)}/levels`, rest)),
  );

  server.tool(
    "level_erase",
    "Retire un de tes niveaux de travail d'un dossier (il disparaît du graphique, sauf si un autre dossier ouvert s'y appuie), en disant pourquoi.",
    { scenario_id: SCENARIO, drawing_id: z.string().describe("Le niveau (d_…)"), reason: z.string() },
    async ({ scenario_id, drawing_id, reason }) =>
      text(await post(api, `/setups/scenarios/${encodeURIComponent(scenario_id)}/levels/${encodeURIComponent(drawing_id)}/erase`, { reason })),
  );

  server.tool(
    "drawing_suggest",
    "Suggère une correction sur un tracé de l'utilisateur, que tu ne modifies jamais : il la voit (écran Opportunités, et Kopilia peut la lui dire) et décide. Par exemple une zone qui coupe des mèches évidentes, une oblique cassée, un niveau dépassé. Une seule suggestion en attente par tracé (la dernière remplace la précédente).",
    {
      drawing_id: z.string().describe("Le tracé de l'utilisateur (d_…)"),
      text: z.string().describe("La suggestion, en une phrase pour lui (« ta zone coupe les mèches de 28 070 : la descendre à 28 065 ? »)"),
      scenario_id: SCENARIO.optional(),
    },
    async (args) => text(await post(api, "/setups/suggestions", args)),
  );
}
