import { signal } from "@angular/core";
import type { ScreenApi, ScreenSession } from "../api";
import { DocView, MAX_DOCUMENT_BYTES, formatSize } from "./documents";

/** Les documents déposés : envoyés au serveur tout de suite, ils partent avec la prochaine phrase. */
export class DocumentsStore {
  readonly documents = signal<DocView[]>([]);

  constructor(
    private readonly api: ScreenApi,
    private readonly session: () => ScreenSession,
    private readonly online: () => boolean,
    private readonly report: (message: string) => void,
  ) {}

  /** Dépose des fichiers : ils partiront avec ta prochaine phrase, qui dira quoi en faire. */
  add(files: File[]): void {
    for (const file of files) void this.upload(file);
  }

  /** Partis avec une phrase : ils quittent l'attente. */
  sent(documentIds: string[]): void {
    const ids = new Set(documentIds);
    this.documents.update((list) => list.filter((d) => !d.documentId || !ids.has(d.documentId)));
  }

  /** La conversation est perdue : les documents en attente aussi. Vrai s'il y en avait. */
  drop(): boolean {
    if (!this.documents().length) return false;
    this.documents.set([]);
    return true;
  }

  /** Retire un document déposé avant de l'avoir envoyé. */
  remove(localId: string): void {
    const doc = this.documents().find((d) => d.localId === localId);
    this.documents.update((list) => list.filter((d) => d.localId !== localId));
    if (doc?.documentId) void this.deleteRemote(doc.documentId, this.session());
  }

  private async upload(file: File): Promise<void> {
    if (file.size > MAX_DOCUMENT_BYTES) {
      this.report(`« ${file.name} » est trop lourd : ${formatSize(MAX_DOCUMENT_BYTES)} au plus.`);
      return;
    }
    if (!this.online()) {
      this.report("Kopilia est hors ligne — dépose le document une fois reconnecté.");
      return;
    }
    const localId = crypto.randomUUID();
    // La session du dépôt : un retrait pendant l'envoi s'adresse à elle, même après une reconnexion.
    const session = this.session();
    this.documents.update((list) => [...list, { localId, name: file.name, size: file.size, status: "uploading" }]);
    try {
      const res = await this.api.fetch(
        "/api/documents",
        { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file },
        session,
      );
      const body = (await res.json().catch(() => ({}))) as { documentId?: string; pages?: number | null; inline?: boolean; message?: string };
      if (!res.ok || !body.documentId) throw new Error(body.message ?? `envoi refusé (${res.status})`);
      if (!this.documents().some((d) => d.localId === localId)) {
        // Retiré pendant l'envoi : il ne doit pas partir avec la phrase suivante.
        void this.deleteRemote(body.documentId, session);
        return;
      }
      const { documentId, pages, inline } = body;
      this.documents.update((list) => list.map((d) => (d.localId === localId ? { ...d, documentId, pages, inline, status: "ready" } : d)));
    } catch (e) {
      this.documents.update((list) => list.filter((d) => d.localId !== localId));
      this.report(`« ${file.name} » n'a pas pu être joint : ${(e as Error).message}`);
    }
  }

  private async deleteRemote(documentId: string, session: ScreenSession): Promise<void> {
    try {
      await this.api.fetch(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }, session);
    } catch {
      /* hors ligne : la conversation, et ce document avec elle, est de toute façon terminée */
    }
  }
}
