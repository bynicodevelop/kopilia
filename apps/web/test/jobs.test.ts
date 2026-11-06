import { test } from "node:test";
import assert from "node:assert/strict";
import { isActiveJob, jobContext, jobLabel, plain, recentJobs, upsertJob, type JobView } from "../src/app/jobs/jobs";
import { stripBriefTitle } from "../src/app/brief/render";

test("mise à jour d'un travail : en tête, genre, dossier et étapes conservés", () => {
  const list: JobView[] = [
    { jobId: "a", state: "running", kind: "agent", folder: "Kopilia", steps: 3, lastStep: "Recherche web" },
    { jobId: "b", state: "succeeded" },
  ];
  const next = upsertJob(list, { jobId: "a", state: "succeeded", summary: "fini" });
  assert.deepEqual(
    next.map((j) => j.jobId),
    ["a", "b"],
  );
  assert.deepEqual(next[0], {
    jobId: "a",
    state: "succeeded",
    title: undefined,
    summary: "fini",
    pendingInstruction: null,
    kind: "agent",
    folder: "Kopilia",
    steps: 3,
    lastStep: "Recherche web",
  });
  assert.deepEqual(
    upsertJob(list, { jobId: "c", state: "queued" }).map((j) => j.jobId),
    ["c", "a", "b"],
  );
});

test("travaux affichés : tous ceux en cours, puis les derniers terminés (trois au moins)", () => {
  const done = (id: string): JobView => ({ jobId: id, state: "succeeded" });
  const run = (id: string): JobView => ({ jobId: id, state: "running" });
  assert.deepEqual(
    recentJobs([done("1"), run("2"), done("3"), done("4")]).map((j) => j.jobId),
    ["2", "1", "3"],
  );
  assert.deepEqual(
    recentJobs([run("1"), run("2"), run("3"), run("4"), done("5")]).map((j) => j.jobId),
    ["1", "2", "3", "4"],
  );
});

test("travaux : libellés, contexte, résumé sans Markdown", () => {
  assert.equal(jobLabel("awaiting_approval"), "En attente d'accord");
  assert.equal(jobLabel("inconnu"), "inconnu");
  assert.equal(isActiveJob("queued"), true);
  assert.equal(isActiveJob("unverified"), false);
  assert.equal(jobContext({ jobId: "x", state: "running", kind: "agent", folder: "Kopilia" }), "Agent · Kopilia");
  assert.equal(jobContext({ jobId: "x", state: "running", kind: "task" }), "");
  assert.equal(plain("# Wrap\n**BCE** : `taux` inchangés"), "Wrap BCE : taux inchangés");
});

test("brief : la ligne de titre retirée du texte, le reste intact", () => {
  assert.equal(stripBriefTitle("# Wrap du jour\n## En bref\nRien."), "## En bref\nRien.");
  assert.equal(stripBriefTitle("## En bref\nRien."), "## En bref\nRien.", "pas de titre : rien à retirer");
});
