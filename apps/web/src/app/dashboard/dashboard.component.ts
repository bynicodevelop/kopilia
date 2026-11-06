import { NgTemplateOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import type { PanelDisplay } from "@kopilia/contracts";
import type { PanelView, QuoteView } from "./views";
import { ChartPanelComponent } from "./chart-panel.component";
import { QuotesPanelComponent } from "./quotes-panel.component";
import { ProductsPanelComponent } from "./products-panel.component";
import { RobotsPanelComponent } from "./robots-panel.component";
import { SetupsListComponent } from "../setups/setups-list.component";
import { ViewPanelComponent } from "../views/view-panel.component";
import { ActivityListComponent } from "../jobs/activity-list.component";
import { JournalPanelComponent } from "../journal/journal-panel.component";
import { NewsListComponent } from "../news/news-list.component";
import { viewHeight } from "../views/views";
import { changeSince, formatPrice, isStale, quoteDate, timeframeLabel } from "./candles";
import {
  DOCK_SLOTS,
  MAX_TOP,
  MIN_H,
  MIN_W,
  Position,
  STACK_DX,
  STACK_DY,
  Side,
  Size,
  assignSides,
  FRAME,
  clampPosition,
  dockOrder,
  flipGrip,
  isNarrow,
  nextZ,
  anchorPoint,
  maximizedSize,
  maxedAfter,
  resizeLimit,
  sameSides,
  sanitizePositions,
  sanitizeSides,
  sanitizeSizes,
  stackRanks,
} from "./layout";

/** Tailles choisies à la main, par encart, gardées sur cet écran (les écrans n'ont pas la même taille). */
const SIZES_KEY = "kopilia.panelSizes";
/** Positions des encarts sortis de leur marge, par encart, gardées sur cet écran. */
const POSITIONS_KEY = "kopilia.panelPositions";
/** Marge (gauche ou droite) de chaque encart, reçue à son ouverture, gardée sur cet écran. */
const SIDES_KEY = "kopilia.panelSides";
/** Au-delà de ce déplacement, un appui sur l'en-tête devient un glissement. */
const DRAG_START = 4;
/** Hauteur minimale d'un encart empilé (sa base aligné sur celle de l'encart du dessous). */
const STACKED_MIN_H = 160;
/** La liste des produits ne descend pas sous cette hauteur (en-tête et quelques lignes), même quand la place manque. */
const FILL_MIN_H = 160;
/** L'encart de la marge touché en dernier passe devant les autres (un graphique agrandi peut en chevaucher un). */
const TOUCHED_Z = 15;
/** Les encarts sortis de leur marge passent devant ceux qui y sont, empilés et touché compris. */
const FREE_Z = 20;
/** Un graphique agrandi passe devant tous les autres encarts. */
const MAX_Z = 900;
/** Graphiques agrandis (presque tout l'écran), gardés sur cet écran. */
const MAXED_KEY = "kopilia.panelMaximized";

/** Valeur gardée dans le navigateur (JSON), validée par `sanitize` ; rien si absente ou illisible. */
function read<T>(key: string, sanitize: (raw: unknown) => Record<string, T>): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : tailles et positions ne durent que la page */
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Graphiques agrandis relus : des identifiants seulement. */
function readMaxed(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MAXED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeMaxed(ids: string[]): void {
  try {
    localStorage.setItem(MAXED_KEY, JSON.stringify(ids));
  } catch {
    /* stockage indisponible */
  }
}

/** Hauteur d'un suivi de n lignes (en-tête, lignes de 31 px, marges) : pour le garder dans la fenêtre. */
function quotesHeight(rows: number): number {
  return 58 + 31 * rows;
}

/** Hauteur de la liste des setups (comme un suivi ; vide : sa phrase sur deux lignes) : pour la garder dans la fenêtre. */
function setupsHeight(rows: number): number {
  return quotesHeight(Math.max(rows, 2));
}

/**
 * Le tableau de bord : les encarts (graphique d'un produit, suivi des cours)
 * dans les marges, de part et d'autre de l'orbe, dans le même habillage que
 * les tâches et les demandes d'accord ; sur un écran étroit, dans la colonne,
 * au-dessus de l'orbe. Ouverts et fermés à la voix par Kopilia, ou à la main ;
 * un graphique se redimensionne par sa poignée, jusqu'à une marge du bord de
 * la fenêtre, ou s'agrandit presque à tout l'écran par son bouton (entre la
 * barre du haut et la bande d'appel, où la discussion se range à droite des
 * boutons) ; un encart glissé par son en-tête sort de sa marge et se pose où
 * on le lâche (double-clic : il y revient). Les encarts passent devant la
 * discussion, qui ne change ni de place ni de largeur. Deux encarts par marge l'un sous
 * l'autre ; les suivants s'empilent sur le dernier, un peu décalés, et un clic
 * fait passer devant celui de dessous. Tailles et positions sont gardées sur
 * cet écran.
 */
@Component({
  selector: "kp-dashboard",
  standalone: true,
  imports: [
    NgTemplateOutlet,
    ChartPanelComponent,
    QuotesPanelComponent,
    ProductsPanelComponent,
    RobotsPanelComponent,
    SetupsListComponent,
    ViewPanelComponent,
    ActivityListComponent,
    NewsListComponent,
    JournalPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /* Les marges de la colonne centrale (760 px) : un encart par côté, puis en dessous. */
      :host { display: contents; --dock-w: clamp(280px, calc((100vw - 760px) / 2 - 32px), 440px); }
      /* Une couche sur tout l'écran, transparente aux clics entre les encarts ; un seul
         ordre de superposition pour tous les encarts, libres ou dans leur marge. */
      .board { position: fixed; inset: 0; z-index: 3; pointer-events: none; }
      .dock { position: absolute; top: 58px; display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 190px); }
      .dock.left { left: 16px; align-items: flex-start; }
      /* À droite, la discussion occupe le bas de l'écran. */
      .dock.right { right: 16px; align-items: flex-end; max-height: calc(64vh - 80px); }
      .panel {
        position: relative; pointer-events: auto; display: flex; flex-direction: column; box-sizing: border-box;
        width: var(--dock-w); max-width: calc(100vw - 32px);
        background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 8px 12px;
        animation: rise .5s ease both;
        /* Rien ne se sélectionne dans un encart (nom, prix, unités, menus) ; les champs de saisie restent éditables. */
        user-select: none; -webkit-user-select: none;
      }
      /* Au-delà des deux premiers, un encart s'empile sur le dernier de sa marge, décalé vers le bas et vers le centre. */
      .panel.stacked { position: absolute; box-shadow: 0 -4px 18px rgba(0, 0, 0, .3); }
      /* Sorti de sa marge : posé où on l'a lâché, devant les autres. */
      .panel.free { position: fixed; box-shadow: 0 12px 32px rgba(0, 0, 0, .28); }
      @keyframes rise { from { opacity: 0; translate: 0 10px; } }
      /* Une seule ligne : le nom, le prix du moment, la variation du jour, la fermeture. */
      .head { display: flex; align-items: center; gap: 6px; min-height: 24px; cursor: grab; touch-action: none; user-select: none; }
      .panel.moving .head { cursor: grabbing; }
      /* Si la place manque (encart étroit, nom long), seul le nom se raccourcit. */
      .titles { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; }
      .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 600; }
      .last { font-size: 15px; font-variant-numeric: tabular-nums; }
      .delta { font-size: 12px; font-variant-numeric: tabular-nums; }
      .muted { color: var(--muted); }
      .closed { align-self: center; font-size: 10px; line-height: 15px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 5px; }
      .icon { border: none; background: none; color: var(--muted); padding: 0 2px; font-size: 18px; line-height: 1; cursor: pointer; }
      .icon:hover { color: var(--text); }
      /* Poignée dans le coin qui regarde le centre de l'écran : deux traits en diagonale. */
      .grip {
        position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; opacity: .55;
        cursor: nwse-resize; touch-action: none; border-bottom-right-radius: 10px;
        background: linear-gradient(135deg, transparent 0 56%, var(--muted) 56% 63%, transparent 63% 76%, var(--muted) 76% 83%, transparent 83%);
      }
      .grip:hover, .panel.resizing .grip { opacity: 1; }
      .grip.flip { right: auto; left: 2px; cursor: nesw-resize; transform: scaleX(-1); }
      /* Agrandi : entre la barre du haut et la bande d'appel, devant les autres encarts ; ni poignée ni déplacement. */
      .panel.maxed { box-shadow: 0 16px 48px rgba(0, 0, 0, .4); }
      .panel.maxed .head { cursor: default; }
      .icon svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      @media (max-width: 1239px) {
        .board { position: static; display: flex; flex-direction: column; gap: 8px; pointer-events: auto; }
        .dock, .dock.left, .dock.right { position: static; max-height: none; align-items: stretch; }
        .panel { width: auto; }
        .head { cursor: default; touch-action: auto; }
        .grip.flip { right: 2px; left: auto; cursor: nwse-resize; transform: none; }
      }
      /* Montré depuis la liste des produits : un éclair autour du cadre, sur un calque à part (l'animation d'arrivée ne repart pas). */
      /*
       * La liste des produits tient dans sa marge, entre la barre du haut et le bas de
       * la marge, comme les graphiques : elle rétrécit la première pour laisser leur
       * place aux encarts de dessous, sans descendre sous quelques lignes, et défile.
       */
      .panel.fill { min-height: 160px; flex: 0 100 auto; } /* 160 : FILL_MIN_H */
      .panel.flash::after {
        content: ""; position: absolute; inset: -1px; border-radius: 12px; pointer-events: none; animation: flash 0.9s ease-out both;
      }
      @keyframes flash { 0%, 40% { box-shadow: 0 0 0 2px var(--accent); } 100% { box-shadow: 0 0 0 2px transparent; } }
      @media (prefers-reduced-motion: reduce) { .panel, .panel.flash::after { animation: none; } }
    `,
  ],
  template: `
    @if (kopilia.panels().length) {
      <div class="board">
        <div class="dock left">
          @for (p of left(); track p.id) {
            <ng-container *ngTemplateOutlet="card; context: { $implicit: p, side: 'left' }" />
          }
        </div>
        @if (right().length) {
          <div class="dock right">
            @for (p of right(); track p.id) {
              <ng-container *ngTemplateOutlet="card; context: { $implicit: p, side: 'right' }" />
            }
          </div>
        }
      </div>
    }

    <ng-template #card let-p let-side="side">
      <article
        class="panel"
        [class.free]="isFree(p.id) || isMaxed(p.id)"
        [class.maxed]="isMaxed(p.id)"
        [class.stacked]="rank(p.id) > 0"
        [class.resizing]="resizing() === p.id"
        [class.moving]="moving() === p.id"
        [class.flash]="flashing() === p.id"
        [class.fill]="p.kind === 'products'"
        [style.max-height.px]="fillMax(p)"
        [style.width.px]="chartSize(p)?.w ?? null"
        [style.height.px]="heightOf(p)"
        [style.left.px]="leftOf(p.id, side)"
        [style.right.px]="rank(p.id) && side === 'right' ? rank(p.id) * stackDx : null"
        [style.top.px]="topOf(p.id, side)"
        [style.z-index]="zOf(p.id)"
        [attr.data-panel-anchor]="p.id"
        (pointerdown)="raise(p.id)"
        [attr.aria-label]="p.kind === 'chart' ? p.title + ', ' + label(p.timeframe) : p.title"
      >
        <div
          class="head"
          [attr.title]="narrow() ? null : isMaxed(p.id) ? 'Double-clic : taille d’avant' : 'Glisser pour déplacer · double-clic : retour dans la marge'"
          (pointerdown)="startMove($event, p)"
          (pointermove)="moveMove($event)"
          (pointerup)="endMove()"
          (pointercancel)="endMove()"
          (dblclick)="isMaxed(p.id) ? toggleMax(p.id) : redock(p.id)"
        >
          <div class="titles">
            <span class="title">{{ p.title }}</span>
            @if (p.kind === 'chart') {
              @if (quoteOf(p); as q) {
                <span class="last">{{ priceOf(p, q) }}</span>
                @if (changeOf(q); as c) {
                  <span class="delta" [class.trend-up]="c.sign > 0" [class.trend-down]="c.sign < 0" [class.trend-flat]="c.sign === 0" title="Variation depuis l'ouverture du jour">{{ c.text }}</span>
                }
                @if (closed(q)) {
                  <span class="closed" [attr.title]="'Marché fermé · dernière cotation ' + lastQuote(q)">fermé</span>
                }
              } @else {
                <span class="last muted">—</span>
              }
            }
          </div>
          @if (p.kind === 'chart' && !narrow()) {
            <button
              type="button"
              class="icon"
              [attr.title]="isMaxed(p.id) ? 'Taille d’avant' : 'Agrandir'"
              [attr.aria-label]="(isMaxed(p.id) ? 'Remettre à sa taille ' : 'Agrandir ') + p.title"
              (click)="toggleMax(p.id)"
            >
              @if (isMaxed(p.id)) {
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5V6H2.5M10 2.5V6h3.5M6 13.5V10H2.5M10 13.5V10h3.5" /></svg>
              } @else {
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" /></svg>
              }
            </button>
          }
          <button type="button" class="icon" [attr.aria-label]="'Fermer ' + p.title" (click)="kopilia.closePanel(p.id)">×</button>
        </div>
        @if (p.kind === 'chart') {
          <kp-chart-panel [panel]="p" />
          @if (!isMaxed(p.id)) {
            <span
            class="grip"
            [class.flip]="gripFlip(p.id, side)"
            title="Redimensionner"
            (pointerdown)="startResize($event, p.id, side)"
            (pointermove)="moveResize($event)"
            (pointerup)="endResize()"
            (pointercancel)="endResize()"
          ></span>
          }
        } @else if (p.kind === 'setups') {
          <kp-setups-list />
        } @else if (p.kind === 'activity') {
          <kp-activity-list />
        } @else if (p.kind === 'journal') {
          <kp-journal-panel />
        } @else if (p.kind === 'news') {
          <kp-news-list [panel]="p" />
        } @else if (p.kind === 'view') {
          <kp-view-panel [panel]="p" />
        } @else if (p.kind === 'products') {
          <kp-products-panel [panel]="p" />
        } @else if (p.kind === 'robots') {
          <kp-robots-panel />
        } @else {
          <kp-quotes-panel [panel]="p" />
        }
      </article>
    </ng-template>
  `,
})
export class DashboardComponent {
  readonly kopilia = inject(KopiliaService);
  readonly sizes = signal<Record<string, Size>>(read(SIZES_KEY, sanitizeSizes));
  readonly positions = signal<Record<string, Position>>(read(POSITIONS_KEY, sanitizePositions));
  /** Côtés enregistrés ; `sideOf` en déduit celui de chaque encart affiché. */
  private readonly sides = signal<Record<string, Side>>(read(SIDES_KEY, sanitizeSides));
  /**
   * Chaque encart garde la marge reçue à son ouverture (fermer un encart ne fait
   * pas changer les autres de côté, donc pas de rechargement) ; un nouveau va du
   * côté le moins chargé. Un encart sorti de sa marge y garde sa place.
   */
  readonly sideOf = computed(() =>
    assignSides(
      this.kopilia.panels().map((p) => p.id),
      this.sides(),
      new Set(Object.keys(this.positions())),
    ),
  );
  /** Encart de la marge touché en dernier : devant les autres, et sur le dessus de sa pile ; un nouvel encart y passe à son tour. */
  readonly raised = signal<string | null>(null);
  /** Les encarts de chaque marge, de haut en bas, pile comprise ; aucun sur un écran étroit, où tout est dans la colonne. */
  readonly order = computed(() =>
    this.narrow()
      ? { left: [], right: [] }
      : dockOrder(
          this.kopilia.panels().map((p) => p.id),
          this.sideOf(),
          new Set([...Object.keys(this.positions()), ...this.maxed()]),
          this.raised(),
        ),
  );
  /** Rang dans la pile de sa marge (0 : pas empilé). */
  readonly ranks = computed(() => stackRanks(this.order()));
  /** Place de la base de la pile de chaque marge, que les encarts empilés reprennent : mesurée après chaque rendu. */
  readonly stackBase = signal<Partial<Record<Side, { top: number; h: number }>>>({});
  readonly stackDx = STACK_DX;
  readonly left = computed<PanelView[]>(() => this.kopilia.panels().filter((p) => this.sideOf()[p.id] === "left"));
  readonly right = computed<PanelView[]>(() => this.kopilia.panels().filter((p) => this.sideOf()[p.id] === "right"));
  readonly viewport = signal({ w: window.innerWidth, h: window.innerHeight });
  /** Écran étroit : encarts dans la colonne, ni marges ni déplacement (même seuil que le CSS). */
  readonly narrow = computed(() => isNarrow(this.viewport().w));
  /**
   * Les positions, ramenées dans la fenêtre du moment : un écran qui rétrécit ne
   * perd aucun encart, et un suivi qui s'allonge remonte s'il touchait le bas.
   */
  readonly placed = computed<Record<string, Position>>(() => {
    const vp = this.viewport();
    const sizes = this.sizes();
    const panels = new Map(this.kopilia.panels().map((p) => [p.id, p]));
    const out: Record<string, Position> = {};
    for (const [id, p] of Object.entries(this.positions())) {
      const panel = panels.get(id);
      const s = panel?.kind === "chart" ? sizes[id] : undefined;
      const h =
        panel?.kind === "quotes"
          ? quotesHeight(panel.symbols?.length ?? 0)
          : panel?.kind === "setups" || panel?.kind === "activity" || panel?.kind === "journal" || panel?.kind === "robots"
            ? setupsHeight(panel.kind === "setups" ? this.kopilia.watchlist().length : panel.kind === "journal" ? 8 : 4)
            : panel?.kind === "news"
              ? quotesHeight(10)
              : panel?.kind === "products"
                ? FILL_MIN_H
                : panel?.kind === "view"
                  ? viewHeight(panel.view, vp.h - 2 * FRAME)
                  : (s?.h ?? MIN_H);
      out[id] = { ...clampPosition(p, s?.w ?? MIN_W, h, vp.w, vp.h), z: p.z };
    }
    return out;
  });
  /** Encart en cours de redimensionnement. */
  readonly resizing = signal<string | null>(null);
  /** Encart en cours de déplacement. */
  readonly moving = signal<string | null>(null);
  private drag?: { id: string; side: Side; x: number; y: number; w: number; h: number; free: boolean; px: number; py: number };
  /** Graphiques agrandis : ils gardent leur place et leur taille, rendues au retour. */
  readonly maxed = signal<string[]>(readMaxed());
  /** Un graphique affiché est agrandi : la discussion se range dans la bande d'appel, à droite des boutons. */
  readonly anyMaxed = computed(() => this.kopilia.panels().some((p) => p.kind === "chart" && this.isMaxed(p.id)));
  private move?: { id: string; chart: boolean; x: number; y: number; left: number; top: number; w: number; h: number; started: boolean };

  /** L'heure, à la demi-minute : un marché qui ferme se voit sans attendre de cotation. */
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    // Un encart fermé n'a plus de taille ni de position à garder (une fois la liste connue :
    // au chargement, avant la réponse du serveur, elle est vide sans que rien ne soit fermé).
    // Seul un graphique a une taille choisie : le suivi suit le nombre de ses lignes.
    effect(
      () => {
        if (!this.kopilia.panelsKnown()) return;
        const ids = new Set(this.kopilia.panels().map((p) => p.id));
        const charts = new Set(
          this.kopilia
            .panels()
            .filter((p) => p.kind === "chart")
            .map((p) => p.id),
        );
        const sizes = untracked(this.sizes);
        const positions = untracked(this.positions);
        if (Object.keys(sizes).some((id) => !charts.has(id))) {
          const kept = Object.fromEntries(Object.entries(sizes).filter(([id]) => charts.has(id)));
          this.sizes.set(kept);
          write(SIZES_KEY, kept);
        }
        if (Object.keys(positions).some((id) => !ids.has(id))) {
          const kept = Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id)));
          this.positions.set(kept);
          write(POSITIONS_KEY, kept);
        }
        const maxed = untracked(this.maxed);
        if (maxed.some((id) => !charts.has(id))) {
          const kept = maxed.filter((id) => charts.has(id));
          this.maxed.set(kept);
          writeMaxed(kept);
        }
      },
      { allowSignalWrites: true },
    );
    // Un nouvel encart s'empile devant : celui qu'on avait fait passer devant reprend sa place.
    let known = new Set<string>();
    effect(
      () => {
        const ids = this.kopilia.panels().map((p) => p.id);
        if (ids.some((id) => !known.has(id))) this.raised.set(null);
        known = new Set(ids);
      },
      { allowSignalWrites: true },
    );
    // Un affichage demandé à la voix : appliqué une fois, puis effacé.
    effect(
      () => {
        const asked = this.kopilia.panelDisplay();
        if (!asked) return;
        untracked(() => this.applyDisplay(asked.panelId, asked.display));
        this.kopilia.panelDisplay.set(null);
      },
      { allowSignalWrites: true },
    );
    // Un encart montré depuis la liste des produits : devant, avec un éclair.
    effect(
      () => {
        const asked = this.kopilia.panelFocus();
        if (!asked) return;
        untracked(() => this.front(asked.panelId));
        this.kopilia.panelFocus.set(null);
      },
      { allowSignalWrites: true },
    );
    afterRender(() => this.measureStacks());
    // Les côtés attribués aux nouveaux encarts sont enregistrés (ceux des encarts fermés oubliés),
    // une fois la liste connue : avant, la liste vide effacerait tout.
    effect(
      () => {
        if (!this.kopilia.panelsKnown()) return;
        const side = this.sideOf();
        if (sameSides(side, untracked(this.sides))) return;
        this.sides.set(side);
        write(SIDES_KEY, side);
      },
      { allowSignalWrites: true },
    );
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Les encarts affichés, par le bord qui regarde l'orbe (en `cx`, `cy`) : la galaxie les y rattache d'un fil. */
  anchors(cx: number, cy: number): Array<{ id: string; x: number; y: number }> {
    const out: Array<{ id: string; x: number; y: number }> = [];
    for (const el of Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>("[data-panel-anchor]"))) {
      const at = anchorPoint(el.getBoundingClientRect(), cx, cy);
      if (at) out.push({ id: el.dataset["panelAnchor"]!, ...at });
    }
    return out;
  }

  @HostListener("window:resize")
  onResize(): void {
    this.viewport.set({ w: window.innerWidth, h: window.innerHeight });
  }

  /** Taille choisie à la main : seul un graphique en a une (le suivi suit ses lignes), et pas toujours. */
  chartSize(p: PanelView): Size | undefined {
    if (p.kind !== "chart") return undefined;
    if (this.isMaxed(p.id)) {
      const vp = this.viewport();
      return maximizedSize(vp.w, vp.h);
    }
    return this.sizes()[p.id];
  }

  label(tf: string | undefined): string {
    return timeframeLabel(tf);
  }

  /* ---------- En-tête d'un graphique : prix du moment, variation du jour, marché fermé ---------- */

  quoteOf(p: PanelView): QuoteView | undefined {
    return this.kopilia.quotes()[p.symbol ?? ""];
  }

  priceOf(p: PanelView, q: QuoteView): string {
    return formatPrice(q.bid, p.digits ?? q.digits ?? 5);
  }

  changeOf(q: QuoteView) {
    return changeSince(q.dayOpen, q.bid);
  }

  closed(q: QuoteView): boolean {
    return isStale(q.time, this.now());
  }

  lastQuote(q: QuoteView): string {
    return quoteDate(q.time);
  }

  /* ---------- Empilement au-delà de deux encarts par marge ---------- */

  rank(id: string): number {
    return this.ranks()[id] ?? 0;
  }

  /** Un encart empilé : à la place du dernier de sa marge, décalé de son rang (vers le bas). */
  topOf(id: string, side: Side): number | null {
    if (this.isMaxed(id)) return MAX_TOP;
    if (this.isFree(id)) return this.placed()[id].y;
    const k = this.rank(id);
    const base = this.stackBase()[side];
    return k && base ? base.top + k * STACK_DY : null;
  }

  leftOf(id: string, side: Side): number | null {
    if (this.isMaxed(id)) return FRAME;
    if (this.isFree(id)) return this.placed()[id].x;
    const k = this.rank(id);
    return k && side === "left" ? k * STACK_DX : null;
  }

  /** La hauteur choisie à la main, sinon, empilé, celle du dernier encart de sa marge moins son décalage : les bas restent alignés. */
  heightOf(p: PanelView): number | null {
    const own = this.chartSize(p)?.h;
    if (own) return own;
    const k = this.rank(p.id);
    const base = k ? this.stackBase()[this.sideOf()[p.id]] : undefined;
    return base ? Math.max(STACKED_MIN_H, base.h - k * STACK_DY) : null;
  }

  /** Libres devant tout ; puis celui de la marge touché en dernier ; dans une pile, chacun devant ceux de dessous. */
  zOf(id: string): number | null {
    if (this.isMaxed(id)) return MAX_Z;
    if (this.isFree(id)) return FREE_Z + this.placed()[id].z;
    if (this.raised() === id) return TOUCHED_Z;
    return this.rank(id) || null;
  }

  /** Un clic sur un encart de la marge le passe devant les autres (sur le dessus de sa pile, s'il est dans une). */
  raise(id: string): void {
    if (id in this.ranks()) this.raised.set(id);
  }

  /**
   * Hauteur au plus de la liste des produits sortie de sa marge : jusqu'au bas
   * de la fenêtre, moins sa marge (comme un graphique qu'on agrandit par sa
   * poignée). Dans sa marge, c'est la marge qui la borne ; empilée, sa hauteur
   * est celle de la pile.
   */
  fillMax(p: PanelView): number | null {
    if (p.kind !== "products" || !this.isFree(p.id)) return null;
    return Math.max(FILL_MIN_H, this.viewport().h - FRAME - this.placed()[p.id].y);
  }

  /** Encart signalé d'un éclair (montré depuis la liste des produits). */
  readonly flashing = signal<string | null>(null);
  private flashTimer?: ReturnType<typeof setTimeout>;

  /** Devant les autres, avec un éclair : sorti de sa marge, au-dessus des autres sortis ; dans sa marge, comme un clic. */
  front(id: string): void {
    if (this.isFree(id) && !this.isMaxed(id)) {
      const next = { ...this.positions(), [id]: { ...this.positions()[id], z: nextZ(this.positions()) } };
      this.positions.set(next);
      write(POSITIONS_KEY, next);
    } else {
      this.raise(id);
    }
    // Écran étroit : les encarts sont dans la colonne, celui-ci peut être hors de vue.
    if (this.narrow())
      this.host.nativeElement.querySelector<HTMLElement>(`[data-panel-anchor="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.flashing.set(null);
    clearTimeout(this.flashTimer);
    // Un tour plus tard : l'animation repart même si le même encart vient d'être signalé.
    this.flashTimer = setTimeout(() => {
      this.flashing.set(id);
      this.flashTimer = setTimeout(() => this.flashing.set(null), 900);
    }, 0);
  }

  /** La base de la pile de chaque marge : sa place dans la marge, que les encarts empilés reprennent. */
  private measureStacks(): void {
    const order = this.order();
    const next: Partial<Record<Side, { top: number; h: number }>> = {};
    for (const side of ["left", "right"] as const) {
      if (order[side].length <= DOCK_SLOTS) continue;
      const el = this.host.nativeElement.querySelector<HTMLElement>(`[data-panel-anchor="${order[side][DOCK_SLOTS - 1]}"]`);
      if (el) next[side] = { top: el.offsetTop, h: el.offsetHeight };
    }
    const prev = this.stackBase();
    const same = (["left", "right"] as const).every((s) => prev[s]?.top === next[s]?.top && prev[s]?.h === next[s]?.h);
    if (!same) this.stackBase.set(next);
  }

  /* ---------- Agrandir : presque tout l'écran ---------- */

  /** Agrandi (jamais sur un écran étroit : tout est dans la colonne). */
  isMaxed(id: string): boolean {
    return !this.narrow() && this.maxed().includes(id);
  }

  /** Agrandit un graphique, ou lui rend sa place et sa taille d'avant (bouton, double-clic sur l'en-tête agrandi). */
  toggleMax(id: string): void {
    const next = this.maxed().includes(id) ? this.maxed().filter((x) => x !== id) : [...this.maxed(), id];
    this.maxed.set(next);
    writeMaxed(next);
  }

  /** Échap : le dernier graphique agrandi reprend sa taille. Faux s'il n'y en avait pas. */
  restoreMaximized(): boolean {
    const last = this.maxed()
      .filter((id) => this.isMaxed(id))
      .at(-1);
    if (!last) return false;
    this.toggleMax(last);
    return true;
  }

  /**
   * Agrandir, réduire, ramener dans sa marge, à la voix : comme le bouton, Échap
   * ou le double-clic, avec un seul graphique agrandi à la fois. Rien ne
   * s'agrandit sur un écran étroit.
   */
  applyDisplay(id: string | undefined, display: PanelDisplay): void {
    const next = display === "maximize" && this.narrow() ? null : maxedAfter(this.maxed(), id, display);
    if (next) {
      this.maxed.set(next);
      writeMaxed(next);
    }
    if (display === "dock" && id) this.redock(id);
  }

  /** Sorti de sa marge (jamais sur un écran étroit : tout est dans la colonne). */
  isFree(id: string): boolean {
    return !this.narrow() && id in this.positions();
  }

  /** La poignée regarde le centre de l'écran : selon la marge, ou la place de l'encart s'il en est sorti. */
  gripFlip(id: string, side: Side): boolean {
    if (!this.isFree(id)) return side === "right";
    const p = this.placed()[id];
    return flipGrip(p.x, this.sizes()[id]?.w ?? MIN_W, this.viewport().w);
  }

  /* ---------- Déplacement par l'en-tête ---------- */

  startMove(e: PointerEvent, panel: PanelView): void {
    if (e.button !== 0 || this.narrow() || this.isMaxed(panel.id) || (e.target as HTMLElement).closest("button")) return;
    const article = (e.target as HTMLElement).closest("article");
    if (!article) return;
    const r = article.getBoundingClientRect();
    const chart = panel.kind === "chart";
    this.move = { id: panel.id, chart, x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, started: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  moveMove(e: PointerEvent): void {
    const m = this.move;
    if (!m) return;
    const dx = e.clientX - m.x;
    const dy = e.clientY - m.y;
    if (!m.started) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      // Il sort de sa marge et passe devant. Un graphique garde la taille qu'il y avait ;
      // le suivi n'a pas de taille fixe : il grandit et rétrécit avec ses lignes.
      m.started = true;
      this.moving.set(m.id);
      if (m.chart) this.sizes.update((s) => ({ ...s, [m.id]: { w: Math.round(m.w), h: Math.round(m.h) } }));
      this.positions.update((p) => ({ ...p, [m.id]: { x: m.left, y: m.top, z: nextZ(p) } }));
    }
    const vp = this.viewport();
    const at = clampPosition({ x: m.left + dx, y: m.top + dy }, m.w, m.h, vp.w, vp.h);
    this.positions.update((p) => ({ ...p, [m.id]: { ...p[m.id], ...at } }));
    e.preventDefault();
  }

  endMove(): void {
    const m = this.move;
    if (!m) return;
    this.move = undefined;
    if (!m.started) return;
    this.moving.set(null);
    write(SIZES_KEY, this.sizes());
    write(POSITIONS_KEY, this.positions());
  }

  /** Retour dans sa marge (double-clic sur l'en-tête). */
  redock(id: string): void {
    if (!(id in this.positions())) return;
    const { [id]: _, ...rest } = this.positions();
    this.positions.set(rest);
    write(POSITIONS_KEY, rest);
  }

  /* ---------- Redimensionnement par la poignée ---------- */

  startResize(e: PointerEvent, id: string, side: Side): void {
    const article = this.host.nativeElement.querySelector<HTMLElement>(`[data-panel-anchor="${id}"]`);
    if (!article) return;
    const r = article.getBoundingClientRect();
    const free = this.isFree(id);
    const at = free ? this.placed()[id] : { x: r.left, y: r.top };
    this.drag = {
      id,
      side: this.gripFlip(id, side) ? "right" : "left",
      x: e.clientX,
      y: e.clientY,
      w: r.width,
      h: r.height,
      free,
      px: at.x,
      py: at.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.raise(id);
    this.resizing.set(id);
    e.preventDefault();
  }

  /** La largeur grandit vers le centre de l'écran (vers la droite à gauche, vers la gauche à droite), la hauteur vers le bas. */
  moveResize(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const flip = d.side === "right" && !this.narrow();
    const vp = this.viewport();
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // Pas d'autre limite que la marge du bord de la fenêtre : son bord droit (poignée à gauche) ou gauche reste en place.
    const max = resizeLimit({ left: d.px, right: d.px + d.w, top: d.py }, flip, vp.w, vp.h);
    const w = Math.round(clamp(d.w + (flip ? -dx : dx), MIN_W, max.w));
    const h = Math.round(clamp(d.h + dy, MIN_H, max.h));
    if (d.free) this.positions.update((p) => ({ ...p, [d.id]: { ...p[d.id], x: Math.round(d.side === "right" ? d.px + d.w - w : d.px) } }));
    this.sizes.update((s) => ({ ...s, [d.id]: { w, h } }));
  }

  endResize(): void {
    if (!this.drag) return;
    const free = this.drag.free;
    this.drag = undefined;
    this.resizing.set(null);
    write(SIZES_KEY, this.sizes());
    if (free) write(POSITIONS_KEY, this.positions());
  }
}
