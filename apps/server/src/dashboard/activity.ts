import type { ActivityItem } from "@kopilia/contracts";
import type { JobRow } from "../jobs/job.service.js";

/** L'activité montre les travaux de moins de ce temps (et tous ceux en cours). */
export const ACTIVITY_MS = 24 * 3_600_000;
/** Lignes de l'activité, au plus. */
export const ACTIVITY_MAX = 8;

/** Un travail tel que l'encart Activité le montre. */
export function activityItem(j: JobRow, folder?: string): ActivityItem {
  return {
    jobId: j.id,
    state: j.state,
    kind: j.kind === "agent" ? "agent" : "task",
    title: j.title,
    ...(j.summary ? { summary: j.summary } : {}),
    ...(folder ? { folder } : {}),
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

/** Une ligne pour Kopilia : « Euro-yen, structure acheteuse (agent, terminé à 16:42) ». */
export function activityLine(j: JobRow, folder?: string): string {
  const state: Record<string, string> = {
    queued: "en attente",
    running: "en cours",
    awaiting_approval: "attend ton accord",
    succeeded: "terminé",
    failed: "échoué",
    cancelled: "annulé",
    unverified: "interrompu",
  };
  const at = new Date(j.updated_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  return `${j.title} (${j.kind === "agent" ? "agent" : "tâche"}${folder ? ` dans ${folder}` : ""}, ${state[j.state] ?? j.state} à ${at})`;
}
