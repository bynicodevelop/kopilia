// Messages de la passerelle construits depuis les lignes en base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serverMessage } from "@kopilia/contracts";
import { approvalRequired, briefReport, jobReport, jobUpdated, learningReport } from "../src/gateway/messages.js";
import type { ApprovalRow, JobRow } from "../src/jobs/job.service.js";
import type { BriefRow } from "../src/veille/brief.service.js";
import type { SkillRow } from "../src/learning/skill.service.js";

const env = { v: 1, eventId: "e", sessionId: "s", ts: 1 };
const job = {
  id: "job_1",
  session_id: "s",
  kind: "agent",
  project_id: "proj_1",
  title: "Recherche",
  state: "running",
  summary: null,
  pending_instruction: "ajoute le DAX",
} as unknown as JobRow;

test("état d'un travail : complet (genre, projet, consigne en attente) et conforme au protocole", () => {
  const body = jobUpdated(job, "Kopilia");
  assert.deepEqual(body, {
    type: "job.updated",
    jobId: "job_1",
    state: "running",
    projectId: "proj_1",
    folder: "Kopilia",
    title: "Recherche",
    summary: undefined,
    pendingInstruction: "ajoute le DAX",
    kind: "agent",
  });
  assert.ok(serverMessage.safeParse({ ...env, ...JSON.parse(JSON.stringify(body)) }).success);
});

test("demande d'accord : conforme au protocole", () => {
  const a = { id: "appr_1", job_id: "job_1", session_id: "s", action: "écrire", project_id: null, expires_at: 99, state: "pending" } as ApprovalRow;
  const body = approvalRequired(a);
  assert.equal(body.type, "approval.required");
  assert.ok(serverMessage.safeParse({ ...env, ...JSON.parse(JSON.stringify(body)) }).success);
});

test("rapports : un tour par travail, par brief, par lot de recettes (identifiants stables : pas de doublon)", () => {
  assert.equal(jobReport(job).turnId, "agent_job_1");
  const brief = { id: "brief_1", job_id: "job_9", title: "Wrap", content: "## En bref\nRien.", spoken: "Rien.", created_at: 1, trigger: "manual" } as BriefRow;
  assert.deepEqual({ ...briefReport(brief), prompt: "" }, { turnId: "brief_brief_1", jobId: "job_9", title: "Wrap", prompt: "", briefId: "brief_1" });
  const skills = [
    { id: "sk_1", name: "donner-un-cours", run_id: "run_1", reason: "demandé", version: 1 },
    { id: "sk_2", name: "brief", run_id: "run_1", reason: "précisé", version: 2 },
  ] as SkillRow[];
  const r = learningReport(skills);
  assert.equal(r.turnId, "learning_sk_1_sk_2");
  assert.equal(r.jobId, "run_1");
  assert.deepEqual(r.skillIds, ["sk_1", "sk_2"]);
});
