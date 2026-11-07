import { ChangeDetectionStrategy, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, computed, signal, viewChild } from "@angular/core";
import { KopiliaService } from "./kopilia.service";
import { hintFor } from "./call/phase";
import type { KeyLike } from "./call/push-to-talk";
import { pastedName } from "./documents/documents";
import { NetModel, NeuralNet } from "./neural/neural-net";
import { DotSphere } from "./orb/dot-sphere";
import { MemoryPanelComponent } from "./memory/memory-panel.component";
import { DashboardComponent } from "./dashboard/dashboard.component";
import { BriefSheetComponent } from "./brief/brief-sheet.component";
import { TradeSheetComponent } from "./journal/trade-sheet.component";
import { ReviewSheetComponent } from "./journal/review-sheet.component";
import { CalendarSheetComponent } from "./journal/calendar-sheet.component";
import { SetupsPanelComponent } from "./setups/setups-panel.component";
import { NoticesComponent } from "./shell/notices.component";
import { CallBarComponent } from "./shell/call-bar.component";
import { TranscriptComponent } from "./shell/transcript.component";
import { BrokerPillComponent } from "./shell/broker-pill.component";
import { formatDateTime } from "./format";

/** Le glisser porte des fichiers (et non du texte ou un lien de la page). */
function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes("Files");
}

/**
 * La coquille de l'écran : l'en-tête, la colonne (tableau de bord, avis,
 * orbe, barre d'appel), la discussion, les feuilles plein écran. Elle garde
 * l'orbe et la galaxie, animées par une seule boucle, hors de la détection de
 * changements ; les raccourcis clavier ; le dépôt de documents dans la fenêtre.
 */
@Component({
  selector: "kp-root",
  standalone: true,
  imports: [
    MemoryPanelComponent,
    SetupsPanelComponent,
    DashboardComponent,
    BriefSheetComponent,
    TradeSheetComponent,
    ReviewSheetComponent,
    CalendarSheetComponent,
    NoticesComponent,
    CallBarComponent,
    TranscriptComponent,
    BrokerPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      /* Réseau de neurones derrière tout le reste (décor qui informe : étapes, agents, projets). */
      .neural { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }
      .app {
        position: relative; z-index: 1;
        min-height: 100dvh; max-width: 760px; margin: 0 auto; padding: 0 16px;
        display: flex; flex-direction: column;
      }
      header { display: flex; align-items: center; gap: 10px; padding: 18px 0 10px; }
      .brand { font-weight: 600; letter-spacing: .3px; }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
      .dot.on { background: var(--accent-2); }
      .spacer { flex: 1; }
      .textbtn {
        border: 1px solid var(--border); background: none; color: var(--text); border-radius: 999px;
        padding: 4px 12px; font-size: 13px;
      }
      .textbtn:hover { border-color: var(--accent); color: var(--accent); }
      .badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 999px; background: var(--warn); color: #111; font-size: 11px; line-height: 18px; text-align: center; }
      .badge.ai { background: var(--ai); color: #fff; }

      .notices { display: flex; flex-direction: column; gap: 8px; }

      /* ---------- Orbe central : une sphère de points (canvas) qui s'anime au son et à l'activité ---------- */
      .center { flex: 1; min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 48px; }
      .orb {
        position: relative; width: 168px; height: 168px; padding: 0; border: none; border-radius: 50%;
        background: transparent; cursor: default;
      }
      .orb:not(:disabled) { cursor: pointer; }
      .orb:disabled { opacity: 1; }
      .orb:focus-visible { outline: 3px solid var(--accent); outline-offset: 40px; }
      /* Le canvas déborde largement du bouton : le halo (jusqu'à 1,75 rayon, sphère gonflée
         comprise) et les vagues de la voix y tiennent sans jamais toucher le bord. */
      .sphere { position: absolute; inset: -100px; width: 368px; height: 368px; pointer-events: none; display: block; }
      /* Micro coupé : orbe éteint, figé. */
      .hint { margin: 0; color: var(--muted); font-size: 14px; min-height: 1.5em; text-align: center; }

      /* ---------- Bas : les boutons, toujours collés en bas, à hauteur fixe (rien ne les déplace) ;
         devant les encarts (un graphique agrandi s'arrête au-dessus), seuls les boutons arrêtent les clics. ---------- */
      .bottom {
        position: sticky; bottom: 0; z-index: 4; flex: 0 0 auto; pointer-events: none;
        display: flex; flex-direction: column; align-items: center; padding-bottom: 18px;
      }

      .dropzone {
        position: fixed; inset: 12px; z-index: 20; display: grid; place-items: center; text-align: center;
        border: 2px dashed var(--accent); border-radius: 18px; pointer-events: none;
        background: color-mix(in srgb, var(--bg) 88%, transparent); font-size: 18px;
      }
      .dropzone small { display: block; font-size: 13px; color: var(--muted); margin-top: 4px; }
    `,
  ],
  template: `
    <canvas #net class="neural" aria-hidden="true"></canvas>
    <div class="app">
      <header>
        <span class="dot" [class.on]="kopilia.connected()" [attr.title]="kopilia.connected() ? 'Connecté' : 'Hors ligne'"></span>
        <span class="brand">Kopilia</span>
        <kp-broker-pill />
        <span class="spacer"></span>
        @if (kopilia.panels().length) {
          <button type="button" class="textbtn" title="Fermer tous les encarts du tableau de bord" (click)="kopilia.closeAllPanels()">Tout fermer</button>
        }
        @if (kopilia.latestBrief(); as b) {
          <button type="button" class="textbtn" [attr.title]="b.title" (click)="kopilia.openBrief(b.briefId)">Brief · {{ briefDate(b.createdAt) }}</button>
        }
        <button type="button" class="textbtn" title="Setups déclenchés et en attente, hypothèses, résultats" (click)="kopilia.openSetups()">
          Opportunités@if (kopilia.proposedSetups().length) {<span class="badge ai" [attr.aria-label]="kopilia.proposedSetups().length + ' setups déclenchés'">{{ kopilia.proposedSetups().length }}</span>}
        </button>
        <button type="button" class="textbtn" title="Ce que Kopilia a retenu, ses recettes" (click)="kopilia.openMemory()">
          Mémoire@if (kopilia.learningPending()) {<span class="badge" [attr.aria-label]="kopilia.learningPending() + ' à valider'">{{ kopilia.learningPending() }}</span>}
        </button>
      </header>

      <section class="notices">
        <kp-dashboard />
        <kp-notices />
      </section>

      <main class="center">
        <button
          #orb
          type="button"
          class="orb"
          [attr.data-phase]="kopilia.phase()"
          [disabled]="!canTapOrb()"
          [attr.aria-label]="canTapOrb() ? 'Interrompre Kopilia' : 'Kopilia'"
          [attr.title]="canTapOrb() ? 'Toucher pour interrompre' : null"
          (click)="kopilia.tapOrb()"
        >
          <canvas #sphere class="sphere" aria-hidden="true"></canvas>
        </button>
        <p class="hint" aria-live="polite">{{ hint() }}</p>
      </main>

      <footer class="bottom">
        <kp-call-bar />
      </footer>

      <!-- Dans le même plan que les encarts, sous eux ; un graphique agrandi la range dans la bande d'appel. -->
      <kp-transcript [band]="chartMaxed()" />
    </div>

    <kp-brief-sheet />
    <kp-trade-sheet />
    <kp-review-sheet />
    <kp-calendar-sheet />
    <kp-memory-panel />
    <kp-setups-panel />

    @if (dragging()) {
      <div class="dropzone" aria-hidden="true">
        <div>Dépose ton document<small>Il partira avec ta prochaine phrase.</small></div>
      </div>
    }
  `,
})
export class AppComponent implements OnInit, OnDestroy {
  /** Un fichier est glissé au-dessus de la fenêtre. */
  readonly dragging = signal(false);
  /** dragenter et dragleave se répètent d'un élément à l'autre : on compte. */
  private dragDepth = 0;

  private readonly orbEl = viewChild<ElementRef<HTMLElement>>("orb");
  private readonly sphereEl = viewChild<ElementRef<HTMLCanvasElement>>("sphere");
  private readonly netEl = viewChild<ElementRef<HTMLCanvasElement>>("net");
  /** Le tableau de bord donne les points où la galaxie rattache ses encarts. */
  private readonly dashboard = viewChild(DashboardComponent);
  private net?: NeuralNet;
  private sphere?: DotSphere;

  /** Ce que montre le réseau : réflexion en cours, ses étapes, et les agents et tâches avec leur projet. */
  private readonly netModel = computed<NetModel>(() => {
    const phase = this.kopilia.phase();
    const state = this.kopilia.state();
    return {
      busy: phase === "thinking" || phase === "speaking" || state === "thinking",
      steps: this.kopilia.turnSteps(),
      jobs: this.kopilia.jobs().map((j) => ({
        id: j.jobId,
        name: j.folder && j.kind !== "agent" ? j.folder : j.title || j.folder || (j.kind === "agent" ? "Agent" : "Tâche"),
        kind: j.kind === "agent" ? "agent" : "task",
        state: j.state,
        steps: j.steps ?? 0,
        lastStep: j.lastStep,
      })),
    };
  });
  private raf = 0;
  private lvl = 0;

  readonly hint = computed(() =>
    hintFor(this.kopilia.phase(), {
      // Un document attend : c'est la prochaine phrase qui dira quoi en faire.
      readyDocs: this.kopilia.documents().filter((d) => d.status === "ready").length,
      micSupported: this.kopilia.micSupported(),
    }),
  );
  readonly canTapOrb = computed(() => this.kopilia.canInterrupt());
  /** Un graphique agrandi occupe l'écran jusqu'à la bande d'appel. */
  readonly chartMaxed = computed(() => this.dashboard()?.anyMaxed() ?? false);

  constructor(
    public kopilia: KopiliaService,
    private readonly zone: NgZone,
  ) {}

  ngOnInit(): void {
    void this.kopilia.connect();
    // Animation de l'orbe hors détection de changements : 60 i/s sans coût Angular.
    this.zone.runOutsideAngular(() => (this.raf = requestAnimationFrame(this.animate)));
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Attaque rapide, relâche douce : l'orbe suit la voix sans trembler. Le réseau suit l'orbe. */
  private readonly animate = (now: number) => {
    const target = this.kopilia.levelNow();
    this.lvl += (target - this.lvl) * (target > this.lvl ? 0.5 : 0.12);
    const orb = this.orbEl()?.nativeElement;
    const sphereCanvas = this.sphereEl()?.nativeElement;
    if (sphereCanvas) {
      this.sphere ??= new DotSphere(sphereCanvas);
      this.sphere.frame(now, { phase: this.kopilia.phase(), level: this.lvl });
    }
    const canvas = this.netEl()?.nativeElement;
    if (canvas && orb) {
      this.net ??= new NeuralNet(canvas);
      const r = orb.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dashboard = this.dashboard();
      const model = this.kopilia.panels().length && dashboard ? { ...this.netModel(), anchors: dashboard.anchors(cx, cy) } : this.netModel();
      this.net.frame(now, model, cx, cy);
    }
    this.raf = requestAnimationFrame(this.animate);
  };

  /** « lun. 2 nov., 07:04 » */
  briefDate(ms: number): string {
    return formatDateTime(ms);
  }

  /**
   * Échap : ferme le dernier bandeau d'alerte, sinon la page d'un trade, sinon l'analyse de son trading, sinon le calendrier du journal, sinon le brief, sinon les
   * opportunités, sinon la mémoire, sinon remet à sa taille un graphique
   * agrandi, sinon ferme le dernier encart ouvert.
   */
  @HostListener("document:keydown.escape")
  onEscape(): void {
    const fired = this.kopilia.firedAlerts()[0];
    if (fired) {
      this.kopilia.dismissAlert(fired.key);
      return;
    }
    if (this.kopilia.tradeOpen()) {
      this.kopilia.closeTrade();
      return;
    }
    if (this.kopilia.reviewOpen()) {
      this.kopilia.closeReview();
      return;
    }
    if (this.kopilia.calendarOpen()) {
      this.kopilia.closeCalendar();
      return;
    }
    if (this.kopilia.briefOpen()) {
      this.kopilia.closeBrief();
      return;
    }
    if (this.kopilia.setupsOpen()) {
      this.kopilia.closeSetups();
      return;
    }
    if (this.kopilia.memoryOpen()) {
      this.kopilia.closeMemory();
      return;
    }
    if (this.dashboard()?.restoreMaximized()) return;
    const last = this.kopilia.panels().at(-1);
    if (last) void this.kopilia.closePanel(last.id);
  }

  /**
   * ⌥ droite (ou ⌥ Espace) maintenue : parler à Kopilia. Tout geste dans la
   * page autorise d'abord le son et ouvre le micro (une fois par chargement).
   */
  @HostListener("document:keydown", ["$event"])
  @HostListener("document:keyup", ["$event"])
  onKey(e: KeyboardEvent): void {
    if (e.type === "keydown") this.kopilia.gesture();
    // L'application Kopilia écoute tout le clavier du Mac : ⌥ arrive par elle, pas deux fois.
    if (this.kopilia.appKeys()) return;
    if (this.kopilia.pttKey(e)) e.preventDefault();
  }

  /** Un geste de ⌥ transmis par l'application Kopilia, même quand une autre application est devant (TradingView). */
  @HostListener("window:kopilia-key", ["$event"])
  onAppKey(e: Event): void {
    this.kopilia.appKey((e as CustomEvent<KeyLike>).detail);
  }

  @HostListener("document:pointerdown")
  onPointer(): void {
    this.kopilia.gesture();
  }

  /** Fenêtre quittée ou onglet caché, touche tenue : la phrase part, rien ne reste à l'écoute. */
  @HostListener("window:blur")
  @HostListener("document:visibilitychange")
  onLeave(): void {
    // Avec l'application qui écoute tout le clavier, le relâchement arrive toujours, même fenêtre quittée.
    if (this.kopilia.appKeys()) return;
    if (document.hidden || !document.hasFocus()) this.kopilia.pttBlur();
  }

  /* ------------- Documents : glisser-déposer et coller, n'importe où dans la fenêtre ------------- */

  @HostListener("document:dragenter", ["$event"])
  onDragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth++;
    this.dragging.set(true);
  }

  @HostListener("document:dragover", ["$event"])
  onDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault(); // sans cela, le navigateur ouvrirait le fichier à la place de la page
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  @HostListener("document:dragleave", ["$event"])
  onDragLeave(e: DragEvent): void {
    if (!hasFiles(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (!this.dragDepth) this.dragging.set(false);
  }

  @HostListener("document:drop", ["$event"])
  onDrop(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.dragging.set(false);
    this.kopilia.addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  /** Cmd+V d'une capture d'écran (un graphique, par exemple) : jointe comme un fichier. */
  @HostListener("document:paste", ["$event"])
  onPaste(e: ClipboardEvent): void {
    if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    this.kopilia.addFiles(files.map((f) => new File([f], pastedName(f.name), { type: f.type })));
  }
}
