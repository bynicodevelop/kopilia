import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import type { LearningChangeView, LearningRunView, SkillCardView } from "./views";
import { renderBrief } from "../brief/render";
import { formatDateTime } from "../format";

const AUDIENCE: Record<string, string> = { dialogue: "Dialogue", agents: "Agents", all: "Dialogue et agents" };
const STORE: Record<string, string> = { profile: "profil", environment: "environnement", trading: "façon de trader" };

/**
 * La mémoire de Kopilia en plein écran : les recettes qu'il propose d'adopter,
 * ses deux carnets (profil, environnement), ses recettes suivies, et le
 * journal de ce qu'il a retenu, avec de quoi oublier ou défaire.
 */
@Component({
  selector: "kp-memory-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /* Le calque n'existe que panneau ouvert : fermé, il ne couvre rien. */
      .sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto; }
      .inner { max-width: 760px; margin: 0 auto; padding: 0 16px 56px; }
      header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 18px 0 12px; background: var(--bg); border-bottom: 1px solid var(--border); }
      h1 { font-size: 18px; margin: 0; flex: 1; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 28px 0 10px; display: flex; align-items: center; gap: 10px; }
      h2 small { text-transform: none; letter-spacing: 0; font-weight: normal; }
      .icon { border: none; background: none; color: inherit; padding: 0 4px; font-size: 22px; line-height: 1; }
      .small { padding: 4px 10px; font-size: 13px; border-radius: 8px; }
      .note { color: var(--muted); font-size: 14px; margin: 6px 0; }
      .card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 12px 14px; margin: 8px 0; }
      .card.pending { border-color: var(--warn); }
      .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .name { font-weight: 600; }
      .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
      .tag.warn { color: var(--warn); }
      .spacer { flex: 1; }
      .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .reason { margin: 6px 0 0; font-size: 14px; }
      details { margin-top: 8px; }
      summary { cursor: pointer; color: var(--accent); font-size: 13px; }
      .body { font-size: 14px; margin-top: 6px; }
      .bar { height: 4px; border-radius: 2px; background: var(--panel-2); flex: 0 0 120px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: var(--accent-2); }
      .bar.full > i { background: var(--warn); }
      ul.entries { list-style: none; padding: 0; margin: 0; }
      ul.entries li { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
      ul.entries li span { flex: 1; }
      .run { font-size: 14px; padding: 8px 0; border-bottom: 1px solid var(--border); }
      .run time { color: var(--muted); font-size: 12px; margin-right: 6px; }
      .run ul { margin: 4px 0 0; padding-left: 18px; color: var(--muted); }
      .run li button { margin-left: 6px; }
      .failed { color: var(--danger); }
    `,
  ],
  template: `
    @if (kopilia.memoryOpen(); as m) {
      <div class="sheet">
      <div class="inner" role="dialog" aria-modal="true" aria-label="Mémoire de Kopilia">
        <header>
          <h1>Mémoire de Kopilia</h1>
          <button type="button" class="small" [disabled]="m.reviewing" (click)="kopilia.reviewNow()">
            {{ m.reviewing ? 'Relecture en cours…' : 'Relire maintenant' }}
          </button>
          <button type="button" class="icon" aria-label="Fermer la mémoire" (click)="kopilia.closeMemory()">×</button>
        </header>

        @if (pending().length) {
          <h2>À valider <small>ce que Kopilia propose de retenir pour la suite</small></h2>
          @for (s of pending(); track s.name) {
            <div class="card pending">
              <div class="row">
                <span class="name">{{ s.name }}</span>
                <span class="tag warn">{{ s.activeBody === null ? 'nouvelle recette' : 'modification' }}</span>
                <span class="tag">{{ audience(s.audience) }}</span>
              </div>
              <div class="note">{{ s.description }}</div>
              @if (s.reason) { <p class="reason">{{ s.reason }}</p> }
              <details open>
                <summary>{{ s.activeBody === null ? 'La recette' : 'La version proposée' }}</summary>
                <div class="brief body" [innerHTML]="html(s.body)"></div>
              </details>
              @if (s.activeBody !== null) {
                <details>
                  <summary>La version suivie aujourd'hui</summary>
                  <div class="brief body" [innerHTML]="html(s.activeBody)"></div>
                </details>
              }
              <div class="actions">
                <button type="button" class="primary small" (click)="kopilia.skillAction(s.name, 'approve')">Adopter</button>
                <button type="button" class="small" (click)="kopilia.skillAction(s.name, 'reject')">Refuser</button>
              </div>
            </div>
          }
        }

        <h2>Profil <small>qui tu es, tes préférences</small>
          <span class="bar" [class.full]="m.profile.used > m.profile.budget * 0.85"><i [style.width.%]="percent(m.profile.used, m.profile.budget)"></i></span>
        </h2>
        @if (m.profile.entries.length) {
          <ul class="entries">
            @for (e of m.profile.entries; track e.id) {
              <li><span>{{ e.content }}</span><button type="button" class="icon" [attr.aria-label]="'Oublier : ' + e.content" (click)="kopilia.forgetMemory(e.id)">×</button></li>
            }
          </ul>
        } @else {
          <p class="note">Rien encore. Dis-lui ce qui compte pour toi, ou laisse-le relire vos conversations.</p>
        }

        <h2>Environnement <small>outils, sources, pièges</small>
          <span class="bar" [class.full]="m.environment.used > m.environment.budget * 0.85"><i [style.width.%]="percent(m.environment.used, m.environment.budget)"></i></span>
        </h2>
        @if (m.environment.entries.length) {
          <ul class="entries">
            @for (e of m.environment.entries; track e.id) {
              <li><span>{{ e.content }}</span><button type="button" class="icon" [attr.aria-label]="'Oublier : ' + e.content" (click)="kopilia.forgetMemory(e.id)">×</button></li>
            }
          </ul>
        } @else {
          <p class="note">Rien encore.</p>
        }

        @if (m.trading; as t) {
          <h2>Façon de trader <small>ce que l'IA sait de tes setups</small>
            <span class="bar" [class.full]="t.used > t.budget * 0.85"><i [style.width.%]="percent(t.used, t.budget)"></i></span>
          </h2>
          @if (t.entries.length) {
            <ul class="entries">
              @for (e of t.entries; track e.id) {
                <li><span>{{ e.content }}</span><button type="button" class="icon" [attr.aria-label]="'Oublier : ' + e.content" (click)="kopilia.forgetMemory(e.id)">×</button></li>
              }
            </ul>
          } @else {
            <p class="note">Rien encore. Décris-lui ta stratégie, montre-lui des setups (« ça, c'est un setup »), réagis à ses propositions : elle apprend de tout ça.</p>
          }
        }

        <h2>Recettes <small>façons de faire suivies</small></h2>
        @for (s of followed(); track s.name) {
          <div class="card">
            <div class="row">
              <span class="name">{{ s.name }}</span>
              <span class="tag">{{ audience(s.audience) }}</span>
              @if (s.state === 'archived') { <span class="tag">archivée</span> }
              @if (s.pinned) { <span class="tag">épinglée</span> }
              <span class="spacer"></span>
              <span class="note">v{{ s.version }}@if (s.uses) { · ouverte {{ s.uses }} fois }</span>
            </div>
            <div class="note">{{ s.description }}</div>
            <details>
              <summary>Lire</summary>
              <div class="brief body" [innerHTML]="html(s.body)"></div>
              @if (s.files.length) { <p class="note">Fichiers d'appoint : {{ s.files.join(', ') }}</p> }
            </details>
            <div class="actions">
              @if (s.state === 'archived') {
                <button type="button" class="small" (click)="kopilia.skillAction(s.name, 'restore')">Réactiver</button>
              } @else {
                <button type="button" class="small" (click)="kopilia.skillAction(s.name, s.pinned ? 'unpin' : 'pin')">{{ s.pinned ? 'Désépingler' : 'Épingler' }}</button>
                <button type="button" class="small" (click)="kopilia.skillAction(s.name, 'archive')">Archiver</button>
              }
            </div>
          </div>
        } @empty {
          <p class="note">Aucune pour l'instant : elles naissent de vos conversations, quand tu corriges Kopilia ou qu'une méthode marche.</p>
        }

        <h2>Journal <small>ce que Kopilia a retenu</small></h2>
        @for (r of m.runs; track r.id) {
          <div class="run">
            <time>{{ when(r.finishedAt ?? r.createdAt) }}</time>
            <span [class.failed]="r.state === 'failed'">{{ r.kind === 'review' ? 'Relecture' : 'Rangement' }}@if (r.state === 'running') { en cours… } @else { : {{ r.summary }} }</span>
            @if (r.changes.length) {
              <ul>
                @for (c of r.changes; track $index) {
                  <li>
                    {{ describe(c) }}
                    @if (c.kind === 'memory' && c.previousId && canRestore(r, c)) {
                      <button type="button" class="small" (click)="kopilia.restoreMemory(c.previousId!)">Rétablir</button>
                    }
                  </li>
                }
              </ul>
            }
          </div>
        } @empty {
          <p class="note">Pas encore de relecture : elle a lieu quand une conversation est au repos depuis dix minutes.</p>
        }
      </div>
      </div>
    }
  `,
})
export class MemoryPanelComponent {
  readonly kopilia = inject(KopiliaService);

  readonly pending = computed(() => (this.kopilia.memoryOpen()?.skills ?? []).filter((s) => s.state === "draft"));
  readonly followed = computed<SkillCardView[]>(() => (this.kopilia.memoryOpen()?.skills ?? []).filter((s) => s.state !== "draft"));

  /** Le texte vient d'un modèle : échappé puis rendu comme un brief. */
  html(markdown: string): string {
    return renderBrief(markdown);
  }

  audience(a: string): string {
    return AUDIENCE[a] ?? a;
  }

  percent(used: number, budget: number): number {
    return Math.min(100, Math.round((used / Math.max(budget, 1)) * 100));
  }

  when(ms: number): string {
    return formatDateTime(ms);
  }

  describe(c: LearningChangeView): string {
    if (c.kind === "memory") {
      const store = STORE[c.target] ?? c.target;
      if (c.action === "add") return `Retenu (${store}) : ${c.detail}`;
      if (c.action === "replace") return `Reformulé (${store}) : ${c.detail} — avant : ${c.previous ?? "?"}`;
      return `Retiré (${store}) : ${c.detail}`;
    }
    const verb: Record<string, string> = {
      create: c.state === "draft" ? "Recette proposée" : "Recette créée",
      patch: c.state === "draft" ? "Modification proposée" : "Recette modifiée",
      rewrite: c.state === "draft" ? "Refonte proposée" : "Recette refondue",
      write_file: "Fichier d'appoint ajouté",
      archive: "Recette archivée",
      expire: "Proposition expirée",
    };
    return `${verb[c.action] ?? c.action} : ${c.target}${c.detail ? ` — ${c.detail}` : ""}`;
  }

  /** Défaire n'a de sens que pour la passe la plus récente qui a touché cette entrée. */
  canRestore(run: LearningRunView, c: LearningChangeView): boolean {
    return run.state !== "running" && (c.action === "replace" || c.action === "remove");
  }
}
