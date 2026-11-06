import type { ActivityItem, JobState } from "@kopilia/contracts";
import { isActiveJob, type JobView } from "./jobs";

/** Lignes de l'activité, au plus (comme le serveur). */
const MAX_ROWS = 8;

/** Une ligne de l'activité, avec la dernière étape d'un travail de cet écran. */
export type ActivityRow = ActivityItem & { lastStep?: string };

/**
 * L'activité lue sur le serveur, complétée par les travaux de cet écran : leur
 * état et leur étape à jour, et ceux qui viennent de démarrer avant la
 * prochaine lecture. Ceux en cours d'abord, puis les plus récents.
 */
export function activityRows(loaded: readonly ActivityItem[], live: readonly JobView[], now = Date.now()): ActivityRow[] {
  const byId = new Map<string, ActivityRow>(loaded.map((j) => [j.jobId, { ...j }]));
  for (const j of live) {
    const known = byId.get(j.jobId);
    if (known) {
      byId.set(j.jobId, {
        ...known,
        state: j.state as JobState,
        ...(j.summary ? { summary: known.summary && known.summary.length > j.summary.length ? known.summary : j.summary } : {}),
        ...(j.lastStep ? { lastStep: j.lastStep } : {}),
      });
    } else if (isActiveJob(j.state)) {
      byId.set(j.jobId, {
        jobId: j.jobId,
        state: j.state as JobState,
        kind: j.kind === "task" ? "task" : "agent",
        title: j.title || (j.kind === "task" ? "Tâche" : "Agent"),
        ...(j.folder ? { folder: j.folder } : {}),
        ...(j.lastStep ? { lastStep: j.lastStep } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return [...byId.values()].sort((a, b) => Number(isActiveJob(b.state)) - Number(isActiveJob(a.state)) || b.updatedAt - a.updatedAt).slice(0, MAX_ROWS);
}

/** Un résultat lisible : sans marques Markdown (titres, gras, code, citations), les retours à la ligne gardés. */
export function readable(text: string): string {
  return text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
