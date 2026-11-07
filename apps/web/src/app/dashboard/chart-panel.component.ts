import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import {
  Alert,
  Drawing,
  DrawingShape,
  INDICATOR_COLORS,
  Indicator,
  IndicatorColor,
  IndicatorInput,
  MAX_INDICATORS,
  MA_NAMES,
  MA_TYPES,
  MaType,
  PRICE_SOURCES,
  SOURCE_NAMES,
  completeIndicator,
  fibLevels,
  fibRatioLabel,
  indicatorLabel,
  indicatorSchema,
  lotsLabel,
  moneyLabel,
  percentLabel,
  sameIndicator,
  type Risk,
} from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import type { PanelView, QuoteView } from "./views";
import { CHART_TIMEFRAMES, Candle, TIMEFRAME_CHIP, TIMEFRAME_NAMES, TIMEFRAME_SECONDS, applyQuote, formatPrice, mergeCandles, resyncCandles } from "./candles";
import { ChartTip, TIP_W, TipKey, chartTips, tipLeft } from "./chart-tips";
import { CandleChart, ChartAutoMap, ChartBoxInfo, ChartSetup, ChartTarget, ChartTheme, ShownDrawing, timeLabel } from "./candle-chart";
import { DrawTool, Magnet, fibLevelNear, shapeOf } from "./chart-tools";
import { AlertDraft, alertOn, canWatch, draftOf, lineDraft, priceDraft } from "./chart-alerts";
import { AlertMenuComponent } from "./alert-menu.component";
import { RiskMenuComponent } from "../trading/risk-menu.component";
import { askNotifications } from "./alert-signals";
import { cssVar, isLight, onThemeChange, SYSTEM_FONT } from "../theme";

/** Les ajouts en un clic, en bas du panneau des indicateurs (ceux déjà tracés n'y sont plus). */
const QUICK: IndicatorInput[] = [
  { kind: "sma", period: 20 },
  { kind: "sma", period: 50 },
  { kind: "sma", period: 200 },
  { kind: "ema", period: 9 },
  { kind: "ema", period: 21 },
  { kind: "rsi" },
];

/** Cmd sur Mac, Ctrl ailleurs : la touche qui inverse l'aimant. */
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Ce que l'outil attend, en surimpression le temps du tracé. */
const TOOL_HINTS: Record<DrawTool, string> = {
  hline: `Clique un prix · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
  trendline: `Clique deux points (ou glisse) · Maj : 0°, 45°, 90° · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
  zone: `Clique deux coins (ou glisse) · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
  fib: `Clique le début puis la fin du mouvement (ou glisse) · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
  fibext: `Clique le début et la fin de l'impulsion, puis la fin du repli · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
  long: `Clique le prix d'entrée de l'achat, puis tire l'objectif et le stop · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
  short: `Clique le prix d'entrée de la vente, puis tire l'objectif et le stop · ${MOD_KEY} inverse l'aimant · Échap pour annuler`,
};

const MAGNET_TITLES: Record<Magnet, string> = {
  off: `Aimant désactivé (${MOD_KEY} maintenu : aimant fort)`,
  weak: `Aimant faible : colle aux prix de la bougie quand on en est près (${MOD_KEY} maintenu : désactivé)`,
  strong: `Aimant fort : colle toujours au prix le plus proche de la bougie (${MOD_KEY} maintenu : désactivé)`,
};
const MAGNET_NEXT: Record<Magnet, Magnet> = { off: "weak", weak: "strong", strong: "off" };
/** L'aimant du moment, dans sa bulle. */
const MAGNET_STATES: Record<Magnet, string> = { off: "Maintenant : coupé", weak: "Maintenant : faible", strong: "Maintenant : fort" };
/** Les bulles des outils. */
const TIPS = chartTips(MOD_KEY);
/** Délai avant la première bulle ; les suivantes viennent tout de suite, tant qu'on reste sur la barre. */
const TIP_DELAY_MS = 450;
/** L'aimant choisi, gardé sur cet écran. */
const MAGNET_KEY = "kopilia.chartMagnet";
/** La carte automatique montrée ou non, gardée pour cet écran. */
const AUTOMAP_KEY = "kopilia.autoMap";
/** Les niveaux des setups de l'IA montrés ou non, gardés pour cet écran. */
const AI_LEVELS_KEY = "kopilia.aiLevels";
/** La carte automatique affichée est relue à ce rythme (elle ne change qu'à la clôture des bougies). */
const AUTOMAP_REFRESH_MS = 5 * 60_000;

const COLOR_NAMES: Record<IndicatorColor, string> = {
  orange: "orange",
  violet: "violet",
  cyan: "cyan",
  pink: "rose",
  green: "vert",
  yellow: "jaune",
  blue: "bleu",
  red: "rouge",
  gray: "gris",
};

/** L'indicateur en cours de réglage : un nouveau (pas encore ajouté) ou un tracé. */
interface Editor {
  draft: Indicator;
  isNew: boolean;
}

/** Une ligne du menu du clic droit (ou du « + ») sur le graphique. */
interface MenuItem {
  label: string;
  icon: "bell" | "line" | "extend" | "trash" | "pause" | "play" | "edit" | "keep" | "ai" | "risk";
  /** Raccourci affiché à droite. */
  hint?: string;
  /** Bulle d'aide (la raison d'un niveau de l'IA, le texte entier d'une suggestion). */
  title?: string;
  /** Coché (prolongée vers la droite). */
  on?: boolean;
  danger?: boolean;
  run: () => void;
}

/** Hauteur d'une ligne du menu du clic droit (pour le garder dans le graphique). */
const MENU_ITEM_H = 28;
const MENU_W = 230;

/**
 * Le graphique en bougies d'un produit : celles du courtier (par le serveur),
 * la bougie en cours animée par les cotations, le passé chargé en remontant le
 * temps ; ses indicateurs (moyennes mobiles, RSI), les tracés du produit
 * (lignes, obliques, zones, Fibonacci), posés, déplacés et effacés à la souris ou à la
 * voix, et ses alertes (clic droit sur une ligne ou un prix, « + » contre
 * l'axe, Alt+A, la cloche de la barre d'outils). Dessiné par le moteur maison
 * (CandleChart), aux couleurs du thème ; il remplit l'encart, quelle que soit
 * sa taille. Le prix du moment est dans l'en-tête de l'encart ; ici, le
 * graphique, et sur la ligne du bas les unités de temps et les outils.
 */
@Component({
  selector: "kp-chart-panel",
  standalone: true,
  imports: [AlertMenuComponent, RiskMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: flex; flex-direction: column; flex: 1; min-height: 0; container-type: inline-size; }
      /* Le graphique prend toute la place restante de l'encart (250 px s'il n'est pas redimensionné). */
      .chart { position: relative; flex: 1 1 250px; min-height: 120px; margin: 4px -6px 0; }
      /* La bougie survolée, posée sur le graphique en haut à gauche (pas de ligne réservée pour elle). */
      .legend {
        position: absolute; z-index: 1; top: 0; left: 6px; max-width: calc(100% - 80px);
        padding: 1px 6px; border-radius: 6px; pointer-events: none;
        background: color-mix(in srgb, var(--panel) 88%, transparent);
        font-size: 11px; line-height: 1.45; color: var(--muted); font-variant-numeric: tabular-nums;
      }
      .state {
        position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 0 12px;
        font-size: 13px; color: var(--muted); text-align: center;
      }
      /* L'outil en cours, en haut à droite du graphique (pas de ligne réservée pour lui). */
      .hint {
        position: absolute; z-index: 1; top: 0; right: 6px; max-width: calc(100% - 80px);
        padding: 1px 6px; border-radius: 6px; pointer-events: none;
        background: color-mix(in srgb, var(--panel) 88%, transparent);
        font-size: 11px; line-height: 1.45; color: var(--accent);
      }
      .foot { position: relative; display: flex; gap: 3px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
      .tf { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); background: none; color: var(--muted); font-variant-numeric: tabular-nums; }
      .tf.on { color: var(--accent); border-color: var(--accent); }
      .tools { position: relative; display: flex; gap: 4px; align-items: center; margin-left: auto; }
      /* Les objets (tracés à la main), regroupés : on les distingue d'un coup d'œil des indicateurs et de l'IA. */
      .group { display: flex; gap: 1px; padding: 1px; border-radius: 8px; background: var(--panel-2); }
      /* Indicateurs et IA : nommés, plus visibles que les icônes seules. */
      .labeled {
        display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 6px;
        border-radius: 999px; border: 1px solid var(--border); background: none; color: var(--muted);
        font: inherit; font-size: 11px; white-space: nowrap;
      }
      .labeled svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .labeled:hover { color: var(--text); border-color: var(--muted); }
      .labeled.used { color: var(--text); }
      .labeled.on { color: var(--accent); border-color: var(--accent); }
      .labeled.ai.used, .labeled.ai.on { color: var(--ai); }
      .labeled.ai.on { border-color: var(--ai); }
      .count { min-width: 14px; padding: 0 4px; border-radius: 999px; background: var(--panel-2); color: var(--muted); font-size: 10px; line-height: 14px; text-align: center; font-variant-numeric: tabular-nums; }
      /* Un encart étroit : les icônes seules (la bulle dit leur nom), et les neuf unités de temps sur une ligne. */
      @container (max-width: 430px) {
        .labeled .lbl { display: none; }
        .labeled { padding: 0 6px; }
        .foot { gap: 2px; }
        .tf { padding: 1px 4px; }
      }
      .tool {
        display: grid; place-items: center; width: 22px; height: 20px; padding: 0;
        border-radius: 6px; border: 1px solid transparent; background: none; color: var(--muted);
      }
      .tool svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .tool:hover { color: var(--text); border-color: var(--border); }
      .tool.on { color: var(--accent); border-color: var(--accent); }
      .tool.danger:hover { color: var(--danger); border-color: var(--danger); }
      .sep { width: 1px; height: 14px; margin: 0 3px; background: var(--border); }
      .tool.strong { color: #fff; background: var(--accent); border-color: var(--accent); }
      .menu {
        position: absolute; z-index: 3; right: 0; bottom: calc(100% + 4px); width: 260px; max-height: min(70vh, 440px); overflow: auto;
        padding: 6px; box-sizing: border-box;
        background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 8px 24px color-mix(in srgb, #000 30%, transparent);
        font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums;
      }
      .menu-head { display: flex; justify-content: space-between; padding: 2px 4px 6px; font-weight: 600; }
      .muted { color: var(--muted); font-weight: 400; }
      .ind { display: flex; align-items: center; gap: 4px; padding: 2px 2px 2px 6px; border-radius: 6px; }
      .ind:hover { background: var(--panel-2); }
      .ind.off .ind-name { color: var(--muted); text-decoration: line-through; }
      .swatch { flex: none; width: 12px; height: 3px; border-radius: 2px; }
      .ind-name { flex: 1; min-width: 0; padding: 3px 4px; border: none; background: none; color: var(--text); font: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mini { flex: none; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 5px; background: none; color: var(--muted); }
      .mini svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .mini:hover { color: var(--text); background: var(--panel); }
      .mini.danger:hover { color: var(--danger); }
      .empty { margin: 4px 6px 8px; color: var(--muted); }
      .note { margin: 0 4px 6px; color: var(--muted); font-size: 11px; line-height: 1.4; }
      .toggle { display: flex; gap: 8px; align-items: flex-start; padding: 6px 4px; border-radius: 6px; cursor: pointer; }
      .toggle:hover { background: var(--panel-2); }
      .toggle input { margin: 2px 0 0; accent-color: var(--ai); }
      .toggle > span { display: grid; gap: 2px; font-size: 11px; line-height: 1.4; }
      .t-title { font-size: 12px; font-weight: 600; color: var(--text); }
      .t-count { color: var(--ai); font-variant-numeric: tabular-nums; }
      /* La bulle d'un outil : ce qu'il fait, comment, et la phrase à dire à Kopilia. */
      .tip {
        position: absolute; z-index: 4; bottom: calc(100% + 6px); display: grid; gap: 3px; padding: 8px 10px; box-sizing: border-box;
        background: var(--panel); border: 1px solid var(--border); border-radius: 10px; pointer-events: none;
        box-shadow: 0 8px 24px color-mix(in srgb, #000 30%, transparent);
        font-size: 11px; line-height: 1.45; color: var(--muted);
      }
      .tip-group { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
      .tip.ai .tip-group { color: var(--ai); }
      .tip-title { font-size: 12px; color: var(--text); }
      .tip-state { color: var(--text); }
      .tip-voice { color: var(--text); font-style: italic; }
      .adds { display: flex; gap: 4px; margin-top: 6px; }
      .add { flex: 1; padding: 4px 6px; border: 1px dashed var(--border); border-radius: 6px; background: none; color: var(--accent); font: inherit; }
      .add:hover:not(:disabled) { border-color: var(--accent); }
      .add:disabled { color: var(--muted); }
      .quick { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; margin-top: 6px; padding: 0 2px; }
      .chip { padding: 1px 6px; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--muted); font: inherit; font-size: 11px; }
      .chip:hover { color: var(--text); border-color: var(--muted); }
      .editor { display: grid; gap: 6px; padding: 2px; }
      .ed-title { font-weight: 600; padding: 0 2px 2px; }
      .row { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 6px; }
      .row > span { color: var(--muted); }
      .row select, .row input {
        min-width: 0; padding: 3px 6px; border: 1px solid var(--border); border-radius: 6px;
        background: var(--panel-2); color: var(--text); font: inherit;
      }
      .pair { display: flex; gap: 4px; min-width: 0; }
      .pair select { flex: 1; min-width: 0; }
      .pair input { width: 56px; }
      .swatches { display: flex; flex-wrap: wrap; gap: 4px; }
      .sw { width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 2px solid transparent; outline: 1px solid var(--border); }
      .sw.on { border-color: var(--panel); outline: 2px solid var(--text); }
      .seg { display: flex; gap: 2px; }
      .seg button { width: 26px; padding: 2px 0; border: 1px solid var(--border); border-radius: 5px; background: none; color: var(--muted); font: inherit; }
      .seg button.on { color: var(--accent); border-color: var(--accent); }
      .err { margin: 0; color: var(--danger); }
      .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
      .actions button { padding: 4px 10px; border-radius: 6px; font: inherit; border: 1px solid var(--border); background: none; color: var(--text); }
      .actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      .actions .primary:disabled { opacity: .5; }
      /* Le menu du clic droit, posé sur le graphique près du pointeur. */
      .ctx {
        position: absolute; z-index: 4; width: ${MENU_W}px; padding: 4px; box-sizing: border-box;
        background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 8px 24px color-mix(in srgb, #000 30%, transparent);
        font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums;
      }
      .ctx-item {
        display: flex; align-items: center; gap: 8px; width: 100%; height: ${MENU_ITEM_H}px; padding: 0 8px;
        border: none; border-radius: 6px; background: none; color: var(--text); font: inherit; text-align: left;
      }
      .ctx-item:hover, .ctx-item:focus-visible { background: var(--panel-2); outline: none; }
      .ctx-item svg { flex: none; width: 14px; height: 14px; fill: none; stroke: var(--muted); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .ctx-item .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ctx-item .key { color: var(--muted); font-size: 11px; }
      .ctx-item.danger, .ctx-item.danger svg { color: var(--danger); stroke: var(--danger); }
      .ctx-sep { height: 1px; margin: 3px 4px; background: var(--border); }
      .tool.alerting { color: var(--warn); }
      /* Les réglages d'une alerte ont des libellés plus longs que ceux des indicateurs. */
      kp-alert-menu.menu { width: 300px; }
      @media (max-width: 1239px) { .chart { flex-basis: 180px; } }
    `,
  ],
  template: `
    <div #chart class="chart">
      @if (hovered(); as c) {
        <div class="legend" aria-live="off">{{ legend(c) }}</div>
      }
      @if (tool(); as t) {
        <div class="hint">{{ hints[t] }}</div>
      }
      @if (failed(); as err) {
        <p class="state">{{ err }}</p>
      } @else if (loading()) {
        <p class="state">Chargement des bougies…</p>
      }
      @if (ctxMenu(); as m) {
        <div #ctx class="ctx" role="menu" [style.left.px]="m.x" [style.top.px]="m.y">
          @for (item of m.items; track item.label) {
            @if (item.danger && !$first && !m.items[$index - 1].danger) {
              <div class="ctx-sep" role="separator"></div>
            }
            <button type="button" role="menuitem" class="ctx-item" [class.danger]="item.danger" [attr.title]="item.title ?? null" (click)="runItem(item)">
              @switch (item.icon) {
                @case ("bell") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1.2H3z" /><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" /></svg>
                }
                @case ("line") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12" /><circle cx="8" cy="8" r="1.6" /></svg>
                }
                @case ("extend") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h10M9 5l3 3-3 3" /></svg>
                }
                @case ("pause") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4v8M10 4v8" /></svg>
                }
                @case ("play") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.8v8.4L12 8z" /></svg>
                }
                @case ("edit") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 11.5h10" /><circle cx="6" cy="4.5" r="1.6" /><circle cx="10.5" cy="11.5" r="1.6" /></svg>
                }
                @case ("keep") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
                }
                @case ("ai") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4z" /></svg>
                }
                @case ("risk") {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5h10M4.5 12.5V9M8 12.5V5.5M11.5 12.5V3" /></svg>
                }
                @default {
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
                }
              }
              <span class="lbl">{{ item.label }}</span>
              @if (item.on) {
                <span class="key" aria-label="activé">✓</span>
              } @else if (item.hint) {
                <span class="key">{{ item.hint }}</span>
              }
            </button>
          }
        </div>
      }
    </div>
    <div #foot class="foot">
      @for (tf of timeframes; track tf) {
        <button
          type="button"
          class="tf"
          [class.on]="tf === panel().timeframe"
          [attr.aria-pressed]="tf === panel().timeframe"
          [attr.title]="tfNames[tf]"
          [attr.aria-label]="tfNames[tf]"
          (click)="kopilia.setTimeframe(panel().id, tf)"
        >
          {{ short[tf] }}
        </button>
      }
      <div
        class="tools"
        role="toolbar"
        aria-label="Outils du graphique"
        (pointerover)="tipOver($event)"
        (pointerleave)="tipOut()"
        (focusin)="tipOver($event)"
        (focusout)="tipOut()"
        (pointerdown)="tipOut()"
      >
        @if (selectedDrawing(); as d) {
          @if (d.kind !== 'hline' && d.kind !== 'position') {
            <button type="button" class="tool" [class.on]="reachesRight(d)" [attr.aria-pressed]="reachesRight(d)" title="Prolonger vers la droite" aria-label="Prolonger vers la droite" (click)="toggleExtend(d)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h10M9 5l3 3-3 3" /></svg>
            </button>
          }
          <button type="button" class="tool danger" title="Effacer le tracé (Suppr)" aria-label="Effacer le tracé" (click)="erase(d.id)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
          </button>
          <span class="sep" aria-hidden="true"></span>
        }
        <!-- Les objets : ce qu'on trace à la main sur le graphique. -->
        <div class="group" role="group" aria-label="Objets">
          <button
            type="button"
            class="tool"
            data-tip="magnet"
            [class.on]="magnet() !== 'off'"
            [class.strong]="magnet() === 'strong'"
            [attr.aria-label]="magnetTitles[magnet()]"
            (click)="magnet.set(magnetNext[magnet()])"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5v5.5a3.5 3.5 0 0 0 7 0V2.5" /><path d="M3.2 2.5h2.6M10.2 2.5h2.6M4.5 5h0M11.5 5h0" /></svg>
          </button>
          <button type="button" class="tool" data-tip="hline" [class.on]="tool() === 'hline'" [attr.aria-pressed]="tool() === 'hline'" aria-label="Ligne horizontale" (click)="pick('hline')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12" /><circle cx="8" cy="8" r="1.6" /></svg>
          </button>
          <button type="button" class="tool" data-tip="trendline" [class.on]="tool() === 'trendline'" [attr.aria-pressed]="tool() === 'trendline'" aria-label="Oblique" (click)="pick('trendline')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 12.5l9-9" /><circle cx="3" cy="13" r="1.6" /><circle cx="13" cy="3" r="1.6" /></svg>
          </button>
          <button type="button" class="tool" data-tip="zone" [class.on]="tool() === 'zone'" [attr.aria-pressed]="tool() === 'zone'" aria-label="Zone" (click)="pick('zone')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="5" width="11" height="6" rx="1" /></svg>
          </button>
          <button type="button" class="tool" data-tip="fib" [class.on]="tool() === 'fib'" [attr.aria-pressed]="tool() === 'fib'" aria-label="Retracement de Fibonacci" (click)="pick('fib')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12M2 6h12M2 9.5h12M2 13.5h12" /><path d="M3.5 13.5l9-11" stroke-dasharray="1.6 1.6" /></svg>
          </button>
          <button type="button" class="tool" data-tip="fibext" [class.on]="tool() === 'fibext'" [attr.aria-pressed]="tool() === 'fibext'" aria-label="Extension de Fibonacci" (click)="pick('fibext')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 13.5L4.5 4l3 5" stroke-dasharray="1.6 1.6" /><path d="M9 2.5h5.5M9 6h5.5M9 9.5h5.5M9 13.5h5.5" /></svg>
          </button>
          <button type="button" class="tool" data-tip="long" [class.on]="tool() === 'long'" [attr.aria-pressed]="tool() === 'long'" aria-label="Position longue" (click)="pick('long')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M2.5 9.5h11" /><path d="M8 7.5V4.5M6.5 6l1.5-1.5L9.5 6" /></svg>
          </button>
          <button type="button" class="tool" data-tip="short" [class.on]="tool() === 'short'" [attr.aria-pressed]="tool() === 'short'" aria-label="Position courte" (click)="pick('short')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M2.5 6.5h11" /><path d="M8 8.5v3M6.5 10l1.5 1.5L9.5 10" /></svg>
          </button>
        </div>
        <!-- Les indicateurs techniques : calculés sur les bougies. -->
        <button
          #menuButton
          type="button"
          class="labeled"
          data-tip="indicators"
          [class.on]="menuOpen()"
          [class.used]="indicators().length > 0"
          aria-label="Indicateurs"
          aria-haspopup="dialog"
          [attr.aria-expanded]="menuOpen()"
          (click)="toggleMenu()"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 11.5c2.5-5 4.5-6 6.5-2.5s3.5 2.5 6.5-4" /></svg>
          <span class="lbl">Indicateurs</span>
          @if (indicators().length) {
            <span class="count">{{ indicators().length }}</span>
          }
        </button>
        <!-- L'analyse de l'IA : ce que la machine ajoute, en violet. -->
        <button
          #aiButton
          type="button"
          class="labeled ai"
          data-tip="ai"
          [class.on]="aiOpen()"
          [class.used]="autoMapOn() || (aiLevelsOn() && aiLevels().length > 0)"
          aria-label="Analyse de l'IA"
          aria-haspopup="dialog"
          [attr.aria-expanded]="aiOpen()"
          (click)="toggleAi()"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.4 3.9 3.9 1.4-3.9 1.4L8 12.4 6.6 8.5 2.7 7.1l3.9-1.4z" /><path d="M12.6 10.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" /></svg>
          <span class="lbl">IA</span>
        </button>
        @if (aiOpen()) {
          <div #aiMenu class="menu" role="dialog" aria-label="Analyse de l'IA">
            <div class="menu-head"><span>Analyse de l'IA</span></div>
            <p class="note">Ce que la machine ajoute à vos tracés, en violet. Ses alertes portent la marque « IA ».</p>
            <label class="toggle">
              <input type="checkbox" [checked]="autoMapOn()" (change)="autoMapOn.set($any($event.target).checked)" />
              <span>
                <span class="t-title">Carte automatique</span>
                <span class="muted">Zones, obliques et divergences RSI repérées par l'algorithme sur ces bougies, corrigées par l'IA ; relue à la clôture des bougies.</span>
                @if (autoMapOn() && autoMapCounts(); as n) {
                  <span class="t-count">{{ n }}</span>
                }
              </span>
            </label>
            <label class="toggle">
              <input type="checkbox" [checked]="aiLevelsOn()" (change)="aiLevelsOn.set($any($event.target).checked)" />
              <span>
                <span class="t-title">Niveaux de ses setups</span>
                <span class="muted">Ceux que l'IA surveille pour ses setups sur ce produit. Clic droit sur l'un d'eux : le garder dans vos tracés, ou le retirer.</span>
                <span class="t-count">{{ aiLevelsText() }}</span>
              </span>
            </label>
          </div>
        }
        <button
          #alertButton
          type="button"
          class="tool"
          data-tip="alerts"
          [class.on]="alertsOpen()"
          [class.alerting]="!alertsOpen() && watching() > 0"
          [attr.aria-label]="watching() ? 'Alertes (' + watching() + ' surveillées)' : 'Alertes'"
          aria-haspopup="dialog"
          [attr.aria-expanded]="alertsOpen()"
          (click)="toggleAlerts()"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1.2H3z" /><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" /></svg>
        </button>
        @if (riskBox(); as b) {
          <kp-risk-menu #riskMenu class="menu" role="dialog" aria-label="Risque de la boîte" [box]="b" [state]="kopilia.trading()"
            [marginOf]="marginOf" (save)="saveRisk(b, $event)" (cancel)="riskFor.set(null)" />
        }
        @if (alertsOpen()) {
          <kp-alert-menu
            #alertMenu
            class="menu"
            role="dialog"
            aria-label="Alertes"
            [alerts]="userAlerts()"
            [drawings]="drawings()"
            [digits]="chartDigits()"
            [draft]="alertDraft()"
            (edit)="openAlert(draftFor($event), 'list')"
            (save)="saveAlert($event)"
            (cancel)="closeAlertForm()"
            (remove)="deleteAlert($event)"
            (pause)="pauseAlert($event.id, $event.paused)"
          />
        }
        @if (menuOpen()) {
          <div #menu class="menu" role="dialog" aria-label="Indicateurs">
            @if (editor(); as e) {
              <form class="editor" (submit)="$event.preventDefault(); applyEditor()">
                <div class="ed-title">{{ editorTitle(e) }}</div>
                @if (e.draft.kind === 'ma') {
                  <label class="row"><span>Type</span>
                    <select (change)="patch({ type: $any($event.target).value })">
                      @for (t of maTypes; track t) {
                        <option [value]="t" [selected]="t === e.draft.type">{{ maNames[t] }}</option>
                      }
                    </select>
                  </label>
                }
                <label class="row"><span>Longueur</span>
                  <input type="number" min="1" [attr.max]="e.draft.kind === 'ma' ? 500 : 200" step="1" [value]="e.draft.period" (input)="patch({ period: num($event) })" />
                </label>
                <label class="row"><span>Source</span>
                  <select (change)="patch({ source: $any($event.target).value })">
                    @for (src of sources; track src) {
                      <option [value]="src" [selected]="src === e.draft.source">{{ sourceNames[src] }}</option>
                    }
                  </select>
                </label>
                @if (e.draft.kind === 'rsi') {
                  <label class="row"><span>Surachat</span>
                    <input type="number" min="50" max="100" step="1" [value]="e.draft.overbought" (input)="patch({ overbought: num($event) })" />
                  </label>
                  <label class="row"><span>Survente</span>
                    <input type="number" min="0" max="50" step="1" [value]="e.draft.oversold" (input)="patch({ oversold: num($event) })" />
                  </label>
                  <label class="row"><span>Moyenne du RSI</span>
                    <span class="pair">
                      <select (change)="setSignalType($any($event.target).value)">
                        <option value="none" [selected]="!e.draft.signal">aucune</option>
                        @for (t of maTypes; track t) {
                          <option [value]="t" [selected]="t === e.draft.signal?.type">{{ maNames[t] }}</option>
                        }
                      </select>
                      @if (e.draft.signal; as sig) {
                        <input type="number" min="1" max="200" step="1" aria-label="Longueur de la moyenne du RSI" [value]="sig.period" (input)="setSignalPeriod(num($event))" />
                      }
                    </span>
                  </label>
                }
                <div class="row">
                  <span>Couleur</span>
                  <div class="swatches" role="radiogroup" aria-label="Couleur">
                    @for (c of colors; track c) {
                      <button
                        type="button"
                        class="sw"
                        role="radio"
                        [class.on]="e.draft.color === c"
                        [attr.aria-checked]="e.draft.color === c"
                        [style.background]="palette()[c]"
                        [attr.aria-label]="colorNames[c]"
                        [attr.title]="colorNames[c]"
                        (click)="patch({ color: c })"
                      ></button>
                    }
                  </div>
                </div>
                <div class="row">
                  <span>Épaisseur</span>
                  <div class="seg" role="radiogroup" aria-label="Épaisseur">
                    @for (w of widths; track w) {
                      <button type="button" role="radio" [class.on]="(e.draft.width ?? 1) === w" [attr.aria-checked]="(e.draft.width ?? 1) === w" (click)="patch({ width: w })">{{ w }}</button>
                    }
                  </div>
                </div>
                @if (draftError(); as err) {
                  <p class="err">{{ err }}</p>
                }
                <div class="actions">
                  <button type="button" (click)="editor.set(null)">Annuler</button>
                  <button type="submit" class="primary" [disabled]="!!draftError()">{{ e.isNew ? "Ajouter" : "Appliquer" }}</button>
                </div>
              </form>
            } @else {
              <div class="menu-head">
                <span>Indicateurs techniques</span><span class="muted">{{ indicators().length }} / {{ maxIndicators }}</span>
              </div>
              <p class="note">Calculés sur les bougies, et gardés pour ce produit dans toutes les unités. Les tracés à la main sont dans la barre, à gauche.</p>
              @for (i of indicators(); track i.id; let k = $index) {
                <div class="ind" [class.off]="i.hidden">
                  <span class="swatch" [style.background]="colorHex(i, k)" aria-hidden="true"></span>
                  <button type="button" class="ind-name" title="Régler" (click)="editIndicator(i, k)">{{ describe(i) }}</button>
                  <button type="button" class="mini" [attr.aria-label]="(i.hidden ? 'Afficher ' : 'Masquer ') + label(i)" [attr.title]="i.hidden ? 'Afficher' : 'Masquer'" (click)="toggleHidden(i)">
                    @if (i.hidden) {
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><path d="M3 13L13 3" /></svg>
                    } @else {
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.8" /></svg>
                    }
                  </button>
                  <button type="button" class="mini" [attr.aria-label]="'Régler ' + label(i)" title="Régler" (click)="editIndicator(i, k)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 11.5h10" /><circle cx="6" cy="4.5" r="1.6" /><circle cx="10.5" cy="11.5" r="1.6" /></svg>
                  </button>
                  <button type="button" class="mini danger" [attr.aria-label]="'Retirer ' + label(i)" title="Retirer" (click)="removeIndicator(i)">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                  </button>
                </div>
              } @empty {
                <p class="empty">Aucun indicateur sur ce graphique.</p>
              }
              <div class="adds">
                <button type="button" class="add" [disabled]="full()" (click)="newIndicator('ma')">+ Moyenne mobile</button>
                <button type="button" class="add" [disabled]="full()" (click)="newIndicator('rsi')">+ RSI</button>
              </div>
              @if (quick().length && !full()) {
                <div class="quick">
                  <span class="muted">Rapide</span>
                  @for (q of quick(); track q.label) {
                    <button type="button" class="chip" [attr.aria-label]="'Ajouter ' + q.label" (click)="addIndicator(q.indicator)">{{ q.label }}</button>
                  }
                </div>
              }
            }
          </div>
        }
      </div>
      @if (tip(); as t) {
        <div class="tip" role="tooltip" [class.ai]="t.tip.group === 'IA'" [style.left.px]="t.left" [style.width.px]="tipW">
          <span class="tip-group">{{ t.tip.group }}</span>
          <strong class="tip-title">{{ t.tip.title }}</strong>
          @if (t.key === 'magnet') {
            <span class="tip-state">{{ magnetStates[magnet()] }}</span>
          }
          <span class="tip-text">{{ t.tip.text }}</span>
          @if (t.tip.voice) {
            <span class="tip-voice">À la voix : « {{ t.tip.voice }} »</span>
          }
        </div>
      }
    </div>
  `,
})
export class ChartPanelComponent implements AfterViewInit, OnDestroy {
  readonly panel = input.required<PanelView>();
  readonly kopilia = inject(KopiliaService);
  readonly timeframes = CHART_TIMEFRAMES;
  readonly short = TIMEFRAME_CHIP;
  readonly failed = signal<string | null>(null);
  readonly loading = signal(true);
  /** La bougie sous le pointeur. */
  readonly hovered = signal<Candle | undefined>(undefined);
  readonly hints = TOOL_HINTS;
  /** L'outil de tracé choisi (null : la souris fait défiler et sélectionne). */
  readonly tool = signal<DrawTool | null>(null);
  readonly menuOpen = signal(false);
  /** L'indicateur en cours de réglage dans le panneau (null : la liste). */
  readonly editor = signal<Editor | null>(null);
  readonly magnet = signal<Magnet>(savedMagnet());
  /** La carte automatique (zones, obliques, divergences de l'algorithme, corrigées par l'IA), sous les tracés. */
  readonly autoMapOn = signal(savedAutoMap());
  /** La carte automatique affichée (pour en dire le contenu). */
  private readonly autoMap = signal<ChartAutoMap | undefined>(undefined);
  /** Les niveaux des setups de l'IA, montrés sur le graphique ou non. */
  readonly aiLevelsOn = signal(savedFlag(AI_LEVELS_KEY, true));
  /** Le panneau de l'analyse de l'IA. */
  readonly aiOpen = signal(false);
  /** La bulle d'un outil, au-dessus de la barre. */
  readonly tip = signal<{ key: TipKey; tip: ChartTip; left: number } | null>(null);
  readonly tipW = TIP_W;
  readonly magnetStates = MAGNET_STATES;
  readonly tfNames = TIMEFRAME_NAMES;
  private tipTimer?: ReturnType<typeof setTimeout>;
  readonly magnetTitles = MAGNET_TITLES;
  readonly magnetNext = MAGNET_NEXT;
  readonly maTypes = MA_TYPES;
  readonly maNames = MA_NAMES;
  readonly sources = PRICE_SOURCES;
  readonly sourceNames = SOURCE_NAMES;
  readonly colors = INDICATOR_COLORS;
  readonly colorNames = COLOR_NAMES;
  readonly widths = [1, 2, 3, 4];
  readonly maxIndicators = MAX_INDICATORS;
  /** Les teintes des couleurs d'indicateur, selon le thème. */
  readonly palette = signal(indicatorPalette());
  /** Le tracé sélectionné (à la souris). */
  readonly selected = signal<string | undefined>(undefined);
  /** Le menu du clic droit (ou du « + »), là où il s'ouvre dans le graphique. */
  readonly ctxMenu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Le panneau des alertes, et l'alerte qu'on y règle (null : la liste) ; ouvert depuis la liste ou le graphique. */
  readonly alertsOpen = signal(false);
  readonly alertDraft = signal<AlertDraft | null>(null);
  /** Le calcul de marge du courtier, pour le réglage du risque. */
  readonly marginOf = (q: { symbol: string; side: "long" | "short"; lots: number; price: number }) => this.kopilia.tradingMargin(q);
  /** La boîte de trade dont on règle le risque (clic droit, « Risque… »). */
  readonly riskFor = signal<string | null>(null);
  readonly riskBox = computed(() => {
    const d = this.drawings().find((x) => x.id === this.riskFor());
    return d?.kind === "position" ? d : undefined;
  });
  private alertFrom: "list" | "chart" = "list";

  readonly quote = computed<QuoteView | undefined>(() => this.kopilia.quotes()[this.panel().symbol ?? ""]);
  readonly indicators = computed<Indicator[]>(() => this.panel().indicators ?? []);
  /** Les tracés du produit de ce graphique. */
  readonly drawings = computed<Drawing[]>(() => this.kopilia.drawings().filter((d) => d.symbol === this.panel().symbol));
  readonly selectedDrawing = computed(() => this.drawings().find((d) => d.id === this.selected()));
  /** Les niveaux de travail de l'IA sur ce produit. */
  readonly aiLevels = computed(() => this.drawings().filter((d) => d.createdBy === "ia"));
  /** Les tracés montrés : ceux de l'IA seulement s'ils ne sont pas masqués. */
  readonly shownDrawings = computed<Drawing[]>(() => (this.aiLevelsOn() ? this.drawings() : this.drawings().filter((d) => d.createdBy !== "ia")));
  /** « 4 zones · 2 obliques · 1 divergence » : ce que montre la carte automatique. */
  readonly autoMapCounts = computed(() => {
    const m = this.autoMap();
    if (!m) return "";
    const part = (n: number, one: string, many: string) => (n ? `${n} ${n > 1 ? many : one}` : "");
    const parts = [
      part(m.zones.length, "zone", "zones"),
      part(m.trendlines.length, "oblique", "obliques"),
      part(m.divergences.length, "divergence", "divergences"),
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Rien de repéré sur ces bougies.";
  });
  readonly aiLevelsText = computed(() => {
    const n = this.aiLevels().length;
    if (!n) return "Aucun sur ce produit pour l'instant.";
    return `${n} ${n > 1 ? "niveaux" : "niveau"}${this.aiLevelsOn() ? "" : ", masqués"}`;
  });
  /** Les suggestions de l'IA sur les tracés de ce produit. */
  readonly suggestions = computed(() => this.kopilia.drawingSuggestions().filter((x) => x.symbol === this.panel().symbol));
  /** Les alertes du produit de ce graphique, et combien sont surveillées. */
  readonly alerts = computed<Alert[]>(() => this.kopilia.alerts().filter((a) => a.symbol === this.panel().symbol));
  /** Celles de l'utilisateur : le menu des alertes ne montre qu'elles (celles de l'IA vont et viennent avec ses scénarios). */
  readonly userAlerts = computed<Alert[]>(() => this.alerts().filter((a) => !a.scenarioId));
  readonly watching = computed(() => this.userAlerts().filter((a) => a.state === "active").length);
  /** Les setups proposés par l'IA sur ce produit, avec leurs niveaux. */
  readonly setups = computed<ChartSetup[]>(() =>
    this.kopilia
      .scenarios()
      .filter((s) => s.state === "proposed" && s.symbol === this.panel().symbol)
      .map((s) => ({
        id: s.id,
        direction: s.direction,
        entry: s.entry,
        stop: s.stop,
        targets: s.targets,
        since: Math.floor((s.proposedAt ?? s.createdAt) / 1000),
      })),
  );
  readonly chartDigits = computed(() => this.panel().digits ?? this.quote()?.digits ?? 5);
  readonly full = computed(() => this.indicators().length >= MAX_INDICATORS);
  /** Les ajouts en un clic qui ne sont pas déjà tracés. */
  readonly quick = computed(() =>
    QUICK.map((input) => completeIndicator(input, "quick"))
      .filter((q) => !this.indicators().some((i) => sameIndicator(i, q)))
      .map((indicator) => ({ indicator, label: indicatorLabel(indicator) })),
  );
  /** Ce qui ne va pas dans les réglages en cours (undefined : on peut appliquer). */
  readonly draftError = computed(() => {
    const e = this.editor();
    if (!e) return undefined;
    const d = e.draft;
    const r = indicatorSchema.safeParse(d);
    if (!r.success) {
      if (!Number.isInteger(d.period) || d.period < 1) return "La longueur doit être un nombre entier de bougies.";
      if (d.kind === "ma" && d.period > 500) return "500 bougies au plus.";
      if (d.kind === "rsi" && (d.period < 2 || d.period > 200)) return "Longueur du RSI : de 2 à 200 bougies.";
      if (d.kind === "rsi" && d.signal && !(d.signal.period >= 1 && d.signal.period <= 200)) return "Longueur de la moyenne du RSI : de 1 à 200.";
      return "Seuils du RSI : surachat de 50 à 100, survente de 0 à 50.";
    }
    if (d.kind === "rsi" && d.oversold >= d.overbought) return "La survente doit être sous le surachat.";
    return undefined;
  });

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>("chart");
  private readonly menu = viewChild<ElementRef<HTMLElement>>("menu");
  private readonly menuButton = viewChild<ElementRef<HTMLElement>>("menuButton");
  private readonly ctx = viewChild<ElementRef<HTMLElement>>("ctx");
  private readonly alertMenu = viewChild("alertMenu", { read: ElementRef<HTMLElement> });
  private readonly riskMenu = viewChild("riskMenu", { read: ElementRef<HTMLElement> });
  private readonly alertButton = viewChild<ElementRef<HTMLElement>>("alertButton");
  private readonly aiMenu = viewChild<ElementRef<HTMLElement>>("aiMenu");
  private readonly aiButton = viewChild<ElementRef<HTMLElement>>("aiButton");
  private readonly foot = viewChild<ElementRef<HTMLElement>>("foot");
  /** Le dernier déclenchement montré sur ce graphique (sa ligne a clignoté). */
  private flashed = "";
  /** Le dernier prix cité par Kopilia déjà vu par ce graphique (allumé s'il était de son produit). */
  private spotted = 0;
  private chart?: CandleChart;
  private candles: Candle[] = [];
  private more = false;
  private loadingMore = false;
  /** Produit et unité chargés ; un chargement dépassé par un autre est ignoré. */
  private loadedKey = "";
  private loadSeq = 0;
  private stopThemeWatch?: () => void;
  private autoMapTimer?: ReturnType<typeof setInterval>;
  private readonly zone = inject(NgZone);

  constructor() {
    // Produit ou unité de temps changés (à la voix ou aux boutons) : tout recharger.
    effect(() => {
      const key = this.key();
      untracked(() => {
        if (this.chart && key !== this.loadedKey) void this.load();
      });
    });
    // Le courtier vient de se rallumer : un graphique resté sans bougies (en pause) se recharge.
    effect(() => {
      const wakes = this.kopilia.brokerWakes();
      untracked(() => {
        if (wakes && this.chart && this.failed()) void this.load();
      });
    });
    // Chaque cotation anime la bougie en cours.
    effect(() => {
      const q = this.quote();
      if (q) untracked(() => this.onQuote(q));
    });
    // Indicateurs et tracés, tels que le serveur les garde (réglés ici, à la voix ou sur un autre écran).
    effect(() => {
      const list = this.indicators();
      untracked(() => this.chart?.setIndicators(list));
    });
    effect(() => {
      const list = this.shownDrawings();
      untracked(() => this.chart?.setDrawings(list));
    });
    effect(() => saveFlag(AI_LEVELS_KEY, this.aiLevelsOn()));
    effect(() => {
      const list = this.alerts();
      untracked(() => this.chart?.setAlerts(list));
    });
    // Une alerte de ce produit vient de partir : sa ligne clignote.
    effect(() => {
      const f = this.kopilia.firedAlerts()[0];
      untracked(() => {
        if (!f || f.key === this.flashed || f.symbol !== this.panel().symbol) return;
        this.flashed = f.key;
        this.chart?.flash(f.alertId);
      });
    });
    // Une alerte de l'IA vient de partir : sa ligne clignote aussi, sans bandeau.
    effect(() => {
      const f = this.kopilia.aiFired();
      untracked(() => {
        if (!f || f.key === this.flashed || f.symbol !== this.panel().symbol) return;
        this.flashed = f.key;
        this.chart?.flash(f.alertId);
      });
    });
    // Kopilia cite un prix de ce produit : ce qui est à ce prix s'allume, au mot près.
    effect(() => {
      const spoken = this.kopilia.spokenPrices();
      untracked(() => {
        const symbol = this.panel().symbol;
        for (const s of spoken) {
          if (s.id <= this.spotted) continue;
          this.spotted = s.id;
          if (s.symbol === symbol) this.chart?.spotlight(s);
        }
      });
    });
    // Les setups proposés sur ce produit : leurs niveaux sur le graphique.
    effect(() => {
      const list = this.setups();
      untracked(() => this.chart?.setSetups(list));
    });
    // Ses tracés sur lesquels l'IA a une suggestion : marqués « IA ? ».
    effect(() => {
      const ids = this.suggestions().map((x) => x.drawingId);
      untracked(() => this.chart?.setSuggestions(ids));
    });
    // La carte automatique : relue au changement de produit ou d'unité, et de temps en temps.
    effect(() => {
      const on = this.autoMapOn();
      const key = this.key();
      untracked(() => {
        clearInterval(this.autoMapTimer);
        try {
          localStorage.setItem(AUTOMAP_KEY, on ? "1" : "0");
        } catch {
          /* stockage indisponible : le choix vaut pour cette page */
        }
        if (!on) {
          this.chart?.setAutoMap(undefined);
          this.autoMap.set(undefined);
          return;
        }
        void this.loadAutoMap(key);
        this.autoMapTimer = setInterval(() => void this.loadAutoMap(this.key()), AUTOMAP_REFRESH_MS);
      });
    });
    // Le compte, le money management ou un trade ont changé : les boîtes se redessinent avec leurs montants.
    effect(() => {
      this.kopilia.trading();
      untracked(() => this.chart?.setBoxInfo((d) => this.boxView(d)));
    });
    // L'aimant choisi, gardé sur cet écran.
    effect(() => {
      const mode = this.magnet();
      untracked(() => this.chart?.setMagnet(mode));
      try {
        localStorage.setItem(MAGNET_KEY, mode);
      } catch {
        /* stockage indisponible : l'aimant vaut pour cette page */
      }
    });
  }

  ngAfterViewInit(): void {
    // Hors de la zone Angular : un mouvement de souris sur le graphique ne
    // redessine que lui, sans relancer la détection de toute l'application.
    // Les retours écrivent des signals, qui suffisent à rafraîchir la légende.
    this.chart = this.zone.runOutsideAngular(
      () =>
        new CandleChart(this.host().nativeElement, theme(), {
          onNeedMore: () => void this.loadMore(),
          onHover: (c) => this.hovered.set(c),
          onDraw: (shape) => void this.kopilia.draw(this.panel().symbol ?? "", shape),
          onEdit: (id, shape) => void this.editDrawing(id, shape),
          onSelect: (id) => this.selected.set(id),
          onToolEnd: () => this.tool.set(null),
          onContext: (target, x, y) => this.zone.run(() => this.openMenu(this.targetItems(target), x, y)),
          onPlus: (price, x, y) => this.zone.run(() => this.openMenu(this.priceItems(price), x - MENU_W + 10, y + 10)),
          onAlertMove: (id, price) => void this.moveAlert(id, price),
        }),
    );
    this.chart.setIndicators(this.indicators());
    this.chart.setDrawings(this.shownDrawings());
    this.chart.setAlerts(this.alerts());
    this.chart.setSetups(this.setups());
    this.chart.setSuggestions(this.suggestions().map((x) => x.drawingId));
    this.chart.setMagnet(this.magnet());
    this.chart.setBoxInfo((d) => this.boxView(d));
    this.stopThemeWatch = onThemeChange(() => {
      this.palette.set(indicatorPalette());
      this.chart?.setTheme(theme());
    });
    void this.load();
  }

  ngOnDestroy(): void {
    clearInterval(this.autoMapTimer);
    clearTimeout(this.tipTimer);
    this.stopThemeWatch?.();
    this.loadSeq++;
    this.chart?.destroy();
    this.chart = undefined;
  }

  /** Choisit un outil de tracé ; le même, cliqué de nouveau, le repose. */
  pick(tool: DrawTool): void {
    const next = this.tool() === tool ? null : tool;
    this.tool.set(next);
    this.menuOpen.set(false);
    this.alertsOpen.set(false);
    this.chart?.setTool(next);
  }

  /** La carte automatique de ce produit et de cette unité ; une réponse dépassée (autre produit, carte masquée) est ignorée. */
  private async loadAutoMap(key: string): Promise<void> {
    const p = this.panel();
    if (!p.symbol || !p.timeframe) return;
    const map = await this.kopilia.autoMap(p.symbol, p.timeframe);
    if (!this.autoMapOn() || key !== this.key()) return;
    this.chart?.setAutoMap(map);
    this.autoMap.set(map);
  }

  /* ------------------------------- Alertes ------------------------------- */

  toggleAlerts(): void {
    this.alertDraft.set(null);
    this.menuOpen.set(false);
    this.aiOpen.set(false);
    this.alertsOpen.set(!this.alertsOpen());
  }

  /** Ouvre le réglage d'une alerte (nouvelle ou existante) ; `from` : où revenir après. */
  openAlert(draft: AlertDraft, from: "list" | "chart" = "chart"): void {
    this.alertFrom = from;
    this.ctxMenu.set(null);
    this.menuOpen.set(false);
    this.alertDraft.set(draft);
    this.alertsOpen.set(true);
  }

  draftFor(a: Alert): AlertDraft {
    return draftOf(a);
  }

  closeAlertForm(): void {
    this.alertDraft.set(null);
    if (this.alertFrom === "chart") this.alertsOpen.set(false);
  }

  /** Pose ou règle l'alerte ; une alerte déjà partie qu'on enregistre repart. La première demande aussi la permission des notifications. */
  async saveAlert(d: AlertDraft): Promise<void> {
    askNotifications();
    const message = d.message.trim();
    const ok = d.id
      ? await this.kopilia.updateAlert(d.id, {
          condition: d.condition,
          trigger: d.trigger,
          message: message || null,
          ...(d.target.kind === "price" ? { price: d.target.price } : {}),
          ...(d.stopped ? { state: "active" as const } : {}),
        })
      : await this.kopilia.createAlert(this.panel().symbol ?? "", d.timeframe, {
          target: d.target,
          condition: d.condition,
          trigger: d.trigger,
          message,
        });
    if (ok) this.closeAlertForm();
  }

  async deleteAlert(id: string): Promise<void> {
    if (await this.kopilia.deleteAlert(id)) this.closeAlertForm();
  }

  pauseAlert(id: string, paused: boolean): void {
    void this.kopilia.updateAlert(id, { state: paused ? "paused" : "active" });
  }

  /** Une alerte de prix glissée : refusée par le serveur, elle reprend sa place. */
  private async moveAlert(id: string, price: number): Promise<void> {
    if (!(await this.kopilia.updateAlert(id, { price }))) this.chart?.setAlerts(this.alerts());
  }

  /** Le menu du clic droit, gardé dans le graphique. */
  private openMenu(items: MenuItem[], x: number, y: number): void {
    if (!items.length) return;
    const host = this.host().nativeElement;
    const h = items.length * MENU_ITEM_H + 10;
    const left = Math.max(4, Math.min(x, host.clientWidth - MENU_W - 4));
    const top = y + 4 + h <= host.clientHeight ? y + 4 : Math.max(4, y - h - 4);
    this.menuOpen.set(false);
    this.alertsOpen.set(false);
    this.ctxMenu.set({ x: left, y: top, items });
  }

  runItem(item: MenuItem): void {
    this.ctxMenu.set(null);
    item.run();
  }

  /** Ce que propose le clic droit : sur une alerte de prix, sur un tracé, ou sur un prix. */
  private targetItems(t: ChartTarget): MenuItem[] {
    if (t.kind === "price") return this.priceItems(t.price);
    if (t.kind === "alert") {
      const a = this.userAlerts().find((x) => x.id === t.id);
      return a ? this.alertItems(a) : [];
    }
    const d = this.drawings().find((x) => x.id === t.id);
    if (!d) return [];
    // Un niveau de travail de l'IA : il se garde (il devient le sien) ou se retire (l'IA relira ses dossiers sans lui).
    if (d.createdBy === "ia")
      return [
        {
          icon: "keep",
          label: "Garder ce niveau",
          title: d.reason ? `Pourquoi l'IA l'a tracé : ${d.reason}` : undefined,
          run: () => void this.kopilia.keepLevel(d.id),
        },
        { icon: "trash", label: "Retirer ce niveau", hint: "Suppr", danger: true, run: () => this.erase(d.id) },
      ];
    const items: MenuItem[] = [];
    const advice = this.suggestions().find((x) => x.drawingId === d.id);
    if (advice) {
      items.push(
        { icon: "ai", label: `IA : ${clip(advice.text, 34)}`, title: advice.text, run: () => this.kopilia.openSetups() },
        { icon: "trash", label: "Ignorer la suggestion", run: () => void this.kopilia.dismissSuggestion(advice.id) },
      );
    }
    if (canWatch(d)) {
      // Sur un Fibonacci, l'alerte porte sur le niveau visé par le clic droit.
      const level = d.kind === "fib" || d.kind === "fibext" ? (t.level ?? fibLevels(d)[0].ratio) : undefined;
      const a = alertOn(this.userAlerts(), d.id, level);
      const ratio = level !== undefined ? fibRatioLabel(level) : "";
      if (a) items.push(...this.alertItems(a, ratio && ` du ${ratio}`));
      else
        items.push({
          icon: "bell",
          // Le prix du niveau est écrit à côté de lui, et dans le titre du réglage : le menu reste court.
          label: ratio ? `Alerte sur le ${ratio}…` : "Ajouter une alerte…",
          hint: "Alt+A",
          run: () => this.openAlert(lineDraft(d, this.panel().timeframe ?? "15m", level)),
        });
    }
    if (d.kind === "position") items.unshift({ icon: "risk", label: "Risque…", run: () => this.openRisk(d.id) });
    if (d.kind !== "hline" && d.kind !== "position")
      items.push({ icon: "extend", label: "Prolonger vers la droite", on: this.reachesRight(d), run: () => this.toggleExtend(d) });
    items.push({ icon: "trash", label: "Effacer le tracé", hint: "Suppr", danger: true, run: () => this.erase(d.id) });
    return items;
  }

  /** Une alerte, ou une ligne horizontale, à ce prix. */
  private priceItems(price: number): MenuItem[] {
    const p = formatPrice(price, this.chartDigits());
    return [
      {
        icon: "bell",
        label: `Alerte à ${p}…`,
        hint: "Alt+A",
        run: () => this.openAlert(priceDraft(price, this.quote()?.bid, this.panel().timeframe ?? "15m")),
      },
      { icon: "line", label: `Ligne horizontale à ${p}`, run: () => void this.kopilia.draw(this.panel().symbol ?? "", { kind: "hline", price }) },
    ];
  }

  /** Régler, suspendre ou réactiver, supprimer une alerte ; `of` la précise (« du 0,618 », sur un Fibonacci). */
  private alertItems(a: Alert, of = ""): MenuItem[] {
    return [
      { icon: "edit", label: `Régler l'alerte${of}…`, run: () => this.openAlert(draftOf(a)) },
      a.state === "active"
        ? { icon: "pause", label: `Suspendre l'alerte${of}`, run: () => this.pauseAlert(a.id, true) }
        : { icon: "play", label: `Réactiver l'alerte${of}`, run: () => this.pauseAlert(a.id, false) },
      { icon: "trash", label: `Supprimer l'alerte${of}`, danger: true, run: () => void this.kopilia.deleteAlert(a.id) },
    ];
  }

  /**
   * Alt+A : une alerte sur la ligne sélectionnée (sur un Fibonacci, sur le
   * niveau le plus proche du pointeur), sinon au prix sous le pointeur (ou au dernier prix).
   */
  private alertFromKeyboard(): void {
    const d = this.selectedDrawing();
    const tf = this.panel().timeframe ?? "15m";
    if (d && canWatch(d)) {
      const level = d.kind === "fib" || d.kind === "fibext" ? fibLevelNear(d, this.chart?.cursorPrice() ?? d.b.price).ratio : undefined;
      const a = alertOn(this.userAlerts(), d.id, level);
      this.openAlert(a ? draftOf(a) : lineDraft(d, tf, level));
      return;
    }
    const price = this.chart?.cursorPrice();
    if (price !== undefined) this.openAlert(priceDraft(price, this.quote()?.bid, tf));
  }

  /** Une oblique ou un Fibonacci prolongés vers la droite, ou une zone qui va jusqu'à maintenant. */
  reachesRight(d: Drawing): boolean {
    if (d.kind === "trendline" || d.kind === "fib" || d.kind === "fibext") return d.extend;
    return d.kind === "zone" && d.to === undefined;
  }

  /** Prolonge vers la droite, ou arrête à la dernière bougie (une zone). */
  toggleExtend(d: Drawing): void {
    const shape = shapeOf(d);
    if (shape.kind === "trendline" || shape.kind === "fib" || shape.kind === "fibext") void this.editDrawing(d.id, { ...shape, extend: !shape.extend });
    else if (shape.kind === "zone") {
      const { to, ...rest } = shape;
      const last = this.candles[this.candles.length - 1]?.t;
      if (to !== undefined) void this.editDrawing(d.id, rest);
      else if (last !== undefined) void this.editDrawing(d.id, { ...rest, to: last });
    }
  }

  erase(id: string): void {
    this.selected.set(undefined);
    void this.kopilia.eraseDrawing(id);
  }

  label(i: Indicator): string {
    return indicatorLabel(i);
  }

  /** « MME 21 », « RSI 14 · 30 / 70 · MM 14 » : la ligne d'un indicateur dans le panneau. */
  describe(i: Indicator): string {
    if (i.kind === "ma") return `${indicatorLabel(i)} · ${MA_NAMES[i.type]}`;
    return `${indicatorLabel(i)} · ${i.oversold} / ${i.overbought}${i.signal ? ` · moyenne ${i.signal.period}` : ""}`;
  }

  /** La couleur d'un indicateur tracé : la sienne, sinon celle de son rang (comme sur le graphique). */
  colorHex(i: Indicator, k: number): string {
    return this.palette()[i.color ?? INDICATOR_COLORS[k % INDICATOR_COLORS.length]];
  }

  toggleMenu(): void {
    this.editor.set(null);
    this.alertsOpen.set(false);
    this.aiOpen.set(false);
    this.menuOpen.set(!this.menuOpen());
  }

  /** Le panneau de l'analyse de l'IA : la carte automatique et les niveaux de ses setups, à montrer ou masquer. */
  toggleAi(): void {
    this.menuOpen.set(false);
    this.editor.set(null);
    this.alertsOpen.set(false);
    this.alertDraft.set(null);
    this.aiOpen.set(!this.aiOpen());
  }

  /* -------------------------- Bulles des outils -------------------------- */

  /** Le pointeur (ou le clavier) arrive sur un outil : sa bulle, après un court délai si aucune n'est ouverte. */
  tipOver(e: Event): void {
    const button = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
    const key = button?.dataset["tip"] as TipKey | undefined;
    if (!button || !key || !(key in TIPS)) return this.tipOut();
    if (this.menuOpen() || this.alertsOpen() || this.aiOpen() || this.tip()?.key === key) return;
    clearTimeout(this.tipTimer);
    const show = () => {
      const foot = this.foot()?.nativeElement;
      if (!foot || !button.isConnected) return;
      const f = foot.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      this.tip.set({ key, tip: TIPS[key], left: tipLeft(b.left + b.width / 2 - f.left, f.width) });
    };
    if (this.tip()) show();
    else this.tipTimer = setTimeout(show, TIP_DELAY_MS);
  }

  tipOut(): void {
    clearTimeout(this.tipTimer);
    if (this.tip()) this.tip.set(null);
  }

  editorTitle(e: Editor): string {
    if (e.draft.kind === "rsi") return e.isNew ? "Nouveau RSI" : `Réglages · ${indicatorLabel(e.draft)}`;
    return e.isNew ? "Nouvelle moyenne mobile" : `Réglages · ${indicatorLabel(e.draft)}`;
  }

  /** Un nouvel indicateur aux réglages d'usage, à régler avant de l'ajouter ; sa couleur, celle du rang qu'il prendra. */
  newIndicator(kind: "ma" | "rsi"): void {
    const k = this.indicators().length;
    const draft = completeIndicator({ kind, color: INDICATOR_COLORS[k % INDICATOR_COLORS.length] }, newIndicatorId());
    this.editor.set({ draft, isNew: true });
  }

  editIndicator(i: Indicator, k: number): void {
    this.editor.set({ draft: { ...i, color: i.color ?? INDICATOR_COLORS[k % INDICATOR_COLORS.length] }, isNew: false });
  }

  /** Change une partie des réglages en cours. */
  patch(changes: Record<string, unknown>): void {
    this.editor.update((e) => (e ? { ...e, draft: { ...e.draft, ...changes } as Indicator } : e));
  }

  setSignalType(type: string): void {
    this.editor.update((e) => {
      if (!e || e.draft.kind !== "rsi") return e;
      const { signal, ...rest } = e.draft;
      if (type === "none") return { ...e, draft: rest };
      return { ...e, draft: { ...rest, signal: { type: type as MaType, period: signal?.period ?? 14 } } };
    });
  }

  setSignalPeriod(period: number): void {
    this.editor.update((e) => (e && e.draft.kind === "rsi" && e.draft.signal ? { ...e, draft: { ...e.draft, signal: { ...e.draft.signal, period } } } : e));
  }

  /** Ajoute l'indicateur réglé, ou applique ses nouveaux réglages. */
  applyEditor(): void {
    const e = this.editor();
    if (!e || this.draftError()) return;
    const list = this.indicators();
    this.save(e.isNew ? [...list, e.draft] : list.map((i) => (i.id === e.draft.id ? e.draft : i)));
    this.editor.set(null);
  }

  addIndicator(indicator: Indicator): void {
    this.save([...this.indicators(), { ...indicator, id: newIndicatorId() }]);
  }

  toggleHidden(i: Indicator): void {
    this.save(this.indicators().map((j) => (j.id === i.id ? { ...j, hidden: !j.hidden } : j)));
  }

  removeIndicator(i: Indicator): void {
    this.save(this.indicators().filter((j) => j.id !== i.id));
  }

  /** La valeur d'un champ numérique (NaN s'il est vide : les réglages le signalent). */
  num(e: Event): number {
    const v = (e.target as HTMLInputElement).value;
    return v === "" ? NaN : Number(v);
  }

  private save(list: Indicator[]): void {
    void this.kopilia.setIndicators(this.panel().id, list);
  }

  /**
   * Échap ferme un menu, le réglage en cours, ou annule l'outil, le tracé
   * commencé, la sélection (sans fermer l'encart) ; Suppr efface le tracé
   * sélectionné.
   */
  @HostListener("keydown", ["$event"])
  onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (this.ctxMenu()) this.ctxMenu.set(null);
      else if (this.riskFor()) this.riskFor.set(null);
      else if (this.alertDraft()) this.closeAlertForm();
      else if (this.alertsOpen()) this.alertsOpen.set(false);
      else if (this.editor()) this.editor.set(null);
      else if (this.menuOpen()) this.menuOpen.set(false);
      else if (this.aiOpen()) this.aiOpen.set(false);
      else if (!this.chart?.cancel()) return;
      e.stopPropagation();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected() && !(e.target as HTMLElement | null)?.closest("input, textarea, select")) {
      e.preventDefault();
      this.erase(this.selected()!);
    }
  }

  /** Alt+A, le pointeur sur ce graphique (ou le graphique sélectionné) : une alerte, comme sur TradingView. */
  @HostListener("document:keydown", ["$event"])
  onDocumentKey(e: KeyboardEvent): void {
    if (!e.altKey || e.code !== "KeyA" || e.metaKey || e.ctrlKey) return;
    if ((e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
    const host = this.host().nativeElement;
    if (!this.hovered() && !host.contains(document.activeElement)) return;
    e.preventDefault();
    this.alertFromKeyboard();
  }

  /** Un clic ailleurs ferme les menus (indicateurs, alertes, clic droit). */
  @HostListener("document:pointerdown", ["$event"])
  onOutside(e: PointerEvent): void {
    const target = e.target as Node;
    if (this.ctxMenu() && !this.ctx()?.nativeElement.contains(target)) this.ctxMenu.set(null);
    if (this.riskFor() && !this.riskMenu()?.nativeElement.contains(target) && !this.ctx()?.nativeElement.contains(target)) this.riskFor.set(null);
    if (this.alertsOpen() && !this.alertMenu()?.nativeElement.contains(target) && !this.alertButton()?.nativeElement.contains(target)) {
      this.alertsOpen.set(false);
      this.alertDraft.set(null);
    }
    if (this.aiOpen() && !this.aiMenu()?.nativeElement.contains(target) && !this.aiButton()?.nativeElement.contains(target)) this.aiOpen.set(false);
    if (!this.menuOpen()) return;
    if (this.menu()?.nativeElement.contains(target) || this.menuButton()?.nativeElement.contains(target)) return;
    this.menuOpen.set(false);
    this.editor.set(null);
  }

  /** « 3 nov. 11:45 · O 1,08342 H 1,08360 L 1,08320 C 1,08342 » */
  legend(c: Candle): string {
    const d = this.digits();
    return `${timeLabel(c.t, this.tfSeconds())} · O ${formatPrice(c.o, d)}  H ${formatPrice(c.h, d)}  L ${formatPrice(c.l, d)}  C ${formatPrice(c.c, d)}`;
  }

  private digits(): number {
    return this.panel().digits ?? this.quote()?.digits ?? 5;
  }

  private tfSeconds(): number {
    return TIMEFRAME_SECONDS[this.panel().timeframe ?? "15m"] ?? 900;
  }

  private key(): string {
    const p = this.panel();
    return `${p.symbol}|${p.timeframe}`;
  }

  private async load(): Promise<void> {
    const p = this.panel();
    const key = this.key();
    const seq = ++this.loadSeq;
    this.loadedKey = key;
    this.failed.set(null);
    this.loading.set(true);
    this.candles = [];
    this.hovered.set(undefined);
    this.chart?.setCandles([]);
    this.chart?.resetScale();
    this.chart?.setDigits(this.digits());
    this.chart?.setTimeframe(this.tfSeconds());
    this.chart?.setQuoteTime(this.quote()?.time);
    try {
      const r = await this.kopilia.loadCandles(p.symbol ?? "", p.timeframe ?? "15m");
      if (seq !== this.loadSeq) return;
      this.candles = r.candles;
      this.more = r.more;
      this.loading.set(false);
      this.chart?.setCandles(this.candles);
      this.chart?.scrollToLatest();
      const q = this.quote();
      if (q) this.onQuote(q);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.loading.set(false);
      this.failed.set(`Graphique indisponible : ${(e as Error).message}`);
    }
  }

  /** La bougie en cours suit le prix ; une nouvelle bougie reprend la précédente telle que le courtier l'a close. */
  private onQuote(q: QuoteView): void {
    // L'heure de la cotation : trop ancienne (marché fermé), le compte à rebours de la bougie se tait.
    this.chart?.setQuoteTime(q.time);
    if (!this.chart || !this.candles.length || this.loadedKey !== this.key()) return;
    const r = applyQuote(this.candles, q.bid, q.time, this.tfSeconds(), this.panel().timeframe === "1mn");
    if (!r) return;
    if (r.isNew) {
      this.candles.push(r.candle);
      void this.resync();
    } else {
      this.candles[this.candles.length - 1] = r.candle;
    }
    this.chart.updateLast(r.candle);
  }

  /** Les dernières bougies, reprises du courtier (clôture exacte), sans bouger la vue. */
  private async resync(): Promise<void> {
    const p = this.panel();
    const key = this.key();
    try {
      const r = await this.kopilia.loadCandles(p.symbol ?? "", p.timeframe ?? "15m", undefined, 3);
      if (!this.chart || key !== this.loadedKey) return;
      this.candles = resyncCandles(this.candles, r.candles);
      this.chart.setCandles(this.candles, 0);
    } catch {
      /* la bougie en cours reste celle des cotations */
    }
  }

  /* -------------------------- Prise de position -------------------------- */

  /** Le réglage du risque d'une boîte (clic droit) ; les autres panneaux se ferment. */
  openRisk(id: string): void {
    this.alertsOpen.set(false);
    this.menuOpen.set(false);
    this.aiOpen.set(false);
    this.riskFor.set(id);
  }

  /** Le risque choisi pour la boîte (null : celui du money management), gardé avec elle par le serveur. */
  async saveRisk(d: Extract<Drawing, { kind: "position" }>, risk: Risk | null): Promise<void> {
    this.riskFor.set(null);
    const { risk: _old, ...shape } = shapeOf(d) as Extract<DrawingShape, { kind: "position" }>;
    await this.editDrawing(d.id, risk ? { ...shape, risk } : shape);
  }

  /** Ce qu'une boîte montre d'elle-même, écrit : taille, gain, perte et pourcentage, et son trade. */
  private boxView(d: ShownDrawing): ChartBoxInfo | undefined {
    if (d.kind !== "position") return undefined;
    const info = this.kopilia.boxInfo(this.panel().symbol ?? "", d, d.id || undefined);
    if (!info) return undefined;
    const cur = info.currency;
    const s = info.sizing;
    const t = info.trade;
    const r = (v: number) => `${v < 0 ? "\u2212" : "+"}${String(Number(Math.abs(v).toFixed(2))).replace(".", ",")} R`;
    return {
      ...(s && s.lots > 0
        ? {
            lots: lotsLabel(s.lots),
            gain: moneyLabel(s.gain, cur, { sign: true }),
            loss: `${moneyLabel(-s.loss, cur, { sign: true })} · ${percentLabel(s.riskPercent)}`,
          }
        : {}),
      ...(s?.problem && !s.lots ? { problem: s.problem.replace(/^le stop est trop loin pour ce risque : /, "trop loin : ") } : {}),
      ...(t
        ? {
            trade: {
              state: t.state,
              ...(t.profit !== undefined ? { result: `${moneyLabel(t.profit, t.currency, { sign: true })}${t.r !== undefined ? ` · ${r(t.r)}` : ""}` } : {}),
              stop: t.stop,
              protected: t.protected,
            },
          }
        : {}),
    };
  }

  /** Un tracé déplacé : refusé par le serveur, il reprend sa place. */
  private async editDrawing(id: string, shape: DrawingShape): Promise<void> {
    if (!(await this.kopilia.editDrawing(id, shape))) this.chart?.setDrawings(this.shownDrawings());
  }

  /** Près du bord gauche : le paquet de bougies d'avant, sans que la vue saute. */
  private async loadMore(): Promise<void> {
    if (!this.more || this.loadingMore || !this.candles.length || !this.chart) return;
    this.loadingMore = true;
    const p = this.panel();
    const key = this.key();
    try {
      const r = await this.kopilia.loadCandles(p.symbol ?? "", p.timeframe ?? "15m", this.candles[0].t - 1);
      if (key !== this.loadedKey || !this.chart) return;
      this.more = r.more;
      const merged = mergeCandles(this.candles, r.candles);
      const prepended = merged.length - this.candles.length;
      this.candles = merged;
      this.chart.setCandles(merged, prepended);
    } catch {
      this.more = false;
    } finally {
      this.loadingMore = false;
    }
  }
}

/** Les teintes des couleurs d'indicateur, lisibles sur fond sombre ou clair. */
function indicatorPalette(): Record<IndicatorColor, string> {
  return isLight()
    ? {
        orange: "#d97706",
        violet: "#7c3aed",
        cyan: "#0891b2",
        pink: "#db2777",
        green: "#4d7c0f",
        yellow: "#a16207",
        blue: "#2563eb",
        red: "#dc2626",
        gray: "#64748b",
      }
    : {
        orange: "#ffb454",
        violet: "#b48cff",
        cyan: "#4fc3f7",
        pink: "#f48fb1",
        green: "#aed581",
        yellow: "#ffd54f",
        blue: "#82aaff",
        red: "#ff8a80",
        gray: "#b0bec5",
      };
}

/** « i_3f2a » : l'identifiant d'un indicateur ajouté à l'écran (le serveur le garde). */
function newIndicatorId(): string {
  return `i_${Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0")}`;
}

/** L'aimant gardé sur cet écran (faible par défaut). */
function savedMagnet(): Magnet {
  try {
    const v = localStorage.getItem(MAGNET_KEY);
    if (v === "off" || v === "weak" || v === "strong") return v;
  } catch {
    /* stockage indisponible */
  }
  return "weak";
}

/** La carte automatique, telle que l'utilisateur l'a laissée sur cet écran (masquée par défaut). */
function savedAutoMap(): boolean {
  try {
    return localStorage.getItem(AUTOMAP_KEY) === "1";
  } catch {
    return false;
  }
}

/** Un choix oui / non gardé sur cet écran ; `fallback` s'il n'y en a pas. */
function savedFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* stockage indisponible : le choix vaut pour cette page */
  }
}

/** Les couleurs du thème (sombre ou clair), lues sur la page. */
function theme(): ChartTheme {
  const v = cssVar;
  return {
    text: v("--muted", "#9aa0ab"),
    grid: v("--border", "#2a2f3a"),
    up: v("--accent-2", "#38d39f"),
    down: v("--danger", "#ff6b6b"),
    accent: v("--accent", "#5b8cff"),
    panel: v("--panel-2", "#1f232c"),
    surface: v("--panel", "#171a21"),
    onAccent: "#ffffff",
    alert: v("--warn", "#ffb454"),
    ai: v("--ai", "#b48cff"),
    font: SYSTEM_FONT,
    palette: indicatorPalette(),
  };
}

/** Un texte coupé à `n` caractères, avec des points de suspension. */
function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`;
}
