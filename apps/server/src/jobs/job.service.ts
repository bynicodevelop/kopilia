import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { JobState, TurnOutcome } from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { ProjectService } from "../session/project.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { SkillService } from "../learning/skill.service.js";
import { LEARNING_SESSION_ID } from "../learning/session-id.js";
import { SETUPS_SESSION_ID } from "../setups/session-id.js";
import { ClaudeProcess } from "../session/claude-process.js";
import { OWN_TOOLS_ENV } from "../session/child-env.js";
import { AgentKnowledge, agentSystemPrompt, documentsPrompt, workerSystemPrompt } from "../session/prompts.js";
import { calendarSnapshot } from "../calendar/calendar.service.js";
import { AppLogger } from "../common/logger.js";
import { newId } from "../common/ids.js";
import {
  AGENT_MARKET_TOOLS as AGENT_MARKET_NAMES,
  AGENT_SETUP_TOOLS as AGENT_SETUP_NAMES,
  AGENT_ACTION_TOOLS as AGENT_ACTION_NAMES,
  AGENT_ALGO_TOOLS as AGENT_ALGO_NAMES,
  AGENT_SKILL_TOOLS as AGENT_SKILL_NAMES,
  LEARNING_TOOLS as LEARNING_NAMES,
  MCP_SERVER,
  mcpConfig,
  mcpTools,
  removeMcpConfig,
  writeMcpConfig,
} from "../mcp/catalog.js";

/** `agent` : recherche ou analyse en lecture seule ; `task` : ouvrier qui agit. */
export type JobKind = "agent" | "task";

export interface JobRow {
  id: string;
  session_id: string;
  kind: JobKind;
  project_id: string | null;
  claude_session_id: string | null;
  title: string;
  state: JobState;
  summary: string | null;
  pending_instruction: string | null;
  outcome: string | null;
  /** Consigne reçue (relue par l'apprentissage). */
  prompt?: string | null;
  /** JSON : étapes en bref (outil, détail, erreur). */
  trace?: string | null;
  created_at: number;
  updated_at: number;
}

/** Une étape de la trace d'un agent : l'outil, ce qu'il visait, et son erreur éventuelle. */
export interface TraceStep {
  tool: string;
  detail?: string;
  error?: string;
}

export interface StartJobInput {
  sessionId: string;
  /** Défaut : `task`. */
  kind?: JobKind;
  /**
   * Sous-dossier de l'espace de travail (Documents). Tâche : vide = la racine.
   * Agent : omis = recherche web dans un dossier neutre.
   */
  folder?: string;
  title: string;
  prompt: string;
  /** Tâche qui modifie le projet => confirmation requise. Sans effet pour un agent. */
  requiresApproval?: boolean;
  /** Agent : modèle le plus puissant, pour une analyse longue ou difficile. */
  deep?: boolean;
  /**
   * Agent : documents joints par l'utilisateur à lire, déjà validés par
   * l'appelant, et leur désignation (« rapport.pdf », 42 pages).
   */
  documents?: Array<{ path: string; label: string }>;
  /**
   * Agent d'action : il agit sur Kopilia (tracés, alertes, indicateurs de
   * plusieurs graphiques), sans toucher à l'écran. Sans effet pour une tâche.
   */
  act?: boolean;
  /**
   * Réglages réservés aux services internes (jamais relayés depuis l'API de
   * contrôle) : agent spécialisé comme la veille.
   */
  internal?: {
    /** Remplace la consigne d'agent par défaut. */
    appendSystemPrompt?: string;
    /** Dossier de travail déjà validé par le service appelant. */
    cwd?: string;
    model?: string;
    /** Le service appelant rapporte lui-même le résultat (pas d'annonce générique). */
    quiet?: boolean;
    timeoutMs?: number;
    /**
     * Relecture ou rangement : les seuls outils d'apprentissage (carnets,
     * recettes, recherche dans les conversations), ni web ni fichiers.
     */
    learning?: { runId: string; kind: "review" | "curator" };
    /** Agent de la recherche d'opportunités : ses outils (hypothèses, dossiers, alertes de l'IA) en plus de ceux des agents. */
    setups?: boolean;
    /** Agent quant du laboratoire de stratégies : ses outils (bibliothèque, réserve, versions, backtests) en plus de ceux des agents. */
    algo?: boolean;
  };
}

/** Fin d'un travail : `result` est la réponse finale complète (le résumé stocké est tronqué). */
export interface JobFinished {
  job: JobRow;
  announce: boolean;
  result: string;
}

export interface ApprovalRow {
  id: string;
  job_id: string | null;
  session_id: string | null;
  action: string;
  project_id: string | null;
  state: string;
  decision: string | null;
  expires_at: number;
  created_at: number;
  resolved_at: number | null;
}

/** Délai d'approbation avant blocage automatique (ms). */
const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Travaux simultanés par sorte : les agents ne bloquent pas les tâches. Les
 * tâches, en plus, se limitent à une par projet (voir checkTaskSlot).
 */
const MAX_ACTIVE: Record<JobKind, number> = { agent: 3, task: 3 };

/** Résultat conservé : un agent rapporte des détails (horaires, chiffres). */
const SUMMARY_MAX: Record<JobKind, number> = { agent: 6000, task: 2000 };

/** Un agent bloqué ne garde pas sa place indéfiniment ; un ouvrier, lui, n'a pas de limite. */
const AGENT_TIMEOUT_MS = 15 * 60_000;

/**
 * Outils d'un agent : web et lecture du dossier courant. `dontAsk` refuse tout
 * le reste sans demander : un agent ne modifie jamais rien.
 */
const AGENT_ALLOWED_TOOLS = ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Bash(curl *)"];
const AGENT_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];
/** Recettes de Kopilia, par le serveur MCP « kopilia » des agents. */
const AGENT_SKILL_TOOLS = mcpTools(MCP_SERVER.agents, AGENT_SKILL_NAMES);
/** Laboratoire de stratégies : les outils de l'agent quant, par le même serveur. */
const AGENT_ALGO_TOOLS = mcpTools(MCP_SERVER.agents, AGENT_ALGO_NAMES);
/** Cours du compte MetaTrader, par le même serveur (si MetaApi est configuré). */
const AGENT_MARKET_TOOLS = mcpTools(MCP_SERVER.agents, AGENT_MARKET_NAMES);
/** Recherche d'opportunités, par le même serveur. */
const AGENT_SETUP_TOOLS = mcpTools(MCP_SERVER.agents, AGENT_SETUP_NAMES);
const AGENT_ACTION_TOOLS = mcpTools(MCP_SERVER.agents, AGENT_ACTION_NAMES);
/** Relecteur et rangement : leurs outils d'apprentissage, et rien d'autre. */
const LEARNING_TOOLS = mcpTools(MCP_SERVER.learning, LEARNING_NAMES);
const LEARNING_DISALLOWED_TOOLS = ["Bash", "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch", "Task", "Agent", "TodoWrite"];
/** Trace d'un agent : les dernières étapes, chacune en bref. */
const TRACE_MAX_STEPS = 40;
const TRACE_DETAIL_CHARS = 160;

/**
 * Gère les agents et les tâches lancés par Kopilia : chacun est une session
 * `claude` distincte, plus puissante que le dialogue. Le résultat revient sous
 * forme de résumé associé au job.
 *
 * Émet 'job.updated' (JobRow) pour que la gateway relaie l'état au navigateur,
 * 'job.step' ({ job, tool }) à chaque outil appelé (une étape montrée à
 * l'écran), et 'job.finished' (JobFinished) quand un travail se termine : la
 * gateway fait alors rapporter le résultat par Kopilia, à voix haute.
 */
/** Événements de JobService (la passerelle les relaie aux écrans ; la veille et l'apprentissage écoutent la fin). */
export interface JobEvents {
  "job.updated": [JobRow];
  "job.step": [{ job: JobRow; tool: string }];
  "job.finished": [JobFinished];
  "approval.required": [ApprovalRow];
}

/** Demande refusée pour une raison que l'utilisateur doit entendre (quota, travail terminé ou inconnu…). */
export class JobError extends Error {}

@Injectable()
export class JobService extends EventEmitter<JobEvents> implements OnModuleInit, OnModuleDestroy {
  private workers = new Map<string, ClaudeProcess>();
  /** Lancements en attente d'approbation (jobId -> contexte d'exécution). */
  private pending = new Map<string, { cwd: string; prompt: string; approvalId: string; timer: NodeJS.Timeout }>();
  /** Travaux dont le résultat est rapporté par leur service appelant. */
  private quiet = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly projects: ProjectService,
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  /**
   * Démarrage : un travail resté en cours ou en attente vient d'un serveur
   * arrêté, son processus n'existe plus. Il passe « à vérifier » (jamais
   * relancé) ; une tâche qui attendait une confirmation est annulée et son
   * approbation expire. Sans cela, il compterait toujours dans les quotas
   * (« déjà 3 tâches en cours ») et resterait affiché indéfiniment.
   */
  onModuleInit() {
    const now = Date.now();
    const { interrupted, unapproved, expired } = this.db.tx(() => ({
      interrupted: this.db.db
        .prepare("UPDATE jobs SET state=?, summary=?, outcome=?, updated_at=? WHERE state IN ('queued','running')")
        .run(JobState.Unverified, "interrompu : redémarrage du serveur", JobState.Unverified, now).changes,
      unapproved: this.db.db
        .prepare("UPDATE jobs SET state=?, summary=?, outcome=?, updated_at=? WHERE state = 'awaiting_approval'")
        .run(JobState.Cancelled, "approbation expirée : redémarrage du serveur", JobState.Cancelled, now).changes,
      expired: this.db.db.prepare("UPDATE approvals SET state='expired', resolved_at=? WHERE state='pending'").run(now).changes,
    }));
    if (interrupted + unapproved + expired) {
      this.logger.warn(
        `reprise : ${interrupted} travail(s) interrompu(s), ${unapproved} tâche(s) non confirmée(s), ${expired} approbation(s) expirée(s)`,
        "jobs",
      );
    }
  }

  onModuleDestroy() {
    for (const w of this.workers.values()) w.stop();
  }

  /**
   * Travaux en cours d'une sorte ; une relecture d'apprentissage ou un agent de
   * la recherche d'opportunités (qui a son propre plafond) ne prend pas la
   * place d'un agent du dialogue.
   */
  private activeCount(kind: JobKind): number {
    return (
      this.db.db
        .prepare("SELECT count(*) c FROM jobs WHERE kind = ? AND session_id NOT IN (?, ?) AND state IN ('queued','running','awaiting_approval')")
        .get(kind, LEARNING_SESSION_ID, SETUPS_SESSION_ID) as { c: number }
    ).c;
  }

  /**
   * Une tâche à la fois par projet : deux ouvriers ne modifient jamais les
   * mêmes fichiers. Un dossier qui en contient un autre compte comme le même
   * projet (une tâche dans Documents touche tous les projets).
   */
  private checkTaskSlot(cwd: string) {
    const active = this.db.db
      .prepare(
        "SELECT j.title, p.path FROM jobs j LEFT JOIN projects p ON p.id = j.project_id WHERE j.kind = 'task' AND j.state IN ('queued','running','awaiting_approval')",
      )
      .all() as Array<{ title: string; path: string | null }>;
    const clash = active.find((t) => !t.path || t.path === cwd || isInside(cwd, t.path) || isInside(t.path, cwd));
    if (clash) {
      throw new JobError(
        `une tâche est déjà en cours dans ${this.projects.folderLabel(clash.path ?? cwd)} (« ${clash.title} ») : attends qu'elle se termine, ou ajoute-lui une consigne`,
      );
    }
    if (active.length >= MAX_ACTIVE.task) throw new JobError(`déjà ${MAX_ACTIVE.task} tâches en cours : attends qu'une se termine`);
  }

  start(input: StartJobInput): JobRow {
    const kind = input.kind ?? "task";
    if (kind === "agent" && this.activeCount("agent") >= MAX_ACTIVE.agent) {
      throw new JobError(`déjà ${MAX_ACTIVE.agent} agents au travail : attends qu'un résultat arrive`);
    }
    // Dossier de travail : validé (realpath, racines autorisées) puis enregistré.
    // Un agent sans dossier travaille dans un répertoire neutre (recherche web).
    const own = input.internal?.cwd;
    const neutral = !!own || (kind === "agent" && !input.folder?.trim());
    const cwd = own ?? (neutral ? this.agentsDir() : this.projects.resolveFolder(input.folder));
    if (kind === "task") this.checkTaskSlot(cwd);
    const project = neutral ? null : this.projects.register(cwd);
    const needsApproval = kind === "task" && !!input.requiresApproval;
    const now = Date.now();
    const row: JobRow = {
      id: newId("job"),
      session_id: input.sessionId,
      kind,
      project_id: project?.id ?? null,
      claude_session_id: null,
      title: input.title,
      // Une tâche qui modifie le projet attend une confirmation avant exécution.
      state: needsApproval ? JobState.AwaitingApproval : JobState.Running,
      summary: null,
      pending_instruction: null,
      outcome: null,
      // La consigne d'une relecture contient des conversations entières : inutile de la garder.
      prompt: input.internal?.learning ? null : input.prompt,
      trace: null,
      created_at: now,
      updated_at: now,
    };
    this.db.db
      .prepare(
        "INSERT INTO jobs (id,session_id,kind,project_id,claude_session_id,title,state,summary,pending_instruction,outcome,prompt,trace,created_at,updated_at) VALUES (@id,@session_id,@kind,@project_id,@claude_session_id,@title,@state,@summary,@pending_instruction,@outcome,@prompt,@trace,@created_at,@updated_at)",
      )
      .run(row);

    if (input.internal?.quiet) this.quiet.add(row.id);
    // Un agent lit les documents joints là où ils sont rangés, hors de son dossier.
    const docs = kind === "agent" ? (input.documents ?? []) : [];
    const prompt = docs.length ? `${input.prompt}\n\n${documentsPrompt(docs)}` : input.prompt;
    if (needsApproval) {
      this.createApproval(row, cwd, prompt, this.projects.folderLabel(cwd));
    } else {
      this.launch(row, () =>
        this.spawnWorker(
          row,
          cwd,
          prompt,
          input.deep,
          input.internal,
          docs.map((d) => dirname(d.path)),
          kind === "agent" && !!input.act,
        ),
      );
    }
    // État relu : un lancement raté a déjà terminé le travail.
    const current = this.get(row.id) ?? row;
    if (!isFinal(current.state)) this.emit("job.updated", current);
    return current;
  }

  /** Lance l'ouvrier ; s'il lève (dossier, calendrier, processus), le travail échoue au lieu de rester en cours. */
  private launch(job: JobRow, spawn: () => void) {
    try {
      spawn();
    } catch (e) {
      this.logger.error(`lancement de ${job.id} impossible : ${(e as Error).message}`, "jobs");
      this.finish(job.id, JobState.Failed, `lancement impossible : ${(e as Error).message}`);
    }
  }

  /**
   * Serveur MCP « kopilia » des agents : recettes, et cours si MetaApi est
   * configuré, avec un jeton qui n'ouvre que ces lectures. Un agent de la
   * recherche d'opportunités (`setupJob` : son travail) a en plus ses outils,
   * avec son propre jeton.
   */
  private agentMcpConfig(market: boolean, setupJob?: string, actionJob?: string, algoJob?: string) {
    return mcpConfig(MCP_SERVER.agents, this.config.agentServerPath, {
      KOPILIA_INTERNAL_URL: this.config.internalBaseUrl,
      KOPILIA_AGENT_TOKEN: this.config.agentToken,
      KOPILIA_MARKET_TOOLS: market ? "1" : "0",
      ...(setupJob ? { KOPILIA_SETUP_TOOLS: "1", KOPILIA_SETUP_TOKEN: this.config.setupToken, KOPILIA_SETUP_JOB: setupJob } : {}),
      ...(actionJob ? { KOPILIA_ACTION_TOOLS: "1", KOPILIA_ACTION_TOKEN: this.config.actionToken, KOPILIA_ACTION_JOB: actionJob } : {}),
      ...(algoJob ? { KOPILIA_ALGO_TOOLS: "1", KOPILIA_ALGO_TOKEN: this.config.algoToken, KOPILIA_ALGO_JOB: algoJob } : {}),
    });
  }

  /** Serveur MCP « apprentissage » d'une relecture : son jeton ne vaut que pour cette passe. */
  private learningMcpConfig(learning: { runId: string; kind: "review" | "curator" }) {
    return mcpConfig(MCP_SERVER.learning, this.config.learningServerPath, {
      KOPILIA_INTERNAL_URL: this.config.internalBaseUrl,
      KOPILIA_LEARNING_TOKEN: this.config.learningToken,
      KOPILIA_LEARNING_RUN: learning.runId,
      KOPILIA_LEARNING_KIND: learning.kind,
    });
  }

  /** Ce que la mémoire apprise apporte à un agent : notes d'environnement et index des recettes. */
  private knowledge(withSkills: boolean): AgentKnowledge {
    return {
      environment: this.memory.snapshot().environment,
      skills: withSkills ? this.skills.activeFor("agents").map((s) => ({ name: s.name, description: s.description })) : [],
    };
  }

  /** Répertoire neutre des agents de recherche (hors des projets). */
  private agentsDir(): string {
    const dir = resolve(this.config.dataDir, "agents");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Crée une approbation en attente et notifie l'utilisateur (voix + UI). */
  private createApproval(job: JobRow, cwd: string, prompt: string, folderLabel: string) {
    const now = Date.now();
    const approval: ApprovalRow = {
      id: newId("appr"),
      job_id: job.id,
      session_id: job.session_id,
      // L'action exacte ET le dossier concerné, présentés avant exécution.
      action: `${job.title} (dossier : ${folderLabel})`,
      project_id: job.project_id,
      state: "pending",
      decision: null,
      expires_at: now + APPROVAL_TIMEOUT_MS,
      created_at: now,
      resolved_at: null,
    };
    this.db.db
      .prepare(
        "INSERT INTO approvals (id,job_id,session_id,action,project_id,state,decision,expires_at,created_at,resolved_at) VALUES (@id,@job_id,@session_id,@action,@project_id,@state,@decision,@expires_at,@created_at,@resolved_at)",
      )
      .run(approval);
    const timer = setTimeout(() => this.resolveApproval(approval.id, "deny", true), APPROVAL_TIMEOUT_MS);
    timer.unref();
    this.pending.set(job.id, { cwd, prompt, approvalId: approval.id, timer });
    this.emit("approval.required", approval);
    this.logger.log(`approbation requise pour job ${job.id}: ${job.title}`, "jobs");
  }

  /** Résout une approbation (décision utilisateur ou expiration). */
  approval(approvalId: string): ApprovalRow | undefined {
    return this.db.db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
  }

  resolveApproval(approvalId: string, decision: "approve" | "deny", expired = false): void {
    const appr = this.approval(approvalId);
    if (!appr || appr.state !== "pending") return;
    const state = expired ? "expired" : decision === "approve" ? "approved" : "denied";
    this.db.db.prepare("UPDATE approvals SET state=?, decision=?, resolved_at=? WHERE id=?").run(state, decision, Date.now(), approvalId);

    const jobId = appr.job_id;
    if (!jobId) return;
    const pend = this.pending.get(jobId);
    if (pend) {
      clearTimeout(pend.timer);
      this.pending.delete(jobId);
    }
    if (decision === "approve" && !expired && pend) {
      this.db.db.prepare("UPDATE jobs SET state=?, updated_at=? WHERE id=?").run(JobState.Running, Date.now(), jobId);
      const row = this.get(jobId);
      if (row) this.emit("job.updated", row);
      const job = this.get(jobId)!;
      this.launch(job, () => this.spawnWorker(job, pend.cwd, pend.prompt));
    } else {
      // Refus ou expiration : action bloquée, jamais exécutée. Un refus vient de
      // l'utilisateur lui-même ; une expiration mérite d'être dite à voix haute.
      this.finish(jobId, JobState.Cancelled, expired ? "approbation expirée : action bloquée" : "action refusée", expired);
    }
  }

  private spawnWorker(
    job: JobRow,
    cwd: string,
    prompt: string,
    deep?: boolean,
    internal?: StartJobInput["internal"],
    /** Dossiers lus en plus du dossier de travail (documents joints). */
    readDirs: string[] = [],
    /** Agent d'action : il agit sur Kopilia (tracés, alertes, indicateurs). */
    act = false,
  ) {
    const facts = this.memory.snapshot().profile;
    const agent = job.kind === "agent";
    const learning = internal?.learning;
    const model = internal?.model ?? (agent ? (deep ? this.config.deepModel : this.config.agentModel) : this.config.claudeModel);
    const extraArgs: string[] = [];
    // Configuration MCP dans un fichier privé, retiré à la fin du processus (jamais de jeton dans ps).
    let configFile: string | undefined;
    const mcpFile = (config: object) => (configFile = writeMcpConfig(this.config.dataDir, `job-${job.id}`, config));
    const fallback = this.config.fallbackModel;
    if (fallback && fallback !== model) extraArgs.push("--fallback-model", fallback);
    // Les agents lisent le calendrier Forex Factory de la semaine, hors de leur dossier.
    const calendarFile = agent && !learning ? calendarSnapshot(this.config.dataDir) : undefined;
    // Les agents lisent les cours et les recettes par le serveur Nest (outils MCP), jamais MetaApi en direct.
    const agentTools = agent && !learning && this.config.agentToolsReady;
    const market = agentTools && this.config.marketToolsReady;
    const setups = agentTools && !!internal?.setups;
    const actions = agentTools && act && !setups;
    const algo = agentTools && !!internal?.algo && !setups && !actions;
    if (learning) {
      // Relecture : les carnets et les recettes, rien d'autre (ni web, ni fichiers,
      // ni les serveurs MCP de l'utilisateur).
      extraArgs.push("--mcp-config", mcpFile(this.learningMcpConfig(learning)), "--strict-mcp-config");
      extraArgs.push("--permission-mode", "dontAsk", "--allowedTools", ...LEARNING_TOOLS);
    } else if (agent) {
      if (calendarFile) extraArgs.push("--add-dir", dirname(calendarFile));
      for (const dir of new Set(readDirs)) extraArgs.push("--add-dir", dir);
      if (agentTools)
        extraArgs.push(
          "--mcp-config",
          mcpFile(this.agentMcpConfig(market, setups ? job.id : undefined, actions ? job.id : undefined, algo ? job.id : undefined)),
        );
      // Seulement le serveur de Kopilia : ceux de l'utilisateur (connecteurs claude.ai, Figma…) ne sont pas autorisés
      // aux agents, et leur nombre ferait différer le chargement de ses outils.
      extraArgs.push("--strict-mcp-config");
      // --allowedTools en dernier (variadique) : consomme toute la liste.
      extraArgs.push(
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        ...AGENT_ALLOWED_TOOLS,
        ...(agentTools ? AGENT_SKILL_TOOLS : []),
        ...(market ? AGENT_MARKET_TOOLS : []),
        ...(setups ? AGENT_SETUP_TOOLS : []),
        ...(actions ? AGENT_ACTION_TOOLS : []),
        ...(algo ? AGENT_ALGO_TOOLS : []),
      );
    } else {
      // Ouvrier « pleins pouvoirs » : la confirmation a eu lieu au niveau de la
      // tâche, l'exécution ne redemande pas outil par outil.
      extraArgs.push("--permission-mode", "bypassPermissions");
    }
    const knowledge = { ...this.knowledge(agentTools), ...(actions ? { trading: this.memory.snapshot().trading } : {}) };
    const worker = new ClaudeProcess({
      bin: this.config.claudeBin,
      cwd,
      model,
      appendSystemPrompt:
        internal?.appendSystemPrompt ??
        (agent ? agentSystemPrompt(facts, new Date(), calendarFile, market, knowledge, actions) : workerSystemPrompt(facts, new Date(), knowledge)),
      disallowedTools: learning ? LEARNING_DISALLOWED_TOOLS : agent ? AGENT_DISALLOWED_TOOLS : undefined,
      detached: true, // kill de groupe à l'annulation
      extraArgs,
      // Relecteur et agents : leurs outils chargés d'emblée ; l'ouvrier garde le réglage de l'utilisateur.
      ...(agent ? { env: OWN_TOOLS_ENV } : {}),
      logger: this.logger,
    });
    worker.on("session", (id: string) => {
      this.db.db.prepare("UPDATE jobs SET claude_session_id = ?, updated_at = ? WHERE id = ?").run(id, Date.now(), job.id);
    });
    if (!learning) this.recordTrace(job.id, worker);
    worker.on("exit", () => {
      this.workers.delete(job.id);
      if (configFile) removeMcpConfig(configFile);
    });
    worker.on("fatal", (err: Error) => this.finish(job.id, JobState.Failed, `erreur worker: ${err.message}`));
    worker.start();
    this.workers.set(job.id, worker);
    this.logger.log(`${job.kind} ${job.id} lancé (${model ?? "modèle du compte"}) : ${job.title}`, "jobs");

    const limit = internal?.timeoutMs ?? (agent ? AGENT_TIMEOUT_MS : undefined);
    const deadline = limit
      ? setTimeout(() => {
          this.finish(job.id, JobState.Failed, `délai dépassé (${Math.round(limit / 60_000)} min) : travail arrêté`);
          worker.stop();
        }, limit)
      : undefined;
    deadline?.unref();

    const turn = (text: string) =>
      worker.sendTurn(
        text,
        () => {
          /* la sortie n'est pas synthétisée : Kopilia rapporte le résultat à la fin */
        },
        (tool) => this.emit("job.step", { job, tool }),
      );
    const run = async () => {
      let res = await turn(prompt);
      // Consignes ajoutées pendant le travail : chacune est un tour de plus, avant la fin.
      for (let note = this.takeInstruction(job.id); note && res.outcome === TurnOutcome.Success; note = this.takeInstruction(job.id)) {
        res = await turn(`Consigne ajoutée : ${note}`);
      }
      return res;
    };
    run()
      .then((res) => {
        const state = res.outcome === TurnOutcome.Success ? JobState.Succeeded : JobState.Failed;
        const result = (res.final || res.text).trim();
        this.finish(job.id, state, result.slice(0, SUMMARY_MAX[job.kind]), true, result);
      })
      .catch((err: Error) => {
        // Sortie inattendue : issue inconnue -> à vérifier (jamais de relance auto).
        const cur = this.get(job.id);
        if (cur && (cur.state === JobState.Running || cur.state === JobState.Queued)) {
          this.finish(job.id, JobState.Unverified, `interrompu: ${err.message}`);
        }
      })
      .finally(() => {
        clearTimeout(deadline);
        worker.stop();
      });
  }

  /**
   * Trace d'un travail : chaque outil appelé, ce qu'il visait (requête, page,
   * commande, symboles) et son erreur éventuelle, enregistrés au fil de l'eau.
   * La relecture y voit quelle source a marché et laquelle a échoué.
   */
  private recordTrace(jobId: string, worker: ClaudeProcess) {
    const steps: TraceStep[] = [];
    const byId = new Map<string, TraceStep>();
    const save = () => {
      const kept = steps.slice(-TRACE_MAX_STEPS);
      this.db.db.prepare("UPDATE jobs SET trace = ? WHERE id = ?").run(JSON.stringify(kept), jobId);
    };
    worker.on("tool.use", (e: { id: string; name: string; input: unknown }) => {
      if (e.name === "ToolSearch") return; // chargement d'un outil par le CLI : pas une étape
      const step: TraceStep = { tool: e.name.replace(/^mcp__[^_]+__/, ""), ...(toolDetail(e.input) ? { detail: toolDetail(e.input) } : {}) };
      steps.push(step);
      byId.set(e.id, step);
      save();
    });
    worker.on("tool.result", (e: { id: string; isError: boolean; text: string }) => {
      const step = byId.get(e.id);
      if (!step || !e.isError) return;
      step.error = shorten(e.text, TRACE_DETAIL_CHARS) || "erreur";
      save();
    });
  }

  /** Trace d'un travail, en étapes (vide si aucune). */
  trace(job: JobRow): TraceStep[] {
    try {
      return job.trace ? (JSON.parse(job.trace) as TraceStep[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * `announce` : Kopilia rapporte ce résultat de lui-même (faux si l'utilisateur
   * l'a annulé, ou si le service appelant s'en charge). `result` : réponse complète.
   */
  private finish(jobId: string, state: JobState, summary: string, announce = true, result = summary) {
    const before = this.get(jobId);
    // Déjà terminé (p.ex. annulé puis sortie du worker) : rien à refaire.
    if (!before || isFinal(before.state)) return;
    const outcome = state === JobState.Succeeded ? "success" : state;
    this.db.db.prepare("UPDATE jobs SET state=?, summary=?, outcome=?, updated_at=? WHERE id=?").run(state, summary, outcome, Date.now(), jobId);
    const row = this.get(jobId)!;
    const quiet = this.quiet.delete(jobId);
    this.emit("job.updated", row);
    const finished: JobFinished = { job: row, announce: announce && !quiet, result };
    this.emit("job.finished", finished);
    this.logger.log(`job ${jobId} -> ${state}`, "jobs");
  }

  get(jobId: string): JobRow | undefined {
    return this.db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  }

  /** Nom du dossier où travaille un job (« Kopilia ») ; rien pour une recherche web. */
  folderOf(job: JobRow): string | undefined {
    const project = job.project_id ? this.projects.get(job.project_id) : undefined;
    return project ? basename(project.path) : undefined;
  }

  /** Dernier job actif d'une session (pour les commandes sans jobId explicite). */
  activeFor(sessionId: string): JobRow | undefined {
    return this.db.db
      .prepare("SELECT * FROM jobs WHERE session_id=? AND state IN ('queued','running','awaiting_approval') ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as JobRow | undefined;
  }

  /** Dernier job d'une session, quel que soit son état (« où en es-tu ? »). */
  latestFor(sessionId: string): JobRow | undefined {
    return this.db.db.prepare("SELECT * FROM jobs WHERE session_id=? ORDER BY created_at DESC LIMIT 1").get(sessionId) as JobRow | undefined;
  }

  /** Travaux terminés entre `from` (exclu) et `to` (inclus), hors sessions système données. */
  finishedBetween(from: number, to: number, excludeSessions: string[] = []): JobRow[] {
    const rows = this.db.db
      .prepare("SELECT * FROM jobs WHERE updated_at > ? AND updated_at <= ? AND state NOT IN ('queued','running','awaiting_approval') ORDER BY updated_at")
      .all(from, to) as JobRow[];
    return rows.filter((r) => !excludeSessions.includes(r.session_id));
  }

  /** Travaux d'une session lancés depuis `since` (le plus récent d'abord) : les tentatives de la veille du jour. */
  startedSince(sessionId: string, since: number): JobRow[] {
    return this.db.db.prepare("SELECT * FROM jobs WHERE session_id = ? AND created_at >= ? ORDER BY created_at DESC").all(sessionId, since) as JobRow[];
  }

  /** Les `limit` derniers travaux terminés d'une session, du plus ancien au plus récent. */
  recentFinished(sessionId: string, limit: number): JobRow[] {
    return this.db.db
      .prepare(
        "SELECT * FROM (SELECT * FROM jobs WHERE session_id = ? AND state NOT IN ('queued','running','awaiting_approval') ORDER BY updated_at DESC LIMIT ?) ORDER BY updated_at",
      )
      .all(sessionId, limit) as JobRow[];
  }

  /**
   * Les agents et tâches de l'utilisateur (hors sessions système : veille,
   * apprentissage, recherche d'opportunités), toutes conversations confondues :
   * ceux en cours, puis les plus récents depuis `since`, `limit` au plus.
   */
  recentForUser(since: number, limit: number): JobRow[] {
    return this.db.db
      .prepare(
        `SELECT j.* FROM jobs j JOIN sessions s ON s.id = j.session_id
         WHERE s.state != 'system' AND (j.state IN ('queued','running','awaiting_approval') OR j.updated_at >= ?)
         ORDER BY CASE WHEN j.state IN ('queued','running','awaiting_approval') THEN 0 ELSE 1 END, j.updated_at DESC LIMIT ?`,
      )
      .all(since, limit) as JobRow[];
  }

  listActive(): JobRow[] {
    return this.db.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','running','awaiting_approval') ORDER BY created_at DESC").all() as JobRow[];
  }

  /**
   * Consigne ajoutée à un travail en cours : transmise à son processus dès la
   * fin du tour en cours (une tâche pas encore confirmée la reçoit après son
   * premier tour). Plusieurs consignes s'ajoutent, aucune n'en écrase une autre.
   */
  instruct(jobId: string, note: string): JobRow {
    const row = this.get(jobId);
    if (!row) throw new JobError("aucune tâche trouvée");
    if (isFinal(row.state)) throw new JobError("ce travail est déjà terminé : lance-en un nouveau avec cette consigne");
    this.db.db
      .prepare(
        "UPDATE jobs SET pending_instruction = CASE WHEN pending_instruction IS NULL THEN ? ELSE pending_instruction || char(10) || ? END, updated_at = ? WHERE id = ?",
      )
      .run(note, note, Date.now(), jobId);
    const updated = this.get(jobId)!;
    this.emit("job.updated", updated);
    return updated;
  }

  /** La consigne en attente, retirée de la file (elle part au processus). */
  private takeInstruction(jobId: string): string | undefined {
    const note = this.get(jobId)?.pending_instruction;
    if (!note) return undefined;
    this.db.db.prepare("UPDATE jobs SET pending_instruction = NULL, updated_at = ? WHERE id = ?").run(Date.now(), jobId);
    this.emit("job.updated", this.get(jobId)!);
    return note;
  }

  /** Annule : kill du groupe de processus puis état cancelled après observation. */
  cancel(jobId: string): JobRow | undefined {
    if (!this.get(jobId)) throw new JobError("aucune tâche trouvée");
    const worker = this.workers.get(jobId);
    if (worker) {
      worker.stop();
      this.workers.delete(jobId);
    }
    // Annulée avant confirmation : l'approbation en attente tombe avec elle.
    const pend = this.pending.get(jobId);
    if (pend) {
      clearTimeout(pend.timer);
      this.pending.delete(jobId);
      this.db.db.prepare("UPDATE approvals SET state='denied', decision='deny', resolved_at=? WHERE id=? AND state='pending'").run(Date.now(), pend.approvalId);
    }
    this.finish(jobId, JobState.Cancelled, "annulé par l'utilisateur", false);
    return this.get(jobId);
  }
}

/** Ce que visait un appel d'outil, en bref : sa requête, sa page, sa commande ou ses symboles. */
function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ["query", "url", "command", "pattern", "file_path", "symbols", "name", "prompt"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return shorten(v, TRACE_DETAIL_CHARS);
    if (Array.isArray(v) && v.length) return shorten(v.join(", "), TRACE_DETAIL_CHARS);
  }
  return undefined;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `dir` est un sous-dossier de `parent` (chemins canoniques). */
function isInside(dir: string, parent: string): boolean {
  const rel = relative(parent, dir);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isFinal(state: JobState): boolean {
  return state !== JobState.Queued && state !== JobState.Running && state !== JobState.AwaitingApproval;
}
