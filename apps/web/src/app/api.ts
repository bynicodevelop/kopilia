/** La session de l'écran : remise à l'amorçage, exigée par toute l'API /api. */
export interface ScreenSession {
  sessionId: string;
  token: string;
}

/**
 * Client de l'API de l'écran (même origine) : la session en en-têtes, et une
 * réponse en erreur qui lève avec le message du serveur. Un seul endroit pour
 * ce que mémoire, tableau de bord, briefs et documents recopiaient chacun.
 */
export class ScreenApi {
  constructor(private readonly session: () => ScreenSession) {}

  /** Requête brute (un fichier déposé…), avec la session du moment ou celle donnée. */
  fetch(path: string, init: RequestInit = {}, session = this.session()): Promise<Response> {
    const headers = { "x-session-id": session.sessionId, "x-session-token": session.token, ...(init.headers as Record<string, string> | undefined) };
    return fetch(path, { ...init, headers });
  }

  /** Requête JSON ; une réponse en erreur lève avec le message du serveur. */
  async json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await this.fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new Error(data.message ?? `refusé (${res.status})`);
    return data as T;
  }
}
