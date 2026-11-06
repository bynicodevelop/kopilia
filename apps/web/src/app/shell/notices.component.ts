import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import type { Ticket } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";

/** Une erreur reste affichée ce temps-là (ou jusqu'à ce qu'on la ferme). */
const ERROR_MS = 20_000;
/** « Kopilia a retenu… » reste affiché ce temps-là. */
const NOTE_MS = 15_000;

/**
 * Les avis au-dessus de l'orbe : ce qui passe (alertes qui viennent de partir,
 * erreur, ce que Kopilia vient de retenir), en bandeaux qui s'effacent seuls, et
 * ce qui attend une décision (accords demandés), qui reste. Les agents et les
 * tâches ne sont plus ici : ils ont leur encart, l'Activité. Dans la colonne de
 * la coquille (ses enfants s'y alignent directement).
 */
@Component({
  selector: "kp-notices",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: contents; }
      .banner, .approval {
        background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px;
      }
      .banner { display: flex; gap: 10px; align-items: flex-start; border-color: var(--danger); color: var(--danger); }
      .banner span { flex: 1; }
      .banner.learned { border-color: var(--accent-2); color: var(--text); align-items: center; }
      /* Les alertes parties : en haut de l'écran, par-dessus les encarts (un graphique agrandi couvre la colonne). */
      .alerts {
        position: fixed; z-index: 30; top: 12px; left: 50%; transform: translateX(-50%);
        width: min(560px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 8px;
      }
      .banner.alert { border-color: var(--warn); color: var(--text); align-items: center; box-shadow: 0 8px 24px color-mix(in srgb, #000 35%, transparent); }
      .banner.alert svg { flex: none; width: 18px; height: 18px; fill: none; stroke: var(--warn); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
      .banner.alert small { display: block; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
      .banner.alert.setup { border-color: var(--ai); }
      .banner.alert.setup svg { stroke: var(--ai); }
      .banner.alert.news { border-color: var(--accent); }
      .banner.alert.news svg { stroke: var(--accent); }
      .banner.alert .see { border: none; background: none; color: var(--ai); padding: 2px 6px; font-size: 13px; }
      /* La croix d'un bandeau d'alerte : une vraie cible (30 px), pas le seul signe ×. */
      .banner.alert .close {
        flex: none; display: grid; place-items: center; width: 30px; height: 30px; margin: -6px -6px -6px 0; padding: 0;
        border: none; border-radius: 8px; background: none; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer;
      }
      .banner.alert .close:hover { color: var(--text); background: var(--panel-2); }
      .banner.alert.trade { border-color: var(--accent); }
      .banner.alert.trade svg { stroke: var(--accent); }
      .banner.alert.trade.bad { border-color: var(--danger); }
      .banner.alert.trade.bad svg { stroke: var(--danger); }
      /* Le ticket à confirmer : il reste tant qu'il n'a pas expiré ; rien ne part sans lui. */
      .ticket {
        background: var(--panel); border: 1px solid var(--accent); border-radius: 12px; padding: 12px 14px;
        display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; box-shadow: 0 8px 24px color-mix(in srgb, #000 35%, transparent);
      }
      .ticket .what { flex: 1; min-width: 260px; line-height: 1.45; }
      .ticket .kicker .live { color: var(--danger); }
      .ticket small { display: block; margin-top: 4px; color: var(--muted); font-size: 12.5px; }
      .ticket small.warn { color: var(--warn); }
      .approval { border-color: var(--accent); display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .approval .what { flex: 1; min-width: 220px; }
      .kicker { display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
      .actions { display: flex; gap: 8px; }
    `,
  ],
  template: `
    @if (kopilia.firedAlerts().length || kopilia.ticket()) {
      <div class="alerts">
        @if (kopilia.ticket(); as t) {
          <div class="ticket" role="dialog" aria-label="Ordre à confirmer">
            <div class="what">
              <span class="kicker"
                >{{ kicker(t) }} ·
                @if (t.demo) {
                  démo
                } @else {
                  <span class="live">compte réel</span>
                }
              </span>
              {{ t.text }}
              @for (w of t.warnings; track w) {
                <small class="warn">{{ w }}</small>
              }
              <small>Dis « je confirme », ou passe-le ici. Expire dans {{ left() }} s.</small>
            </div>
            <div class="actions">
              <button class="primary" type="button" [disabled]="kopilia.ticketSending()" (click)="kopilia.confirmTicket(t.id)">
                {{ kopilia.ticketSending() ? "Envoi…" : t.action === "cancel" ? "Retirer l'ordre" : t.action === "close" ? "Fermer la position" : "Passer l'ordre" }}
              </button>
              <button type="button" (click)="kopilia.cancelTicket(t.id)">
                {{ t.action === "cancel" ? "Garder l'ordre" : t.action === "close" ? "Garder la position" : "Annuler" }}
              </button>
            </div>
          </div>
        }
        @for (a of kopilia.firedAlerts(); track a.key) {
          <div class="banner alert" [class.setup]="!!a.setup" [class.news]="!!a.news" [class.trade]="!!a.trade" [class.bad]="a.trade === 'rejected' || a.trade === 'error'" role="alert">
            @if (a.news) {
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h9v9h-8a1 1 0 0 1-1-1z" /><path d="M11.5 6h2v5.5a1 1 0 0 1-2 0" /><path d="M4.5 6h5M4.5 8.5h5M4.5 11h3" /></svg>
            } @else if (a.trade) {
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6" /><circle cx="12.5" cy="11.5" r="1.2" /></svg>
            } @else if (a.setup) {
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 12.5l3.5-4 3 2 4.5-6" /><path d="M10.5 4.5h3v3" /></svg>
            } @else {
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1.2H3z" /><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" /></svg>
            }
            <span>{{ a.title }}<small>{{ a.detail }}</small></span>
            @if (a.setup) {
              <button type="button" class="see" (click)="kopilia.openSetups(); kopilia.dismissAlert(a.key)">Voir</button>
            }
            <button type="button" class="close" (click)="kopilia.dismissAlert(a.key)" aria-label="Fermer" title="Fermer (Échap)">×</button>
          </div>
        }
      </div>
    }
    @if (kopilia.error(); as err) {
      <div class="banner" role="alert">
        <span>{{ err }}</span>
        <button type="button" class="icon" (click)="dismissError()" aria-label="Fermer">×</button>
      </div>
    }
    @if (kopilia.learningNote(); as note) {
      <div class="banner learned" role="status">
        <span>{{ note }}</span>
        <button type="button" class="inline" (click)="kopilia.openMemory()">Voir</button>
        <button type="button" class="icon" (click)="dismissNote()" aria-label="Fermer">×</button>
      </div>
    }
    @for (a of kopilia.approvals(); track a.approvalId) {
      <div class="approval">
        <div class="what"><span class="kicker">Kopilia veut</span>{{ a.action }}</div>
        <div class="actions">
          <button class="primary" (click)="kopilia.resolveApproval(a.approvalId, 'approve')">Approuver</button>
          <button class="danger" (click)="kopilia.resolveApproval(a.approvalId, 'deny')">Refuser</button>
        </div>
      </div>
    }
  `,
})
export class NoticesComponent {
  readonly kopilia = inject(KopiliaService);
  /** Ce que demande le ticket : un ordre à passer, une gestion, ou retirer l'ordre d'une boîte qu'il vient d'effacer. */
  kicker(t: Ticket): string {
    if (t.eraseBox) return t.action === "cancel" ? "Boîte effacée : ordre à retirer" : "Boîte effacée : position à fermer";
    if (t.action !== "open") return "Gestion à confirmer";
    return t.execution === "market" ? "Ordre au marché à confirmer" : "Ordre en attente à confirmer";
  }

  /** L'heure, à la seconde, tant qu'un ticket attend : son compte à rebours. */
  private readonly now = signal(Date.now());
  readonly left = computed(() => Math.max(0, Math.ceil(((this.kopilia.ticket()?.expiresAt ?? 0) - this.now()) / 1000)));

  constructor() {
    effect((onCleanup) => {
      if (!this.kopilia.ticket()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    // Ce qui passe s'efface seul ; un nouvel avis repart pour sa durée entière.
    this.fade(
      () => this.kopilia.error(),
      () => this.kopilia.error.set(null),
      ERROR_MS,
    );
    this.fade(
      () => this.kopilia.learningNote(),
      () => this.kopilia.learningNote.set(null),
      NOTE_MS,
    );
  }

  /** Efface l'avis `read` au bout de `ms`, s'il n'a pas changé entre-temps. */
  private fade(read: () => string | null, clear: () => void, ms: number): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect((onCleanup) => {
      const shown = read();
      clearTimeout(timer);
      if (shown === null) return;
      timer = setTimeout(() => {
        if (read() === shown) clear();
      }, ms);
      onCleanup(() => clearTimeout(timer));
    });
  }

  dismissError(): void {
    this.kopilia.error.set(null);
  }

  dismissNote(): void {
    this.kopilia.learningNote.set(null);
  }
}
