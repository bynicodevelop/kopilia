#!/usr/bin/env node
/**
 * Serveur MCP local « kopilia » exposé à la SESSION DE DIALOGUE Claude.
 * Il n'offre que des outils de coordination : déléguer à un agent, lancer /
 * consulter / annuler / instruire une tâche, lister les projets, retenir ou
 * oublier une information, ouvrir une recette, chercher dans les conversations
 * passées, demander un apprentissage. Agents et ouvriers ont les outils de travail.
 *
 * Lancé par le CLI comme sous-processus via --mcp-config. Il relaie vers l'API
 * interne de Nest (loopback + jeton). Variables d'environnement attendues :
 *   KOPILIA_INTERNAL_URL, KOPILIA_INTERNAL_TOKEN, KOPILIA_SESSION_ID
 */
import "../common/legacy-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerMarketTools } from "./market-tools.js";
import { registerConversationSearch, registerSkillView } from "./knowledge-tools.js";
import { CHART_TIMEFRAMES } from "../market/timeframes.js";
import { MA_TYPES, MAX_VIEW_BLOCKS, PANEL_DISPLAYS, viewBlockInputSchema } from "@kopilia/contracts";
import { INDICATOR, SETTINGS, registerActionTools } from "./action-tools.js";
import { registerTradingTools } from "./trading-tools.js";

const BASE = process.env.KOPILIA_INTERNAL_URL ?? "http://127.0.0.1:4317";
const TOKEN = process.env.KOPILIA_INTERNAL_TOKEN ?? "";
const SESSION_ID = process.env.KOPILIA_SESSION_ID ?? "";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}/internal${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`contrôle interne ${res.status}`);
  return res.json();
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const server = new McpServer({ name: "kopilia", version: "0.4.0" });

server.tool("list_folders", "Liste les projets de l'utilisateur : les sous-dossiers de son dossier Documents.", async () => text(await api("/folders")));

server.tool(
  "ask_agent",
  "Confie une recherche, une analyse ou un travail à un agent plus puissant que toi, qui travaille en arrière-plan pendant que la conversation continue : web (lire des pages précises, croiser des sites, horaires, programmes, prix), lecture des fichiers d'un projet sans rien y modifier, cours du marché, et avec act, des actions sur Kopilia (tracés, alertes, indicateurs). Aucune confirmation nécessaire. Renvoie tout de suite ; son résultat te sera transmis automatiquement quand il sera prêt.",
  {
    title: z.string().describe("Titre court, lisible à voix haute (ex. « Séances au cinéma d'Annecy »)"),
    prompt: z.string().describe("Consigne complète et autonome : la demande exacte, le lieu, la date, le contexte utile"),
    folder: z
      .string()
      .optional()
      .describe("Sous-dossier de Documents à étudier, tel que renvoyé par list_folders (« . » pour Documents lui-même). Omis pour une recherche web."),
    deep: z.boolean().optional().describe("true pour une analyse longue ou difficile (modèle le plus puissant, plus lent)"),
    documents: z
      .array(z.string())
      .optional()
      .describe("Identifiants des documents joints par l'utilisateur que l'agent doit lire (ex. « doc_… », tels qu'annoncés par [Document joint])"),
    act: z
      .boolean()
      .optional()
      .describe(
        "true : l'agent agit aussi sur Kopilia, sans toucher à l'écran : il trace sur les graphiques, pose ou règle des alertes, règle des indicateurs. Pour une analyse technique d'un ou plusieurs produits (il trace l'essentiel et dit ce qu'il voit), ou un travail produit par produit",
      ),
  },
  async ({ title, prompt, folder, deep, documents, act }) =>
    text(
      await api("/jobs", {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, kind: "agent", folder, title, prompt, deep: deep ?? false, documents, act: act ?? false }),
      }),
    ),
);

server.tool(
  "start_task",
  "Lance un ouvrier qui AGIT dans un projet de l'utilisateur : écrire ou modifier des fichiers, coder, lancer des commandes, git. L'utilisateur confirme à l'écran avant l'exécution. Une tâche à la fois par projet, mais des projets différents avancent en parallèle (trois au plus). Renvoie immédiatement un jobId ; le résultat te sera transmis automatiquement. Pour seulement chercher ou lire, utilise ask_agent.",
  {
    title: z.string().describe("Titre court de la tâche, lisible à voix haute"),
    prompt: z.string().describe("Instruction complète pour l'ouvrier"),
    folder: z
      .string()
      .optional()
      .describe("Sous-dossier de Documents où travailler, tel que renvoyé par list_folders (ex. « Kopilia »). Vide = Documents lui-même."),
  },
  async ({ title, prompt, folder }) =>
    text(
      await api("/jobs", {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, kind: "task", folder: folder ?? "", title, prompt, requiresApproval: true }),
      }),
    ),
);

server.tool(
  "task_status",
  "Consulte l'état d'un agent ou d'une tâche (ou du dernier lancé si jobId est omis).",
  { jobId: z.string().optional() },
  async ({ jobId }) => text(await api(`/jobs/${encodeURIComponent(jobId ?? "active")}?sessionId=${encodeURIComponent(SESSION_ID)}`)),
);

server.tool(
  "instruct_task",
  "Ajoute une consigne à une tâche en cours (statut en attente tant que l'ouvrier ne l'a pas prise en compte).",
  { jobId: z.string(), note: z.string() },
  async ({ jobId, note }) => text(await api(`/jobs/${encodeURIComponent(jobId)}/instruct`, { method: "POST", body: JSON.stringify({ note }) })),
);

server.tool("cancel_task", "Annule un agent ou une tâche, et ses processus enfants.", { jobId: z.string() }, async ({ jobId }) =>
  text(await api(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" })),
);

server.tool(
  "start_brief",
  "Lance l'agent de veille : il rédige le brief sous forme de wrap des séances, uniquement ce qui est nouveau depuis le brief précédent (banques centrales, indicateurs publiés, devises, taux, actions, pétrole, or, géopolitique qui fait bouger les marchés, rendez-vous à suivre), en quelques minutes. Renvoie tout de suite ; le résumé te sera transmis automatiquement et le brief complet s'affichera à l'écran.",
  async () => text(await api("/briefs", { method: "POST", body: JSON.stringify({ sessionId: SESSION_ID }) })),
);

server.tool(
  "get_brief",
  "Renvoie le dernier brief de veille complet (titre, date, texte Markdown), pour répondre à une question sur son contenu ou en détailler une rubrique.",
  async () => text(await api("/briefs/latest")),
);

server.tool(
  "economic_calendar",
  "Calendrier économique Forex Factory, gardé en local (réponse immédiate) : annonces d'indicateurs, banques centrales, discours, jours fériés, avec l'heure (heure de Paris), la devise, l'impact, la prévision, le chiffre précédent et, une fois sorti, le chiffre publié (« publié », lu dans les news en temps réel). Couvre la semaine en cours.",
  {
    period: z
      .enum(["today", "tomorrow", "yesterday", "week"])
      .optional()
      .describe("Jour demandé (aujourd'hui par défaut) ou toute la semaine, du lundi au dimanche"),
    date: z.string().optional().describe("Jour précis AAAA-MM-JJ, à la place de period"),
    impact: z
      .enum(["high", "medium", "all"])
      .optional()
      .describe("high : annonces fortes ; medium : moyennes et fortes ; all : tout. Défaut : all pour un jour, medium pour la semaine"),
    currencies: z.array(z.string()).optional().describe('Devises à garder (ex. ["USD", "EUR"]) ; toutes si omis'),
  },
  async ({ period, date, impact, currencies }) => {
    const q = new URLSearchParams();
    if (period) q.set("period", period);
    if (date) q.set("date", date);
    if (impact) q.set("impact", impact);
    if (currencies?.length) q.set("currencies", currencies.join(","));
    return text(await api(`/calendar?${q}`));
  },
);

server.tool(
  "news_recent",
  "Les news en temps réel (FinancialJuice, traduites en français, gardées pour toujours) : heure, niveau (forte, moyenne, faible), titre, impact probable sur sa liste, et la réaction du marché quand elle a été mesurée. Pour « pourquoi l'or monte ? » (symbol : ses news de la journée par défaut ; cherche d'abord les fortes), « quelles news cet après-midi ? » (since « 13:00 »), « les dernières news » (la dernière heure par défaut), « qu'a dit Powell sur l'inflation ? » (query, dans toute l'archive). Local, réponse immédiate.",
  {
    symbol: z.string().optional().describe("Le produit (code usuel ou nom courant : or, Nasdaq, EURUSD) ; toutes les news sinon"),
    since: z
      .string()
      .optional()
      .describe(
        "Depuis cette heure (heure de Paris) : « 13:00 » aujourd'hui, ou « AAAA-MM-JJ HH:MM » ; « ce matin » : « 07:00 », « cet après-midi » : « 13:00 »",
      ),
    minutes: z.number().int().positive().max(10080).optional().describe("Ou les news de ces dernières minutes"),
    query: z.string().optional().describe("Des mots à chercher dans toute l'archive (en anglais ou en français : Powell, tarifs, Ormuz)"),
    level: z.enum(["high", "medium"]).optional().describe("high : les fortes seulement ; medium : moyennes et fortes ; toutes sinon"),
    limit: z.number().int().positive().max(40).optional().describe("Nombre de news au plus (20 par défaut)"),
  },
  async ({ symbol, since, minutes, query, level, limit }) => {
    const q = new URLSearchParams();
    if (symbol) q.set("symbol", symbol);
    if (since) q.set("since", since);
    if (minutes) q.set("minutes", String(minutes));
    if (query) q.set("query", query);
    if (level) q.set("level", level);
    if (limit) q.set("limit", String(limit));
    return text(await api(`/news?${q}`));
  },
);

// Cours en direct et historique (MetaApi), les mêmes que pour les agents.
registerMarketTools(server, api);

// Tableau de bord : les encarts affichés autour de l'orbe, pilotés à la voix.
const PANEL_REF =
  "L'encart : son identifiant (p_…), ou le produit qu'il montre (EURUSD, Nasdaq, or), ou « suivi », ou « produits », ou « setups », ou « activité », ou « news », ou « journal », ou le titre d'une vue";

server.tool(
  "panel_open",
  "Affiche un encart à l'écran de l'utilisateur : le graphique en bougies d'un produit (kind chart, par défaut), en direct de son compte MetaTrader, ou un suivi des prix de plusieurs produits (kind quotes ; un seul suivi, les produits s'y ajoutent), ou la liste de tous ses produits (kind products : sa liste entière, comme la liste de surveillance de TradingView, prix et variation du jour, un clic sur une ligne ouvre le graphique ; « affiche mes produits », « montre-moi la liste de mes produits »), ou la liste des setups repérés par l'IA (kind setups : en attente et déclenchés, avec leur prix en direct, mise à jour d'elle-même ; « affiche les setups », « montre-moi les dossiers ouverts »), ou l'activité (kind activity : les agents et tâches récents, leur état et leur résultat ; « montre-moi les agents », « qu'est-ce qui tourne ? »), ou les news en temps réel (kind news : traduites, avec leur impact ; avec symbol, celles d'un produit : « affiche les news », « montre les news sur l'or »), ou son journal de trading (kind journal : ses trades rangés par fiche d'analyse, avec leur résultat ; « affiche mon journal », « montre-moi mon journal de trading »), ou les robots du laboratoire de stratégies (kind robots : les stratégies que Kopilia a développées et backtestées, leur statut et leurs chiffres en R, mis à jour d'eux-mêmes ; « affiche les robots », « montre-moi mes stratégies »). Renvoie le prix du moment (ou les setups en cours), à dire en une phrase. Les encarts restent affichés d'une conversation à l'autre, douze au plus (au-delà de deux par côté, ils s'empilent).",
  {
    kind: z
      .enum(["chart", "quotes", "products", "setups", "activity", "news", "journal", "robots"])
      .optional()
      .describe(
        "chart (défaut) : le graphique d'un produit ; quotes : le suivi de plusieurs ; products : la liste de tous ses produits ; setups : la liste des setups repérés ; activity : les agents et tâches récents ; news : les news en temps réel (avec symbol : d'un produit) ; journal : son journal de trading ; robots : les robots du laboratoire de stratégies",
      ),
    symbol: z.string().optional().describe("Le produit du graphique : code usuel (EURUSD, XAUUSD) ou nom courant (Nasdaq, or, pétrole)"),
    symbols: z.array(z.string()).optional().describe("Les produits d'un suivi (kind quotes)"),
    timeframe: z
      .enum(CHART_TIMEFRAMES)
      .optional()
      .describe("Unité de temps des bougies (1w : la semaine, 1mn : le mois) ; 15m si l'utilisateur ne dit rien et que tu ne connais pas sa préférence"),
    maximize: z.boolean().optional().describe("Le graphique en grand, presque tout l'écran, dès l'ouverture (« ouvre l'or en plein écran »)"),
  },
  async (args) => text(await api("/panels", { method: "POST", body: JSON.stringify(args) })),
);

server.tool(
  "panel_display",
  "Montre un encart autrement à l'écran : agrandit un graphique (maximize : presque tout l'écran ; « mets l'or en grand », « plein écran », « agrandis-le »), lui rend sa taille et sa place d'avant (restore : « réduis-le », « remets-le comme avant », « rends-lui sa place » ; sans panel, tous les graphiques agrandis), ou ramène dans sa marge un encart déplacé à la main (dock : « remets-le à sa place », « range-le »). Un produit pas encore affiché s'ouvre directement en grand. Un seul graphique agrandi à la fois : en agrandir un rend leur taille aux autres.",
  {
    panel: z.string().optional().describe(`${PANEL_REF} ; sans, avec restore : tous les graphiques agrandis`),
    display: z.enum(PANEL_DISPLAYS),
  },
  async (args) => text(await api("/panels/display", { method: "POST", body: JSON.stringify(args) })),
);

server.tool(
  "panel_update",
  "Modifie un encart affiché : l'unité de temps (timeframe), le produit (symbol) ou les indicateurs d'un graphique (moyennes mobiles sur les bougies, RSI dans un bandeau sous elles ; dix au plus, plusieurs du même genre possibles) : addIndicators en ajoute, editIndicators en change les réglages (par leur identifiant i_…, donné par la note des encarts), removeIndicators en retire ; les produits ajoutés (add) ou retirés (remove) d'un suivi.",
  {
    panel: z.string().describe(PANEL_REF),
    timeframe: z.enum(CHART_TIMEFRAMES).optional(),
    symbol: z.string().optional().describe("Le nouveau produit du graphique"),
    add: z.array(z.string()).optional().describe("Produits à ajouter au suivi"),
    remove: z.array(z.string()).optional().describe("Produits à retirer du suivi"),
    addIndicators: z.array(INDICATOR).optional().describe("Indicateurs à tracer sur le graphique"),
    editIndicators: z
      .array(z.object({ id: z.string().describe("Identifiant de l'indicateur (i_…)"), ...SETTINGS }))
      .optional()
      .describe("Réglages à changer (seuls ceux donnés changent) : « passe la moyenne 50 en exponentielle », « mets le RSI à 80 / 20 »"),
    removeIndicators: z
      .array(
        z.object({
          id: z.string().optional().describe("Identifiant (i_…)"),
          kind: z.enum(["ma", "rsi", ...MA_TYPES]).optional(),
          period: z.number().int().optional(),
        }),
      )
      .optional()
      .describe("Indicateurs à retirer : par identifiant, ou par genre (et longueur ; sans, tous ceux du genre)"),
  },
  async (args) => text(await api("/panels/update", { method: "POST", body: JSON.stringify(args) })),
);

server.tool(
  "panel_close",
  "Ferme un encart (panel), ou tous (all : « efface le tableau de bord », « enlève tout »), ou tous sauf certains (all avec except).",
  {
    panel: z.string().optional().describe(PANEL_REF),
    all: z.boolean().optional().describe("true : tous les encarts"),
    except: z.array(z.string()).optional().describe("Avec all : les encarts à garder"),
  },
  async (args) => text(await api("/panels/close", { method: "POST", body: JSON.stringify(args) })),
);

// Vues : des encarts composés à partir d'un catalogue de blocs (comme les outils d'un serveur MCP), sans nouveau code.
const VIEW_BLOCKS = z
  .array(viewBlockInputSchema)
  .min(1)
  .max(MAX_VIEW_BLOCKS)
  .describe(
    "Les blocs, dans l'ordre d'affichage. Vivants : quotes, sparkline, calendar, setups, hypotheses, brief ; écrits : heading, text, stat, table, list",
  );

server.tool(
  "view_catalog",
  "Le catalogue des blocs dont une vue peut être faite : chaque genre, ce qu'il montre, s'il reste à jour tout seul. Pour répondre à « qu'est-ce que tu peux m'afficher ? », ou avant une vue inhabituelle.",
  {},
  async () => text(await api("/views/catalog")),
);

server.tool(
  "view_open",
  "Compose un encart sur mesure (une vue) à partir des blocs du catalogue : « fais-moi un tableau USD pour la semaine avec l'or et le dollar », « un récap de mes setups et des annonces du jour ». Les blocs vivants restent à jour à l'écran ; les blocs écrits gardent ce que tu y mets. Une vue du même titre est remplacée. Elle se déplace et se ferme comme les autres encarts (panel_close avec son titre).",
  {
    title: z.string().describe("Titre court, celui qu'on dira pour la désigner (« USD semaine »)"),
    blocks: VIEW_BLOCKS,
  },
  async (args) => text(await api("/views", { method: "POST", body: JSON.stringify(args) })),
);

server.tool(
  "view_update",
  "Change une vue affichée : son titre, ou ses blocs (la liste entière, dans l'ordre : reprends ceux à garder, donnés par panel_open ou la note des encarts).",
  {
    panel: z.string().describe("La vue : son identifiant (p_…) ou son titre"),
    title: z.string().optional(),
    blocks: VIEW_BLOCKS.optional(),
  },
  async (args) => text(await api("/views/update", { method: "POST", body: JSON.stringify(args) })),
);

// Analyse technique et alertes : tracés d'un produit, alertes, indicateurs de plusieurs graphiques (partagés avec les agents d'action).
registerActionTools(server, api);

// Prise de position : money management, tickets d'ordre (confirmés par l'utilisateur seul), bilan. Jamais aux agents.
registerTradingTools(server, api);

server.tool(
  "remember",
  "Retient durablement une information sur l'utilisateur, pour toutes les conversations suivantes : dans son profil (où il habite, ses goûts, ses habitudes, ses proches, son travail), ou dans son carnet de trader (notebook trading) une règle de sa façon de trader, que suit l'IA qui cherche ses setups.",
  {
    fact: z
      .string()
      .describe(
        "L'information, en une phrase autonome (ex. « Habite à Annecy (74000). », « Considère comme swing une entrée en 1 heure, 4 heures ou daily. »)",
      ),
    notebook: z
      .enum(["profile", "trading"])
      .optional()
      .describe(
        "profile par défaut ; trading pour sa façon de trader : ce qu'il appelle swing ou intraday et leurs unités de temps, les horizons qu'il trade, ses niveaux et comment il les trace, ses indicateurs, sa confirmation, ses heures, ce qu'il refuse",
      ),
    replaces: z.string().optional().describe("Quand il change une règle déjà notée dans ce carnet : quelques mots de l'ancienne (« swing »), qu'elle remplace"),
  },
  async ({ fact, notebook, replaces }) =>
    text(await api("/memories", { method: "POST", body: JSON.stringify({ content: fact, sessionId: SESSION_ID, notebook, replaces }) })),
);

server.tool(
  "forget",
  "Oublie une information retenue sur l'utilisateur, à sa demande : dans son profil, ou une règle de son carnet de trader (notebook trading).",
  {
    about: z.string().describe("De quoi il s'agit (ex. « adresse », « cinéma préféré », « swing »)"),
    notebook: z.enum(["profile", "trading"]).optional().describe("profile par défaut"),
  },
  async ({ about, notebook }) => text(await api("/memories/forget", { method: "POST", body: JSON.stringify({ query: about, notebook }) })),
);

// Mémoire apprise : recettes, conversations passées, apprentissage à la demande.
registerSkillView(
  server,
  api,
  "Ouvre une recette de Kopilia (façon de faire validée avec l'utilisateur) qui n'est pas déjà en entier dans tes consignes : à suivre quand la demande correspond.",
);

registerConversationSearch(server, api, { exclude: SESSION_ID });

server.tool(
  "learn_from_conversation",
  "Quand l'utilisateur demande de retenir une façon de faire, une préférence pour la suite, ou de tirer les leçons de ce qui vient de se passer : un relecteur relit la conversation en arrière-plan et met à jour la mémoire et les recettes de Kopilia (une recette nouvelle ou modifiée lui sera proposée). Renvoie tout de suite.",
  { what: z.string().describe("Ce qu'il faut retenir, avec les mots de l'utilisateur (ex. « donner les prix à la seconde près »)") },
  async ({ what }) => text(await api("/learning-requests", { method: "POST", body: JSON.stringify({ sessionId: SESSION_ID, what }) })),
);

server.tool(
  "learning_status",
  "Ce que Kopilia a appris récemment en relisant les conversations, et les recettes qui attendent l'accord de l'utilisateur.",
  async () => text(await api("/learning-status")),
);

server.tool(
  "skill_decide",
  "Adopte (approve) ou refuse (reject) une recette que Kopilia a proposée, selon la réponse de l'utilisateur.",
  {
    name: z.string().describe("Nom de la recette proposée"),
    decision: z.enum(["approve", "reject"]),
  },
  async ({ name, decision }) => text(await api("/skill-decisions", { method: "POST", body: JSON.stringify({ name, decision }) })),
);

/* ------------------------- Recherche d'opportunités ------------------------- */

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const PRODUCT = "Nom courant ou code du produit (Nasdaq, Dow Jones, or, EURUSD)";

server.tool(
  "robot_develop",
  "Lance le laboratoire de stratégies : à partir d'une idée de stratégie dite par l'utilisateur (« teste un croisement de moyennes sur le Nasdaq en 15 minutes », « développe une stratégie de rejet de la plage asiatique sur l'or »), un robot est créé et un agent quant part en arrière-plan (dix à trente minutes) : il écrit le robot en TypeScript, le backteste sur deux ans de bougies du courtier avec les coûts, l'améliore dans un budget de trente essais, et le code juge (prometteur, fragile, rejeté). Son compte rendu te sera transmis à la fin ; la fiche du robot garde tout. Avant de lancer : l'idée doit être dite par l'utilisateur, avec ses mots ; s'il reste un flou qui change tout (le produit, l'unité), demande-le ; sinon lance, et laisse l'agent décider du reste (stop, sorties, filtres).",
  {
    idea: z.string().describe("L'idée de stratégie, dans les mots de l'utilisateur (une ou deux phrases)"),
    products: z.array(z.string()).min(1).max(6).optional().describe("Les produits (noms courants ou symboles) ; sans eux, son premier produit"),
    timeframe: z
      .enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"])
      .optional()
      .describe("Unité de temps des décisions ; 15m si l'utilisateur ne dit rien (son intraday), 1h ou 4h pour du swing"),
    name: z.string().optional().describe("Nom court du robot, si l'utilisateur en donne un"),
    details: z.string().optional().describe("Ce qu'il a précisé en plus : stop, objectif, séances, ce qu'il attend"),
  },
  async ({ idea, products, timeframe, name, details }) =>
    text(await post("/algo/develop", { sessionId: SESSION_ID, idea, products, timeframe, name, details })),
);

server.tool(
  "robots_list",
  "La liste des robots du laboratoire de stratégies : nom, statut (idée, en test, prometteur, fragile, rejeté), univers, meilleur backtest en R. À lire pour répondre à « quels robots on a », « où en est la recherche », avant robot_get pour le détail d'un robot.",
  {},
  async () => text(await api("/algo/robots")),
);

server.tool(
  "robot_get",
  "La fiche d'un robot : l'idée, l'hypothèse préenregistrée, le plan (les règles en français), ses backtests (apprentissage, vérification, mois réservés, verdict du code et ses raisons), les tranches par séance, jour, année et sortie du meilleur, le fil des décisions et des leçons, et sur demande ses trades (les pires ou les meilleurs). Pour en débattre avec l'utilisateur : appuie-toi sur ces chiffres, une objection à la fois, et dis « c'est une intuition » quand tu n'as pas de preuve.",
  {
    robot: z.string().describe("Identifiant (rb_…), nom ou bout de nom, ou « dernier »"),
    trades: z
      .enum(["worst", "best", "first", "last"])
      .optional()
      .describe("Joindre dix trades du meilleur backtest : les pires, les meilleurs, les premiers, les derniers"),
  },
  async ({ robot, trades }) => text(await api(`/algo/robots/${encodeURIComponent(robot)}${trades ? `?trades=${trades}` : ""}`)),
);

server.tool(
  "setups_search",
  "Lance tout de suite une passe de la recherche d'opportunités : l'IA revoit ses scénarios, met ses hypothèses à jour et cherche de nouveaux setups (quelques minutes, en arrière-plan). Son résultat te sera transmis à la fin : les setups en attente qu'elle a repérés, ou pourquoi rien. Elle passe déjà d'elle-même après le wrap du matin et de midi.",
  { focus: z.string().optional().describe("Ce que l'utilisateur a précisé, avec ses mots (« sur l'or », « en 4 heures », « des ventes sur le Nasdaq »)") },
  async ({ focus }) => text(await post("/setups/search", { focus })),
);

server.tool(
  "setups_list",
  "Les setups déclenchés (triggered : proposés par l'IA, avec entrée, stop et objectifs), ceux en attente (waiting : repérés, leur déclencheur n'est pas encore arrivé), ceux fermés récemment, les hypothèses (les siennes et celles de l'utilisateur) et les résultats des setups. Avec id (sc_…) : le dossier d'un scénario et son fil, pour dire pourquoi l'IA a fait quelque chose.",
  { id: z.string().optional().describe("Un scénario (sc_…) pour avoir son dossier et son fil") },
  async ({ id }) => text(await api(`/setups${id ? `?${new URLSearchParams({ id })}` : ""}`)),
);

server.tool(
  "setup_feedback",
  "Note la réaction de l'utilisateur à un setup proposé (scenario) : taken (il le prend), declined (pas pour lui), modified (il change un niveau), comment (une remarque), avec ses mots en note ; ou une remarque sur un produit (product, sans scenario), attachée à tous ses scénarios ouverts, que l'IA relira.",
  {
    scenario: z.string().optional().describe("Le setup ou le scénario (sc_…)"),
    product: z.string().optional().describe(`Sans scenario : le produit de la remarque. ${PRODUCT}`),
    reaction: z.enum(["taken", "declined", "modified", "comment"]).optional().describe("comment par défaut"),
    note: z.string().optional().describe("Ce qu'il a dit, avec ses mots (« trop près de la news », « stop à 2 665 »)"),
  },
  async (args) => text(await post("/setups/feedback", args)),
);

/* ----------------------------- Fiches d'analyse ----------------------------- */

const BIAS = z.enum(["up", "down", "neutral"]);

server.tool(
  "analysis_note",
  "Note dans sa fiche d'analyse ce que l'utilisateur dit d'un produit quand il l'analyse ou change d'avis (« sur l'or, j'attends un rebond dans la zone des 2 600, je vois une hausse parce que les taux réels baissent ») : seulement ce qu'il vient de dire, avec ses mots. Une fiche par produit, qui continue d'un jour à l'autre ; elle s'ouvre d'elle-même. Renvoie la fiche, ce qu'il disait avant et quand, sa fiche fermée récemment, les setups du système sur ce produit, le wrap du jour, et les points à confronter : de quoi le contredire. N'en déduis rien qu'il n'a pas dit : ni un biais (« l'or peut corriger » ne change pas son fondamental), ni un horizon, ni une unité d'entrée (une invalidation « en clôture horaire » n'en est pas une), ni une zone, même tirés de son carnet ; ce qu'il ne redit pas reste tel quel dans sa fiche. Sa réponse à une objection va dans answer.",
  {
    product: z.string().describe(PRODUCT),
    summary: z.string().optional().describe("Sa lecture en une phrase, avec ses mots"),
    fundamental_bias: BIAS.optional().describe("Son biais fondamental (macro, banques centrales, annonces) : up haussier, down baissier, neutral"),
    fundamental_reason: z.string().optional().describe("Pourquoi, avec ses mots (« les taux réels baissent »)"),
    technical_bias: BIAS.optional().describe("Sa lecture technique (tendance, structure, niveaux) : up, down, neutral"),
    technical_reason: z.string().optional().describe("Pourquoi, avec ses mots (« sous la moyenne 200 en 4 heures »)"),
    side: z.enum(["buy", "sell", "none"]).optional().describe("Son idée de trade : buy un achat, sell une vente, none pas d'idée pour l'instant"),
    zone: z.string().optional().describe("La zone de son idée, avec ses mots (« la zone des 2 600 »)"),
    zone_low: z.number().optional().describe("Le bas de la zone, s'il donne des prix"),
    zone_high: z.number().optional().describe("Le haut de la zone"),
    zone_drawing: z.string().optional().describe("Son tracé de la zone (d_…, donné par chart_drawings), s'il désigne un tracé"),
    trigger: z.string().optional().describe("Ce qu'il attend pour entrer (« une bougie de rejet en 15 minutes »)"),
    horizon: z.enum(["intraday", "swing"]).optional(),
    timeframe: z.enum(CHART_TIMEFRAMES).optional().describe("L'unité de temps de son entrée"),
    invalidation: z.string().optional().describe("Ce qui invaliderait son idée, s'il l'a dit"),
    catalysts: z.string().optional().describe("Ce qui peut la faire bouger (« le CPI de 14 h 30 »)"),
    answer: z
      .string()
      .optional()
      .describe(
        "Sa réponse à une objection du contradicteur (« le dollar a rebondi depuis hier soir, l'or peut corriger avant de repartir »), avec ses mots : elle ne change pas sa fiche. Seul ce qu'il change lui-même (« mon fondamental devient baissier ») ou ajoute (une invalidation, une zone) va dans les autres champs",
      ),
  },
  async (args) => text(await post("/analyses/note", args)),
);

server.tool(
  "analysis_get",
  "Relit la fiche d'analyse d'un produit et son fil daté (« qu'est-ce que je disais hier sur l'or ? », « relis-moi ma fiche ») ; sans produit, ses fiches ouvertes et celles fermées depuis une semaine.",
  {
    product: z.string().optional().describe(PRODUCT),
    closed: z.boolean().optional().describe("true : sa dernière fiche fermée sur ce produit plutôt que celle ouverte"),
  },
  async ({ product, closed }) => {
    const q = new URLSearchParams();
    if (product) q.set("product", product);
    if (closed) q.set("closed", "1");
    return text(await api(`/analyses${q.size ? `?${q}` : ""}`));
  },
);

server.tool(
  "analysis_close",
  "Ferme la fiche d'analyse d'un produit, à sa demande (« je ferme l'analyse sur l'or », « on repart de zéro sur l'or »), avec sa raison. Sa prochaine analyse de ce produit ouvrira une nouvelle fiche ; celle-ci reste lisible et rappelée deux semaines.",
  {
    product: z.string().describe(PRODUCT),
    reason: z.string().optional().describe("Pourquoi, avec ses mots (« zone cassée », « je repars de zéro »)"),
  },
  async (args) => text(await post("/analyses/close", args)),
);

server.tool(
  "setup_example",
  "« Ça, c'est un setup » (positive true) ou « ça, ce n'en est pas un » (positive false) : garde cet instant du graphique d'un produit, avec les bougies qui y mènent, ses tracés et sa remarque. L'IA apprend sa façon de trader de ces exemples.",
  {
    product: z.string().describe(PRODUCT),
    timeframe: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]).optional().describe("Celle de son graphique par défaut"),
    at: z.string().optional().describe("L'instant montré, « AAAA-MM-JJ HH:MM » heure de Paris ; maintenant par défaut"),
    positive: z.boolean(),
    note: z.string().optional().describe("Ce qu'il en dit, avec ses mots (« rejet propre de ma zone en 15 minutes »)"),
  },
  async (args) => text(await post("/setups/examples", args)),
);

server.tool(
  "level_keep",
  "« Garde cette zone », « je garde l'oblique de l'IA » : les niveaux de l'IA (tracés marqués IA, identifiants donnés par chart_drawings) deviennent les tracés de l'utilisateur ; ils ne partiront plus avec leur scénario. Pour en retirer un (« pas cette zone »), efface-le avec chart_erase : l'IA relira ses dossiers sans lui.",
  {
    ids: z.array(z.string()).min(1).describe("Les niveaux de l'IA à garder (d_…)"),
    note: z.string().optional().describe("Ce qu'il en dit, avec ses mots"),
  },
  async (args) => text(await post("/setups/levels/keep", args)),
);

server.tool(
  "telegram_send",
  "Envoie un message sur Telegram, à la demande de l'utilisateur seulement : un texte, et s'il le demande l'image du graphique d'un produit (chart), dessinée par le serveur avec ses bougies, ses tracés, ses alertes et les indicateurs de son encart. Par défaut dans son canal technique, privé : le message part tout de suite. Vers un canal public (channel, son nom) : rien n'est publié ; un aperçu part dans le canal technique, et l'outil renvoie draftId et le texte à relire à l'utilisateur, avant telegram_publish sur son oui. Ce que tu rédiges pour un canal public est public : une analyse (ce que montrent le graphique, les niveaux, un scénario), jamais un conseil ni un ordre.",
  {
    text: z.string().max(3500).optional().describe("Le texte, court, en français ; facultatif avec un graphique"),
    title: z.string().max(120).optional().describe("Une première ligne en gras (« Or : cassure de la résistance »), facultative"),
    chart: z.string().optional().describe("Le graphique à joindre : un graphique affiché (son identifiant) ou un produit (« l'or », « Nasdaq »)"),
    timeframe: z.enum(CHART_TIMEFRAMES).optional().describe("L'unité de temps du graphique ; par défaut celle de son encart, sinon 15m"),
    channel: z.string().optional().describe("Le canal, par son nom (« public ») ; par défaut, son canal technique"),
  },
  async (args) => text(await post("/telegram", args)),
);

server.tool(
  "telegram_publish",
  "Publie sur son canal public l'aperçu que telegram_send a préparé, tel quel, seulement après que l'utilisateur a dit oui en l'entendant. Une seule fois par aperçu ; pour changer le message, refais telegram_send.",
  { draftId: z.string().describe("Le draftId renvoyé par telegram_send") },
  async (args) => text(await post("/telegram/publish", args)),
);

server.tool(
  "x_compose",
  "Prépare un post sur X (ex-Twitter), à la demande de l'utilisateur seulement : ouvre la fenêtre de post d'X dans son navigateur, le texte déjà écrit (avec la mention en bas), et met s'il le demande l'image du graphique d'un produit (chart) dans son presse-papiers. Rien n'est publié : c'est lui qui colle l'image (Commande V) et clique Poster. 280 signes au plus, comptés comme X, mention comprise ; sans @mention. Ce que tu rédiges est public : une analyse, jamais un conseil ni un ordre.",
  {
    text: z.string().max(2000).optional().describe("Le texte du post, court, en français ; facultatif avec un graphique"),
    chart: z
      .string()
      .optional()
      .describe("Le graphique à mettre dans le presse-papiers : un graphique affiché (son identifiant) ou un produit (« l'or », « Nasdaq »)"),
    timeframe: z.enum(CHART_TIMEFRAMES).optional().describe("L'unité de temps du graphique ; par défaut celle de son encart, sinon 15m"),
  },
  async (args) => text(await post("/x", args)),
);

await server.connect(new StdioServerTransport());
