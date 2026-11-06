/**
 * Outils de l'agent quant du laboratoire de stratégies, sur le serveur MCP des
 * agents (« kopilia ») : la bibliothèque et les leçons, la réserve de bougies,
 * l'enregistrement d'une version du robot (le code TypeScript et son plan),
 * un backtest, les trades de la période d'apprentissage, le fil de la fiche et
 * les leçons. Seul le serveur Nest écrit en base et juge ; l'agent demande,
 * avec un jeton qui n'ouvre que ces outils et les lectures des agents, et
 * chaque appel porte l'identifiant de son travail (le budget d'essais).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const post = (api: Api, path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
const ROBOT = z.string().describe("Identifiant du robot (rb_…), donné dans ta tâche");

export function registerAlgoTools(server: McpServer, api: Api) {
  server.tool(
    "algo_library",
    "La bibliothèque du laboratoire : les robots déjà développés (nom, statut, univers, meilleur backtest) et les leçons du carnet du laboratoire. À lire avant d'écrire, pour s'appuyer sur ce qui a marché et ne pas refaire ce qui a été rejeté.",
    { robot: z.string().optional().describe("Un robot (rb_…) dont tu veux la fiche complète : plan, code, backtests, fil") },
    async ({ robot }) => text(await api(robot ? `/algo/robots/${encodeURIComponent(robot)}?code=1` : "/algo/library")),
  );

  server.tool(
    "algo_data",
    "La réserve de bougies du courtier pour un produit et une unité : première et dernière bougie, nombre, passé épuisé ou non. Avec load, charge (ou complète) deux ans de bougies closes avant de répondre, une requête à la fois ; un backtest le fait aussi de lui-même pour les unités qu'il joue.",
    {
      product: z.string().describe("Nom courant ou symbole du courtier (Nasdaq, or, EURUSD)"),
      timeframe: z.enum(TIMEFRAMES).describe("Unité de temps"),
      load: z.boolean().optional().describe("Charger ou compléter la réserve avant de répondre"),
      depth_days: z.number().int().min(30).max(3650).optional().describe("Profondeur voulue en jours (défaut 730)"),
    },
    async ({ product, timeframe, load, depth_days }) =>
      text(
        load
          ? await post(api, "/algo/data/load", { product, timeframe, depthDays: depth_days })
          : await api(`/algo/data?${new URLSearchParams({ product, timeframe })}`),
      ),
  );

  server.tool(
    "algo_robot_save",
    "Enregistre une version du robot : son code TypeScript (compilé tout de suite ; refusé avec la raison s'il ne compile pas ou sort de l'API) et son plan, les règles en français que l'utilisateur relira. La première fois, donne aussi l'hypothèse préenregistrée (ce que « ça marche » voudra dire) et un nom court. Chaque version garde la précédente : dis dans le plan ce qui change.",
    {
      robot: ROBOT,
      code: z.string().describe("Le module TypeScript complet (export default { … })"),
      plan: z
        .string()
        .describe(
          "Les règles exactes en français, lisibles à voix haute : entrée, stop, sortie, filtres, paramètres ; et ce qui change par rapport à la version d'avant",
        ),
      hypothesis: z
        .string()
        .optional()
        .describe("L'hypothèse préenregistrée (première version) : règles de base, univers, et ce que « ça marche » voudra dire"),
      name: z.string().optional().describe("Nom court du robot (« Croisement MME 9/21 »)"),
    },
    async ({ robot, code, plan, hypothesis, name }) =>
      text(await post(api, `/algo/robots/${encodeURIComponent(robot)}/versions`, { code, plan, hypothesis, name })),
  );

  server.tool(
    "algo_backtest_run",
    "Joue une version du robot sur les bougies closes du courtier (deux ans par défaut), avec ses coûts (écart du moment, commission 0, glissement 0), et renvoie les mesures en R par phase : apprentissage (détaillé, avec les tranches par séance, jour, année, sens, sortie, et les notes du robot), vérification et mois réservés (chiffres seulement), le verdict du code et ses raisons, le rang de l'essai et le budget restant. Un essai compte, même raté : réfléchis avant de lancer.",
    {
      robot: ROBOT,
      version: z.number().int().positive().optional().describe("Version à jouer (défaut : la dernière enregistrée)"),
      products: z.array(z.string()).min(1).max(6).optional().describe("Produits (noms courants ou symboles) ; défaut : ceux du robot"),
      timeframe: z.enum(TIMEFRAMES).optional().describe("Unité principale ; défaut : celle du robot"),
      contexts: z
        .array(z.enum(TIMEFRAMES))
        .max(2)
        .optional()
        .describe("Unités de contexte que le code lit avec ctx.context(…) : plus grandes que l'unité principale"),
      minute: z
        .boolean()
        .optional()
        .describe("Charger la minute pour départager stop et objectif touchés dans la même bougie (lourd : seulement si la stratégie en a besoin)"),
      depth_days: z.number().int().min(30).max(3650).optional().describe("Profondeur en jours (défaut 730)"),
      params: z.record(z.string(), z.unknown()).optional().describe("Paramètres remplaçant ceux du module (params), pour une variante sans réécrire le code"),
      costs: z
        .object({ spread: z.number().nonnegative().optional(), commission: z.number().nonnegative().optional(), slippage: z.number().nonnegative().optional() })
        .optional()
        .describe("Test de résistance : coûts imposés en unités de prix (écart, commission par aller-retour, glissement) ; sinon ceux du courtier"),
      note: z.string().optional().describe("Ce que cet essai teste, en une phrase (écrit au fil)"),
    },
    async ({ robot, version, products, timeframe, contexts, minute, depth_days, params, costs, note }) =>
      text(
        await post(api, `/algo/robots/${encodeURIComponent(robot)}/backtests`, {
          version,
          products,
          timeframe,
          contexts,
          minute,
          depthDays: depth_days,
          params,
          costs,
          note,
        }),
      ),
  );

  server.tool(
    "algo_backtest_trades",
    "Les trades d'un backtest sur la période d'apprentissage (jamais la vérification ni les mois réservés) : les pires, les meilleurs ou les premiers, avec entrée, sortie, raison, R, pire et meilleure excursion. Pour comprendre où la stratégie perd avant de changer une règle.",
    {
      backtest: z.string().describe("Identifiant du backtest (bt_…)"),
      which: z.enum(["worst", "best", "first", "last"]).optional().describe("Quels trades (défaut : worst)"),
      limit: z.number().int().min(1).max(50).optional().describe("Nombre (défaut 10)"),
    },
    async ({ backtest, which, limit }) =>
      text(await api(`/algo/backtests/${encodeURIComponent(backtest)}/trades?${new URLSearchParams({ which: which ?? "worst", limit: String(limit ?? 10) })}`)),
  );

  server.tool(
    "algo_note",
    "Écrit au fil de la fiche du robot : une décision et sa raison (decision), le plan d'exploration (plan), un résultat lu (result), le verdict final (verdict). La fiche est la mémoire de la recherche et ce que l'utilisateur relira : écris pour lui, court et précis.",
    {
      robot: ROBOT,
      kind: z.enum(["plan", "decision", "result", "verdict"]).describe("Genre de la note"),
      text: z.string().describe("La note, en français"),
      backtest: z.string().optional().describe("Le backtest dont parle la note (bt_…)"),
    },
    async ({ robot, kind, text: body, backtest }) =>
      text(await post(api, `/algo/robots/${encodeURIComponent(robot)}/notes`, { kind, text: body, backtestId: backtest })),
  );

  server.tool(
    "algo_lesson",
    "Verse une leçon réutilisable au carnet du laboratoire : ce qui a marché ou non, sur quels produits et quelle unité, avec le backtest qui le prouve. Une leçon est une phrase qu'un autre robot pourra suivre (« sur NAS100 en 15 min, la sortie au croisement inverse bat l'objectif fixe 2 R »). Une ou deux par recherche, pas plus.",
    {
      text: z.string().describe("La leçon, une phrase"),
      products: z.array(z.string()).min(1).describe("Produits où elle a été vue (symboles du courtier)"),
      timeframe: z.enum(TIMEFRAMES).optional().describe("Unité de temps"),
      robot: ROBOT.optional(),
      backtest: z.string().optional().describe("Le backtest qui la prouve (bt_…)"),
    },
    async ({ text: body, products, timeframe, robot, backtest }) =>
      text(await post(api, "/algo/lessons", { text: body, products, timeframe, robotId: robot, backtestId: backtest })),
  );
}
