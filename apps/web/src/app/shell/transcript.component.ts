import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, viewChild } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import { CALL_BAND } from "../dashboard/layout";
import { SPOT_MS } from "../dashboard/price-spots";

/** Délai avant que la discussion pâlisse, une fois l'échange fini. */
const QUIET_MS = 8000;
/** Dans la bande d'appel : son bas, et l'écart gardé sous le graphique agrandi. */
const BAND_BOTTOM = 16;
const BAND_GAP = 10;

/**
 * La discussion, discrète, en bas à droite de l'écran, hors du flux : elle ne
 * déplace jamais les boutons. Elle apparaît en fondu, le haut (l'ancien texte)
 * s'efface, et au repos elle pâlit ; la survoler la ravive. Sur un écran large,
 * elle ne recouvre pas un encart : celui qu'on pose sur elle passe devant, et
 * elle garde sa place et sa largeur. Un graphique agrandi lui laisse la bande
 * du bas : elle s'y range, à droite des boutons d'appel (`band`).
 */
@Component({
  selector: "kp-transcript",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /* Sous les encarts (couche 3), dans le même plan qu'eux : un encart posé sur elle passe devant. */
      .transcript {
        position: fixed; right: 24px; bottom: 24px; z-index: 2;
        width: min(340px, calc(100vw - 48px)); max-height: 36vh; overflow-y: auto; scrollbar-width: none;
        display: flex; flex-direction: column; gap: 6px; padding-top: 2.6em;
        font-size: 13px; text-align: left;
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 2.6em);
        mask-image: linear-gradient(to bottom, transparent 0, #000 2.6em);
        opacity: 0; translate: 0 10px; pointer-events: none;
        transition: opacity .8s ease, translate .8s ease;
      }
      .transcript.filled { opacity: .92; translate: 0 0; pointer-events: auto; }
      /* Un graphique agrandi : dans la bande du bas, à droite des boutons d'appel (la colonne
         des boutons fait 360 px au centre), plus large et moins haute ; fondu du haut plus court. */
      .transcript.band {
        bottom: ${BAND_BOTTOM}px; width: min(600px, calc(50vw - 224px)); max-height: ${CALL_BAND - BAND_BOTTOM - BAND_GAP}px;
        padding-top: 1.3em;
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.3em);
        mask-image: linear-gradient(to bottom, transparent 0, #000 1.3em);
      }
      .transcript.filled.quiet { opacity: .3; }
      .transcript.filled.quiet:hover { opacity: .92; }
      /* Écran étroit : au-dessus des boutons, centrée. */
      @media (max-width: 999px) {
        .transcript { left: 16px; right: 16px; width: auto; bottom: 132px; max-height: 18vh; text-align: center; }
      }
      .line { animation: fade-up .7s ease both; }
      @keyframes fade-up { from { opacity: 0; translate: 0 6px; } }
      .you { margin: 0; color: var(--muted); font-size: 12px; }
      .partial { font-style: italic; }
      .tag {
        font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent);
        border: 1px solid currentColor; border-radius: 999px; padding: 1px 7px; margin-right: 4px;
      }
      .resp { white-space: pre-wrap; line-height: 1.5; color: color-mix(in srgb, var(--text) 85%, transparent); }
      /* Un prix que Kopilia dit : en violet, le temps qu'il est allumé sur le graphique (SPOT_MS), puis comme le reste. */
      .spot { border-radius: 3px; animation: spot ${SPOT_MS}ms ease-out forwards; }
      @keyframes spot {
        0%, 75% { background: color-mix(in srgb, var(--ai) 24%, transparent); color: var(--ai); }
        100% { background: transparent; color: color-mix(in srgb, var(--text) 85%, transparent); }
      }
      .att {
        display: inline-block; font-size: 12px; color: var(--muted); border: 1px solid var(--border);
        border-radius: 6px; padding: 0 6px; margin-left: 4px; white-space: nowrap;
      }
      @media (prefers-reduced-motion: reduce) {
        .transcript, .line { animation: none !important; transition: none; }
      }
    `,
  ],
  template: `
    <!-- Chaque nouvel échange apparaît en fondu (recréé à chaque tour). Pas d'annonce aux
         lecteurs d'écran : le texte se dévoile mot à mot pendant que Kopilia le dit à voix
         haute ; l'état est annoncé par la ligne d'aide. -->
    <div class="transcript" #transcript [class.filled]="hasConversation()" [class.quiet]="quiet()" [class.band]="band()" aria-live="off">
      @for (key of [exchangeKey()]; track key) {
        @if (kopilia.reportTitle(); as title) {
          <p class="you line">
            <span class="tag">{{ kopilia.reportBriefId() ? 'Veille' : "Résultat d'agent" }}</span> {{ title }}
            @if (kopilia.reportBriefId(); as id) {
              <button type="button" class="inline" (click)="kopilia.openBrief(id)">Lire le brief</button>
            }
          </p>
        } @else if (kopilia.transcriptFinal() || kopilia.transcriptPartial()) {
          <p class="you line">
            {{ kopilia.transcriptFinal() }} <span class="partial">{{ kopilia.transcriptPartial() }}</span>
            @for (name of kopilia.attached(); track $index) {
              <span class="att" title="Document envoyé avec ta phrase">{{ name }}</span>
            }
          </p>
        }
        @if (kopilia.response()) {
          <!-- Les prix que Kopilia dit, et qui s'allument sur un graphique, s'allument aussi ici. -->
          <div class="resp line">@for (part of parts(); track part.start) {<span [class.spot]="part.spot">{{ part.text }}</span>}</div>
        }
      }
    </div>
  `,
})
export class TranscriptComponent {
  readonly kopilia = inject(KopiliaService);
  /** Un graphique est agrandi : la discussion prend la bande du bas, à droite des boutons. */
  readonly band = input(false);
  private readonly el = viewChild<ElementRef<HTMLElement>>("transcript");

  readonly hasConversation = computed(
    () => !!(this.kopilia.transcriptFinal() || this.kopilia.transcriptPartial() || this.kopilia.response() || this.kopilia.reportTitle()),
  );
  /**
   * La réponse en morceaux : les prix allumés à part (leur place ne change
   * pas : le morceau garde son élément, et son animation, pendant que la suite
   * s'affiche).
   */
  readonly parts = computed(() => {
    const text = this.kopilia.response();
    const out: Array<{ start: number; text: string; spot: boolean }> = [];
    let at = 0;
    const spots = [...this.kopilia.spokenPrices()].sort((a, b) => a.start - b.start);
    for (const s of spots) {
      if (s.start < at || s.start >= text.length) continue;
      if (s.start > at) out.push({ start: at, text: text.slice(at, s.start), spot: false });
      out.push({ start: s.start, text: text.slice(s.start, Math.min(s.end, text.length)), spot: true });
      at = Math.min(s.end, text.length);
    }
    if (at < text.length) out.push({ start: at, text: text.slice(at), spot: false });
    return out;
  });
  /** Un échange par phrase (ou par rapport d'agent) : il change, le texte réapparaît en fondu. */
  readonly exchangeKey = computed(() => this.kopilia.reportTitle() ?? this.kopilia.transcriptFinal());
  /** Personne ne parle depuis un moment : la discussion pâlit. */
  readonly quiet = signal(false);
  private quietTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.quietTimer));
    // Le texte défile vers le bas au fil de la réponse, et quand elle passe dans la bande d'appel (moins haute) ou en revient.
    effect(() => {
      this.kopilia.response();
      this.band();
      const el = this.el()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
    // Ravivée à chaque nouveauté ; pâlit QUIET_MS après la fin de l'échange.
    effect(
      () => {
        this.kopilia.response();
        this.kopilia.transcriptPartial();
        this.exchangeKey();
        const phase = this.kopilia.phase();
        clearTimeout(this.quietTimer);
        this.quiet.set(false);
        if (phase !== "thinking" && phase !== "speaking" && phase !== "hearing") {
          this.quietTimer = setTimeout(() => this.quiet.set(true), QUIET_MS);
        }
      },
      { allowSignalWrites: true },
    );
  }
}
