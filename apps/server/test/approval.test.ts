import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseService } from "../src/db/database.service.js";
import { ProjectService } from "../src/session/project.service.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { JobError, JobService, ApprovalRow, JobRow } from "../src/jobs/job.service.js";
import { SkillService } from "../src/learning/skill.service.js";
import { insertSession, tempData, type TempData } from "./harness.js";
import { JobState } from "@kopilia/contracts";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
let root: string;
let projectDir: string;
let db: DatabaseService;
let jobs: JobService;
let projects: ProjectService;
let projectId: string;

let data: TempData;

before(() => {
  data = tempData("appr", (dir) => ({
    KOPILIA_PROJECT_ROOTS: dir,
    KOPILIA_CLAUDE_BIN: resolve(REPO, "workers/_doubles/mock-claude.mjs"),
    KOPILIA_CLAUDE_MODEL: "",
    // MetaApi configuré (faux jeton) : les agents reçoivent les outils de cours, jamais ce jeton.
    KOPILIA_METAAPI_TOKEN: "jeton-metaapi-de-test",
  }));
  const { config, logger } = data;
  db = data.db;
  root = data.root;
  projectDir = join(root, "projet");
  mkdirSync(projectDir, { recursive: true });
  projects = new ProjectService(db, config);
  projectId = projects.register(projectDir, "projet").id;
  // Session parente (contrainte FK jobs.session_id -> sessions.id).
  insertSession(db, "s1", { projectId });
  jobs = new JobService(db, config, projects, new MemoryService(db, config), new SkillService(db, config), logger);
});

after(() => {
  jobs?.onModuleDestroy();
  data?.cleanup();
});

function waitJob(jobId: string, state: JobState, timeoutMs = 8000): Promise<void> {
  return new Promise((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`timeout attente ${state}`)), timeoutMs);
    const check = () => {
      if (jobs.get(jobId)?.state === state) {
        clearTimeout(deadline);
        jobs.off("job.updated", check);
        res();
      }
    };
    jobs.on("job.updated", check);
    check();
  });
}

test("tâche en lecture seule : lancée immédiatement, pas d'approbation", async () => {
  const row = jobs.start({ sessionId: "s1", folder: "projet", title: "Analyser le code", prompt: "liste les fichiers", requiresApproval: false });
  assert.equal(row.state, JobState.Running);
  await waitJob(row.id, JobState.Succeeded);
});

test("tâche modifiante : attend l'approbation, puis s'exécute sur OK", async () => {
  let approvalId = "";
  jobs.once("approval.required", (a: ApprovalRow) => (approvalId = a.id));
  const row = jobs.start({ sessionId: "s1", folder: "projet", title: "Supprimer les logs", prompt: "rm logs", requiresApproval: true });
  assert.equal(row.state, JobState.AwaitingApproval);
  assert.ok(approvalId, "approval.required non émis");
  assert.equal(jobs.get(row.id)?.state, JobState.AwaitingApproval); // pas encore exécuté

  jobs.resolveApproval(approvalId, "approve");
  await waitJob(row.id, JobState.Succeeded);
});

test("tâche modifiante refusée : action bloquée, jamais exécutée", async () => {
  let approvalId = "";
  let action = "";
  jobs.once("approval.required", (a: ApprovalRow) => {
    approvalId = a.id;
    action = a.action;
  });
  const row = jobs.start({ sessionId: "s1", folder: "projet", title: "git push", prompt: "push", requiresApproval: true });
  assert.equal(row.state, JobState.AwaitingApproval);
  assert.match(action, /git push \(dossier : .+\/projet\)/, `action : ${action}`);
  jobs.resolveApproval(approvalId, "deny");
  assert.equal(jobs.get(row.id)?.state, JobState.Cancelled);
});

test("espace de travail : les projets sont les sous-dossiers visibles", () => {
  mkdirSync(join(root, "Clients"));
  mkdirSync(join(root, ".cache"));
  mkdirSync(join(root, "Carte mentale.mindnode"));
  const names = projects.listFolders();
  assert.ok(names.includes("Clients") && names.includes("projet"), names.join(", "));
  assert.ok(!names.includes(".cache"), "dossier caché listé");
  assert.ok(!names.includes("Carte mentale.mindnode"), "paquet macOS listé comme projet");
});

test("dossier hors de l'espace de travail : refusé", () => {
  assert.throws(() => jobs.start({ sessionId: "s1", folder: "../", title: "x", prompt: "x" }), /hors de l'espace autorisé/);
});

test("dossier inexistant : refusé avec un message clair", () => {
  assert.throws(() => jobs.start({ sessionId: "s1", folder: "nexistepas", title: "x", prompt: "x" }), /dossier introuvable : nexistepas/);
});

test("sans dossier : la tâche tourne à la racine de l'espace de travail", async () => {
  const row = jobs.start({ sessionId: "s1", title: "Ranger Documents", prompt: "liste", requiresApproval: false });
  assert.equal(projects.get(row.project_id!)?.path, root);
  await waitJob(row.id, JobState.Succeeded);
});

test("« où en es-tu ? » sans jobId : renvoie la dernière tâche de la session", async () => {
  const row = jobs.start({ sessionId: "s1", folder: "projet", title: "Dernière", prompt: "ok", requiresApproval: false });
  assert.equal(jobs.latestFor("s1")?.id, row.id);
  await waitJob(row.id, JobState.Succeeded);
});

test("agent : jamais d'approbation, même s'il en demande une ; dossier neutre sans folder", async () => {
  let asked = false;
  const onApproval = () => (asked = true);
  jobs.on("approval.required", onApproval);
  const row = jobs.start({ sessionId: "s1", kind: "agent", title: "Séances", prompt: "programme", requiresApproval: true });
  jobs.off("approval.required", onApproval);
  assert.equal(row.kind, "agent");
  assert.equal(row.state, JobState.Running);
  assert.equal(row.project_id, null, "une recherche web ne travaille dans aucun projet");
  assert.ok(!asked, "un agent ne doit jamais demander d'accord");
  await waitJob(row.id, JobState.Succeeded);
});

test("agent avec dossier : il lit le projet indiqué", async () => {
  const row = jobs.start({ sessionId: "s1", kind: "agent", folder: "projet", title: "Étudier le projet", prompt: "résume" });
  assert.equal(projects.get(row.project_id!)?.path, projectDir);
  await waitJob(row.id, JobState.Succeeded);
});

test("limites séparées : 3 agents au plus, et ils ne bloquent pas une tâche", async () => {
  const agents = [1, 2, 3].map((i) => jobs.start({ sessionId: "s1", kind: "agent", title: `A${i}`, prompt: "[lent] cherche" }));
  assert.throws(() => jobs.start({ sessionId: "s1", kind: "agent", title: "A4", prompt: "x" }), /déjà 3 agents/);
  const task = jobs.start({ sessionId: "s1", folder: "projet", title: "Tâche", prompt: "ok" });
  assert.equal(task.state, JobState.Running);
  await Promise.all([...agents, task].map((j) => waitJob(j.id, JobState.Succeeded)));
});

test("plusieurs projets en même temps : une tâche par projet, trois au plus", async () => {
  for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) mkdirSync(join(root, name), { recursive: true });
  const alpha = jobs.start({ sessionId: "s1", folder: "Alpha", title: "Tests d'Alpha", prompt: "[lent] ok" });
  const beta = jobs.start({ sessionId: "s1", folder: "Beta", title: "Tests de Beta", prompt: "[lent] ok" });
  assert.equal(beta.state, JobState.Running, "un autre projet avance en parallèle");
  assert.equal(jobs.folderOf(beta), "Beta");
  assert.throws(
    () => jobs.start({ sessionId: "s1", folder: "Alpha", title: "Doublon", prompt: "x" }),
    /déjà en cours dans .+\/Alpha \(« Tests d'Alpha »\)/,
    "jamais deux ouvriers dans le même projet",
  );
  assert.throws(() => jobs.start({ sessionId: "s1", title: "Ranger Documents", prompt: "x" }), /déjà en cours/, "Documents contient les projets en cours");
  // En attente d'accord, une tâche garde aussi sa place.
  const gamma = jobs.start({ sessionId: "s1", folder: "Gamma", title: "Push de Gamma", prompt: "x", requiresApproval: true });
  assert.equal(gamma.state, JobState.AwaitingApproval);
  assert.throws(() => jobs.start({ sessionId: "s1", folder: "Delta", title: "Quatrième", prompt: "x" }), /déjà 3 tâches en cours/);
  jobs.cancel(gamma.id);
  await Promise.all([alpha, beta].map((j) => waitJob(j.id, JobState.Succeeded)));
  const again = jobs.start({ sessionId: "s1", folder: "Alpha", title: "Alpha, la suite", prompt: "ok" });
  assert.equal(again.state, JobState.Running, "le projet est libre une fois sa tâche finie");
  await waitJob(again.id, JobState.Succeeded);
});

test("fin d'un travail : rapporté par Kopilia, sauf s'il a été annulé par l'utilisateur", async () => {
  const finished: Array<{ job: JobRow; announce: boolean }> = [];
  const onFinished = (e: { job: JobRow; announce: boolean }) => finished.push(e);
  jobs.on("job.finished", onFinished);
  const done = jobs.start({ sessionId: "s1", kind: "agent", title: "Rapide", prompt: "ok" });
  await waitJob(done.id, JobState.Succeeded);
  const cancelled = jobs.start({ sessionId: "s1", kind: "agent", title: "Annulé", prompt: "[lent] long" });
  jobs.cancel(cancelled.id);
  await new Promise((r) => setTimeout(r, 300));
  jobs.off("job.finished", onFinished);

  const ok = finished.find((e) => e.job.id === done.id);
  assert.ok(ok?.announce, "un résultat doit être rapporté");
  assert.match(ok!.job.summary ?? "", /Bien reçu : ok/, "le résultat final de l'agent est conservé");
  const stopped = finished.filter((e) => e.job.id === cancelled.id);
  assert.equal(stopped.length, 1, "une seule fin, même si le processus sort ensuite");
  assert.equal(stopped[0].announce, false, "une annulation ne se rapporte pas");
});

test("agent : recettes et cours MetaApi par le serveur « kopilia », avec un jeton de lecture ; un ouvrier non", async () => {
  const agent = jobs.start({ sessionId: "s1", kind: "agent", title: "Outils de l'agent", prompt: "[outils]" });
  const task = jobs.start({ sessionId: "s1", folder: "projet", title: "Outils de l'ouvrier", prompt: "[outils]" });
  await Promise.all([waitJob(agent.id, JobState.Succeeded), waitJob(task.id, JobState.Succeeded)]);
  const tools = jobs.get(agent.id)!.summary ?? "";
  assert.match(tools, /mcp__kopilia__skill_view mcp__kopilia__market_price mcp__kopilia__market_history/);
  assert.match(
    tools,
    /Serveurs MCP : kopilia \(KOPILIA_INTERNAL_URL, KOPILIA_AGENT_TOKEN, KOPILIA_MARKET_TOOLS\)\./,
    "ni le jeton interne, ni le jeton MetaApi",
  );
  assert.match(jobs.get(task.id)!.summary ?? "", /Outils : aucun\.\nServeurs MCP : aucun\./);
});

test("trace d'un agent : sa consigne, chaque outil visé et ses erreurs, pour l'apprentissage", async () => {
  const agent = jobs.start({ sessionId: "s1", kind: "agent", title: "Horaires du cinéma", prompt: "Trouve les séances [trace]" });
  await waitJob(agent.id, JobState.Succeeded);
  const row = jobs.get(agent.id)!;
  assert.equal(row.prompt, "Trouve les séances [trace]");
  assert.deepEqual(jobs.trace(row), [
    { tool: "WebFetch", detail: "https://cinema.example/horaires", error: "Request failed with status code 403" },
    { tool: "Bash", detail: "curl -sL https://cinema.example/horaires" },
  ]);
});

test("consigne ajoutée pendant le travail : transmise à l'agent avant la fin, puis effacée", async () => {
  const row = jobs.start({ sessionId: "s1", kind: "agent", title: "Recherche", prompt: "[lent] cherche les cours" });
  await new Promise((r) => setTimeout(r, 200));
  jobs.instruct(row.id, "ajoute le DAX");
  jobs.instruct(row.id, "et le CAC");
  assert.equal(jobs.get(row.id)?.pending_instruction, "ajoute le DAX\net le CAC", "deux consignes : aucune n'écrase l'autre");
  await waitJob(row.id, JobState.Succeeded);
  const done = jobs.get(row.id)!;
  assert.match(String(done.summary), /ajoute le DAX/, "le résultat tient compte de la consigne");
  assert.equal(done.pending_instruction, null, "plus rien en attente à l'écran");
});

test("consigne sur un travail terminé ou inconnu : refusée clairement, rien n'est stocké", async () => {
  const row = jobs.start({ sessionId: "s1", kind: "agent", title: "Rapide", prompt: "x" });
  await waitJob(row.id, JobState.Succeeded);
  assert.throws(
    () => jobs.instruct(row.id, "trop tard"),
    (e: unknown) => e instanceof JobError && /terminé/.test((e as Error).message),
  );
  assert.equal(jobs.get(row.id)?.pending_instruction, null);
  assert.throws(() => jobs.instruct("job_inconnu", "x"), JobError);
  assert.throws(() => jobs.cancel("job_inconnu"), JobError);
});
