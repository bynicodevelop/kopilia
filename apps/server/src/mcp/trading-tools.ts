/**
 * Outils de la prise de position, pour le dialogue seulement (jamais les
 * agents) : l'état du compte et des trades, le money management de
 * l'utilisateur, la préparation d'un ticket d'ordre et le bilan. Aucun outil
 * n'envoie d'ordre : un ticket part chez le courtier seulement quand
 * l'utilisateur le confirme (« je confirme », ou le bouton du ticket),
 * reconnu par le code.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const RISK = {
  risk_percent: z.number().positive().optional().describe("Le risque en % du capital (« à 2 % »)"),
  risk_amount: z.number().positive().optional().describe("Ou : le risque en montant, devise du compte (« 150 euros de risque »)"),
  lots: z.number().positive().optional().describe("Ou : la taille en lots (« 3 lots ») ; la perte se calcule"),
};

export function registerTradingTools(server: McpServer, api: Api) {
  server.tool(
    "trading_status",
    "La prise de position : le compte du courtier (démo ou réel, solde, capitaux propres), le money management de l'utilisateur (risque par défaut, plafond par trade, limites), si les ordres sont permis, les trades passés par Kopilia (en attente, ouverts, fermés, avec leur identifiant t_…) et le ticket qui attend sa confirmation.",
    {},
    async () => text(await api("/trading")),
  );

  server.tool(
    "trading_settings",
    "Règle le money management de l'utilisateur, à sa demande seulement : ce sont ses règles, tu ne les choisis pas et tu ne lui conseilles aucun pourcentage. Seuls les champs donnés changent ; null retire une limite.",
    {
      default_risk_percent: z.number().positive().optional().describe("Risque par défaut d'une boîte, en % du capital"),
      default_risk_amount: z.number().positive().optional().describe("Ou : risque par défaut en montant"),
      default_lots: z.number().positive().optional().describe("Ou : taille par défaut en lots"),
      max_risk_percent: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Plafond par trade, en % : au-delà, la taille est réduite et des lots qui le dépassent sont refusés"),
      max_open_risk_percent: z.number().positive().max(100).nullable().optional().describe("Risque total ouvert au plus, en %"),
      max_daily_loss_percent: z
        .number()
        .positive()
        .max(100)
        .nullable()
        .optional()
        .describe("Perte du jour au plus, en % : atteinte, plus d'ouverture jusqu'au lendemain"),
      max_weekly_loss_percent: z.number().positive().max(100).nullable().optional().describe("Perte de la semaine au plus, en %"),
      capital_base: z.enum(["balance", "equity"]).optional().describe("Capital de calcul : balance (le solde) ou equity (les capitaux propres)"),
      breakeven_reminder_r: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe("Rappel de passer à break-even quand une position atteint ce multiple du risque (1 : à 1 R) ; null : aucun"),
      commission_product: z.string().optional().describe("Le produit d'une commission (or, Nasdaq, EURUSD)"),
      commission: z
        .number()
        .nonnegative()
        .nullable()
        .optional()
        .describe("Sa commission aller-retour par lot, devise du compte ; null : revenir à celle lue sur ses transactions"),
      tier_name: z.string().max(20).optional().describe("Un palier de risque à lui, ajouté ou changé (même nom) : son nom (« A+ », « standard »)"),
      tier_percent: z.number().positive().max(100).optional().describe("Le pourcentage du palier (au plus le plafond par trade)"),
      tier_when: z.string().max(200).optional().describe("Quand il le prend, avec ses mots (« quand le 4 h et le 15 min vont dans le même sens »)"),
      tier_remove: z.string().optional().describe("Le nom d'un palier à retirer"),
    },
    async (args) => text(await api("/trading/settings", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "order_prepare",
    "Prépare l'ordre d'une boîte de trade (son identifiant d_…, chart_drawings) quand l'utilisateur te le demande (« place l'ordre de ma boîte ») : l'ordre suit la boîte, en attente à son entrée sauf demande explicite d'entrer au marché ; la taille selon son risque, ses limites vérifiées, un ordre par objectif. Rien ne part : le ticket s'affiche, tu le lui relis, et seul l'utilisateur le confirme (« je confirme » ou le bouton). Jamais de ta propre initiative. Sans boîte, pose-la d'abord (chart_draw kind position) avec les niveaux qu'il donne.",
    {
      box: z.string().describe("La boîte de trade (d_…)"),
      execution: z
        .enum(["pending", "market"])
        .optional()
        .describe(
          "pending (par défaut, presque toujours) : l'ordre en attente au prix de l'entrée de la boîte (à cours limité ou stop selon le marché) ; « place l'ordre », « place-le sur le marché », « envoie-le chez le courtier » veulent dire pending. market : seulement s'il dit « au marché », « au prix du marché » ou « tout de suite », et si l'entrée de la boîte est au prix du moment (sinon le serveur refuse : l'ordre suit la boîte)",
        ),
      targets: z.array(z.number()).max(3).optional().describe("Plusieurs objectifs (prix) : une part du volume pour chacun ; sans : l'objectif de la boîte"),
      shares: z.array(z.number().positive()).max(3).optional().describe("Part de chaque objectif (0.5, 0.5) ; sans : parts égales"),
      setup: z.string().optional().describe("Le setup de l'IA qu'il reprend (sc_…), s'il y en a un"),
      tier: z.string().optional().describe("Le palier de risque qu'il choisit (« A+ ») ; jamais choisi par toi"),
      ...RISK,
    },
    async (args) => text(await api("/trading/ticket", { method: "POST", body: JSON.stringify({ ...args, action: "open" }) })),
  );

  server.tool(
    "trade_manage",
    "Prépare la gestion d'un trade de Kopilia en cours, quand l'utilisateur te le demande : breakeven (stop à l'entrée, commission comprise), modify (nouveau stop ou objectif), close (tout fermer au marché, ou retirer l'ordre en attente), partial (fermer une part), cancel (retirer l'ordre en attente). Comme un ordre : un ticket s'affiche, tu le relis, et seul l'utilisateur le confirme. Le trade : son identifiant (t_…), sa boîte, ou le produit s'il n'y en a qu'un.",
    {
      action: z.enum(["breakeven", "modify", "close", "partial", "cancel"]),
      trade: z.string().optional().describe("Le trade (t_…)"),
      box: z.string().optional().describe("Ou : sa boîte (d_…)"),
      product: z.string().optional().describe("Ou : son produit (or, Nasdaq)"),
      stop: z.number().optional().describe("modify : le nouveau stop"),
      objective: z.number().optional().describe("modify : le nouvel objectif"),
      fraction: z.number().positive().max(1).optional().describe("partial : la part à fermer (0.5 : la moitié)"),
    },
    async (args) => text(await api("/trading/ticket", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "ticket_cancel",
    "Retire le ticket en attente de confirmation (rien n'est parti), quand l'utilisateur y renonce ou en demande un autre.",
    {},
    async () => text(await api("/trading/ticket/cancel", { method: "POST", body: "{}" })),
  );

  server.tool(
    "trading_review",
    "Liste sommaire des trades passés par Kopilia sur une période, par niveau de risque. Pour un bilan de sa journée, de sa semaine ou de son mois, préfère journal_bilan, plus complet.",
    { days: z.number().int().min(1).max(365).optional().describe("La période, en jours (7 par défaut)") },
    async ({ days }) => text(await api(`/trading/review${days ? `?days=${days}` : ""}`)),
  );

  // Journal de trading : ses trades rattachés à leur fiche, leurs gestes, leurs sorties, ses notes.
  const REF = {
    trade: z.string().optional().describe("L'identifiant du trade (t_…), s'il est connu"),
    product: z.string().optional().describe("Ou : le produit (« Nasdaq », « l'or ») : son dernier trade"),
  };
  server.tool(
    "journal_get",
    "Son journal de trading. Sans trade ni produit : ses trades des derniers jours rangés par fiche d'analyse (l'idée de la fiche, l'idée de départ si elle a changé de sens, chaque trade avec son résultat gagnant, perdant ou neutre, sa sortie, fidèle à la fiche ou contre elle, sa note). Avec trade ou product : la page d'un trade — ses faits calculés par le serveur (contre la fiche, objection relevée avant, entrée dans la zone, stop élargi, gestion, plan du ticket rejoué contre ce qu'il a géré, ce qu'a fait le prix après sa sortie, son idée de départ rejouée sur les cours) et son fil daté (lectures de la fiche, objections et réponses, ticket, exécution, gestes, sorties, notes). Avec review : la dernière analyse de son trading (son résumé, les chiffres du serveur, les constats, la règle proposée pour son carnet). Des faits ; ton avis franc en plus s'il te le demande.",
    {
      ...REF,
      days: z.number().int().min(1).max(365).optional().describe("La période de la liste, en jours (30 par défaut)"),
      review: z.boolean().optional().describe("true : la dernière analyse de son trading"),
    },
    async ({ trade, product, days, review }) => {
      if (review) return text(await api("/journal/review"));
      if (trade || product) {
        const q = new URLSearchParams({ ...(trade ? { trade } : {}), ...(product ? { product } : {}) });
        return text(await api(`/journal/trade?${q}`));
      }
      return text(await api(`/journal${days ? `?days=${days}` : ""}`));
    },
  );

  server.tool(
    "journal_note",
    "Écrit sa note sur un trade dans son journal, avec ses mots (« je suis sorti trop tôt, j'avais peur de rendre », « j'ai attendu la bougie de rejet »). Sans trade ni produit : son dernier trade fermé. Ce n'est pas le carnet de trader : une règle durable va au carnet (remember, notebook trading).",
    { text: z.string().min(1).describe("Sa note, avec ses mots, sans rien y ajouter"), ...REF },
    async (args) => text(await api("/journal/note", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "journal_show",
    "Ouvre à l'écran la page d'un trade de son journal : son graphique figé au ticket (ses tracés d'alors, son stop et son objectif marche par marche, son entrée et ses sorties), ses faits et son fil (« montre-moi le trade du Nasdaq », « ouvre mon dernier trade »). Sans trade ni produit : son dernier trade fermé. Avec review : la dernière analyse de son trading (« remets-moi l'analyse »). Avec calendar : le calendrier de son journal, chaque jour en R (« montre-moi le calendrier », « le mois d'octobre », « ma journée du 3 »).",
    {
      ...REF,
      review: z.boolean().optional().describe("true : ouvre la dernière analyse de son trading"),
      calendar: z.string().optional().describe("Le calendrier : un mois AAAA-MM ou un jour AAAA-MM-JJ ; « now » : le mois en cours"),
    },
    async (args) => text(await api("/journal/show", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "journal_bilan",
    "Le bilan de ses trades fermés, compté par le serveur (« comment s'est passée ma journée ? », « ma semaine ? », « mon mois d'octobre ? », « mes 30 derniers jours ») : nombre, gagnants, perdants, neutres, R total et par trade, gain et perte moyens, meilleur et pire trade, série de pertes, répartitions (face à la fiche, horizon, palier, produit, séance), ce qui revient (contre la fiche, changement d'avis, malgré une objection, hors de sa zone, stop élargi, objectif touché après sa sortie) et les trades sans note. Des faits ; ton avis franc en plus s'il te le demande.",
    {
      period: z
        .enum(["day", "week", "month", "days"])
        .optional()
        .describe("day : un jour ; week : la semaine du lundi (par défaut) ; month : un mois ; days : les N derniers jours"),
      date: z.string().optional().describe("Le jour (AAAA-MM-JJ) ou le mois (AAAA-MM) visé ; aujourd'hui par défaut"),
      days: z.number().int().min(1).max(365).optional().describe("Avec period days : le nombre de jours"),
    },
    async ({ period, date, days }) => {
      const q = new URLSearchParams({ ...(period ? { period } : {}), ...(date ? { date } : {}), ...(days ? { days: String(days) } : {}) });
      return text(await api(`/journal/bilan?${q}`));
    },
  );

  server.tool(
    "journal_settings",
    "Le bilan du soir de son journal, à sa demande seulement : evening règle l'heure (« fais-moi le bilan de ma journée tous les soirs à 22 h 30 » : 22:30), null l'arrête. Il part chaque jour à cette heure s'il a fermé des trades dans la journée : dit en appel, sinon sur Telegram. Sans champ : le réglage du moment.",
    { evening: z.string().nullable().optional().describe("L'heure HH:MM, ou null pour arrêter") },
    async (args) => text(await api("/journal/settings", { method: "POST", body: JSON.stringify(args) })),
  );

  server.tool(
    "journal_analyze",
    "Lance, à sa demande, l'analyse de son trading par l'IA sur une période (« analyse mon trading de la semaine », « où est-ce que je fais des erreurs ? », « est-ce que je change trop d'avis ? ») : ses trades, leurs faits et rejeux, ses fiches, ses notes, ses idées non prises et quelques graphiques figés. Elle tourne en arrière-plan (une à deux minutes) ; son résultat te revient de lui-même et s'affiche à l'écran. Jamais de toi-même.",
    { days: z.number().int().min(1).max(365).optional().describe("La période, en jours (7 par défaut ; « du mois » : 30)") },
    async (args) => text(await api("/journal/review", { method: "POST", body: JSON.stringify(args) })),
  );
}
