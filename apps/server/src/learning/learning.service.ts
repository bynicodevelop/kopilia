import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { JobState } from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { JobFinished, JobRow, JobService } from "../jobs/job.service.js";
import { MemoryError, MemoryKind, MemoryService, MemoryStore, storeOf } from "../memory/memory.service.js";
import { SkillAudience, SkillError, SkillRow, SkillService } from "./skill.service.js";
import { ConversationService, TurnRow } from "./conversation.service.js";
import { SessionService } from "../session/session.service.js";
import { curatorSystemPrompt, curatorTaskPrompt, Notebook, ReviewJob, reviewSystemPrompt, reviewTaskPrompt, SkillLine } from "./learning-prompts.js";
import { AppLogger } from "../common/logger.js";
import { newId } from "../common/ids.js";
import { ensureSystemSession } from "../session/system-session.js";
import { LEARNING_SESSION_ID } from "./session-id.js";
import { SETUPS_SESSION_ID } from "../setups/session-id.js";
import { tradingSignals } from "../setups/signals.js";

export { LEARNING_SESSION_ID };

const TICK_MS = 60_000;
/** Une conversation est relue quand elle est au repos depuis 10 minutes… */
const IDLE_BEFORE_REVIEW_MS = 10 * 60_000;
/** …ou, après 10 demandes non relues (comme Hermes), dès 2 minutes de calme. */
const BUSY_REVIEW_USER_TURNS = 10;
const SHORT_IDLE_MS = 2 * 60_000;
/** Moins de deux demandes et aucun travail d'agent : on attend la suite. */
const MIN_USER_TURNS = 2;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
/** Une même fenêtre qui échoue trois fois est passée (on ne bloque pas l'apprentissage). */
const MAX_FAILED_WINDOW = 3;
/** Matière d'une relecture : au-delà, la suite part dans la relecture suivante. */
const MATERIAL_MAX_CHARS = 45_000;
const REVIEW_TIMEOUT_MS = 8 * 60_000;
/** Une demande explicite (« retiens ça ») relit les derniers tours de la conversation. */
const FOCUS_TURNS = 40;
/** Rangement : une fois par semaine, quand l'utilisateur ne parle plus depuis 2 heures. */
const CURATOR_INTERVAL_MS = 7 * 86_400_000;
const CURATOR_MIN_IDLE_MS = 2 * 3_600_000;
const CURATOR_TIMEOUT_MS = 10 * 60_000;
/** Le rangement par un modèle ne sert que si un carnet approche de son budget ou si les recettes se multiplient. */
const CURATOR_NOTEBOOK_RATIO = 0.85;
const CURATOR_MIN_SKILLS = 6;
/** Après trois écritures refusées, le relecteur s'arrête plutôt que de s'acharner. */
const MAX_WRITE_FAILURES = 3;
const SUMMARY_MAX = 600;

export type LearningKind = "review" | "curator";

/** Un changement fait pendant une passe : montré à l'utilisateur, avec de quoi le défaire. */
export interface LearningChange {
  kind: "memory" | "skill";
  action: string;
  /** Carnet (profile, environment) ou nom de recette. */
  target: string;
  /** Texte retenu, ou raison du changement de recette. */
  detail: string;
  /** Entrée ou version créée. */
  id?: string;
  /** Texte remplacé ou retiré (jamais perdu en silence), et son identifiant. */
  previous?: string;
  previousId?: string;
  /** Recette : état après le changement (draft : en attente de l'utilisateur). */
  state?: string;
}

export interface LearningRunRow {
  id: string;
  kind: LearningKind;
  job_id: string | null;
  state: "running" | "done" | "failed";
  window_from: number | null;
  window_to: number | null;
  summary: string | null;
  changes: string;
  created_at: number;
  finished_at: number | null;
  announced_at: number | null;
}

interface RunningPass {
  runId: string;
  jobId: string;
  kind: LearningKind;
  window?: { from: number; to: number };
  writeFailures: number;
}

/** Ce que la passe en cours renvoie à un outil du relecteur. */
type ToolReply = Record<string, unknown>;

/**
 * La boucle d'apprentissage de Kopilia, sur le modèle de Hermes Agent :
 * - un relecteur relit en arrière-plan les conversations au repos (et la trace
 *   des agents lancés) et met à jour les carnets (profil, environnement) et les
 *   recettes ;
 * - un rangement hebdomadaire archive ce qui ne sert plus et fusionne ce qui
 *   déborde ;
 * - l'utilisateur peut demander d'apprendre tout de suite (« retiens ça »).
 * Une seule passe à la fois. Les recettes proposées attendent l'accord de
 * l'utilisateur (sauf adoption automatique) ; rien n'est jamais supprimé.
 *
 * Émet 'learning.finished' (LearningRunRow) à la fin de chaque passe.
 */
@Injectable()
export class LearningService extends EventEmitter<{ "learning.finished": [LearningRunRow] }> implements OnModuleInit, OnModuleDestroy {
  private running?: RunningPass;
  /** Demande explicite arrivée pendant une passe : lancée juste après. */
  private queuedFocus?: { sessionId: string; focus: string };
  private ticker?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly jobs: JobService,
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly conversations: ConversationService,
    private readonly sessions: SessionService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  onModuleInit() {
    // Une erreur ici ne doit pas empêcher les autres abonnés (la passerelle) d'être prévenus.
    this.jobs.on("job.finished", (e: JobFinished) => {
      try {
        this.onJobFinished(e);
      } catch (err) {
        this.logger.error(`fin de passe mal traitée (${e.job.id}) : ${(err as Error).message}`, "learning");
      }
    });
    // Une passe interrompue par un arrêt du serveur ne reviendra jamais.
    this.db.db
      .prepare("UPDATE learning_runs SET state = 'failed', summary = 'interrompue par un redémarrage', finished_at = ? WHERE state = 'running'")
      .run(Date.now());
    if (!this.config.learningReady) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref();
    setTimeout(() => this.tick(), 30_000).unref();
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
  }

  get busy(): boolean {
    return !!this.running;
  }

  /* ------------------------------ Déclenchement ------------------------------ */

  /** Lance la passe due (rangement d'abord, puis relecture). Renvoie sa sorte, ou rien. */
  tick(now = Date.now()): LearningKind | undefined {
    if (!this.config.learningReady || this.running) return undefined;
    try {
      if (this.curatorDue(now)) {
        this.startCurator(now);
        return "curator";
      }
      const window = this.reviewWindow(now);
      if (window) {
        this.launchReview(window.turns, window.jobs, { window: { from: window.from, to: window.to } });
        return "review";
      }
    } catch (e) {
      this.logger.warn(`apprentissage : ${(e as Error).message}`, "learning");
    }
    return undefined;
  }

  /**
   * Tours à relire depuis le curseur, s'il est temps : au moins deux demandes
   * (ou un travail d'agent), et la conversation au repos. Une fenêtre trop
   * longue est coupée : la suite partira dans la relecture suivante.
   */
  reviewWindow(now = Date.now(), force = false): { from: number; to: number; turns: TurnRow[]; jobs: JobRow[] } | undefined {
    const from = Number(this.getState("reviewed_until") ?? 0);
    const all = this.conversations.between(from, now);
    if (!all.length) return undefined;
    const lastAt = all.at(-1)!.created_at;
    if (!force) {
      const userTurns = all.filter((t) => t.role === "user").length;
      const jobs = this.jobs.finishedBetween(from, lastAt, [LEARNING_SESSION_ID, SETUPS_SESSION_ID]);
      if (userTurns < MIN_USER_TURNS && !jobs.length) return undefined;
      const idle = now - lastAt;
      if (idle < IDLE_BEFORE_REVIEW_MS && !(userTurns >= BUSY_REVIEW_USER_TURNS && idle >= SHORT_IDLE_MS)) return undefined;
      const lastFailure = this.db.db
        .prepare("SELECT finished_at FROM learning_runs WHERE kind = 'review' AND state = 'failed' AND window_from = ? ORDER BY created_at DESC LIMIT 1")
        .get(from) as { finished_at: number } | undefined;
      if (lastFailure && now - lastFailure.finished_at < RETRY_AFTER_FAILURE_MS) return undefined;
    }
    let chars = 0;
    let end = all.length;
    for (let i = 0; i < all.length; i++) {
      chars += all[i].text.length;
      if (chars > MATERIAL_MAX_CHARS && i > 0) {
        end = i;
        break;
      }
    }
    const turns = all.slice(0, end);
    const to = turns.at(-1)!.created_at;
    return { from, to, turns, jobs: this.jobs.finishedBetween(from, to, [LEARNING_SESSION_ID, SETUPS_SESSION_ID]) };
  }

  /**
   * Relecture demandée : par l'utilisateur (« retiens comment faire ça »,
   * `focus` et la conversation en cours), ou depuis l'écran (relire maintenant).
   */
  requestReview(opts: { sessionId?: string; focus?: string } = {}): { started?: string; queued?: boolean; error?: string } {
    if (!this.config.learningReady) return { error: "l'apprentissage est désactivé" };
    if (this.running) {
      if (opts.focus && opts.sessionId) {
        this.queuedFocus = { sessionId: opts.sessionId, focus: opts.focus };
        return { queued: true };
      }
      return { error: "une relecture est déjà en cours" };
    }
    if (opts.focus && opts.sessionId) {
      const turns = this.conversations.lastTurns(opts.sessionId, FOCUS_TURNS);
      const jobs = this.jobs.recentFinished(opts.sessionId, 5);
      return { started: this.launchReview(turns, jobs, { focus: opts.focus }) };
    }
    const window = this.reviewWindow(Date.now(), true);
    if (!window) return { error: "rien de nouveau à relire" };
    return { started: this.launchReview(window.turns, window.jobs, { window: { from: window.from, to: window.to } }) };
  }

  private launchReview(turns: TurnRow[], jobs: JobRow[], opts: { window?: { from: number; to: number }; focus?: string }): string {
    // Ce que la recherche d'opportunités apprend de l'utilisateur pendant la fenêtre (une demande ciblée : le dernier jour).
    const span = opts.window ?? { from: Date.now() - 86_400_000, to: Date.now() };
    const prompt = reviewTaskPrompt({
      profile: this.notebook("profile"),
      environment: this.notebook("environment"),
      trading: this.notebook("trading"),
      signals: tradingSignals(this.db, span.from, span.to),
      skills: this.skillLines(),
      turns: turns.map((t) => ({ sessionId: t.session_id, role: t.role, text: t.text, at: t.created_at })),
      jobs: jobs.map((j) => this.reviewJob(j)),
      focus: opts.focus,
    });
    // Les consignes du dialogue sans ses carnets ni ses recettes : le relecteur
    // ne recopie pas dans une recette ce qu'elles disent déjà.
    const system = reviewSystemPrompt({ autoApprove: this.config.learningAutoApprove, dialoguePrompt: this.sessions.dialoguePrompt(false) });
    return this.launch("review", "Relecture des conversations", prompt, system, REVIEW_TIMEOUT_MS, opts.window);
  }

  /* --------------------------------- Rangement -------------------------------- */

  /**
   * Le rangement est-il dû ? Au tout premier passage, on note seulement la date :
   * une installation neuve ne range rien avant une semaine (comme Hermes).
   */
  curatorDue(now = Date.now()): boolean {
    const last = this.getState("curator_at");
    if (last === undefined) {
      this.setState("curator_at", String(now));
      return false;
    }
    if (now - Number(last) < CURATOR_INTERVAL_MS) return false;
    const lastTurn = this.conversations.lastTurnAt();
    if (lastTurn !== undefined && now - lastTurn < CURATOR_MIN_IDLE_MS) return false;
    return this.jobs.listActive().length === 0;
  }

  /**
   * Rangement : d'abord ce qui ne demande aucun jugement (souvenirs échus,
   * recettes d'agent inutilisées depuis 90 jours, propositions oubliées), puis,
   * seulement si un carnet approche de son budget ou si les recettes se
   * multiplient, un modèle qui fusionne.
   */
  startCurator(now = Date.now()): string {
    this.setState("curator_at", String(now));
    const expired = this.memory.expire(now);
    const { archived, expired: dropped } = this.skills.applyTransitions(now);
    const changes: LearningChange[] = [
      ...archived.map((name) => ({ kind: "skill" as const, action: "archive", target: name, detail: "inutilisée depuis 90 jours" })),
      ...dropped.map((name) => ({ kind: "skill" as const, action: "expire", target: name, detail: "proposition restée sans réponse" })),
    ];
    const full = (["profile", "environment", "trading"] as MemoryStore[]).some((s) => {
      const { used, budget } = this.memory.usage(s);
      return used > budget * CURATOR_NOTEBOOK_RATIO;
    });
    const many = this.skills.catalog().filter((s) => s.state === "active").length >= CURATOR_MIN_SKILLS;
    if (!full && !many) {
      const parts = [
        expired ? `${expired} souvenir${expired > 1 ? "s" : ""} échu${expired > 1 ? "s" : ""} retiré${expired > 1 ? "s" : ""}` : "",
        archived.length ? `${archived.length} recette${archived.length > 1 ? "s" : ""} archivée${archived.length > 1 ? "s" : ""}` : "",
        dropped.length ? `${dropped.length} proposition${dropped.length > 1 ? "s" : ""} expirée${dropped.length > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      const run = this.insertRun("curator", null, undefined, "done", parts.length ? `Rangement : ${parts.join(", ")}.` : "Rien à ranger.", changes, now);
      this.emit("learning.finished", run);
      return run.id;
    }
    const prompt = curatorTaskPrompt({
      profile: this.notebook("profile"),
      environment: this.notebook("environment"),
      trading: this.notebook("trading"),
      skills: this.skillLines(),
    });
    const runId = this.launch("curator", "Rangement de la mémoire", prompt, curatorSystemPrompt(new Date(now)), CURATOR_TIMEOUT_MS);
    for (const c of changes) this.recordChange(runId, c);
    return runId;
  }

  /* ------------------------------ Passe en cours ------------------------------ */

  private launch(kind: LearningKind, title: string, prompt: string, system: string, timeoutMs: number, window?: { from: number; to: number }): string {
    const run = this.insertRun(kind, window ?? null, undefined, "running", null, []);
    ensureSystemSession(this.db, LEARNING_SESSION_ID);
    try {
      const job = this.jobs.start({
        sessionId: LEARNING_SESSION_ID,
        kind: "agent",
        title,
        prompt,
        internal: {
          cwd: this.learningDir(),
          model: this.config.learningModel,
          appendSystemPrompt: system,
          quiet: true,
          timeoutMs,
          learning: { runId: run.id, kind },
        },
      });
      this.db.db.prepare("UPDATE learning_runs SET job_id = ? WHERE id = ?").run(job.id, run.id);
      this.running = { runId: run.id, jobId: job.id, kind, window, writeFailures: 0 };
      this.logger.log(`${kind === "review" ? "relecture" : "rangement"} lancé (${run.id}, job ${job.id})`, "learning");
      return run.id;
    } catch (e) {
      this.finishRun(run.id, "failed", (e as Error).message);
      throw e;
    }
  }

  private onJobFinished({ job, result }: JobFinished) {
    const pass = this.running;
    if (!pass || job.id !== pass.jobId) return;
    this.running = undefined;
    this.skills.endRun(pass.runId);
    const ok = job.state === JobState.Succeeded;
    const summary = ok ? cleanSummary(result) : `échec : ${job.summary ?? job.state}`;
    if (pass.kind === "review" && pass.window) {
      const failures = ok
        ? 0
        : 1 +
          (
            this.db.db.prepare("SELECT count(*) c FROM learning_runs WHERE kind = 'review' AND state = 'failed' AND window_from = ?").get(pass.window.from) as {
              c: number;
            }
          ).c;
      if (ok || failures >= MAX_FAILED_WINDOW) this.setState("reviewed_until", String(pass.window.to));
      if (!ok && failures >= MAX_FAILED_WINDOW) this.logger.warn(`relecture abandonnée pour cette fenêtre après ${failures} échecs`, "learning");
    }
    const run = this.finishRun(pass.runId, ok ? "done" : "failed", summary);
    this.logger.log(`${pass.kind === "review" ? "relecture" : "rangement"} ${pass.runId} -> ${run.state} : ${summary}`, "learning");
    this.emit("learning.finished", run);
    const next = this.queuedFocus;
    this.queuedFocus = undefined;
    if (next) this.requestReview(next);
  }

  /** La passe en cours, si `runId` est bien la sienne (sinon les outils sont refusés). */
  private pass(runId: string | undefined): RunningPass {
    if (!runId || this.running?.runId !== runId) throw new LearningRunError();
    return this.running;
  }

  isCurrentRun(runId: string | undefined): boolean {
    return !!runId && this.running?.runId === runId;
  }

  /* -------------------------- Outils du relecteur -------------------------- */

  memoryTool(runId: string | undefined, body: { action?: string; store?: string; content?: string; id?: string; kind?: string }): ToolReply {
    const pass = this.pass(runId);
    if (pass.writeFailures >= MAX_WRITE_FAILURES) return stopWriting();
    const provenance = `${pass.kind}:${pass.runId}`;
    try {
      if (body.action === "add") {
        const store: MemoryStore = body.store === "environment" || body.store === "trading" ? body.store : "profile";
        const kind: MemoryKind = body.kind === "preference" || body.kind === "correction" ? body.kind : "fact";
        const row = this.memory.add(store, body.content ?? "", { kind, provenance, strict: true });
        this.recordChange(pass.runId, { kind: "memory", action: "add", target: store, detail: row.content, id: row.id });
        return saved(this.memory.usage(store));
      }
      if (body.action === "replace") {
        const before = this.memoryRow(body.id);
        const row = this.memory.replace(body.id ?? "", body.content ?? "", { provenance, strict: true });
        const store = storeOf(row);
        this.recordChange(pass.runId, {
          kind: "memory",
          action: "replace",
          target: store,
          detail: row.content,
          id: row.id,
          previous: before?.content,
          previousId: before?.id,
        });
        return { ...saved(this.memory.usage(store)), replaced: before?.content };
      }
      if (body.action === "remove") {
        const old = this.memory.retire(body.id ?? "");
        const store = storeOf(old);
        this.recordChange(pass.runId, { kind: "memory", action: "remove", target: store, detail: old.content, previous: old.content, previousId: old.id });
        return { ...saved(this.memory.usage(store)), removed: old.content };
      }
      throw new MemoryError("action inconnue : add, replace ou remove");
    } catch (e) {
      return this.refused(pass, e);
    }
  }

  skillTool(
    runId: string | undefined,
    body: {
      action?: string;
      name?: string;
      audience?: string;
      description?: string;
      body?: string;
      old_text?: string;
      new_text?: string;
      path?: string;
      content?: string;
      reason?: string;
      absorbed_into?: string;
    },
  ): ToolReply {
    const pass = this.pass(runId);
    if (pass.writeFailures >= MAX_WRITE_FAILURES) return stopWriting();
    const prov = { origin: pass.kind === "curator" ? ("curator" as const) : ("review" as const), reason: body.reason, runId: pass.runId };
    const name = (body.name ?? "").trim();
    const audience = body.audience as SkillAudience | undefined;
    try {
      let row: SkillRow;
      switch (body.action) {
        case "create":
          row = this.skills.create({ name, description: body.description ?? "", audience: audience ?? "agents", body: body.body ?? "" }, prov);
          break;
        case "patch":
          row = this.skills.update(name, { patch: { old: body.old_text ?? "", new: body.new_text ?? "" } }, prov);
          break;
        case "rewrite":
          row = this.skills.update(name, { body: body.body, description: body.description, audience }, prov);
          break;
        case "write_file":
          row = this.skills.update(name, { file: { path: body.path ?? "", content: body.content ?? "" } }, prov);
          break;
        case "archive": {
          if (pass.kind !== "curator") throw new SkillError("seul le rangement archive une recette");
          if (!body.absorbed_into || !this.skills.active(body.absorbed_into)) {
            throw new SkillError("nomme la recette active qui absorbe celle-ci (absorbed_into)");
          }
          if (this.skills.meta(name)?.pinned) throw new SkillError(`« ${name} » est épinglée par l'utilisateur : n'y touche pas`);
          this.skills.archive(name);
          this.recordChange(pass.runId, { kind: "skill", action: "archive", target: name, detail: `absorbée dans ${body.absorbed_into}` });
          return { ok: true, done: true, note: `« ${name} » archivée (récupérable).` };
        }
        default:
          throw new SkillError("action inconnue");
      }
      this.recordChange(pass.runId, {
        kind: "skill",
        action: body.action,
        target: row.name,
        detail: row.reason ?? "",
        id: row.id,
        state: row.state,
      });
      return {
        ok: true,
        done: true,
        state: row.state,
        version: row.version,
        note:
          row.state === "draft"
            ? "Proposé : l'utilisateur validera. Ce changement est fait, ne le refais pas."
            : "Adopté. Ce changement est fait, ne le refais pas.",
      };
    } catch (e) {
      return this.refused(pass, e);
    }
  }

  skillCatalog(runId: string | undefined): ToolReply {
    this.pass(runId);
    return { skills: this.skillLines() };
  }

  skillView(runId: string | undefined, name: string, file?: string): ToolReply {
    const pass = this.pass(runId);
    try {
      return { ...this.skills.view(name, { file, runId: pass.runId }) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private refused(pass: RunningPass, e: unknown): ToolReply {
    if (!(e instanceof MemoryError) && !(e instanceof SkillError)) throw e;
    pass.writeFailures++;
    if (pass.writeFailures >= MAX_WRITE_FAILURES) return { ...stopWriting(), error: e.message };
    return { error: e.message };
  }

  /* ------------------------------ Lecture, écran ------------------------------ */

  /** Ce que Kopilia a appris récemment et ce qui attend l'utilisateur (dialogue et écran). */
  status(limit = 5): { recent: Array<{ at: number; kind: LearningKind; summary: string | null; state: string }>; pending: SkillRow[] } {
    const recent = (
      this.db.db.prepare("SELECT * FROM learning_runs WHERE state <> 'running' ORDER BY created_at DESC LIMIT ?").all(limit) as LearningRunRow[]
    ).map((r) => ({ at: r.finished_at ?? r.created_at, kind: r.kind, summary: r.summary, state: r.state }));
    return { recent, pending: this.skills.pending() };
  }

  runs(limit = 15): LearningRunRow[] {
    return this.db.db.prepare("SELECT * FROM learning_runs ORDER BY created_at DESC LIMIT ?").all(limit) as LearningRunRow[];
  }

  /** Propositions jamais annoncées à voix haute. */
  unannouncedProposals(): SkillRow[] {
    return this.skills.pending().filter((s) => s.announced_at === null);
  }

  notebook(store: MemoryStore): Notebook {
    const { used, budget } = this.memory.usage(store);
    return { entries: this.memory.entries(store).map((r) => ({ id: r.id, content: r.content })), used, budget };
  }

  skillLines(): SkillLine[] {
    return this.skills.catalog().map((s) => {
      const meta = this.skills.meta(s.name);
      return {
        name: s.name,
        audience: s.audience,
        state: s.state,
        version: s.version,
        description: s.description,
        pinned: !!meta?.pinned,
        uses: meta?.uses ?? 0,
      };
    });
  }

  /* ---------------------------------- Interne --------------------------------- */

  private reviewJob(j: JobRow): ReviewJob {
    return { title: j.title, kind: j.kind, state: j.state, prompt: j.prompt ?? null, trace: this.jobs.trace(j), result: j.summary, at: j.updated_at };
  }

  private memoryRow(id: string | undefined) {
    return this.memory
      .entries("profile")
      .concat(this.memory.entries("environment"))
      .find((r) => r.id === id);
  }

  private insertRun(
    kind: LearningKind,
    window: { from: number; to: number } | null,
    jobId: string | undefined,
    state: LearningRunRow["state"],
    summary: string | null,
    changes: LearningChange[],
    now = Date.now(),
  ): LearningRunRow {
    const row: LearningRunRow = {
      id: newId("learn"),
      kind,
      job_id: jobId ?? null,
      state,
      window_from: window?.from ?? null,
      window_to: window?.to ?? null,
      summary,
      changes: JSON.stringify(changes),
      created_at: now,
      finished_at: state === "running" ? null : now,
      announced_at: null,
    };
    this.db.db
      .prepare(
        "INSERT INTO learning_runs (id,kind,job_id,state,window_from,window_to,summary,changes,created_at,finished_at,announced_at) VALUES (@id,@kind,@job_id,@state,@window_from,@window_to,@summary,@changes,@created_at,@finished_at,@announced_at)",
      )
      .run(row);
    return row;
  }

  private finishRun(runId: string, state: "done" | "failed", summary: string): LearningRunRow {
    this.db.db.prepare("UPDATE learning_runs SET state = ?, summary = ?, finished_at = ? WHERE id = ?").run(state, summary, Date.now(), runId);
    return this.db.db.prepare("SELECT * FROM learning_runs WHERE id = ?").get(runId) as LearningRunRow;
  }

  private recordChange(runId: string, change: LearningChange) {
    const row = this.db.db.prepare("SELECT changes FROM learning_runs WHERE id = ?").get(runId) as { changes: string } | undefined;
    if (!row) return;
    const changes = parseChanges(row.changes);
    changes.push(change);
    this.db.db.prepare("UPDATE learning_runs SET changes = ? WHERE id = ?").run(JSON.stringify(changes), runId);
  }

  private getState(key: string): string | undefined {
    return (this.db.db.prepare("SELECT value FROM learning_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private setState(key: string, value: string) {
    this.db.db.prepare("INSERT INTO learning_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private learningDir(): string {
    const dir = resolve(this.config.dataDir, "learning");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** Outil appelé hors de la passe en cours (jeton rejoué, passe terminée). */
export class LearningRunError extends Error {
  constructor() {
    super("aucune relecture en cours avec cet identifiant");
  }
}

export function parseChanges(json: string): LearningChange[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as LearningChange[]) : [];
  } catch {
    return [];
  }
}

function saved(usage: { used: number; budget: number }): ToolReply {
  return {
    ok: true,
    done: true,
    usage: `${Math.round((usage.used / usage.budget) * 100)} % (${usage.used}/${usage.budget} caractères)`,
    note: "Enregistré. Cette mise à jour est faite : ne la refais pas.",
  };
}

function stopWriting(): ToolReply {
  return {
    done: true,
    error: "trop d'écritures refusées",
    note: "Arrête d'écrire pour cette relecture : termine par ta réponse finale (ce que tu as retenu, ou « Rien à retenir. »).",
  };
}

/** Résumé d'une passe : la réponse finale du relecteur, en une ou deux phrases. */
function cleanSummary(text: string): string {
  const flat =
    text
      .replace(/^\s*[#>]+\s*/gm, "")
      .replace(/\*\*|`/g, "")
      .replace(/\s+/g, " ")
      .trim() || "Rien à retenir.";
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, "")}…` : flat;
}
