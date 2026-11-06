/** Les travaux (agents, tâches) tels que l'écran les montre. Fonctions pures, testées à plat. */

export interface JobView {
  jobId: string;
  state: string;
  title?: string;
  summary?: string;
  pendingInstruction?: string | null;
  /** agent (lecture seule) | task (agit) */
  kind?: string;
  /** Dossier où il travaille, s'il y en a un. */
  folder?: string;
  /** Étapes faites (outils appelés) et la dernière, montrées autour de son nœud. */
  steps?: number;
  lastStep?: string;
}

/** Demande d'accord avant une action qui modifie un projet. */
export interface ApprovalView {
  approvalId: string;
  action: string;
  expiresAt: number;
}

const LABEL: Record<string, string> = {
  queued: "En file",
  running: "En cours",
  awaiting_approval: "En attente d'accord",
  succeeded: "Terminée",
  failed: "Échec",
  cancelled: "Annulée",
  unverified: "À vérifier",
};
const ACTIVE = new Set(["queued", "running", "awaiting_approval"]);

export function jobLabel(state: string): string {
  return LABEL[state] ?? state;
}

export function isActiveJob(state: string): boolean {
  return ACTIVE.has(state);
}

/**
 * Mise à jour d'un travail : il remonte en tête ; ce que le serveur ne redit
 * pas (genre, dossier) et les étapes comptées à l'écran sont conservés.
 */
export function upsertJob(list: JobView[], j: JobView): JobView[] {
  const prev = list.find((x) => x.jobId === j.jobId);
  return [
    {
      jobId: j.jobId,
      state: j.state,
      title: j.title,
      summary: j.summary,
      pendingInstruction: j.pendingInstruction ?? null,
      kind: j.kind ?? prev?.kind,
      folder: j.folder ?? prev?.folder,
      steps: prev?.steps,
      lastStep: prev?.lastStep,
    },
    ...list.filter((x) => x.jobId !== j.jobId),
  ];
}

/** Tous les travaux en cours (plusieurs projets peuvent avancer à la fois), complétés par les derniers terminés. */
export function recentJobs(jobs: JobView[]): JobView[] {
  const active = jobs.filter((j) => isActiveJob(j.state));
  return [...active, ...jobs.filter((j) => !isActiveJob(j.state))].slice(0, Math.max(3, active.length));
}

/** « Agent », « Kopilia », « Agent · Kopilia » : qui travaille, et dans quel projet. */
export function jobContext(j: JobView): string {
  return [j.kind === "agent" ? "Agent" : "", j.folder ?? ""].filter(Boolean).join(" · ");
}

/** Résumé d'une ligne : sans marques Markdown (un brief commence par « # … »). */
export function plain(s: string): string {
  return s
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
