import { signal } from "@angular/core";
import type { ScreenApi } from "../api";
import type { LearningView } from "./views";

/** Durée d'affichage de « Kopilia a retenu… » après une relecture. */
const NOTE_MS = 15_000;

/** La mémoire de Kopilia vue de l'écran : propositions en attente, ce qu'il vient de retenir, la feuille Mémoire. */
export class LearningStore {
  /** Recettes proposées par la relecture, en attente de l'utilisateur. */
  readonly pending = signal(0);
  /** Ce que Kopilia vient de retenir (affiché un moment, discrètement). */
  readonly note = signal<string | null>(null);
  /** Mémoire affichée en plein écran. */
  readonly open = signal<LearningView | null>(null);
  private noteTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly api: ScreenApi,
    private readonly report: (message: string) => void,
  ) {}

  /** Relecture ou rangement terminé : ce qui a été retenu, et ce qui attend. */
  updated(run: { pending: number; summary: string; changes: number }): void {
    this.pending.set(run.pending);
    const summary = run.summary || "";
    if (run.changes > 0 && summary) {
      this.note.set(summary);
      clearTimeout(this.noteTimer);
      this.noteTimer = setTimeout(() => this.note.set(null), NOTE_MS);
    }
    if (this.open()) void this.load(true);
  }

  /** Recharge la mémoire ; `show` : l'affiche (sinon met seulement à jour le nombre de propositions). */
  async load(show: boolean): Promise<void> {
    try {
      const view = await this.api.json<LearningView>("/api/learning");
      this.pending.set(view.skills.filter((s) => s.state === "draft").length);
      if (show) this.open.set(view);
    } catch {
      if (show) this.report("Mémoire indisponible — réessaie dans un instant.");
    }
  }

  close(): void {
    this.open.set(null);
  }

  /** Une action sur la mémoire (recette, souvenir, relecture), puis la mémoire relue. */
  async action(path: string, method: string): Promise<void> {
    try {
      await this.api.json(`/api/learning${path}`, method);
    } catch (e) {
      this.report((e as Error).message);
    }
    await this.load(!!this.open());
  }
}
