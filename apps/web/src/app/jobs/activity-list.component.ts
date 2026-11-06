import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from "@angular/core";
import type { ActivityItem } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { dateFormat, formatDateTime } from "../format";
import { activityRows, readable } from "./activity";

/** L'activité est aussi relue à ce rythme, au cas où un signal se serait perdu (reconnexion). */
const REFRESH_MS = 60_000;

/**
 * L'encart Activité : les agents et tâches récents, toutes conversations
 * confondues, présentés comme la liste de surveillance (le titre, l'heure,
 * l'état). Un clic sur une ligne déplie son résultat, ou sa dernière étape en
 * cours de route ; le reste se dit à la voix (« annule l'agent », « qu'est-ce
 * qu'il a trouvé ? »). Lu sur le serveur, complété en direct par les travaux
 * de cet écran ; ne touche ni aux avis ni à la galaxie.
 */
@Component({
  selector: "kp-activity-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      ul { list-style: none; margin: 6px 0 4px; padding: 0; max-height: calc(100vh - 160px); overflow-y: auto; }
      li { border-top: 1px solid var(--border); }
      .row {
        width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 5px 0; text-align: left;
        border: none; border-radius: 0; background: none; color: var(--text); font-size: 14px;
      }
      .row:hover .name { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .where { font-size: 12px; color: var(--muted); margin-left: 4px; }
      .at { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .state { font-size: 12px; min-width: 64px; text-align: right; color: var(--muted); white-space: nowrap; }
      .state.active { color: var(--accent); }
      .state.wait { color: var(--warn); }
      .state.fail { color: var(--danger); }
      .result { margin: 0 0 8px; font-size: 13px; color: var(--muted); white-space: pre-line; overflow-wrap: anywhere; max-height: 40vh; overflow-y: auto; }
      .empty { margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
    `,
  ],
  template: `
    @if (rows().length) {
      <ul>
        @for (j of rows(); track j.jobId) {
          <li>
            <button type="button" class="row" [attr.aria-expanded]="open() === j.jobId" [attr.title]="open() === j.jobId ? 'Replier' : 'Déplier'" (click)="toggle(j.jobId)">
              <span class="name"
                >{{ j.title }}<span class="where">{{ j.kind === 'agent' ? 'agent' : 'tâche' }}@if (j.folder) { · {{ j.folder }} }</span></span
              >
              <span class="at">{{ at(j.updatedAt) }}</span>
              <span class="state" [class.active]="j.state === 'running' || j.state === 'queued'" [class.wait]="j.state === 'awaiting_approval'" [class.fail]="failed(j)">{{ label(j) }}</span>
            </button>
            @if (open() === j.jobId) {
              <p class="result">{{ detail(j) }}</p>
            }
          </li>
        }
      </ul>
    } @else {
      <p class="empty">Aucun agent ni tâche récents. Dis « mets un agent sur… » pour en lancer un.</p>
    }
  `,
})
export class ActivityListComponent {
  readonly kopilia = inject(KopiliaService);
  /** Lus sur le serveur. */
  private readonly loaded = signal<ActivityItem[]>([]);
  /** La ligne dépliée. */
  readonly open = signal<string | null>(null);
  /** Lus sur le serveur, complétés par les travaux de cet écran (leur état et leur étape, à jour). */
  readonly rows = computed(() => activityRows(this.loaded(), this.kopilia.jobs()));

  constructor() {
    const load = () =>
      this.kopilia.activity().then(
        (items) => this.loaded.set(items),
        () => undefined,
      );
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // Un travail de cet écran change d'état : relu aussitôt (son résultat complet vient du serveur).
    // Un travail a changé, dans n'importe quelle conversation : relu aussitôt (son résultat complet vient du serveur).
    let seen = this.kopilia.activityChanged();
    effect(() => {
      const n = this.kopilia.activityChanged();
      if (n === seen) return;
      seen = n;
      untracked(() => void load());
    });
  }

  toggle(id: string): void {
    this.open.update((o) => (o === id ? null : id));
  }

  label(j: ActivityItem): string {
    return LABEL[j.state] ?? j.state;
  }

  failed(j: ActivityItem): boolean {
    return j.state === "failed" || j.state === "cancelled" || j.state === "unverified";
  }

  /** Le résultat, sans les marques Markdown ; en cours, la dernière étape. */
  detail(j: ActivityItem & { lastStep?: string }): string {
    if (j.state === "running" || j.state === "queued") return j.lastStep ? `En cours : ${j.lastStep}` : "En cours…";
    return j.summary ? readable(j.summary) : "Pas de résultat écrit.";
  }

  /** L'heure seule aujourd'hui, la date sinon. */
  at(ms: number): string {
    return new Date(ms).toDateString() === new Date().toDateString()
      ? dateFormat("clock", { hour: "2-digit", minute: "2-digit" }).format(ms)
      : formatDateTime(ms);
  }
}

const LABEL: Record<string, string> = {
  queued: "en file",
  running: "en cours",
  awaiting_approval: "ton accord",
  succeeded: "terminé",
  failed: "échec",
  cancelled: "annulé",
  unverified: "à vérifier",
};
