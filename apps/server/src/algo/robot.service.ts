import { EventEmitter } from "node:events";
import { Injectable } from "@nestjs/common";
import {
  type BacktestSummary,
  type BacktestTrade,
  type LabLesson,
  ROBOT_NOTE_KINDS,
  ROBOT_STATUSES,
  type RobotNote,
  type RobotNoteKind,
  type RobotSheet,
  type RobotStatus,
  type RobotSummary,
  type Verdict,
} from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import { newId } from "../common/ids.js";

/*
 * La bibliothèque du laboratoire : les robots (une fiche par idée), leurs
 * versions (le code TypeScript et le plan lisible), leurs backtests avec
 * leurs trades, le fil daté de chaque fiche (idée, hypothèse, décisions,
 * résultats, remarques de l'utilisateur, verdict) et les leçons du carnet du
 * laboratoire. Seul le serveur écrit ; l'agent demande par ses outils.
 */

/** Une erreur que le modèle peut corriger : elle lui revient en { error }. */
export class RobotError extends Error {}

interface RobotRow {
  id: string;
  name: string;
  idea: string;
  status: RobotStatus;
  hypothesis: string | null;
  plan: string | null;
  products: string;
  timeframe: string | null;
  version: number;
  trials: number;
  best_backtest_id: string | null;
  job_id: string | null;
  parents: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

interface BacktestRow {
  id: string;
  robot_id: string;
  version: number;
  job_id: string | null;
  trial: number;
  data: string;
  created_at: number;
}

const VERDICT_RANK: Record<Verdict, number> = { promising: 2, fragile: 1, rejected: 0 };

/** Le meilleur de deux backtests : le verdict d'abord, puis l'espérance en vérification, puis en apprentissage. */
export function betterBacktest(a: BacktestSummary, b: BacktestSummary): BacktestSummary {
  const rank = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
  if (rank !== 0) return rank > 0 ? a : b;
  const oa = a.outOfSample?.trades ? a.outOfSample.avgR : -Infinity;
  const ob = b.outOfSample?.trades ? b.outOfSample.avgR : -Infinity;
  if (oa !== ob) return oa > ob ? a : b;
  return a.inSample.avgR >= b.inSample.avgR ? a : b;
}

export interface CreateRobotInput {
  idea: string;
  name?: string;
  products: string[];
  timeframe?: string;
  sessionId?: string;
  parents?: string[];
}

export interface RobotPatch {
  name?: string;
  hypothesis?: string;
  plan?: string;
  status?: RobotStatus;
  jobId?: string | null;
  products?: string[];
  timeframe?: string;
  parents?: string[];
}

@Injectable()
export class RobotService extends EventEmitter<{ changed: [] }> {
  now: () => number = () => Date.now();

  constructor(private readonly db: DatabaseService) {
    super();
  }

  /* ------------------------------ Robots ------------------------------ */

  create(input: CreateRobotInput): RobotSummary {
    const idea = input.idea.trim();
    if (!idea) throw new RobotError("l'idée est vide : écris-la dans les mots de l'utilisateur");
    const id = newId("rb").slice(0, 11);
    const at = this.now();
    this.db.db
      .prepare(
        `INSERT INTO robots (id, name, idea, status, products, timeframe, version, trials, parents, session_id, created_at, updated_at)
         VALUES (?, ?, ?, 'idea', ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        (input.name ?? "").trim() || defaultName(idea),
        idea,
        JSON.stringify(input.products),
        input.timeframe ?? null,
        JSON.stringify(input.parents ?? []),
        input.sessionId ?? null,
        at,
        at,
      );
    this.note(id, "idea", idea);
    this.changed();
    return this.summary(id)!;
  }

  update(id: string, patch: RobotPatch): RobotSummary {
    const row = this.row(id);
    if (patch.status && !ROBOT_STATUSES.includes(patch.status)) throw new RobotError(`statut inconnu : ${patch.status}`);
    this.db.db
      .prepare(
        `UPDATE robots SET name = ?, hypothesis = ?, plan = ?, status = ?, job_id = ?, products = ?, timeframe = ?, parents = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        (patch.name ?? row.name).trim() || row.name,
        patch.hypothesis !== undefined ? patch.hypothesis.trim() : row.hypothesis,
        patch.plan !== undefined ? patch.plan.trim() : row.plan,
        patch.status ?? row.status,
        patch.jobId === undefined ? row.job_id : patch.jobId,
        patch.products ? JSON.stringify(patch.products) : row.products,
        patch.timeframe ?? row.timeframe,
        patch.parents ? JSON.stringify(patch.parents) : row.parents,
        this.now(),
        id,
      );
    if (patch.hypothesis) this.note(id, "hypothesis", patch.hypothesis.trim());
    if (patch.plan) this.note(id, "plan", patch.plan.trim());
    this.changed();
    return this.summary(id)!;
  }

  /** Une nouvelle version du code (et de son plan) ; renvoie son numéro. */
  saveVersion(id: string, code: string, plan?: string): number {
    const row = this.row(id);
    if (!code.trim()) throw new RobotError("le code est vide");
    const version = row.version + 1;
    const at = this.now();
    const tx = this.db.db.transaction(() => {
      this.db.db
        .prepare("INSERT INTO robot_versions (robot_id, version, code, plan, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, version, code, plan ?? null, at);
      this.db.db
        .prepare(
          "UPDATE robots SET version = ?, plan = COALESCE(?, plan), status = CASE WHEN status = 'idea' THEN 'testing' ELSE status END, updated_at = ? WHERE id = ?",
        )
        .run(version, plan ?? null, at, id);
    });
    tx();
    if (plan) this.note(id, "plan", `v${version} : ${plan.trim()}`);
    this.changed();
    return version;
  }

  /** Le code d'une version (la courante par défaut). */
  version(id: string, version?: number): { version: number; code: string; plan?: string } {
    const row = this.row(id);
    const v = version ?? row.version;
    const found = this.db.db.prepare("SELECT version, code, plan FROM robot_versions WHERE robot_id = ? AND version = ?").get(id, v) as
      { version: number; code: string; plan: string | null } | undefined;
    if (!found) throw new RobotError(v === 0 ? "ce robot n'a pas encore de code : enregistre-le d'abord (algo_robot_save)" : `version ${v} inconnue`);
    return { version: found.version, code: found.code, ...(found.plan ? { plan: found.plan } : {}) };
  }

  list(): RobotSummary[] {
    const rows = this.db.db.prepare("SELECT * FROM robots ORDER BY updated_at DESC").all() as RobotRow[];
    return rows.map((r) => this.toSummary(r));
  }

  summary(id: string): RobotSummary | undefined {
    const row = this.db.db.prepare("SELECT * FROM robots WHERE id = ?").get(id) as RobotRow | undefined;
    return row ? this.toSummary(row) : undefined;
  }

  /** Le robot d'un travail de recherche en cours. */
  byJob(jobId: string): RobotSummary | undefined {
    const row = this.db.db.prepare("SELECT * FROM robots WHERE job_id = ?").get(jobId) as RobotRow | undefined;
    return row ? this.toSummary(row) : undefined;
  }

  /** Le robot désigné par un identifiant, ou par son nom (ou un bout), ou le dernier modifié si « dernier ». */
  find(query: string): RobotSummary {
    const q = query.trim();
    const direct = this.summary(q);
    if (direct) return direct;
    const all = this.list();
    if (!all.length) throw new RobotError("aucun robot : l'utilisateur n'a encore fait développer aucune stratégie");
    if (/^(dernier|last|latest)$/i.test(q) || !q) return all[0];
    const lower = q.toLowerCase();
    const hits = all.filter((r) => r.name.toLowerCase().includes(lower) || r.idea.toLowerCase().includes(lower) || r.id.includes(lower));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new RobotError(`aucun robot ne correspond à « ${q} » ; les robots : ${all.map((r) => `${r.name} (${r.id})`).join(", ")}`);
    throw new RobotError(`plusieurs robots correspondent à « ${q} » : ${hits.map((r) => `${r.name} (${r.id})`).join(", ")}`);
  }

  sheet(id: string): RobotSheet {
    const row = this.row(id);
    const summary = this.toSummary(row);
    const backtests = (this.db.db.prepare("SELECT * FROM backtests WHERE robot_id = ? ORDER BY created_at").all(id) as BacktestRow[]).map((b) =>
      this.toBacktest(b),
    );
    let code: string | undefined;
    if (row.version > 0) code = this.version(id).code;
    return {
      ...summary,
      ...(row.hypothesis ? { hypothesis: row.hypothesis } : {}),
      ...(row.plan ? { plan: row.plan } : {}),
      ...(code ? { code } : {}),
      backtests,
      notes: this.notes(id),
      parents: JSON.parse(row.parents) as string[],
    };
  }

  /* ----------------------------- Backtests ----------------------------- */

  /** Enregistre un backtest et ses trades ; le compteur d'essais avance, le meilleur est revu. */
  recordBacktest(
    robotId: string,
    data: Omit<BacktestSummary, "id" | "createdAt" | "trial" | "robotId">,
    trades: readonly BacktestTrade[],
    jobId?: string,
  ): BacktestSummary {
    const row = this.row(robotId);
    const id = newId("bt").slice(0, 11);
    const at = this.now();
    const trial = row.trials + 1;
    const summary: BacktestSummary = { ...data, id, robotId, trial, createdAt: at };
    const tx = this.db.db.transaction(() => {
      this.db.db
        .prepare("INSERT INTO backtests (id, robot_id, version, job_id, trial, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, robotId, data.version, jobId ?? null, trial, JSON.stringify(summary), at);
      const ins = this.db.db.prepare("INSERT INTO backtest_trades (backtest_id, data) VALUES (?, ?)");
      for (const t of trades) ins.run(id, JSON.stringify(t));
      const best = row.best_backtest_id ? this.backtest(row.best_backtest_id) : undefined;
      const newBest = best ? betterBacktest(best, summary) : summary;
      this.db.db
        .prepare(
          "UPDATE robots SET trials = ?, best_backtest_id = ?, status = CASE WHEN status IN ('idea', 'testing') THEN 'testing' ELSE status END, updated_at = ? WHERE id = ?",
        )
        .run(trial, newBest.id, at, robotId);
    });
    tx();
    this.changed();
    return summary;
  }

  backtest(id: string): BacktestSummary | undefined {
    const row = this.db.db.prepare("SELECT * FROM backtests WHERE id = ?").get(id) as BacktestRow | undefined;
    return row ? this.toBacktest(row) : undefined;
  }

  /** Nombre de backtests faits par un travail de recherche (le budget). */
  trialsOf(jobId: string): number {
    return (this.db.db.prepare("SELECT COUNT(*) AS n FROM backtests WHERE job_id = ?").get(jobId) as { n: number }).n;
  }

  /**
   * Les trades d'un backtest, par phase : `inSample` seul pour l'agent (il ne
   * voit jamais la vérification ni le réservé en détail), tout pour l'écran.
   */
  trades(backtestId: string, opts: { phase?: "inSample" | "all" } = {}): BacktestTrade[] {
    const summary = this.backtest(backtestId);
    if (!summary) throw new RobotError(`backtest ${backtestId} inconnu`);
    const rows = this.db.db.prepare("SELECT data FROM backtest_trades WHERE backtest_id = ?").all(backtestId) as Array<{ data: string }>;
    let list = rows.map((r) => JSON.parse(r.data) as BacktestTrade);
    if ((opts.phase ?? "all") === "inSample" && summary.inEnd !== undefined) list = list.filter((t) => t.entryAt < summary.inEnd!);
    return list.sort((a, b) => a.entryAt - b.entryAt);
  }

  /** La recherche est finie : le statut suit le verdict du meilleur backtest. */
  finishResearch(robotId: string): RobotSummary {
    const row = this.row(robotId);
    const best = row.best_backtest_id ? this.backtest(row.best_backtest_id) : undefined;
    const status: RobotStatus = !best ? "rejected" : best.verdict;
    this.db.db.prepare("UPDATE robots SET status = ?, job_id = NULL, updated_at = ? WHERE id = ?").run(status, this.now(), robotId);
    this.changed();
    return this.summary(robotId)!;
  }

  /* ------------------------------- Fil ------------------------------- */

  note(robotId: string, kind: RobotNoteKind, text: string, opts: { backtestId?: string; jobId?: string } = {}): RobotNote {
    if (!ROBOT_NOTE_KINDS.includes(kind)) throw new RobotError(`genre de note inconnu : ${kind}`);
    const clean = text.trim();
    if (!clean) throw new RobotError("note vide");
    const at = this.now();
    this.db.db
      .prepare("INSERT INTO robot_notes (robot_id, at, kind, text, backtest_id, job_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(robotId, at, kind, clean.slice(0, 4000), opts.backtestId ?? null, opts.jobId ?? null);
    this.db.db.prepare("UPDATE robots SET updated_at = ? WHERE id = ?").run(at, robotId);
    if (kind !== "idea") this.changed();
    return { at, kind, text: clean, ...(opts.backtestId ? { backtestId: opts.backtestId } : {}) };
  }

  notes(robotId: string, limit = 200): RobotNote[] {
    const rows = this.db.db
      .prepare("SELECT at, kind, text, backtest_id FROM robot_notes WHERE robot_id = ? ORDER BY at, id LIMIT ?")
      .all(robotId, limit) as Array<{ at: number; kind: RobotNoteKind; text: string; backtest_id: string | null }>;
    return rows.map((r) => ({ at: r.at, kind: r.kind, text: r.text, ...(r.backtest_id ? { backtestId: r.backtest_id } : {}) }));
  }

  /* ------------------------------ Leçons ------------------------------ */

  lesson(input: { text: string; products: string[]; timeframe?: string; robotId?: string; backtestId?: string }): LabLesson {
    const text = input.text.trim();
    if (!text) throw new RobotError("leçon vide");
    const id = newId("ls").slice(0, 11);
    const at = this.now();
    this.db.db
      .prepare("INSERT INTO lab_lessons (id, text, products, timeframe, robot_id, backtest_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)")
      .run(id, text.slice(0, 1000), JSON.stringify(input.products), input.timeframe ?? null, input.robotId ?? null, input.backtestId ?? null, at);
    if (input.robotId) this.note(input.robotId, "lesson", text, { backtestId: input.backtestId });
    return {
      id,
      text,
      products: input.products,
      ...(input.timeframe ? { timeframe: input.timeframe } : {}),
      ...(input.robotId ? { robotId: input.robotId } : {}),
      ...(input.backtestId ? { backtestId: input.backtestId } : {}),
      createdAt: at,
    };
  }

  lessons(limit = 40): LabLesson[] {
    const rows = this.db.db.prepare("SELECT * FROM lab_lessons WHERE status = 'active' ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{
      id: string;
      text: string;
      products: string;
      timeframe: string | null;
      robot_id: string | null;
      backtest_id: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      products: JSON.parse(r.products) as string[],
      ...(r.timeframe ? { timeframe: r.timeframe } : {}),
      ...(r.robot_id ? { robotId: r.robot_id } : {}),
      ...(r.backtest_id ? { backtestId: r.backtest_id } : {}),
      createdAt: r.created_at,
    }));
  }

  /* ------------------------------ Interne ------------------------------ */

  private row(id: string): RobotRow {
    const row = this.db.db.prepare("SELECT * FROM robots WHERE id = ?").get(id) as RobotRow | undefined;
    if (!row) throw new RobotError(`robot ${id} inconnu`);
    return row;
  }

  private toSummary(r: RobotRow): RobotSummary {
    const best = r.best_backtest_id ? this.backtest(r.best_backtest_id) : undefined;
    return {
      id: r.id,
      name: r.name,
      idea: r.idea,
      status: r.status,
      products: JSON.parse(r.products) as string[],
      ...(r.timeframe ? { timeframe: r.timeframe } : {}),
      version: r.version,
      trials: r.trials,
      ...(best ? { best } : {}),
      ...(r.job_id ? { jobId: r.job_id } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private toBacktest(b: BacktestRow): BacktestSummary {
    return JSON.parse(b.data) as BacktestSummary;
  }

  private changed(): void {
    this.emit("changed");
  }
}

/** Un nom par défaut tiré de l'idée : sans l'article du début, coupé à un mot, 60 caractères au plus. */
export function defaultName(idea: string): string {
  const clean = idea.trim().replace(/^(une?|des?|du|la|le|les|l')\s+/i, "");
  const text = clean.charAt(0).toLocaleUpperCase("fr-FR") + clean.slice(1);
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:]+$/, "") + "…";
}
