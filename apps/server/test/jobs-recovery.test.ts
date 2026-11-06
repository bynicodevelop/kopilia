// JobService face aux arrêts et aux lancements ratés : aucun travail ne reste
// « en cours » sans processus derrière (quotas bloqués, nœud éternel à l'écran).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { JobState } from "@kopilia/contracts";
import { ProjectService } from "../src/session/project.service.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { SkillService } from "../src/learning/skill.service.js";
import { JobService, type JobRow } from "../src/jobs/job.service.js";
import { insertSession, tempData } from "./harness.js";
import { ensureSystemSession } from "../src/session/system-session.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..");

function jobsOn(bin = resolve(REPO, "workers/_doubles/mock-claude.mjs")) {
  const data = tempData("jobs", (dir) => ({ KOPILIA_PROJECT_ROOTS: dir, KOPILIA_CLAUDE_BIN: bin, KOPILIA_CLAUDE_MODEL: "" }));
  const { db, config, logger } = data;
  insertSession(db, "s1");
  const jobs = new JobService(db, config, new ProjectService(db, config), new MemoryService(db, config), new SkillService(db, config), logger);
  return { data, jobs, db };
}

function insertJob(db: ReturnType<typeof jobsOn>["db"], id: string, state: string, kind = "agent") {
  db.db
    .prepare("INSERT INTO jobs (id, session_id, kind, title, state, created_at, updated_at) VALUES (?, 's1', ?, ?, ?, 1, 1)")
    .run(id, kind, `travail ${id}`, state);
}

test("redémarrage : les travaux restés en cours passent « à vérifier », les approbations expirent", () => {
  const { data, jobs, db } = jobsOn();
  try {
    insertJob(db, "j_run", "running");
    insertJob(db, "j_queue", "queued");
    insertJob(db, "j_wait", "awaiting_approval", "task");
    insertJob(db, "j_done", "succeeded");
    db.db
      .prepare(
        "INSERT INTO approvals (id, job_id, session_id, action, state, expires_at, created_at) VALUES ('a1', 'j_wait', 's1', 'écrire', 'pending', 9e15, 1)",
      )
      .run();
    jobs.onModuleInit();
    const state = (id: string) => (jobs.get(id) as JobRow).state;
    assert.equal(state("j_run"), JobState.Unverified);
    assert.equal(state("j_queue"), JobState.Unverified);
    assert.equal(state("j_wait"), JobState.Cancelled);
    assert.equal(state("j_done"), JobState.Succeeded, "un travail terminé ne bouge pas");
    assert.match(String(jobs.get("j_run")?.summary), /redémarrage/);
    assert.equal((db.db.prepare("SELECT state FROM approvals WHERE id = 'a1'").get() as { state: string }).state, "expired");
    assert.equal(jobs.activeFor("s1"), undefined, "plus rien ne compte comme en cours");
  } finally {
    jobs.onModuleDestroy();
    data.cleanup();
  }
});

test("lancement impossible (claude introuvable) : le travail échoue, il ne reste pas en cours", { timeout: 8_000 }, async () => {
  const { data, jobs } = jobsOn("/chemin/inexistant/claude");
  try {
    const finished = new Promise<JobRow>((res) => jobs.once("job.finished", (e: { job: JobRow }) => res(e.job)));
    const job = jobs.start({ sessionId: "s1", title: "recherche", prompt: "cherche", kind: "agent" });
    const done = await finished;
    assert.equal(done.id, job.id);
    assert.equal(done.state, JobState.Failed);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((jobs as unknown as { workers: Map<string, unknown> }).workers.size, 0, "aucun processus fantôme suivi");
  } finally {
    jobs.onModuleDestroy();
    data.cleanup();
  }
});

test("lancement qui lève (préparation du dossier, du calendrier…) : le travail échoue aussitôt", () => {
  const { data, jobs } = jobsOn();
  try {
    (jobs as unknown as { spawnWorker: () => void }).spawnWorker = () => {
      throw new Error("disque plein");
    };
    const updates: JobRow[] = [];
    jobs.on("job.updated", (row: JobRow) => updates.push(row));
    const job = jobs.start({ sessionId: "s1", title: "recherche", prompt: "cherche", kind: "agent" });
    assert.equal(jobs.get(job.id)?.state, JobState.Failed);
    assert.match(String(jobs.get(job.id)?.summary), /disque plein/);
    assert.equal(updates.at(-1)?.state, JobState.Failed, "le dernier état montré à l'écran est l'échec");
  } finally {
    jobs.onModuleDestroy();
    data.cleanup();
  }
});

test("activité : les travaux de l'utilisateur, toutes conversations confondues, sans les sessions système ; ceux en cours d'abord", () => {
  const { data, jobs, db } = jobsOn();
  try {
    insertSession(db, "s2");
    ensureSystemSession(db, "sess_setups");
    const now = Date.now();
    const put = (id: string, session: string, state: string, updated: number) =>
      db.db
        .prepare("INSERT INTO jobs (id, session_id, kind, title, state, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?, ?, ?)")
        .run(id, session, `travail ${id}`, state, updated, updated);
    put("j_old", "s1", "succeeded", now - 30 * 3_600_000);
    put("j_done", "s1", "succeeded", now - 60_000);
    put("j_other", "s2", "failed", now - 120_000);
    put("j_run", "s2", "running", now - 40 * 3_600_000);
    put("j_pass", "sess_setups", "succeeded", now - 1000);
    assert.deepEqual(
      jobs.recentForUser(now - 24 * 3_600_000, 8).map((j) => j.id),
      ["j_run", "j_done", "j_other"],
      "en cours d'abord (même ancien), puis les récents de toutes les conversations ; ni la passe système ni le travail d'avant-hier",
    );
    assert.deepEqual(
      jobs.recentForUser(now - 24 * 3_600_000, 2).map((j) => j.id),
      ["j_run", "j_done"],
    );
  } finally {
    data.cleanup();
  }
});
