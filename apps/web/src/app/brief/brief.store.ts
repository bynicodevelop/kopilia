import { signal } from "@angular/core";
import type { ScreenApi } from "../api";
import { renderBrief, stripBriefTitle } from "./render";
import type { BriefMeta, BriefView } from "./views";

/** Les briefs de veille vus de l'écran : le dernier (bouton « Brief »), et celui ouvert en plein écran. */
export class BriefStore {
  readonly latest = signal<BriefMeta | null>(null);
  readonly open = signal<BriefView | null>(null);

  constructor(
    private readonly api: ScreenApi,
    private readonly report: (message: string) => void,
  ) {}

  ready(b: BriefMeta): void {
    this.latest.set({ briefId: b.briefId, title: b.title, createdAt: b.createdAt });
  }

  async loadLatest(): Promise<void> {
    try {
      const b = await this.api.json<BriefMeta & { none?: boolean }>("/api/briefs/latest");
      if (!b.none) this.ready(b);
    } catch {
      /* hors ligne : réessayé à la reconnexion */
    }
  }

  /** Affiche un brief en entier (le dernier par défaut). */
  async show(briefId = this.latest()?.briefId): Promise<void> {
    if (!briefId) return;
    try {
      const b = await this.api.json<BriefMeta & { content: string }>(`/api/briefs/${encodeURIComponent(briefId)}`);
      this.open.set({ briefId: b.briefId, title: b.title, createdAt: b.createdAt, html: renderBrief(stripBriefTitle(b.content)) });
    } catch {
      this.report("Brief introuvable — réessaie dans un instant.");
    }
  }

  close(): void {
    this.open.set(null);
  }
}
