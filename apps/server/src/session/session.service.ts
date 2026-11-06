import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeContentBlock, TurnOutcome } from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { DIALOGUE_INLINE_BUDGET, SkillService } from "../learning/skill.service.js";
import { ClaudeProcess } from "./claude-process.js";
import { OWN_TOOLS_ENV } from "./child-env.js";
import { dialogueSystemPrompt, SkillEntry, SkillText } from "./prompts.js";
import { clockLabel } from "../common/dates.js";
import { AppLogger } from "../common/logger.js";
import { newId, newToken } from "../common/ids.js";
import { clearMcpConfigs, DIALOGUE_TOOLS, MCP_SERVER, mcpConfig, mcpTools, removeMcpConfig, writeMcpConfig } from "../mcp/catalog.js";

/** Outils du serveur MCP de coordination autorisés au dialogue. */
const COORDINATION_TOOLS = mcpTools(MCP_SERVER.dialogue, DIALOGUE_TOOLS);

/**
 * Outils agentiques coupés pour la session de dialogue (le worker, lui, les garde).
 * WebSearch/WebFetch RESTENT autorisés : un assistant vocal doit pouvoir donner
 * la météo, l'actualité, un cours, etc. On ne coupe que le code/fichiers/commandes.
 */
const DIALOGUE_DISALLOWED_TOOLS = ["Bash", "BashOutput", "KillBash", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "Task", "Agent", "TodoWrite"];

export interface SessionRow {
  id: string;
  claude_session_id: string | null;
  project_id: string | null;
  token: string;
  state: string;
  created_at: number;
  updated_at: number;
}

/**
 * Possède les sessions de dialogue Kopilia et leur processus `claude` associé.
 * Persiste les tours, capture l'identifiant de session CLI et reprend via
 * --resume après un redémarrage de Nest.
 */
@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private procs = new Map<string, ClaudeProcess>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly logger: AppLogger,
  ) {}

  /** Au démarrage : les configurations MCP laissées par un arrêt brutal ne servent plus. */
  onModuleInit() {
    clearMcpConfigs(this.config.dataDir);
  }

  onModuleDestroy() {
    for (const p of this.procs.values()) p.stop();
  }

  /** Crée une session + jeton d'ouverture WS. */
  create(projectId?: string): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      id: newId("sess"),
      claude_session_id: null,
      project_id: projectId ?? null,
      token: newToken(),
      state: "active",
      created_at: now,
      updated_at: now,
    };
    this.db.db
      .prepare(
        "INSERT INTO sessions (id, claude_session_id, project_id, token, state, created_at, updated_at) VALUES (@id,@claude_session_id,@project_id,@token,@state,@created_at,@updated_at)",
      )
      .run(row);
    return row;
  }

  get(id: string): SessionRow | undefined {
    return this.db.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  /** Valide un couple (sessionId, token) à l'ouverture du WebSocket. */
  validateToken(sessionId: string, token: string): boolean {
    const row = this.get(sessionId);
    return !!row && row.state === "active" && row.token === token;
  }

  /**
   * Lance le processus claude de la session dès que son écran se connecte :
   * sinon la première phrase attend son démarrage (le CLI et son serveur MCP ;
   * environ 1,5 s mesurées le 2026-11-04). Il s'arrête avec la session (close).
   */
  warm(sessionId: string): void {
    const session = this.get(sessionId);
    if (session?.state === "active") this.ensureProcess(session);
  }

  private ensureProcess(session: SessionRow): ClaudeProcess {
    let proc = this.procs.get(session.id);
    if (proc) return proc;
    const { args, configFile } = this.dialogueExtraArgs(session);
    proc = new ClaudeProcess({
      bin: this.config.claudeBin,
      // Le dialogue tourne dans un répertoire neutre : c'est l'ouvrier qui agit
      // dans les projets, jamais la session vocale elle-même.
      cwd: this.dialogueCwd(),
      model: this.config.dialogueModel,
      effort: this.config.dialogueEffort,
      resume: session.claude_session_id ?? undefined,
      // Date, carnets et recettes figés au lancement ; ce que Kopilia retient
      // ensuite (remember) est déjà dans son contexte de conversation.
      systemPrompt: this.dialoguePrompt(),
      excludeDynamicSystemPrompt: true,
      disallowedTools: DIALOGUE_DISALLOWED_TOOLS,
      extraArgs: args,
      env: OWN_TOOLS_ENV,
      logger: this.logger,
    });
    proc.on("session", (claudeId: string) => this.bindClaudeSession(session.id, claudeId));
    proc.on("exit", () => {
      this.procs.delete(session.id);
      if (configFile) removeMcpConfig(configFile);
    });
    proc.on("fatal", (err: Error) => this.logger.error(`claude fatal: ${err.message}`, "session"));
    proc.start();
    this.procs.set(session.id, proc);
    return proc;
  }

  /**
   * Consignes du dialogue : la persona, les carnets (profil, environnement,
   * carnet de trader), et les recettes du dialogue en entier (dans la limite
   * de leur budget ; les autres en index, ouvertes avec skill_view).
   * `withMemory: false` : les consignes seules, pour le relecteur qui doit
   * savoir ce qu'elles disent déjà.
   */
  dialoguePrompt(withMemory = true, now = new Date()): string {
    const snapshot = withMemory ? this.memory.snapshot() : { profile: [], environment: [], trading: undefined };
    const inline: SkillText[] = [];
    const others: SkillEntry[] = [];
    let left = DIALOGUE_INLINE_BUDGET;
    for (const s of withMemory ? this.skills.activeFor("dialogue") : []) {
      if (s.body.length <= left) {
        inline.push({ name: s.name, description: s.description, body: s.body });
        left -= s.body.length;
      } else {
        others.push({ name: s.name, description: s.description });
      }
    }
    return dialogueSystemPrompt(snapshot.profile, now, {
      briefTimes: this.config.briefTimes.map(clockLabel),
      marketPrices: !!this.config.metaApiToken,
      setups: this.config.setupsReady && this.config.coordinationReady,
      products: this.config.setupProducts,
      environment: snapshot.environment,
      trading: snapshot.trading,
      skills: { inline, others },
      learning: this.config.coordinationReady,
      telegram:
        this.config.coordinationReady && !!this.config.telegramToken && (!!this.config.telegramChatId || this.config.telegramChannels.length > 0)
          ? { publics: this.config.telegramChannels.map((c) => c.name) }
          : undefined,
      x: this.config.coordinationReady && this.config.xCompose,
    });
  }

  /**
   * Outils de la session de dialogue : recherche web + coordination (MCP local :
   * agents, tâches, mémoire). Agents et ouvriers reçoivent leurs propres outils.
   * La coordination est inactive si le serveur MCP compilé n'existe pas (p.ex.
   * en dev tsx) : le dialogue reste complet, sans délégation.
   */
  private dialogueExtraArgs(session: SessionRow): { args: string[]; configFile?: string } {
    // La recherche web est TOUJOURS autorisée (météo, actu, cours…). En mode -p,
    // un outil doit être explicitement autorisé, sinon il est bloqué par défaut.
    const allowed = ["WebSearch", "WebFetch"];
    const args: string[] = [];
    let configFile: string | undefined;

    if (this.config.coordinationReady) {
      allowed.push(...COORDINATION_TOOLS);
      const config = mcpConfig(MCP_SERVER.dialogue, this.config.coordinationServerPath, {
        KOPILIA_INTERNAL_URL: this.config.internalBaseUrl,
        KOPILIA_INTERNAL_TOKEN: this.config.internalToken,
        KOPILIA_SESSION_ID: session.id,
      });
      configFile = writeMcpConfig(this.config.dataDir, `dialogue-${session.id}`, config);
      args.push("--mcp-config", configFile);
    }
    // Seulement les outils de Kopilia : les serveurs MCP de l'utilisateur ne sont pas autorisés au dialogue, et leur
    // nombre ferait différer le chargement des siens (un aller-retour de plus avant chaque outil).
    args.push("--strict-mcp-config");
    // --allowedTools en dernier (variadique) : consomme toute la liste.
    args.push("--allowedTools", ...allowed);
    return { args, configFile };
  }

  /** Répertoire de travail neutre de la session de dialogue. */
  private dialogueCwd(): string {
    const dir = resolve(this.config.dataDir, "dialogue");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private bindClaudeSession(sessionId: string, claudeId: string) {
    const row = this.get(sessionId);
    if (row && !row.claude_session_id) {
      this.db.db.prepare("UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?").run(claudeId, Date.now(), sessionId);
      this.logger.log(`session ${sessionId} liée à claude ${claudeId}`, "session");
    }
  }

  claudeSessionId(sessionId: string): string | null {
    return this.get(sessionId)?.claude_session_id ?? null;
  }

  /**
   * Exécute un tour de dialogue : persiste l'entrée utilisateur, diffuse les
   * deltas, persiste la réponse. L'appelant (gateway) relaie les deltas au
   * navigateur et déclenche la synthèse par phrases.
   */
  async runTurn(
    sessionId: string,
    turnId: string,
    /** Phrase de l'utilisateur ; null pour un tour de Kopilia seul (rapport d'agent). */
    userText: string | null,
    onDelta: (text: string) => void,
    opts: {
      /** Texte réellement envoyé à Claude (p.ex. préfixé d'une remarque) ; défaut : userText. */
      prompt?: string;
      /** Documents joints à la phrase, placés avant elle. */
      attachments?: ClaudeContentBlock[];
      /** Un outil est appelé pendant le tour (une étape de travail). */
      onTool?: (name: string) => void;
    } = {},
  ): Promise<{ text: string; outcome: TurnOutcome }> {
    const session = this.get(sessionId);
    if (!session) throw new Error(`session inconnue: ${sessionId}`);

    if (userText !== null) this.persistTurn(sessionId, turnId, "user", userText, null);
    const proc = this.ensureProcess(session);

    const text = opts.prompt ?? userText ?? "";
    const attachments = opts.attachments ?? [];
    const content: string | ClaudeContentBlock[] = attachments.length ? [...attachments, { type: "text", text }] : text;
    const result = await proc.sendTurn(content, onDelta, opts.onTool);
    this.persistTurn(sessionId, turnId, "assistant", result.text, result.outcome);
    this.db.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    return result;
  }

  private persistTurn(sessionId: string, turnId: string, role: "user" | "assistant", text: string, outcome: TurnOutcome | null) {
    this.db.db
      .prepare("INSERT INTO turns (id, session_id, turn_id, role, text, outcome, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(newId("turn"), sessionId, turnId, role, text, outcome, Date.now());
  }

  /** Arrête la génération en cours de la session (barge-in). */
  interrupt(sessionId: string): boolean {
    return this.procs.get(sessionId)?.interrupt() ?? false;
  }

  close(sessionId: string) {
    this.procs.get(sessionId)?.stop();
    this.procs.delete(sessionId);
    this.db.db.prepare("UPDATE sessions SET state = 'closed', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
  }
}
