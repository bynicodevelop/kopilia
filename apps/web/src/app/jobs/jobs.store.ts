import { signal } from "@angular/core";
import { ApprovalView, JobView, upsertJob } from "./jobs";

/** Message vers le serveur (le WebSocket de la session). */
type Send = (body: Record<string, unknown>) => void;

/** Les travaux de la conversation (agents, tâches) et les accords demandés, vus de l'écran. */
export class JobsStore {
  readonly jobs = signal<JobView[]>([]);
  readonly approvals = signal<ApprovalView[]>([]);

  constructor(private readonly send: Send) {}

  updated(job: JobView): void {
    this.jobs.update((list) => upsertJob(list, job));
  }

  /** Une étape de plus pour ce travail (un outil appelé), montrée autour de son nœud. */
  step(jobId: string, label: string): void {
    this.jobs.update((list) => list.map((j) => (j.jobId === jobId ? { ...j, steps: (j.steps ?? 0) + 1, lastStep: label } : j)));
  }

  approvalRequired(a: ApprovalView): void {
    this.approvals.update((list) => [...list, { approvalId: a.approvalId, action: a.action, expiresAt: a.expiresAt }]);
  }

  command(command: "status" | "cancel" | "instruct", jobId?: string, note?: string): void {
    this.send({ type: "job.command", command, jobId, note });
  }

  resolveApproval(approvalId: string, decision: "approve" | "deny"): void {
    this.send({ type: "approval.resolve", approvalId, decision });
    this.approvals.update((a) => a.filter((x) => x.approvalId !== approvalId));
  }
}
