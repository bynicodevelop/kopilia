import { z } from "zod";
import { JobState, PipelineState, TurnOutcome } from "./states.js";
import { drawingSchema, indicatorSchema } from "./technical.js";
import { alertSchema } from "./alerts.js";
import { drawingSuggestionSchema, hypothesisSchema, scenarioSchema, setupStatsRowSchema } from "./setups.js";
import { viewSpecSchema } from "./views.js";
import { newsItemSchema } from "./news.js";
import { tradingStateSchema } from "./trading.js";
import { robotSummarySchema } from "./algo.js";
import { brokerStatusSchema } from "./broker.js";

/** Version du protocole de transport (enveloppe + événements). */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Enveloppe commune à tous les messages de contrôle (JSON texte).
 * Les flux binaires audio sont cadrés séparément (voir audio.ts) et
 * référencent `turnId` / `streamId`.
 */
const envelopeBase = {
  v: z.literal(PROTOCOL_VERSION),
  /** Identifiant unique du message (idempotence côté récepteur). */
  eventId: z.string().min(1),
  /** Session Kopilia (connexion logique navigateur <-> serveur). */
  sessionId: z.string().min(1),
  /** Horodatage d'émission (epoch ms). */
  ts: z.number().int().nonnegative(),
  turnId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  /** Numéro de séquence pour les flux ordonnés (deltas, audio de contrôle). */
  seq: z.number().int().nonnegative().optional(),
};

const audioFormatSchema = z.object({
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  bitDepth: z.number().int().positive(),
  encoding: z.literal("pcm_s16le"),
});

/* ------------------------------------------------------------------ */
/* Navigateur -> Serveur                                               */
/* ------------------------------------------------------------------ */

/** Déclaration du format du flux micro avant les trames binaires. */
export const micFormat = z.object({
  ...envelopeBase,
  type: z.literal("mic.format"),
  turnId: z.string().min(1),
  /** Identifiant numérique du flux micro (repris dans l'en-tête binaire). */
  streamId: z.number().int().nonnegative(),
  format: audioFormatSchema,
  /**
   * L'utilisateur a pris la parole pendant que Kopilia parlait (lecture mise en
   * pause). Si l'énoncé lui demande de se taire, Claude saura qu'il a été coupé.
   */
  bargeIn: z.boolean().optional(),
  /**
   * Dite en maintenant la touche pour parler : relâcher la touche clôt la
   * phrase, qui part donc telle quelle, sans attendre une suite même si elle
   * a l'air inachevée.
   */
  ptt: z.boolean().optional(),
});

/** Abandonne un énoncé en cours : rien n'est transcrit ni envoyé. */
export const micCancel = z.object({
  ...envelopeBase,
  type: z.literal("mic.cancel"),
  streamId: z.number().int().nonnegative(),
});

/** Coupe la lecture en cours (barge-in). */
export const playbackInterrupt = z.object({
  ...envelopeBase,
  type: z.literal("playback.interrupt"),
  /** Flux audio à invalider ; si absent, tout flux actif du tour courant. */
  streamId: z.number().int().nonnegative().optional(),
});

/**
 * L'utilisateur décroche ou raccroche. En appel, Kopilia peut prendre la parole
 * de lui-même (p.ex. annoncer le brief du matin dès qu'on décroche).
 */
export const callState = z.object({
  ...envelopeBase,
  type: z.literal("call.state"),
  inCall: z.boolean(),
  /**
   * Micro coupé pendant l'appel (l'utilisateur parle à quelqu'un d'autre) :
   * Kopilia garde ses prises de parole spontanées pour après, et ce qui part
   * sur Telegram page fermée (alertes, setups, wrap, agents) y part aussitôt.
   * Une page cachée fait de même (`page.visibility`).
   */
  muted: z.boolean().optional(),
});

/**
 * La page est cachée (un autre onglet, fenêtre réduite) ou de nouveau visible.
 * Écrans tous cachés : ce qui part sur Telegram page fermée y part aussi.
 */
export const pageVisibility = z.object({
  ...envelopeBase,
  type: z.literal("page.visibility"),
  hidden: z.boolean(),
});

/** Saisie clavier de diagnostic (sans micro). */
export const textInput = z.object({
  ...envelopeBase,
  type: z.literal("text.input"),
  turnId: z.string().min(1),
  text: z.string().min(1),
});

/** Commandes de coordination des tâches depuis l'interface. */
export const jobCommand = z.object({
  ...envelopeBase,
  type: z.literal("job.command"),
  command: z.enum(["status", "cancel", "instruct"]),
  jobId: z.string().min(1).optional(),
  note: z.string().optional(),
});

/** Réponse de l'utilisateur à une demande d'approbation sensible. */
export const approvalResolve = z.object({
  ...envelopeBase,
  type: z.literal("approval.resolve"),
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

export const clientMessage = z.discriminatedUnion("type", [
  micFormat,
  micCancel,
  playbackInterrupt,
  callState,
  pageVisibility,
  textInput,
  jobCommand,
  approvalResolve,
]);
export type ClientMessage = z.infer<typeof clientMessage>;

/* ------------------------------------------------------------------ */
/* Serveur -> Navigateur                                               */
/* ------------------------------------------------------------------ */

export const sessionReady = z.object({
  ...envelopeBase,
  type: z.literal("session.ready"),
  /** Session Claude (CLI) associée, si déjà initialisée. */
  claudeSessionId: z.string().nullable(),
});

export const transcriptPartial = z.object({
  ...envelopeBase,
  type: z.literal("transcript.partial"),
  turnId: z.string().min(1),
  text: z.string(),
});

export const transcriptFinal = z.object({
  ...envelopeBase,
  type: z.literal("transcript.final"),
  turnId: z.string().min(1),
  text: z.string(),
  lang: z.string().optional(),
  /**
   * La phrase demande à Kopilia de se taire (« stop », « attends », « non »…) :
   * elle coupe la réponse en cours. Sinon, la réponse en cours va à son terme
   * et celle de cette phrase la suit.
   */
  cut: z.boolean().optional(),
});

export const assistantDelta = z.object({
  ...envelopeBase,
  type: z.literal("assistant.delta"),
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  text: z.string(),
});

export const assistantDone = z.object({
  ...envelopeBase,
  type: z.literal("assistant.done"),
  turnId: z.string().min(1),
  outcome: z.nativeEnum(TurnOutcome),
  /** Texte final complet (déjà émis en deltas ; ne pas relire pour la synthèse). */
  text: z.string().optional(),
});

/** Ouvre un flux audio de parole (déclare le format avant les trames). */
export const audioStart = z.object({
  ...envelopeBase,
  type: z.literal("audio.start"),
  turnId: z.string().min(1),
  streamId: z.number().int().nonnegative(),
  format: audioFormatSchema,
});

export const audioEnd = z.object({
  ...envelopeBase,
  type: z.literal("audio.end"),
  turnId: z.string().min(1),
  streamId: z.number().int().nonnegative(),
});

/**
 * Repère de synchronisation texte / voix : le texte affiché (`text`, tel
 * qu'écrit) de la phrase `index` du tour. Envoyé juste avant les trames audio
 * de cette phrase ; `silent` : rien à dire (bloc de code, émoji seul), le
 * texte s'affiche à la suite de la phrase précédente.
 */
export const speechSegment = z.object({
  ...envelopeBase,
  type: z.literal("speech.segment"),
  turnId: z.string().min(1),
  streamId: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  text: z.string(),
  silent: z.boolean().optional(),
});

export const stateChanged = z.object({
  ...envelopeBase,
  type: z.literal("state.changed"),
  state: z.nativeEnum(PipelineState),
  detail: z.string().optional(),
});

export const jobUpdated = z.object({
  ...envelopeBase,
  type: z.literal("job.updated"),
  jobId: z.string().min(1),
  state: z.nativeEnum(JobState),
  projectId: z.string().optional(),
  /** Dossier du projet où travaille le job (« Kopilia ») ; absent pour une recherche web. */
  folder: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  /** Consigne en attente non encore prise en compte par le worker. */
  pendingInstruction: z.string().nullable().optional(),
  /** `agent` : recherche en lecture seule ; `task` : ouvrier qui agit dans un projet. */
  kind: z.enum(["agent", "task"]).optional(),
});

/**
 * Un agent ou une tâche de l'utilisateur a changé (démarré, terminé…), dans
 * n'importe quelle conversation : tous les écrans relisent leur activité.
 */
export const activityChanged = z.object({
  ...envelopeBase,
  type: z.literal("activity.changed"),
  jobId: z.string().min(1),
});

/** Un agent ou une tâche récents, tels que l'encart Activité les montre (toutes conversations confondues). */
export interface ActivityItem {
  jobId: string;
  state: JobState;
  kind: "agent" | "task";
  title: string;
  /** Le résultat (agent : jusqu'à 6 000 caractères), ou la raison d'un échec. */
  summary?: string;
  /** Le dossier du projet où il travaille. */
  folder?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Kopilia prend la parole de lui-même pour rapporter le résultat d'un agent ou
 * d'une tâche. Les deltas et l'audio de ce `turnId` suivent.
 */
export const agentReport = z.object({
  ...envelopeBase,
  type: z.literal("agent.report"),
  turnId: z.string().min(1),
  jobId: z.string().min(1),
  title: z.string(),
  /** Rapport d'un brief de veille : son texte complet est consultable à l'écran. */
  briefId: z.string().optional(),
});

/** Un nouveau brief de veille est disponible (texte complet via GET /api/briefs/:id). */
export const briefReady = z.object({
  ...envelopeBase,
  type: z.literal("brief.ready"),
  briefId: z.string().min(1),
  title: z.string(),
  /** Epoch ms. */
  createdAt: z.number().int().positive(),
  trigger: z.enum(["manual", "scheduled"]),
});

/**
 * Kopilia a relu des conversations ou rangé sa mémoire : ce qu'il a retenu
 * (détail via GET /api/learning) et les recettes qui attendent l'utilisateur.
 */
export const learningUpdated = z.object({
  ...envelopeBase,
  type: z.literal("learning.updated"),
  runId: z.string().min(1),
  kind: z.enum(["review", "curator"]),
  /** Ce que Kopilia a retenu, en une ou deux phrases. */
  summary: z.string(),
  /** Changements faits pendant cette passe (carnets, recettes). */
  changes: z.number().int().nonnegative(),
  /** Recettes proposées en attente de l'utilisateur (toutes passes confondues). */
  pending: z.number().int().nonnegative(),
});

/**
 * Un encart du tableau de bord : un graphique d'un produit, un suivi de
 * plusieurs, la liste des setups repérés par l'IA (son contenu vient de
 * setups.updated, ses prix du flux de cotations), l'activité (les agents et
 * tâches récents, lus sur le serveur), ou une vue composée par Kopilia à partir
 * du catalogue de blocs.
 */
export const panelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["chart", "quotes", "products", "setups", "activity", "news", "journal", "robots", "view"]),
  /** Titre affiché et dit (« Euro-dollar », « Suivi »). */
  title: z.string(),
  /** Graphique : le symbole du courtier, son nom courant, ses décimales, l'unité de temps. */
  symbol: z.string().optional(),
  name: z.string().optional(),
  digits: z.number().int().nonnegative().optional(),
  timeframe: z.string().optional(),
  /** Graphique : les indicateurs tracés (moyennes sur les bougies, RSI dans son bandeau), dans l'ordre d'ajout. */
  indicators: z.array(indicatorSchema).optional(),
  /** Suivi : les produits listés. */
  symbols: z.array(z.object({ symbol: z.string(), name: z.string(), digits: z.number().int().nonnegative().optional() })).optional(),
  /** Vue : ses blocs. */
  view: viewSpecSchema.optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});
export type Panel = z.infer<typeof panelSchema>;

/**
 * Le tableau de bord a changé (encart ouvert, modifié ou fermé, tracé ou
 * alerte ajouté, déplacé ou effacé, à la voix ou à l'écran) : tous les
 * encarts, dans l'ordre, et les tracés et alertes des produits de leurs
 * graphiques. Envoyé aussi à la connexion.
 */
export const dashboardUpdated = z.object({
  ...envelopeBase,
  type: z.literal("dashboard.updated"),
  panels: z.array(panelSchema),
  drawings: z.array(drawingSchema),
  alerts: z.array(alertSchema),
});

/**
 * Comment montrer un encart, demandé à la voix : agrandi (presque tout
 * l'écran), rendu à sa taille et à sa place d'avant, ou ramené dans sa marge.
 */
export const PANEL_DISPLAYS = ["maximize", "restore", "dock"] as const;
export type PanelDisplay = (typeof PANEL_DISPLAYS)[number];

/**
 * Un encart à montrer autrement, à la voix : chaque écran l'applique comme le
 * bouton d'agrandissement, Échap ou le double-clic sur l'en-tête (la taille et
 * la place restent des choix de chaque écran). Sans encart : tous les
 * graphiques agrandis reprennent leur taille (restore).
 */
export const panelDisplay = z.object({
  ...envelopeBase,
  type: z.literal("panel.display"),
  panelId: z.string().min(1).optional(),
  display: z.enum(PANEL_DISPLAYS),
});

/**
 * Une alerte vient de se déclencher : l'écran la signale (bandeau, son,
 * notification, ligne qui clignote) ; en appel, Kopilia la dit aussitôt après.
 */
export const alertTriggered = z.object({
  ...envelopeBase,
  type: z.literal("alert.triggered"),
  alertId: z.string().min(1),
  symbol: z.string().min(1),
  /** « Or : résistance franchie à la hausse ». */
  title: z.string(),
  /** « 3 950,40 à 14:32:05 · ligne à 3 950,00 ». */
  detail: z.string(),
  direction: z.enum(["up", "down"]),
  price: z.number(),
  /** Instant du franchissement (epoch ms). */
  at: z.number().int().positive(),
  /** Alerte de l'IA : son scénario. L'écran fait seulement clignoter sa ligne, sans bandeau ni son : l'agent décidera s'il faut prévenir. */
  scenarioId: z.string().optional(),
});

/**
 * La recherche d'opportunités a changé : les hypothèses actives (et celles
 * qui viennent de changer d'état), les scénarios ouverts et ceux clos depuis
 * peu, avec leur fil, et les statistiques des setups proposés. Envoyé aussi à
 * la connexion.
 */
export const setupsUpdated = z.object({
  ...envelopeBase,
  type: z.literal("setups.updated"),
  hypotheses: z.array(hypothesisSchema),
  scenarios: z.array(scenarioSchema),
  stats: z.array(setupStatsRowSchema),
  /** Suggestions de l'IA sur les tracés de l'utilisateur, en attente de sa décision. */
  suggestions: z.array(drawingSuggestionSchema).optional(),
});

/**
 * Un setup vient d'être proposé, ou un scénario déjà proposé est abandonné :
 * l'écran le signale (bandeau, son) ; en appel, Kopilia le dit aussitôt après.
 */
export const setupSignal = z.object({
  ...envelopeBase,
  type: z.literal("setup.signal"),
  scenarioId: z.string().min(1),
  kind: z.enum(["proposed", "abandoned"]),
  symbol: z.string().min(1),
  /** « Or : setup vendeur 15 min ». */
  title: z.string(),
  /** « Entrée 2 652, stop 2 661, objectif 2 630 ». */
  detail: z.string(),
});

/**
 * Une recherche de setups est finie : l'écran arrête son « recherche en
 * cours » et la signale si elle a repéré des setups, ou si l'utilisateur
 * l'avait lancée ; en appel, Kopilia la résume.
 */
export const setupsSearched = z.object({
  ...envelopeBase,
  type: z.literal("setups.searched"),
  /** Lancée par l'utilisateur (à la voix ou depuis l'écran), et non après un wrap. */
  byUser: z.boolean(),
  /** Les setups en attente qu'elle a repérés (sc_…). */
  opened: z.array(z.string()),
  /** « Recherche finie : 1 setup en attente ». */
  title: z.string(),
  /** « Or, achat : rebond sur le support 1h 4 021–4 028 ». */
  detail: z.string(),
});

/** Cotation en direct d'un produit affiché (courtier de l'utilisateur, via le serveur). */
export const marketQuote = z.object({
  ...envelopeBase,
  type: z.literal("market.quote"),
  symbol: z.string().min(1),
  bid: z.number(),
  ask: z.number().optional(),
  /** Instant de la cotation (epoch ms). */
  time: z.number().int().nonnegative(),
  digits: z.number().int().nonnegative().optional(),
  /** Ouverture de la journée du courtier, pour la variation du jour. */
  dayOpen: z.number().optional(),
});

/**
 * Une étape de travail (un outil appelé) : par le dialogue pendant le tour
 * `turnId`, ou par l'agent ou la tâche `jobId`. L'écran en fait un nœud du
 * réseau qui s'anime derrière l'orbe.
 */
export const activityStep = z.object({
  ...envelopeBase,
  type: z.literal("activity.step"),
  /** Nom de l'outil (« WebSearch », « mcp__kopilia__ask_agent »). */
  tool: z.string().min(1),
  /** Ce qu'il fait, à afficher (« Recherche web », « Agent dépêché »). */
  label: z.string().min(1),
});

/**
 * Les documents déposés sont partis avec la phrase `turnId` de l'utilisateur :
 * ils quittent la liste d'attente de l'écran.
 */
export const documentsAttached = z.object({
  ...envelopeBase,
  type: z.literal("documents.attached"),
  turnId: z.string().min(1),
  documents: z.array(z.object({ documentId: z.string().min(1), name: z.string() })),
});

export const approvalRequired = z.object({
  ...envelopeBase,
  type: z.literal("approval.required"),
  approvalId: z.string().min(1),
  jobId: z.string().optional(),
  /** Description exacte de l'action sensible et du projet concerné. */
  action: z.string().min(1),
  projectId: z.string().optional(),
  /** Expiration (epoch ms) ; dépassement => action bloquée. */
  expiresAt: z.number().int().positive(),
});

export const errorEvent = z.object({
  ...envelopeBase,
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  /** Action de reprise suggérée, le cas échéant. */
  recovery: z.string().optional(),
  fatal: z.boolean().optional(),
});

/**
 * Des news viennent d'arriver (traduites, avec leur niveau), ou une news a
 * changé (réaction du marché mesurée) : l'encart News les ajoute ; une forte
 * fait aussi son bandeau et son son, et Kopilia la dit en appel.
 */
export const newsAdded = z.object({
  ...envelopeBase,
  type: z.literal("news.added"),
  items: z.array(newsItemSchema),
  /** Des news déjà connues mises à jour (traduction, réaction du marché). */
  update: z.boolean().optional(),
  /** Les news fortes à signaler tout de suite : leur bandeau (titre, détail) et le son. */
  banners: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string(), symbol: z.string().optional() })).optional(),
});

/**
 * La prise de position : compte, money management, conditions du courtier des
 * produits affichés, trades en cours et ticket à confirmer. Envoyé à la
 * connexion et à chaque changement.
 */
export const tradingUpdated = z.object({
  ...envelopeBase,
  type: z.literal("trading.updated"),
  state: tradingStateSchema,
});

/** Ce qui arrive à un trade passé par Kopilia (ordre exécuté, stop ou objectif touché, rappel de break-even) : bandeau et son. */
export const TRADING_SIGNALS = ["placed", "filled", "closed", "rejected", "reminder", "error"] as const;
export const tradingSignal = z.object({
  ...envelopeBase,
  type: z.literal("trading.signal"),
  kind: z.enum(TRADING_SIGNALS),
  tradeId: z.string().optional(),
  symbol: z.string().optional(),
  title: z.string().min(1),
  detail: z.string().optional(),
});

/** Le journal de trading a changé (un trade, une note, une fiche) : les écrans qui le montrent le relisent. */
/**
 * Le laboratoire de stratégies a changé (robot créé ou jugé, backtest fini,
 * note au fil) : la liste des robots et leur meilleur backtest, pour l'encart
 * Robots. Envoyé aussi à la connexion.
 */
export const robotsUpdated = z.object({
  ...envelopeBase,
  type: z.literal("robots.updated"),
  robots: z.array(robotSummarySchema),
});

/**
 * Le compte MetaApi allumé, en pause ou en train de se rallumer : l'écran
 * l'affiche en haut (et le délai d'un rallumage). Envoyé à la connexion et à
 * chaque changement.
 */
export const brokerStatusEvent = z.object({
  ...envelopeBase,
  type: z.literal("broker.status"),
  status: brokerStatusSchema,
});

export const journalChanged = z.object({
  ...envelopeBase,
  type: z.literal("journal.changed"),
  tradeId: z.string().optional(),
});

/** Kopilia ouvre à l'écran la page d'un trade du journal (« montre-moi le trade du Nasdaq »), ou l'analyse de son trading. */
export const journalShow = z.object({
  ...envelopeBase,
  type: z.literal("journal.show"),
  tradeId: z.string().min(1).optional(),
  reviewId: z.string().min(1).optional(),
  /** Le calendrier du journal : un mois (AAAA-MM) ou un jour (AAAA-MM-JJ). */
  calendar: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/)
    .optional(),
});

export const serverMessage = z.discriminatedUnion("type", [
  sessionReady,
  transcriptPartial,
  transcriptFinal,
  assistantDelta,
  assistantDone,
  audioStart,
  audioEnd,
  speechSegment,
  stateChanged,
  jobUpdated,
  agentReport,
  briefReady,
  learningUpdated,
  dashboardUpdated,
  panelDisplay,
  alertTriggered,
  setupsUpdated,
  setupSignal,
  setupsSearched,
  activityChanged,
  newsAdded,
  marketQuote,
  activityStep,
  documentsAttached,
  approvalRequired,
  tradingUpdated,
  tradingSignal,
  journalChanged,
  robotsUpdated,
  brokerStatusEvent,
  journalShow,
  errorEvent,
]);
export type ServerMessage = z.infer<typeof serverMessage>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessage.parse(raw);
}

export function safeParseClientMessage(raw: unknown) {
  return clientMessage.safeParse(raw);
}
