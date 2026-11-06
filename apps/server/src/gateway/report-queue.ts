import type { Conn } from "./conn.js";
import type { Report } from "./messages.js";

/** Délai avant que Kopilia rapporte un résultat une fois la conversation au repos (ms). */
export const REPORT_DELAY_MS = 400;

export interface ReportHooks {
  /** La conversation est occupée : réponse en cours, utilisateur qui parle, micro coupé. */
  busy(conn: Conn): boolean;
  /** La connexion est toujours ouverte. */
  alive(conn: Conn): boolean;
  /** Kopilia dit ce rapport (un tour de dialogue à lui). */
  run(conn: Conn, report: Report): void;
}

/**
 * Ce que Kopilia a à rapporter de lui-même (résultats d'agents, briefs, recettes
 * proposées, alertes), par conversation. Il ne coupe jamais la conversation :
 * un rapport part après un court repos, et attend tant qu'elle est occupée ;
 * la passerelle relance `schedule` à la fin de chaque activité. Un rapport
 * urgent (une alerte) passe devant les autres, après les urgents déjà là.
 */
export class ReportQueue {
  private readonly queues = new Map<string, Report[]>();
  private readonly timers = new Map<Conn, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly hooks: ReportHooks,
    private readonly delayMs = REPORT_DELAY_MS,
  ) {}

  /** Ajoute un rapport (une seule fois par tour) et programme le prochain. */
  add(conn: Conn, report: Report): void {
    const queue = this.queues.get(conn.sessionId) ?? [];
    if (queue.some((r) => r.turnId === report.turnId)) return;
    const before = report.urgent ? queue.findIndex((r) => !r.urgent) : -1;
    if (before >= 0) queue.splice(before, 0, report);
    else queue.push(report);
    this.queues.set(conn.sessionId, queue);
    this.schedule(conn);
  }

  /** Programme le prochain rapport en attente de cette conversation, après un court repos. */
  schedule(conn: Conn): void {
    if (this.stopped || this.timers.has(conn) || !this.queues.get(conn.sessionId)?.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(conn);
      if (!this.hooks.alive(conn) || this.hooks.busy(conn)) return; // relancé à la fin de l'activité
      const queue = this.queues.get(conn.sessionId);
      // Un rapport périmé (une news qui n'est plus fraîche) n'est plus dit.
      let report = queue?.shift();
      while (report?.expiresAt !== undefined && report.expiresAt < Date.now()) report = queue?.shift();
      if (report) this.hooks.run(conn, report);
    }, this.delayMs);
    timer.unref();
    this.timers.set(conn, timer);
  }

  /** Les rapports en attente d'une conversation. */
  pending(sessionId: string): readonly Report[] {
    return this.queues.get(sessionId) ?? [];
  }

  /** La connexion se ferme : son rapport programmé ne partira pas (la file de la session reste). */
  forget(conn: Conn): void {
    clearTimeout(this.timers.get(conn));
    this.timers.delete(conn);
  }

  /** Plus aucun écran sur cette session : ses rapports en attente sont abandonnés. */
  dropSession(sessionId: string): void {
    this.queues.delete(sessionId);
  }

  /** Arrêt du serveur : plus rien ne part. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
