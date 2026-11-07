import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { adoptLegacyEnv } from "../common/legacy-env.js";

/** Charge .env (si présent) puis l'environnement. Aucune valeur par défaut secrète. */
function loadDotEnv(root: string) {
  const file = resolve(root, ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    // Une valeur collée entre guillemets (jeton…) est prise sans eux.
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = val;
  }
  adoptLegacyEnv();
}

/** Modèle configurable : absent => défaut fourni ; vide => défaut du compte. */
function optionalModel(name: string, fallback: string): string | undefined {
  const v = process.env[name];
  return v === undefined ? fallback : v || undefined;
}

/** Niveaux d'effort du CLI (--effort). */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Effort configurable : absent => défaut fourni ; vide => réglage de Claude Code de l'utilisateur ; inconnu => refusé. */
function optionalEffort(name: string, fallback: Effort): Effort | undefined {
  const v = process.env[name]?.trim();
  if (v === undefined) return fallback;
  if (!v) return undefined;
  if (!(EFFORTS as readonly string[]).includes(v)) throw new Error(`${name} invalide (« ${v} ») : ${EFFORTS.join(", ")} ou vide`);
  return v as Effort;
}

/** Un canal Telegram nommé : son nom (dit à la voix) et l'identifiant de sa discussion. */
export interface TelegramChannelConfig {
  name: string;
  chat: string;
}

/** La mention par défaut des messages publics. */
export const DEFAULT_PUBLIC_FOOTER = "Analyse personnelle, pas un conseil en investissement.";

/**
 * « public:@moncanal, signaux:-1001234 » -> canaux nommés, dans l'ordre ; un
 * élément sans nom ou sans identifiant est ignoré, un nom en double aussi.
 */
export function parseTelegramChannels(v: string): TelegramChannelConfig[] {
  const out: TelegramChannelConfig[] = [];
  for (const part of v.split(/[,;]/)) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const chat = part.slice(i + 1).trim();
    if (name && chat && !out.some((c) => c.name === name)) out.push({ name, chat });
  }
  return out;
}

/** « 07:00 » -> { hour: 7, minute: 0 } ; vide ou invalide -> null (désactivé). */
function parseClock(v: string): { hour: number; minute: number } | null {
  const m = v.trim().match(/^(\d{1,2})[:h](\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** « 07:00,12:30 » -> heures valides, dans l'ordre ; vide -> aucune. */
function parseClocks(v: string): Array<{ hour: number; minute: number }> {
  return v
    .split(",")
    .map(parseClock)
    .filter((t) => t !== null)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

@Injectable()
export class ConfigService {
  readonly repoRoot: string;
  readonly host: string;
  readonly port: number;
  /**
   * Le serveur écoute ailleurs que sur la machine elle-même : l'API interne
   * (protégée par jeton) et l'interface deviennent joignables depuis le réseau.
   */
  get exposed(): boolean {
    return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(this.host);
  }
  readonly projectRoots: string[];
  /** Espace de travail de Kopilia (Documents) : ses sous-dossiers sont les projets. */
  readonly workspaceRoot: string;
  readonly claudeBin: string;
  /** Modèle de l'ouvrier qui AGIT dans un projet (start_task). */
  readonly claudeModel: string | undefined;
  /** Modèle rapide pour le DIALOGUE vocal (réponses courtes). */
  readonly dialogueModel: string | undefined;
  /** Effort du dialogue (--effort) ; undefined : celui des réglages de Claude Code de l'utilisateur. */
  readonly dialogueEffort: Effort | undefined;
  /** Modèle des agents de recherche (ask_agent), plus puissant que le dialogue. */
  readonly agentModel: string | undefined;
  /** Modèle des agents pour une analyse approfondie (ask_agent deep=true). */
  readonly deepModel: string | undefined;
  /** Repli si le modèle d'un agent est surchargé ou indisponible sur le compte. */
  readonly fallbackModel: string | undefined;
  /** Modèle de l'agent de veille (brief macro). */
  readonly veilleModel: string | undefined;
  /** Heures des wraps automatiques, du lundi au vendredi (heure locale du Mac) ; vide = désactivé. */
  readonly briefTimes: Array<{ hour: number; minute: number }>;
  /** Flux JSON du calendrier économique Forex Factory ; vide = désactivé. */
  readonly ffCalendarUrl: string;
  /** Flux RSS des news en temps réel (FinancialJuice) ; vide = désactivé. */
  readonly newsFeedUrl: string;
  /** Modèle qui traduit les news (par lots, sans outils). */
  readonly newsModel: string | undefined;
  /** Mesure de la réaction du marché après une news (bougies d'une minute du courtier). */
  readonly newsReactions: boolean;
  /** Jeton d'API MetaApi (cours en direct du compte MetaTrader) ; vide = désactivé. Jamais transmis aux sous-processus. */
  readonly metaApiToken: string;
  /** Identifiant MetaApi du compte ; vide = le seul compte de l'utilisateur. */
  readonly metaApiAccountId: string;
  readonly metaApiProvisioningUrl: string;
  /** API des cours ; vide = déduite de la région du compte. */
  readonly metaApiClientUrl: string;
  /** API de l'historique (bougies) ; vide = déduite de la région du compte. */
  readonly metaApiDataUrl: string;
  /** Cotations des encarts poussées par MetaApi (WebSocket) ; sinon, interrogées toutes les 2 s. */
  readonly metaApiStream: boolean;
  /**
   * Pause du compte MetaApi (week-end, nuit en option, à la voix) : MetaApi
   * facture chaque heure où il est déployé. Coupée (0), Kopilia ne touche
   * jamais à l'état du compte : un serveur d'essai sur le compte de
   * l'utilisateur la coupe toujours.
   */
  readonly brokerPause: boolean;
  /** Sans usage du marché pendant ce délai (min), un compte allumé pendant une fenêtre de pause se rendort. */
  readonly brokerIdleMinutes: number;
  /** Une alerte qui se déclenche sans écran ouvert s'affiche en notification du Mac. */
  readonly alertNotify: boolean;
  /**
   * Ordres chez le courtier (prise de position) : coupés par défaut, Kopilia ne
   * fait alors que les calculs (taille, perte, gain). Activés, un ordre ne part
   * que sur la confirmation de l'utilisateur, jamais sur la seule décision de l'IA.
   */
  readonly tradingOrders: boolean;
  /** Ordres permis aussi sur un compte réel ; sinon, seulement sur un compte de démonstration. */
  readonly tradingLive: boolean;
  /**
   * Jeton du bot Telegram (créé par l'utilisateur avec BotFather) ; vide =
   * Telegram désactivé. Secret : jamais journalisé ni transmis aux sous-processus.
   */
  readonly telegramToken: string;
  /**
   * Le canal technique, privé (« -100… » ou « @nom ») : tout ce qui part de
   * soi-même page fermée, et ce que l'utilisateur y envoie ; vide = rien d'automatique.
   */
  readonly telegramChatId: string;
  /** Les autres canaux (publics), nommés : seulement à la demande, après aperçu et accord. */
  readonly telegramChannels: TelegramChannelConfig[];
  /** Mention ajoutée en bas de chaque message publié sur un canal public ; vide = aucune. */
  readonly telegramPublicFooter: string;
  /** Adresse de l'API Bot de Telegram (remplacée par un faux serveur dans les tests). */
  readonly telegramApiUrl: string;
  /**
   * Poster sur X (ex-Twitter) sans l'API, payante : Kopilia ouvre la fenêtre de
   * post d'X dans le navigateur du Mac, le texte déjà écrit et le graphique
   * dans le presse-papiers ; l'utilisateur colle l'image et clique Poster
   * lui-même. Seulement sur le Mac, où tourne le serveur ; KOPILIA_X_COMPOSE=0 le coupe.
   */
  readonly xCompose: boolean;
  /** Mention ajoutée en bas de chaque post X ; vide = aucune. */
  readonly xFooter: string;
  /** Longueur maximale d'un post, comptée comme X la compte : 280, davantage avec X Premium. */
  readonly xMaxChars: number;
  readonly whisperModel: string;
  /** Termes à bien reconnaître (noms propres, sigles), un par ligne. */
  readonly sttVocabularyFile: string;
  readonly whisperLang: string;
  readonly kokoroVoice: string;
  readonly kokoroLang: string;
  readonly sttCommand: string[];
  readonly ttsCommand: string[];
  readonly memoryContextBudget: number;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly webDist: string;
  /** Coordination des tâches via MCP exposé à la session de dialogue. */
  readonly enableCoordination: boolean;
  /** Jeton interne (loopback) protégeant l'API de contrôle des jobs. */
  readonly internalToken: string;
  /**
   * Jeton des agents : il n'ouvre que la lecture des cours (outils market_*)
   * et des recettes (skill_view), rien d'autre de l'API interne.
   */
  readonly agentToken: string;
  /** Apprentissage : relecture des conversations, carnets, recettes, rangement. */
  readonly learningEnabled: boolean;
  /** Modèle du relecteur et du rangement (le jugement compte plus que la vitesse). */
  readonly learningModel: string | undefined;
  /** Les recettes proposées par la relecture sont adoptées sans attendre l'utilisateur. */
  readonly learningAutoApprove: boolean;
  /** Jeton du relecteur : il n'ouvre que les outils d'apprentissage, pendant une relecture. */
  readonly learningToken: string;
  /** Recherche d'opportunités : hypothèses, scénarios, alertes de l'IA, passes et réveils d'agents. */
  readonly setupsEnabled: boolean;
  /** Modèle des agents de la recherche d'opportunités (passes et réveils). */
  readonly setupModel: string | undefined;
  /** Produits passés en revue à chaque passe, en plus des graphiques affichés (noms courants). */
  readonly setupProducts: string[];
  /** Réveils d'agents au plus par jour (alertes, rendez-vous, changements de contexte) ; au-delà, la passe suivante reprend. */
  readonly setupWakesPerDay: number;
  /** Jeton des agents de la recherche d'opportunités : leurs outils (dossiers, alertes de l'IA), et les lectures des agents. */
  readonly setupToken: string;
  /** Jeton des agents d'action (tâches de fond sur Kopilia) : tracés, alertes, indicateurs, et les lectures des agents. */
  readonly actionToken: string;
  /** Laboratoire de stratégies : le jeton de l'agent quant et son modèle. */
  readonly algoToken: string;
  readonly algoModel: string | undefined;

  constructor() {
    // apps/server/dist -> remonter à la racine du dépôt
    this.repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
    // Les tests posent KOPILIA_SKIP_DOTENV=1 : ils ne dépendent pas du .env du poste.
    if (process.env.KOPILIA_SKIP_DOTENV !== "1") loadDotEnv(this.repoRoot);

    this.host = process.env.KOPILIA_HOST ?? "127.0.0.1";
    this.port = Number(process.env.KOPILIA_PORT ?? 4317);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new Error(`KOPILIA_PORT invalide (« ${process.env.KOPILIA_PORT} ») : un numéro de port entre 1 et 65535 est attendu`);
    }
    // realpath : les chemins de projets sont comparés sous forme canonique
    // (sur macOS, /var est par exemple un lien vers /private/var).
    this.projectRoots = (process.env.KOPILIA_PROJECT_ROOTS ?? resolve(this.repoRoot, ".."))
      .split(":")
      .filter(Boolean)
      .map((p) => {
        try {
          return realpathSync(p);
        } catch {
          return resolve(p);
        }
      });
    this.workspaceRoot = this.projectRoots[0];
    this.claudeBin = process.env.KOPILIA_CLAUDE_BIN ?? "claude";
    // Partage des rôles : un dialogue rapide (Haiku) qui délègue à des agents
    // plus puissants. Variable vide => modèle par défaut du compte.
    this.dialogueModel = optionalModel("KOPILIA_DIALOGUE_MODEL", "claude-haiku-5-5");
    // Sans effort explicite, le dialogue prend celui des réglages de Claude Code (souvent « high ») :
    // Haiku réfléchit avant de parler, environ 2 s de plus avant le premier mot (mesuré le 2026-11-04).
    // La réflexion de fond, elle, part aux agents.
    this.dialogueEffort = optionalEffort("KOPILIA_DIALOGUE_EFFORT", "low");
    this.agentModel = optionalModel("KOPILIA_AGENT_MODEL", "claude-sonnet-5-5");
    this.deepModel = optionalModel("KOPILIA_DEEP_MODEL", "claude-opus-5-5");
    this.claudeModel = optionalModel("KOPILIA_CLAUDE_MODEL", "claude-opus-5-5");
    this.fallbackModel = optionalModel("KOPILIA_FALLBACK_MODEL", "claude-sonnet-5-5");
    this.veilleModel = optionalModel("KOPILIA_VEILLE_MODEL", "claude-sonnet-5-5");
    // Le matin (nuit américaine et Asie), puis à midi (Londres, avant l'ouverture de New York).
    this.briefTimes = parseClocks(process.env.KOPILIA_BRIEF_TIMES ?? "07:00,12:30");
    this.ffCalendarUrl = (process.env.KOPILIA_FF_CALENDAR_URL ?? "https://nfs.faireconomy.media/ff_calendar_thisweek.json").trim();
    this.newsFeedUrl = (process.env.KOPILIA_NEWS_FEED_URL ?? "https://www.financialjuice.com/feed.ashx?xy=rss").trim();
    this.newsModel = optionalModel("KOPILIA_NEWS_MODEL", "claude-haiku-5-5");
    this.newsReactions = (process.env.KOPILIA_NEWS_REACTIONS ?? "1") !== "0";
    this.metaApiToken = (process.env.KOPILIA_METAAPI_TOKEN ?? "").trim();
    this.metaApiAccountId = (process.env.KOPILIA_METAAPI_ACCOUNT_ID ?? "").trim();
    this.metaApiProvisioningUrl = (process.env.KOPILIA_METAAPI_PROVISIONING_URL || "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai").replace(
      /\/+$/,
      "",
    );
    this.metaApiClientUrl = (process.env.KOPILIA_METAAPI_CLIENT_URL ?? "").trim().replace(/\/+$/, "");
    this.metaApiDataUrl = (process.env.KOPILIA_METAAPI_DATA_URL ?? "").trim().replace(/\/+$/, "");
    this.metaApiStream = (process.env.KOPILIA_METAAPI_STREAM ?? "1") !== "0";
    this.brokerPause = (process.env.KOPILIA_BROKER_PAUSE ?? "1") !== "0";
    const idle = Number(process.env.KOPILIA_BROKER_IDLE_MIN ?? "20");
    this.brokerIdleMinutes = Number.isFinite(idle) && idle > 0 ? idle : 20;
    this.alertNotify = (process.env.KOPILIA_ALERT_NOTIFY ?? "1") !== "0";
    this.tradingOrders = (process.env.KOPILIA_TRADING_ORDERS ?? "0") === "1";
    this.tradingLive = (process.env.KOPILIA_TRADING_LIVE ?? "0") === "1";
    this.telegramToken = (process.env.KOPILIA_TELEGRAM_TOKEN ?? "").trim();
    this.telegramChatId = (process.env.KOPILIA_TELEGRAM_CHAT_ID ?? "").trim();
    this.telegramChannels = parseTelegramChannels(process.env.KOPILIA_TELEGRAM_CHANNELS ?? "");
    this.telegramPublicFooter = (process.env.KOPILIA_TELEGRAM_PUBLIC_FOOTER ?? DEFAULT_PUBLIC_FOOTER).trim();
    this.telegramApiUrl = (process.env.KOPILIA_TELEGRAM_API_URL || "https://api.telegram.org").trim().replace(/\/+$/, "");
    this.xCompose = (process.env.KOPILIA_X_COMPOSE ?? "1") !== "0" && process.platform === "darwin";
    this.xFooter = (process.env.KOPILIA_X_FOOTER ?? DEFAULT_PUBLIC_FOOTER).trim();
    this.xMaxChars = Math.max(1, Math.floor(Number(process.env.KOPILIA_X_MAX_CHARS ?? 280)) || 280);
    // large-v3-turbo par défaut (bien meilleur en français) ; repli sur Base tant
    // qu'il n'est pas téléchargé (`pnpm models:fetch`), pour rester utilisable.
    const turbo = this.abs("models/ggml-large-v3-turbo-q5_0.bin");
    this.whisperModel = this.abs(process.env.KOPILIA_WHISPER_MODEL || (existsSync(turbo) ? turbo : "models/ggml-base.bin"));
    // Le vocabulaire de l'utilisateur (personnel, hors git) ; à défaut, le modèle livré avec le dépôt.
    const ownVocabulary = this.abs("config/vocabulaire.txt");
    this.sttVocabularyFile = this.abs(process.env.KOPILIA_STT_VOCABULARY ?? (existsSync(ownVocabulary) ? ownVocabulary : "config/vocabulaire.example.txt"));
    this.whisperLang = process.env.KOPILIA_WHISPER_LANG ?? "fr";
    this.kokoroVoice = process.env.KOPILIA_KOKORO_VOICE ?? "ff_siwis";
    this.kokoroLang = process.env.KOPILIA_KOKORO_LANG ?? "f";
    // Commandes des workers vocaux. Surchargées par KOPILIA_STT_CMD/KOPILIA_TTS_CMD
    // (p.ex. pour brancher les doubles de test).
    this.sttCommand = (process.env.KOPILIA_STT_CMD ?? `node ${this.abs("workers/whisper/run.mjs")}`).split(" ");
    this.ttsCommand = (process.env.KOPILIA_TTS_CMD ?? `${this.abs("workers/kokoro/.venv/bin/python")} ${this.abs("workers/kokoro/run.py")}`).split(" ");
    this.memoryContextBudget = Number(process.env.KOPILIA_MEMORY_CONTEXT_BUDGET ?? 6);
    this.dataDir = this.abs(process.env.KOPILIA_DATA_DIR ?? "data");
    // Une base créée avant le nom Kopilia garde son fichier (jarvis.sqlite).
    const legacyDb = resolve(this.dataDir, "jarvis.sqlite");
    this.dbPath = resolve(this.dataDir, "kopilia.sqlite");
    if (!existsSync(this.dbPath) && existsSync(legacyDb)) this.dbPath = legacyDb;
    this.webDist = this.abs("apps/web/dist/kopilia-web/browser");
    this.enableCoordination = (process.env.KOPILIA_ENABLE_COORDINATION ?? "1") !== "0";
    this.internalToken = process.env.KOPILIA_INTERNAL_TOKEN ?? randomBytes(24).toString("base64url");
    this.agentToken = process.env.KOPILIA_AGENT_TOKEN ?? randomBytes(24).toString("base64url");
    this.learningEnabled = (process.env.KOPILIA_LEARNING ?? "1") !== "0";
    this.learningModel = optionalModel("KOPILIA_LEARNING_MODEL", "claude-sonnet-5-5");
    this.learningAutoApprove = process.env.KOPILIA_LEARNING_AUTO_APPROVE === "1";
    this.learningToken = process.env.KOPILIA_LEARNING_TOKEN ?? randomBytes(24).toString("base64url");
    this.setupsEnabled = (process.env.KOPILIA_SETUPS ?? "1") !== "0";
    this.setupModel = optionalModel("KOPILIA_SETUP_MODEL", "claude-sonnet-5-5");
    // Les produits que suit l'utilisateur, et eux seuls (noms courants ou symboles : le courtier les retrouve) ;
    // sa liste à lui va dans son .env, la valeur par défaut n'est qu'un exemple.
    this.setupProducts = (process.env.KOPILIA_SETUP_PRODUCTS ?? "Nasdaq,Dow Jones,or")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.setupWakesPerDay = Math.max(0, Number(process.env.KOPILIA_SETUP_WAKES_PER_DAY ?? 40) || 0);
    this.setupToken = process.env.KOPILIA_SETUP_TOKEN ?? randomBytes(24).toString("base64url");
    this.actionToken = process.env.KOPILIA_ACTION_TOKEN ?? randomBytes(24).toString("base64url");
    this.algoToken = process.env.KOPILIA_ALGO_TOKEN ?? randomBytes(24).toString("base64url");
    this.algoModel = optionalModel("KOPILIA_ALGO_MODEL", "claude-sonnet-5-5");
    this.coordinationServerPath = this.abs("apps/server/dist/mcp/coordination-server.js");
    this.agentServerPath = this.abs("apps/server/dist/mcp/agent-server.js");
    this.learningServerPath = this.abs("apps/server/dist/mcp/learning-server.js");
  }

  readonly coordinationServerPath!: string;
  /** Serveur MCP « kopilia » des agents : cours (si MetaApi) et recettes. */
  readonly agentServerPath!: string;
  /** Serveur MCP « apprentissage » du relecteur : carnets et recettes. */
  readonly learningServerPath!: string;

  /** Les agents ont leurs outils (recettes, cours) si leur serveur MCP est compilé. */
  get agentToolsReady(): boolean {
    return existsSync(this.agentServerPath);
  }

  /** Les agents ont les outils de cours si MetaApi est configuré et leur serveur MCP compilé. */
  get marketToolsReady(): boolean {
    return !!this.metaApiToken && this.agentToolsReady;
  }

  /** La recherche d'opportunités tourne si elle est activée et que les agents ont les cours. */
  get setupsReady(): boolean {
    return this.setupsEnabled && this.marketToolsReady;
  }

  /** La relecture tourne si elle est activée et son serveur MCP compilé. */
  get learningReady(): boolean {
    return this.learningEnabled && existsSync(this.learningServerPath);
  }

  /** La coordination n'est active que si le serveur MCP compilé existe. */
  get coordinationReady(): boolean {
    return this.enableCoordination && existsSync(this.coordinationServerPath);
  }

  get internalBaseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  private abs(p: string): string {
    return isAbsolute(p) ? p : resolve(this.repoRoot, p);
  }

  /** Vérifie qu'un chemin canonique est contenu dans une racine autorisée. */
  isPathAllowed(canonical: string): boolean {
    return this.projectRoots.some((root) => canonical === root || canonical.startsWith(root + "/"));
  }
}
