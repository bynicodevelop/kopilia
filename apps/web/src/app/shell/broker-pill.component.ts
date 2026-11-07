import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { wakeDurationLabel } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";

/**
 * L'état du courtier (le compte MetaApi), en haut de la page, seulement quand
 * il n'est pas simplement allumé : en pause (un clic le rallume), en train de
 * se rallumer (avec le temps écoulé : une à trois minutes), ou allumé pendant
 * une pause (il se rendort après un moment sans usage).
 */
@Component({
  selector: "kp-broker-pill",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: contents; }
      .pill {
        display: inline-flex; align-items: center; gap: 6px;
        border: 1px solid var(--border); background: none; color: var(--muted); border-radius: 999px;
        padding: 3px 10px; font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums;
      }
      button.pill { cursor: pointer; }
      button.pill:hover { border-color: var(--accent); color: var(--accent); }
      .pill i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
      .pill.waking { color: var(--text); }
      .pill.waking i { background: var(--accent); animation: beat 1.1s ease-in-out infinite; }
      .pill.error i { background: var(--warn); }
      @keyframes beat { 50% { opacity: .25; } }
      @media (prefers-reduced-motion: reduce) { .pill.waking i { animation: none; } }
    `,
  ],
  template: `
    @if (view(); as v) {
      @if (v.click) {
        <button type="button" class="pill" [class.error]="v.kind === 'error'" [attr.title]="v.title" (click)="wake()">
          <i aria-hidden="true"></i>{{ v.text }}
        </button>
      } @else {
        <span class="pill" [class.waking]="v.kind === 'waking'" [attr.title]="v.title" role="status">
          <i aria-hidden="true"></i>{{ v.text }}
        </span>
      }
    }
  `,
})
export class BrokerPillComponent {
  private readonly kopilia = inject(KopiliaService);
  private readonly now = signal(Date.now());

  readonly view = computed(() => {
    const s = this.kopilia.broker();
    if (!s) return null;
    const usual = s.wakeMs ? `d'habitude ${wakeDurationLabel(s.wakeMs)}` : "une à trois minutes";
    switch (s.state) {
      case "paused":
        return { kind: "paused", click: true, text: "Courtier en pause", title: `${s.label} · clic pour le rallumer (${usual})` };
      case "pausing":
        return { kind: "paused", click: true, text: "Courtier : mise en pause…", title: "Clic pour le garder allumé" };
      case "waking":
        return {
          kind: "waking",
          click: false,
          text: `Rallumage du courtier · ${clock(this.now() - s.since)}`,
          title: `Prix, graphiques et ordres reviennent dans un instant (${usual})`,
        };
      case "error":
        return { kind: "error", click: true, text: "Courtier : erreur", title: `${s.label} · clic pour réessayer` };
      case "on":
        return s.sleepsAt ? { kind: "on", click: false, text: "Courtier allumé", title: s.label } : null;
      default:
        return null;
    }
  });

  constructor() {
    // Le temps écoulé d'un rallumage, à la seconde, seulement pendant qu'il dure.
    let timer: ReturnType<typeof setInterval> | undefined;
    effect(() => {
      const waking = this.kopilia.broker()?.state === "waking";
      if (waking && !timer) {
        // Un effet ne peut pas écrire un signal : la première seconde vient de la minuterie.
        timer = setInterval(() => this.now.set(Date.now()), 1000);
      } else if (!waking && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  wake() {
    void this.kopilia.wakeBroker();
  }
}

/** « 0:42 », « 1:05 ». */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
