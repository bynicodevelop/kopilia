/**
 * Graphique en bougies dessiné à la main sur un canvas, sans bibliothèque :
 * les bougies du courtier, l'axe des prix et celui du temps (heure de Paris,
 * le jour quand il change), la ligne du dernier prix (et le temps restant de
 * la bougie en cours sous son étiquette), le réticule et ses
 * étiquettes, la bougie survolée ; zoom à la molette ou au pincement,
 * défilement à la souris ou au doigt, et le passé demandé en approchant du
 * bord gauche. Par-dessus : les moyennes mobiles, le RSI dans un bandeau sous
 * les bougies, les tracés du produit (lignes, obliques, zones, Fibonacci,
 * boîtes de trade), posés,
 * saisis, déplacés et effacés à la souris, et ses alertes (une cloche sur les
 * lignes, les zones et les niveaux de Fibonacci qui en portent, les alertes de prix en pointillés, qu'on
 * glisse ; le « + » contre l'axe des prix, le clic droit). En violet, ce que
 * fait l'IA : ses alertes (marquées « IA »), les niveaux des setups qu'elle
 * propose, et la carte automatique, en dessous de tout. Aux couleurs du thème ; net sur
 * un écran Retina ; suit la taille de son conteneur (l'encart se redimensionne).
 * Les calculs de graduations et de tracés sont des fonctions pures, testées
 * sans écran.
 */
import {
  Alert,
  Drawing,
  DrawingShape,
  FibShape,
  INDICATOR_COLORS,
  Indicator,
  IndicatorColor,
  MA_SHORT,
  PositionShape,
  RsiIndicator,
  barPosition,
  barTime,
  fibLevelPrice,
  fibLevels,
  fibRatioLabel,
  indicatorLabel,
  indicatorSeries,
  isOverlay,
  positionRatio,
  ratioLabel,
} from "@kopilia/contracts";
import { Candle, candleTimeLeft, formatPrice, formatTimeLeft } from "./candles";
import { dateFormat, decimalFormat } from "../format";
import {
  ChartPoint,
  DrawTool,
  Frame,
  Magnet,
  Part,
  constrainAngle,
  dragShape,
  effectiveMagnet,
  fibGeometry,
  fibLevelAt,
  ghostShape,
  hitTest,
  isKeyFibLevel,
  isMove,
  pointsNeeded,
  positionFrom,
  positionGeometry,
  positionTool,
  shapeFrom,
  shapeOf,
  snapPrice,
  trendlineSegment,
  zoneRect,
} from "./chart-tools";
import { matchLevel, SPOT_MS, type PriceMention, type SpotLevel } from "./price-spots";

export interface ChartTheme {
  text: string;
  grid: string;
  up: string;
  down: string;
  accent: string;
  /** Fond des étiquettes du réticule. */
  panel: string;
  /** Fond de l'encart, sous le graphique : le halo qui détache une étiquette des bougies. */
  surface: string;
  onAccent: string;
  /** Les alertes : leurs lignes de prix, leurs cloches. */
  alert: string;
  /** Ce que fait l'IA : ses alertes, les setups qu'elle propose, la carte automatique. */
  ai: string;
  font: string;
  /** Teinte de chaque couleur d'indicateur (sans couleur choisie : selon son rang). */
  palette: Record<IndicatorColor, string>;
}

export interface ChartCallbacks {
  /** La vue approche des bougies les plus anciennes : en charger d'avant. */
  onNeedMore?: () => void;
  /** La bougie sous le pointeur a changé (undefined : le pointeur est sorti). */
  onHover?: (candle: Candle | undefined) => void;
  /** Un tracé vient d'être posé à la souris ; l'outil se libère (`onToolEnd`). */
  onDraw?: (shape: DrawingShape) => void;
  /** Un tracé a été déplacé à la souris. */
  onEdit?: (id: string, shape: DrawingShape) => void;
  /** Le tracé sélectionné a changé (undefined : aucun). */
  onSelect?: (id: string | undefined) => void;
  /** L'outil de tracé est libéré (tracé posé ou annulé). */
  onToolEnd?: () => void;
  /** Clic droit sur une alerte de prix, un tracé, ou un prix ; (x, y) : dans le graphique. */
  onContext?: (target: ChartTarget, x: number, y: number) => void;
  /** Le « + » contre l'axe des prix, cliqué : le prix du réticule. */
  onPlus?: (price: number, x: number, y: number) => void;
  /** Une alerte de prix glissée à un autre prix. */
  onAlertMove?: (id: string, price: number) => void;
}

/**
 * Ce qu'une boîte de trade montre d'elle-même, déjà écrit : sa taille
 * (« 2,4 lots »), son gain (« +286 € ») et sa perte (« −98 € · 0,98 % »), ce
 * qui empêche de la prendre ; et son trade s'il y en a un : son état, son
 * résultat (« +42 € · +0,4 R »), son stop du moment.
 */
export interface ChartBoxInfo {
  lots?: string;
  gain?: string;
  loss?: string;
  problem?: string;
  trade?: { state: "pending" | "open" | "closed" | "cancelled" | "rejected"; result?: string; stop?: number; protected?: boolean };
}

/** Ce que vise un clic droit ; sur un Fibonacci, le niveau le plus proche (son ratio). */
export type ChartTarget = { kind: "alert"; id: string } | { kind: "drawing"; id: string; level?: number } | { kind: "price"; price: number };

/** Un setup proposé par l'IA, tel que le graphique le montre : ses niveaux, depuis sa proposition (epoch s). */
export interface ChartSetup {
  id: string;
  direction: "long" | "short";
  entry?: number;
  stop?: number;
  targets: number[];
  since: number;
}

/** La carte automatique (zones, obliques, divergences RSI), corrigée par l'IA, telle que le graphique la montre. */
export interface ChartAutoMap {
  zones: Array<{ key: string; top: number; bottom: number; corrected?: string }>;
  trendlines: Array<{ key: string; a: { t: number; price: number }; b: { t: number; price: number } }>;
  divergences: Array<{ kind: "bullish" | "bearish"; from: { t: number; price: number }; to: { t: number; price: number } }>;
}

/** Largeur d'une bougie (espace compris), en px. */
const MIN_BAR = 2;
const MAX_BAR = 48;
const DEFAULT_BAR = 7;
/** Hauteur de l'axe du temps. */
const AXIS_H = 22;
/** Marge minimale à droite du bord de la vue, en bougies (la dernière n'est jamais coupée). */
const RIGHT_MARGIN_BARS = 0.5;
/** Bougies d'avance laissées par défaut à droite de la dernière, pour qu'elle ne colle pas à l'axe des prix. */
const DEFAULT_FUTURE_BARS = 6;
/** Part de la vue qu'on peut laisser vide à droite de la dernière bougie, en tirant le graphique. */
const MAX_FUTURE_SHARE = 0.8;
/** Glisser le graphique de plus que cela en hauteur le déplace verticalement (l'échelle des prix passe à la main). */
const VERTICAL_PAN_PX = 24;
/** Sensibilité du glisser sur les axes (zoom en hauteur ou en largeur), par pixel. */
const AXIS_ZOOM = 0.006;
/** En deçà de ce nombre de bougies avant le bord gauche, le passé est demandé. */
const MORE_THRESHOLD = 15;
/** Air au-dessus et au-dessous des bougies visibles. */
const PRICE_PAD = 0.07;
const TICK_PX = 44;
const TIME_TICK_PX = 84;
const FONT_SIZE = 11;
/** Bandeau du RSI : sa part de la hauteur, sa hauteur minimale, l'espace qui le sépare des bougies. */
const RSI_SHARE = 0.24;
const RSI_MIN_H = 56;
const PANE_GAP = 6;
/** Un clic qui bouge de moins que cela reste un clic (un tracé en deux clics), pas un glisser. */
const CLICK_PX = 4;
/** Le « + » contre l'axe des prix : son rayon ; la ligne d'une alerte se saisit à cette distance. */
const PLUS_R = 7;
const ALERT_HIT_PX = 5;
/** Une alerte qui part fait clignoter sa ligne ce temps-là (ms). */
const FLASH_MS = 4000;
/** Les niveaux d'un setup proposé se lisent sur au moins cette largeur (avant l'axe des prix). */
const SETUP_MIN_PX = 160;
/** Un prix cité par Kopilia s'allume puis s'éteint en douceur. */
const SPOT_IN_MS = 180;
const SPOT_OUT_MS = 700;
/** Étiquette du dernier prix : sa hauteur, et celle de la ligne du compte à rebours en dessous. */
const LABEL_H = 16;
const COUNTDOWN_H = 13;

/** Ce qui s'allume quand Kopilia cite un prix : un élément du graphique, ou, faute de mieux, le prix lui-même (« bare »). */
type SpotRef =
  | { kind: "drawing"; id: string; part?: "entry" | "stop" | "target"; ratio?: number }
  | { kind: "alert"; id: string }
  | { kind: "setup"; id: string; part: "entry" | "stop" | number }
  | { kind: "auto-zone"; key: string }
  | { kind: "auto-trend"; key: string }
  | { kind: "indicator"; index: number }
  | { kind: "last" }
  | { kind: "bare"; low: number; high: number };

/** Un prix allumé : ce qui s'allume, les prix montrés sur l'axe, depuis quand et jusqu'à quand (performance.now). */
interface Spot {
  ref: SpotRef;
  prices: number[];
  start: number;
  until: number;
}

/** Ce qu'on dessine d'un prix allumé, en pixels : des traits, une bande, ou la courbe d'un indicateur. */
interface SpotShape {
  color: string;
  segs: Array<readonly [{ x: number; y: number }, { x: number; y: number }]>;
  band?: { left: number; right: number; top: number; bottom: number };
  series?: number[];
}

interface Tick {
  index: number;
  label: string;
  /** Changement de jour : étiquette en évidence, trait un peu plus marqué. */
  day: boolean;
}

/** Les volets du graphique, en px : les bougies en haut, le RSI (s'il y en a un) au-dessous. */
interface Layout {
  plotW: number;
  plotH: number;
  axisW: number;
  /** Hauteur du volet des prix. */
  priceH: number;
  /** Haut et hauteur du bandeau du RSI (0 sans RSI). */
  rsiTop: number;
  rsiH: number;
}

/** Un tracé tel qu'affiché (éventuellement à la place où on le déplace) ; « ia » : un niveau de travail de l'IA. */
export type ShownDrawing = DrawingShape & { id: string; label?: string; createdBy?: Drawing["createdBy"] };

/** Échelle des prix du dernier dessin : la souris s'en sert pour poser et déplacer les tracés. */
interface Scale {
  min: number;
  max: number;
  h: number;
}

export class CandleChart {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver;
  private candles: Candle[] = [];
  private times: number[] = [];
  private tf = 900;
  private digits = 5;
  private barWidth = DEFAULT_BAR;
  /** Indice (fractionnaire) de la bougie au bord droit ; `follow` : la plus récente, toujours. */
  private rightIndex = 0;
  private follow = true;
  private w = 0;
  private h = 0;
  private hover?: { x: number; y: number };
  private hoverIndex = -1;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Le graphique saisi : défilement, et déplacement vertical (`range` : l'échelle au moment où il commence). */
  private drag?: { x: number; y: number; rightIndex: number; vertical: boolean; range?: { min: number; max: number; y: number } };
  /** Un axe saisi : celui des prix (hauteur des bougies) ou du temps (largeur). */
  private axisDrag?: { kind: "price" | "time"; x: number; y: number; barWidth: number; right: number; min: number; max: number };
  /** En suivi : bougies d'avance à droite de la dernière (on en crée en tirant le graphique vers la gauche). */
  private future = DEFAULT_FUTURE_BARS;
  /** Échelle des prix réglée à la main (axe tiré, graphique déplacé en hauteur) ; undefined : ajustée aux bougies visibles. */
  private manual?: { min: number; max: number };
  /** Maj maintenu : une oblique à 0°, 45° ou 90°. */
  private shift = false;
  private pinch?: { dist: number; barWidth: number; rightIndex: number; mid: number };
  private raf = 0;
  private moreAsked = false;
  private readonly ac = new AbortController();
  /* Indicateurs : la liste, et leur série recalculée à chaque changement de bougies. */
  private indicators: Indicator[] = [];
  private series: Array<{ main: number[]; signal?: number[] } | undefined> = [];
  /** Aimant choisi, et Cmd ou Ctrl maintenu (qui l'inverse). */
  private magnet: Magnet = "weak";
  private modifier = false;
  /* Tracés : ceux du produit, l'outil choisi, les points déjà posés, la sélection, le tracé en cours de déplacement. */
  private drawings: Drawing[] = [];
  private tool: DrawTool | null = null;
  private placed: ChartPoint[] = [];
  private selected?: string;
  /** Le tracé sous le pointeur (une boîte de trade y montre ses montants). */
  private hoveredId?: string;
  /** Ce qu'une boîte de trade montre d'elle-même : sa taille, ses montants, son trade (calculés par l'encart, en direct). */
  private boxInfo?: (d: ShownDrawing) => ChartBoxInfo | undefined;
  /** Tracés de l'utilisateur avec une suggestion de l'IA en attente. */
  private suggested = new Set<string>();
  private editing?: { id: string; part: Part; start: ChartPoint; original: DrawingShape; shape: DrawingShape; pointer: number };
  /** Forme déplacée en attente du serveur : affichée jusqu'à la liste suivante. */
  private moved?: { id: string; shape: DrawingShape };
  private down?: { x: number; y: number };
  private scale?: Scale;
  /* Alertes : celles du produit, celle de prix qu'on glisse, son nouveau prix en attente du serveur, celle qui clignote. */
  private alerts: Alert[] = [];
  private alertDrag?: { id: string; price: number; pointer: number; moved: boolean };
  private alertMoved?: { id: string; price: number };
  private flashing?: { id: string; until: number };
  /** Les prix que Kopilia vient de citer, allumés quelques secondes. */
  private spots: Spot[] = [];
  /** Les setups proposés sur ce produit, et la carte automatique (absente : masquée). */
  private setups: ChartSetup[] = [];
  private autoMap?: ChartAutoMap;
  /** Le « + » du dernier dessin (contre l'axe, à la hauteur du réticule), et pressé (il agit au relâcher, comme un bouton). */
  private plus?: { x: number; y: number; price: number };
  private plusDown = false;
  /** Heure de la dernière cotation (ms) : trop ancienne, le marché est fermé et le compte à rebours se tait. */
  private quoteTime?: number;
  /** Le compte à rebours du dernier dessin, et sa ligne sur l'axe (absente : dernier prix hors de la vue), repeinte seule chaque seconde. */
  private countdown?: { text?: string; rect?: { x: number; y: number; w: number; h: number } };
  /** Hauteur de l'étiquette du réticule sur l'axe des prix au dernier dessin (undefined : aucune). */
  private crossY?: number;
  private clock = 0;
  /** Largeur réservée au compte à rebours sur l'axe, pour une unité et une police. */
  private clockW?: { key: string; w: number };

  constructor(
    private readonly host: HTMLElement,
    private theme: ChartTheme,
    private readonly cb: ChartCallbacks = {},
  ) {
    this.ctx = this.canvas.getContext("2d")!;
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      touchAction: "none",
      cursor: "crosshair",
      display: "block",
      outline: "none",
    });
    // Focalisable : Suppr efface le tracé sélectionné (écouté par l'encart).
    this.canvas.tabIndex = 0;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    const o = { signal: this.ac.signal };
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e), o);
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e), o);
    this.canvas.addEventListener("pointerup", (e) => this.onUp(e), o);
    this.canvas.addEventListener("pointercancel", (e) => this.onUp(e), o);
    this.canvas.addEventListener("pointerleave", () => this.onLeave(), o);
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { ...o, passive: false });
    this.canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e), o);
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e), o);
    // Cmd ou Ctrl pressé ou relâché sans bouger la souris : l'aimant change aussitôt sous le pointeur.
    const onKey = (e: KeyboardEvent) => {
      this.setModifier(e.metaKey || e.ctrlKey);
      this.setShift(e.shiftKey);
    };
    window.addEventListener("keydown", onKey, o);
    window.addEventListener("keyup", onKey, o);
    window.addEventListener(
      "blur",
      () => {
        this.setModifier(false);
        this.setShift(false);
      },
      o,
    );
    this.resize();
    this.tick();
  }

  setTheme(theme: ChartTheme): void {
    this.theme = theme;
    this.schedule();
  }

  setDigits(digits: number): void {
    this.digits = digits;
    this.schedule();
  }

  setTimeframe(seconds: number): void {
    this.tf = seconds;
    this.placed = [];
    this.schedule();
  }

  /** Remplace les bougies ; `prepended` : combien ont été ajoutées devant (la vue ne bouge pas). */
  setCandles(candles: Candle[], prepended = 0): void {
    this.candles = candles;
    if (!this.follow) this.rightIndex += prepended;
    this.moreAsked = false;
    this.hoverIndex = -1;
    this.recompute();
    this.schedule();
  }

  /** La bougie en cours (même instant : remplacée) ou une nouvelle (ajoutée). */
  updateLast(candle: Candle): void {
    const last = this.candles[this.candles.length - 1];
    if (last && candle.t === last.t) this.candles[this.candles.length - 1] = candle;
    else if (!last || candle.t > last.t) this.candles.push(candle);
    else return;
    this.recompute();
    this.schedule();
  }

  /** Les indicateurs à tracer (moyennes sur les bougies, RSI dans son bandeau). */
  setIndicators(list: Indicator[]): void {
    this.indicators = list;
    this.recompute();
    this.schedule();
  }

  /** L'heure de la dernière cotation (ms ; undefined : aucune) : trop ancienne, pas de compte à rebours. */
  setQuoteTime(ms: number | undefined): void {
    this.quoteTime = ms;
  }

  /** L'aimant des tracés (désactivé, faible, fort). */
  setMagnet(mode: Magnet): void {
    this.magnet = mode;
    this.schedule();
  }

  /** Les tracés du produit, tels que le serveur les garde. */
  setDrawings(list: Drawing[]): void {
    this.drawings = list;
    this.moved = undefined;
    if (this.editing && !list.some((d) => d.id === this.editing!.id)) this.editing = undefined;
    if (this.selected && !list.some((d) => d.id === this.selected)) this.select(undefined);
    this.schedule();
  }

  /** Ce que montrent les boîtes de trade (taille, perte, gain, trade), calculé à chaque dessin : il suit le tracé qu'on tire. */
  setBoxInfo(fn: ((d: ShownDrawing) => ChartBoxInfo | undefined) | undefined): void {
    this.boxInfo = fn;
    this.schedule();
  }

  /** Les alertes du produit, telles que le serveur les garde. */
  setAlerts(list: Alert[]): void {
    this.alerts = list;
    this.alertMoved = undefined;
    this.schedule();
  }

  /** Les setups proposés par l'IA sur ce produit : leur entrée, leur stop, leurs objectifs. */
  /** Les tracés de l'utilisateur sur lesquels l'IA a une suggestion en attente (marqués « IA ? »). */
  setSuggestions(drawingIds: string[]): void {
    this.suggested = new Set(drawingIds);
    this.schedule();
  }

  setSetups(list: ChartSetup[]): void {
    this.setups = list;
    this.schedule();
  }

  /** La carte automatique du produit dans cette unité (undefined : masquée). */
  setAutoMap(map: ChartAutoMap | undefined): void {
    this.autoMap = map;
    this.schedule();
  }

  /** Une alerte vient de partir : sa ligne clignote quelques secondes. */
  flash(id: string): void {
    this.flashing = { id, until: performance.now() + FLASH_MS };
    this.schedule();
  }

  /**
   * Kopilia cite ce prix (ou cette zone) : ce qui est à ce prix sur le
   * graphique s'allume quelques secondes (tracé, alerte, niveau d'un setup,
   * moyenne, carte automatique, dernier prix) ; s'il n'y a rien, une ligne
   * violette temporaire. Hors de la vue, un repère au bord de l'axe ; la vue
   * ne bouge pas. Renvoie le genre de ce qui s'est allumé (« drawing », « bare »…).
   */
  spotlight(m: Pick<PriceMention, "low" | "high" | "decimals">): string | undefined {
    if (!this.candles.length) return undefined;
    const hit = matchLevel(m, this.spotLevels());
    const ref: SpotRef = hit?.key ?? { kind: "bare", low: m.low, high: m.high };
    const prices = !hit ? (m.high > m.low ? [m.high, m.low] : [m.low]) : "price" in hit ? [hit.price] : [hit.top, hit.bottom];
    const same = JSON.stringify(ref);
    const now = performance.now();
    this.spots = [...this.spots.filter((s) => JSON.stringify(s.ref) !== same), { ref, prices, start: now, until: now + SPOT_MS }];
    this.schedule();
    return ref.kind;
  }

  /** Le prix sous le pointeur (dans le volet des prix), sinon le dernier : celui d'une alerte posée au clavier. */
  cursorPrice(): number | undefined {
    const s = this.scale;
    const h = this.hover;
    if (s && h && h.x <= this.plotWidth() && h.y <= s.h) return this.priceAt(h.y);
    return this.candles[this.candles.length - 1]?.c;
  }

  /** L'outil de tracé (null : aucun, la souris fait défiler et sélectionne). */
  setTool(tool: DrawTool | null): void {
    this.tool = tool;
    this.placed = [];
    if (tool) this.select(undefined);
    this.canvas.style.cursor = "crosshair";
    this.schedule();
  }

  /** Échap : annule le tracé commencé, sinon l'outil, sinon la sélection. Vrai s'il y avait quelque chose à annuler. */
  cancel(): boolean {
    if (this.editing) {
      this.editing = undefined;
      this.schedule();
      return true;
    }
    if (this.tool) {
      this.setTool(null);
      this.cb.onToolEnd?.();
      return true;
    }
    if (this.selected) {
      this.select(undefined);
      return true;
    }
    return false;
  }

  /** Retour au présent : la dernière bougie, avec l'avance choisie à sa droite. */
  scrollToLatest(): void {
    this.follow = true;
    this.schedule();
  }

  /** Un autre produit ou une autre unité de temps : l'échelle des prix redevient automatique. */
  resetScale(): void {
    this.manual = undefined;
    this.schedule();
  }

  destroy(): void {
    this.ac.abort();
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.clock);
    this.canvas.remove();
  }

  /* ------------------------------ Géométrie ------------------------------ */

  private get right(): number {
    return this.follow ? this.candles.length - 1 + this.future : this.rightIndex;
  }

  private axisWidth(): number {
    const sample = this.candles.length ? Math.max(...this.candles.slice(-50).map((c) => c.h)) : 0;
    this.ctx.font = `${FONT_SIZE}px ${this.theme.font}`;
    const price = this.ctx.measureText(formatPrice(sample, this.digits)).width;
    return Math.max(48, Math.ceil(Math.max(price, this.countdownWidth())) + 14);
  }

  /** La place du plus long compte à rebours de l'unité (« 59:59 », « 30 j 23:59 ») : l'axe ne bouge pas quand le marché ouvre ou ferme. */
  private countdownWidth(): number {
    const key = `${this.tf}|${this.theme.font}`;
    if (this.clockW?.key !== key) {
      const longest = this.tf === MONTH ? 31 * 86_400 - 1 : this.tf - 1;
      this.clockW = { key, w: this.tabularWidth(formatTimeLeft(longest, this.tf)) };
    }
    return this.clockW.w;
  }

  private plotWidth(): number {
    return Math.max(10, this.w - this.axisWidth());
  }

  private plotHeight(): number {
    return Math.max(10, this.h - AXIS_H);
  }

  private layout(): Layout {
    const axisW = this.axisWidth();
    const plotW = Math.max(10, this.w - axisW);
    const plotH = this.plotHeight();
    const rsi = this.indicators.some((i) => !isOverlay(i) && !i.hidden) && plotH > RSI_MIN_H * 2 + PANE_GAP;
    const rsiH = rsi ? Math.max(RSI_MIN_H, Math.round(plotH * RSI_SHARE)) : 0;
    const priceH = rsi ? plotH - rsiH - PANE_GAP : plotH;
    return { plotW, plotH, axisW, priceH, rsiTop: rsi ? priceH + PANE_GAP : plotH, rsiH };
  }

  /** Abscisse du centre de la bougie `i`. */
  private x(i: number, plotW = this.plotWidth()): number {
    return plotW - RIGHT_MARGIN_BARS * this.barWidth - (this.right - i) * this.barWidth;
  }

  /** Indice (fractionnaire) de la bougie sous l'abscisse `x`. */
  private indexAt(x: number, plotW = this.plotWidth()): number {
    return this.right - (plotW - RIGHT_MARGIN_BARS * this.barWidth - x) / this.barWidth;
  }

  private visible(plotW = this.plotWidth()): { from: number; to: number } {
    const to = Math.min(this.candles.length - 1, Math.ceil(this.right));
    const from = Math.max(0, Math.floor(this.indexAt(0, plotW)));
    return { from, to };
  }

  /** Bougies, prix et instants -> pixels du volet des prix (échelle du dernier dessin). */
  private frame(): Frame | undefined {
    const s = this.scale;
    if (!s || !this.times.length) return undefined;
    const plotW = this.plotWidth();
    return {
      x: (pos) => this.x(pos, plotW),
      y: (price) => ((s.max - price) / (s.max - s.min)) * s.h,
      width: plotW,
      pos: (t) => barPosition(this.times, t, this.tf),
      time: (pos) => barTime(this.times, pos, this.tf),
    };
  }

  /** Le prix à la hauteur `py` du volet des prix, aux décimales du produit. */
  private priceAt(py: number): number {
    const s = this.scale!;
    return Number((s.max - (py / s.h) * (s.max - s.min)).toFixed(this.digits));
  }

  /** Les alertes de prix affichées (surveillées ou suspendues), à leur nouveau prix si on les déplace. */
  private priceAlerts(): Array<{ alert: Alert; price: number }> {
    const out: Array<{ alert: Alert; price: number }> = [];
    for (const a of this.alerts) {
      if (a.target.kind !== "price" || (a.state !== "active" && a.state !== "paused")) continue;
      const over = this.alertDrag?.id === a.id ? this.alertDrag : this.alertMoved?.id === a.id ? this.alertMoved : undefined;
      out.push({ alert: a, price: over?.price ?? a.target.price });
    }
    return out;
  }

  /** L'alerte de prix de l'utilisateur dont la ligne passe sous le pointeur (ou son étiquette, sur l'axe) ; celles de l'IA ne se saisissent pas. */
  private alertAt(px: number, py: number): Alert | undefined {
    const s = this.scale;
    if (!s || py > s.h) return undefined;
    const y = (p: number) => ((s.max - p) / (s.max - s.min)) * s.h;
    const onAxis = px > this.plotWidth();
    return this.priceAlerts().find(({ alert, price }) => !alert.scenarioId && Math.abs(y(price) - py) <= (onAxis ? 8 : ALERT_HIT_PX))?.alert;
  }

  /** Les alertes surveillées ou suspendues de l'IA et de l'utilisateur sur ce tracé. */
  private drawingAlerts(id: string): { user?: Alert; ai: boolean } {
    const on = this.alerts.filter((a) => a.target.kind === "drawing" && a.target.drawingId === id);
    return { user: on.find((a) => !a.scenarioId), ai: on.some((a) => a.scenarioId && (a.state === "active" || a.state === "paused")) };
  }

  /** Le pointeur est sur le « + » contre l'axe des prix. */
  private onPlus(px: number, py: number): boolean {
    const p = this.plus;
    return !!p && !this.tool && Math.hypot(px - p.x, py - p.y) <= PLUS_R + 2;
  }

  /** Le point du graphique sous le pointeur ; le prix est aimanté par la bougie visée. */
  private pointAt(px: number, py: number): ChartPoint | undefined {
    const s = this.scale;
    if (!s || py > s.h) return undefined;
    const pos = this.indexAt(px);
    const raw = s.max - (py / s.h) * (s.max - s.min);
    const y = (p: number) => ((s.max - p) / (s.max - s.min)) * s.h;
    return { pos, price: snapPrice(raw, this.candles[Math.round(pos)], y, this.digits, effectiveMagnet(this.magnet, this.modifier)) };
  }

  /** Le point visé : avec Maj, sur une direction à 0°, 45° ou 90° depuis le point fixe de l'oblique ; sinon, aimanté. */
  private cursorPoint(px: number, py: number): ChartPoint | undefined {
    const from = this.shift ? this.shiftAnchor() : undefined;
    return from ? this.constrainedFrom(from, px, py) : this.pointAt(px, py);
  }

  /** Le point fixe d'une oblique qu'on trace ou dont on tire un bout (undefined : Maj ne s'applique pas). */
  private shiftAnchor(): ChartPoint | undefined {
    if (this.tool === "trendline" && this.placed.length === 1) return this.placed[0];
    const e = this.editing;
    if (e && e.original.kind === "trendline" && (e.part === "a" || e.part === "b")) {
      const other = e.part === "a" ? e.original.b : e.original.a;
      return { pos: barPosition(this.times, other.t, this.tf), price: other.price };
    }
    return undefined;
  }

  /** Le pointeur ramené sur l'horizontale, la verticale ou la diagonale de `anchor` (à l'écran) ; le prix exact de l'ancre pour une horizontale. */
  private constrainedFrom(anchor: ChartPoint, px: number, py: number): ChartPoint | undefined {
    const s = this.scale;
    if (!s) return undefined;
    const plotW = this.plotWidth();
    const yOf = (p: number) => ((s.max - p) / (s.max - s.min)) * s.h;
    const priceAt = (y: number) => Number((s.max - (y / s.h) * (s.max - s.min)).toFixed(this.digits));
    const ia = Math.round(anchor.pos);
    const a = { x: this.x(ia, plotW), y: yOf(anchor.price) };
    const c = constrainAngle(a, { x: px, y: Math.min(py, s.h) });
    if (c.dir === "h") return { pos: this.indexAt(c.x, plotW), price: anchor.price };
    if (c.dir === "v") return { pos: ia, price: priceAt(c.y) };
    // Diagonale : sur la bougie la plus proche, à 45° exactement depuis l'ancre.
    const pos = Math.round(this.indexAt(c.x, plotW));
    const slope = c.x === a.x ? 0 : Math.sign((c.y - a.y) / (c.x - a.x));
    return { pos, price: priceAt(a.y + slope * (this.x(pos, plotW) - a.x)) };
  }

  private recompute() {
    this.times = this.candles.map((c) => c.t);
    // Un indicateur masqué n'est pas calculé.
    this.series = this.indicators.map((i) => (i.hidden ? undefined : indicatorSeries(i, this.candles)));
  }

  private resize() {
    const rect = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(0, rect.width);
    this.h = Math.max(0, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  /** Chaque seconde, calée sur l'horloge : le compte à rebours suit. */
  private tick() {
    this.clock = window.setTimeout(() => this.tick(), 1000 - (Date.now() % 1000) + 5);
    this.refreshCountdown();
  }

  /** Le compte à rebours de la bougie en cours (undefined : pas de bougie, pas de cotation, marché fermé). */
  private countdownText(): string | undefined {
    const last = this.candles[this.candles.length - 1];
    if (!last) return undefined;
    const left = candleTimeLeft(last.t, this.quoteTime, Date.now(), this.tf, this.tf === MONTH);
    return left === undefined ? undefined : formatTimeLeft(left, this.tf);
  }

  /**
   * Le compte à rebours a changé : seule sa ligne est repeinte, sans le reste
   * du graphique ; tout est redessiné s'il apparaît ou disparaît (l'étiquette
   * change de hauteur) ou si quelque chose passe par-dessus (le réticule, un
   * prix allumé, une alerte qui clignote).
   */
  private refreshCountdown() {
    const c = this.countdown;
    const text = this.countdownText();
    if (!c || text === c.text || this.raf) return;
    if (text === undefined || c.text === undefined) return this.schedule();
    c.text = text;
    const r = c.rect;
    if (!r) return;
    // L'étiquette du réticule, ramenée dans son volet près des bords, peut s'écarter de sa hauteur : une marge d'une étiquette entière.
    const crossed = this.crossY !== undefined && this.crossY + LABEL_H >= r.y && this.crossY - LABEL_H <= r.y + r.h;
    if (crossed || this.spots.length || this.flashing) return this.schedule();
    this.paintCountdown(text, r);
  }

  /* ------------------------------ Interactions --------------------------- */

  private clampRight(v: number): number {
    const n = this.candles.length;
    if (!n) return 0;
    const slack = (this.plotWidth() / this.barWidth) * MAX_FUTURE_SHARE;
    return Math.min(n - 1 + slack, Math.max(Math.min(n - 1, 3), v));
  }

  /** Place le bord droit (en bougies) : au-delà de la dernière, la vue la suit en gardant cette avance. */
  private setRight(v: number) {
    const n = this.candles.length;
    const right = this.clampRight(v);
    if (right >= n - 1) {
      this.follow = true;
      this.future = right - (n - 1);
    } else {
      this.follow = false;
      this.rightIndex = right;
    }
    this.schedule();
  }

  /** La région sous le pointeur : le graphique, l'axe des prix (à côté des bougies), celui du temps, ou leur coin. */
  private region(px: number, py: number): "plot" | "price" | "time" | "corner" | "rsi-axis" {
    const L = this.layout();
    if (px > L.plotW) return py > L.plotH ? "corner" : py <= L.priceH ? "price" : "rsi-axis";
    return py > L.plotH ? "time" : "plot";
  }

  private select(id: string | undefined) {
    if (id === this.selected) return;
    this.selected = id;
    this.cb.onSelect?.(id);
    this.schedule();
  }

  /** Les tracés tels qu'affichés : celui qu'on déplace, ou qui attend le serveur, à sa nouvelle place. */
  private shown(): ShownDrawing[] {
    const over = this.editing ? { id: this.editing.id, shape: this.editing.shape } : this.moved;
    if (!over) return this.drawings;
    // La forme entière remplace l'ancienne : une zone qui perd sa fin ne doit pas la retrouver.
    return this.drawings.map((d) => (d.id === over.id ? { id: d.id, ...(d.label ? { label: d.label } : {}), createdBy: d.createdBy, ...over.shape } : d));
  }

  private setModifier(on: boolean) {
    if (on === this.modifier) return;
    this.modifier = on;
    if (this.tool || this.editing) this.schedule();
  }

  private setShift(on: boolean) {
    if (on === this.shift) return;
    this.shift = on;
    if (this.tool || this.editing) this.schedule();
  }

  private onDown(e: PointerEvent) {
    this.modifier = e.metaKey || e.ctrlKey;
    this.shift = e.shiftKey;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = undefined;
      this.editing = undefined;
      this.pinch = { dist: Math.max(1, Math.abs(a.x - b.x)), barWidth: this.barWidth, rightIndex: this.right, mid: (a.x + b.x) / 2 };
      return;
    }
    if (this.pointers.size !== 1 || e.button !== 0) return;
    this.down = { x: e.offsetX, y: e.offsetY };
    // Le « + » contre l'axe : une alerte (ou une ligne) au prix du réticule, au relâcher.
    if (this.onPlus(e.offsetX, e.offsetY)) {
      this.plusDown = true;
      return;
    }
    // Une alerte de prix se saisit par sa ligne ou par son étiquette sur l'axe, et se glisse en hauteur.
    const grabbed = !this.tool && this.alertAt(e.offsetX, e.offsetY);
    if (grabbed && grabbed.target.kind === "price") {
      this.select(undefined);
      this.alertDrag = {
        id: grabbed.id,
        price: this.alertMoved?.id === grabbed.id ? this.alertMoved.price : grabbed.target.price,
        pointer: e.pointerId,
        moved: false,
      };
      this.canvas.style.cursor = "grabbing";
      return;
    }
    // Les axes : celui des prix règle la hauteur des bougies, celui du temps leur largeur ; leur coin, l'échelle automatique.
    const region = this.region(e.offsetX, e.offsetY);
    if (region === "corner") {
      this.manual = this.manual ? undefined : this.scale && { min: this.scale.min, max: this.scale.max };
      this.schedule();
      return;
    }
    if (region === "price" || region === "time") {
      const s = this.scale;
      this.axisDrag = { kind: region, x: e.offsetX, y: e.offsetY, barWidth: this.barWidth, right: this.right, min: s?.min ?? 0, max: s?.max ?? 1 };
      return;
    }
    if (region === "rsi-axis") return;
    // Un outil choisi : chaque clic pose un point.
    if (this.tool) {
      const p = this.placed.length ? this.cursorPoint(e.offsetX, e.offsetY) : this.pointAt(e.offsetX, e.offsetY);
      if (!p) return;
      this.place(p);
      this.schedule();
      return;
    }
    // Sinon, un tracé sous le pointeur se saisit ; ailleurs, le graphique défile.
    const f = this.frame();
    const hit = f && hitTest(this.shown(), f, e.offsetX, e.offsetY);
    const start = hit && this.pointAt(e.offsetX, e.offsetY);
    const d = hit && this.drawings.find((x) => x.id === hit.id);
    if (hit && start && d && d.createdBy !== "ia") {
      this.select(hit.id);
      const original = this.moved?.id === d.id ? this.moved.shape : shapeOf(d);
      this.editing = { id: d.id, part: hit.part, start, original, shape: original, pointer: e.pointerId };
      this.canvas.style.cursor = "grabbing";
      return;
    }
    // Un niveau de l'IA ne se déplace pas (il se garde ou se retire, au clic droit) : il se sélectionne, et le graphique défile.
    this.select(d?.createdBy === "ia" ? d.id : undefined);
    // Dans le volet des prix, le graphique se déplace aussi en hauteur ; tout de suite si l'échelle est déjà à la main.
    const vertical = e.offsetY <= (this.scale?.h ?? 0);
    const range = vertical && this.manual ? { ...this.manual, y: e.offsetY } : undefined;
    this.drag = { x: e.offsetX, y: e.offsetY, rightIndex: this.right, vertical, range };
    this.canvas.style.cursor = "grabbing";
  }

  private onMove(e: PointerEvent) {
    this.modifier = e.metaKey || e.ctrlKey;
    this.shift = e.shiftKey;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const ratio = Math.max(1, Math.abs(a.x - b.x)) / this.pinch.dist;
      this.zoomTo(this.pinch.barWidth * ratio, this.pinch.mid, this.pinch.rightIndex, this.pinch.barWidth);
      return;
    }
    if (this.axisDrag) {
      const a = this.axisDrag;
      if (a.kind === "price") {
        // Tirer vers le bas tasse les bougies (plus de prix à l'écran), vers le haut les étire.
        const half = ((a.max - a.min) / 2) * Math.exp((e.offsetY - a.y) * AXIS_ZOOM);
        const mid = (a.min + a.max) / 2;
        this.manual = { min: mid - half, max: mid + half };
      } else {
        // Tirer vers la droite élargit les bougies, vers la gauche les resserre ; le bord droit ne bouge pas.
        this.zoomTo(a.barWidth * Math.exp((e.offsetX - a.x) * AXIS_ZOOM), this.plotWidth(), a.right, a.barWidth);
      }
      this.schedule();
      return;
    }
    if (this.alertDrag && e.pointerId === this.alertDrag.pointer) {
      const s = this.scale;
      if (s) {
        this.alertDrag.price = this.priceAt(Math.min(s.h - 1, Math.max(0, e.offsetY)));
        this.alertDrag.moved = true;
      }
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.schedule();
      return;
    }
    if (this.editing && e.pointerId === this.editing.pointer) {
      const p = this.cursorPoint(e.offsetX, Math.min(e.offsetY, (this.scale?.h ?? 0) - 1));
      const f = this.frame();
      if (p && f) this.editing.shape = dragShape(this.editing.original, this.editing.part, this.editing.start, p, f, 10 ** -this.digits);
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.schedule();
      return;
    }
    if (this.drag) {
      const d = this.drag;
      this.setRight(d.rightIndex - (e.offsetX - d.x) / this.barWidth);
      const s = this.scale;
      if (d.vertical && s) {
        // Au-delà d'un seuil (un défilement n'est jamais parfaitement horizontal), l'échelle passe à la main et suit le geste.
        if (!d.range && Math.abs(e.offsetY - d.y) > VERTICAL_PAN_PX) d.range = { min: s.min, max: s.max, y: e.offsetY };
        if (d.range) {
          const shift = ((e.offsetY - d.range.y) * (d.range.max - d.range.min)) / s.h;
          this.manual = { min: d.range.min + shift, max: d.range.max + shift };
        }
      }
      return;
    }
    this.hover = { x: e.offsetX, y: e.offsetY };
    const region = this.region(e.offsetX, e.offsetY);
    if (this.onPlus(e.offsetX, e.offsetY)) {
      this.canvas.style.cursor = "pointer";
    } else if (!this.tool && this.alertAt(e.offsetX, e.offsetY)) {
      this.canvas.style.cursor = "ns-resize";
    } else if (region !== "plot") {
      this.canvas.style.cursor = region === "price" ? "ns-resize" : region === "time" ? "ew-resize" : region === "corner" ? "pointer" : "default";
    } else if (!this.tool) {
      const f = this.frame();
      const hit = f && hitTest(this.shown(), f, e.offsetX, e.offsetY);
      this.hoveredId = hit ? hit.id : undefined;
      const level = hit && this.drawings.find((x) => x.id === hit.id)?.createdBy === "ia";
      this.canvas.style.cursor = level
        ? "pointer"
        : hit
          ? hit.part === "body" || hit.part === "entry"
            ? "move"
            : hit.part === "top" || hit.part === "bottom" || hit.part === "target" || hit.part === "stop"
              ? "ns-resize"
              : hit.part === "from" || hit.part === "to"
                ? "ew-resize"
                : "pointer"
          : "crosshair";
    } else {
      this.canvas.style.cursor = "crosshair";
    }
    this.schedule();
  }

  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = undefined;
    const down = this.down;
    this.down = undefined;
    if (this.plusDown) {
      this.plusDown = false;
      const p = this.plus;
      if (p && e.type === "pointerup" && this.onPlus(e.offsetX, e.offsetY)) this.cb.onPlus?.(p.price, p.x, p.y);
    }
    if (this.alertDrag && e.pointerId === this.alertDrag.pointer) {
      const { id, price, moved } = this.alertDrag;
      this.alertDrag = undefined;
      if (moved) {
        this.alertMoved = { id, price };
        this.cb.onAlertMove?.(id, price);
      }
      this.canvas.style.cursor = "ns-resize";
      this.schedule();
    }
    if (this.editing && e.pointerId === this.editing.pointer) {
      const { id, shape, original } = this.editing;
      this.editing = undefined;
      if (JSON.stringify(shape) !== JSON.stringify(original)) {
        this.moved = { id, shape };
        this.cb.onEdit?.(id, shape);
      }
      this.canvas.style.cursor = "move";
      this.schedule();
    }
    // Un glisser avec l'outil depuis son premier point : le second est là où on lâche (sinon, il viendra d'un second clic).
    if (this.tool && this.placed.length === 1 && down && e.type === "pointerup" && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) >= CLICK_PX) {
      const p = this.cursorPoint(e.offsetX, e.offsetY);
      if (p) this.place(p);
    }
    if (!this.pointers.size) {
      this.drag = undefined;
      this.axisDrag = undefined;
      if (!this.editing && !this.tool && this.canvas.style.cursor === "grabbing") this.canvas.style.cursor = "crosshair";
    }
  }

  /**
   * Un point de plus pour le tracé en cours ; au dernier, la forme part au
   * serveur et l'outil se libère. L'impulsion d'une extension sans mouvement
   * (même bougie, même prix) n'est pas gardée : son second point se repose.
   */
  private place(p: ChartPoint) {
    const tool = this.tool;
    if (!tool) return;
    if (tool === "fibext" && this.placed.length === 1 && !isMove(this.placed[0], p)) return;
    this.placed.push(p);
    if (this.placed.length < pointsNeeded(tool)) return;
    const [p1, p2, p3] = this.placed;
    const side = positionTool(tool);
    const f = this.frame();
    // Une boîte de trade se pose d'un clic, avec ses écarts par défaut ; elle se règle ensuite en tirant ses lignes.
    const shape = side && f ? positionFrom(side, p1, f, this.digits) : shapeFrom(tool, p1, p2, (pos) => barTime(this.times, pos, this.tf), p3);
    this.placed = [];
    if (!shape) return; // deux points sur la même bougie : on recommence
    this.tool = null;
    this.cb.onDraw?.(shape);
    this.cb.onToolEnd?.();
    this.schedule();
  }

  private onLeave() {
    this.hover = undefined;
    this.hoveredId = undefined;
    if (this.hoverIndex !== -1) {
      this.hoverIndex = -1;
      this.cb.onHover?.(undefined);
    }
    this.schedule();
  }

  /**
   * Double-clic : sur l'axe des prix, l'échelle redevient automatique ; sur
   * celui du temps, largeur des bougies et avance à droite par défaut ; sur le
   * graphique (pas sur un tracé, ni en traçant), retour au présent.
   */
  private onDoubleClick(e: MouseEvent) {
    const region = this.region(e.offsetX, e.offsetY);
    if (region === "price") {
      this.resetScale();
      return;
    }
    if (region === "time") {
      this.barWidth = DEFAULT_BAR;
      this.future = DEFAULT_FUTURE_BARS;
      this.scrollToLatest();
      return;
    }
    if (this.tool || region !== "plot") return;
    const f = this.frame();
    if (f && hitTest(this.shown(), f, e.offsetX, e.offsetY)) return;
    this.scrollToLatest();
  }

  /**
   * Clic droit : pendant un tracé, il l'annule ; sinon le menu de ce qui est
   * sous le pointeur (une alerte de prix, un tracé, qui est alors sélectionné,
   * ou le prix de cette hauteur).
   */
  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (this.tool) {
      this.cancel();
      return;
    }
    const s = this.scale;
    if (!s || e.offsetY > s.h) return;
    const alert = this.alertAt(e.offsetX, e.offsetY);
    if (alert) {
      this.cb.onContext?.({ kind: "alert", id: alert.id }, e.offsetX, e.offsetY);
      return;
    }
    const f = this.frame();
    const hit = f && e.offsetX <= this.plotWidth() ? hitTest(this.shown(), f, e.offsetX, e.offsetY) : undefined;
    if (hit) {
      this.select(hit.id);
      const d = this.shown().find((x) => x.id === hit.id);
      const level = f && d && (d.kind === "fib" || d.kind === "fibext") ? fibLevelAt(d, f, e.offsetY).ratio : undefined;
      this.cb.onContext?.({ kind: "drawing", id: hit.id, ...(level !== undefined ? { level } : {}) }, e.offsetX, e.offsetY);
      return;
    }
    this.cb.onContext?.({ kind: "price", price: this.priceAt(e.offsetY) }, e.offsetX, e.offsetY);
  }

  /** Molette : zoom autour du pointeur ; glissement horizontal (pavé tactile) : défilement. */
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.setRight(this.right + e.deltaX / this.barWidth);
      return;
    }
    // Sur l'axe des prix : la hauteur des bougies, autour du prix visé.
    const s = this.scale;
    if (this.region(e.offsetX, e.offsetY) === "price" && s) {
      const factor = Math.exp(e.deltaY * 0.002);
      const p = s.max - (e.offsetY / s.h) * (s.max - s.min);
      this.manual = { min: p - (p - s.min) * factor, max: p + (s.max - p) * factor };
      this.schedule();
      return;
    }
    this.zoomTo(this.barWidth * Math.exp(-e.deltaY * 0.0022), e.offsetX, this.right, this.barWidth);
  }

  /** Change la largeur des bougies en gardant sous `anchorX` la même bougie (ou la dernière au bord, en suivi). */
  private zoomTo(barWidth: number, anchorX: number, rightBefore: number, barBefore: number) {
    const next = Math.min(MAX_BAR, Math.max(MIN_BAR, barWidth));
    if (next === this.barWidth) return;
    const plotW = this.plotWidth();
    const anchorIndex = rightBefore - (plotW - RIGHT_MARGIN_BARS * barBefore - anchorX) / barBefore;
    const prev = this.barWidth;
    this.barWidth = next;
    // En suivi, l'espace laissé à droite de la dernière bougie garde sa largeur à l'écran ; sinon, la bougie visée reste sous le pointeur.
    if (this.follow) this.future = Math.min((this.future * prev) / next, (plotW / next) * MAX_FUTURE_SHARE);
    else this.setRight(anchorIndex + (plotW - RIGHT_MARGIN_BARS * next - anchorX) / next);
    this.schedule();
  }

  /* -------------------------------- Dessin -------------------------------- */

  private draw() {
    const ctx = this.ctx;
    const t = this.theme;
    ctx.clearRect(0, 0, this.w, this.h);
    this.countdown = undefined;
    if (!this.candles.length || this.w < 20 || this.h < 20) return;
    const L = this.layout();
    const { plotW, plotH, axisW, priceH } = L;
    const { from, to } = this.visible(plotW);
    if (from < MORE_THRESHOLD && !this.moreAsked) {
      this.moreAsked = true;
      this.cb.onNeedMore?.();
    }
    // Échelle des prix : réglée à la main, sinon les bougies visibles, avec de l'air.
    let min = Infinity;
    let max = -Infinity;
    if (this.manual) {
      ({ min, max } = this.manual);
    } else {
      const shown = this.candles.slice(from, to + 1);
      for (const c of shown.length ? shown : this.candles) {
        if (c.l < min) min = c.l;
        if (c.h > max) max = c.h;
      }
      const span = max - min || Math.abs(max) * 0.001 || 1;
      max += span * PRICE_PAD;
      min -= span * PRICE_PAD;
    }
    this.scale = { min, max, h: priceH };
    const y = (p: number) => ((max - p) / (max - min)) * priceH;
    ctx.font = `${FONT_SIZE}px ${t.font}`;
    ctx.textBaseline = "middle";

    // Grille et axe des prix.
    const step = niceStep((max - min) / Math.max(2, Math.floor(priceH / TICK_PX)));
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = t.text;
    ctx.textAlign = "left";
    for (let k = Math.ceil(min / step); k * step <= max; k++) {
      const p = Number((k * step).toFixed(10));
      const yy = Math.round(y(p)) + 0.5;
      if (yy < 4 || yy > priceH - 4) continue;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(formatPrice(p, this.digits), plotW + 6, yy);
    }

    // Axe du temps : la première bougie de chaque pas, le jour quand il change ; les traits traversent les deux volets.
    const ticks = timeTicks(this.candles, from, to, pickTimeStep(this.tf, this.barWidth, TIME_TICK_PX));
    ctx.textAlign = "center";
    for (const tick of ticks) {
      const xx = Math.round(this.x(tick.index, plotW)) + 0.5;
      if (xx < 0 || xx > plotW) continue;
      ctx.strokeStyle = t.grid;
      ctx.globalAlpha = tick.day ? 1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = t.text;
      ctx.font = `${tick.day ? "600 " : ""}${FONT_SIZE}px ${t.font}`;
      ctx.fillText(tick.label, Math.min(plotW - 20, Math.max(20, xx)), plotH + AXIS_H / 2 + 1);
    }
    ctx.font = `${FONT_SIZE}px ${t.font}`;

    // Bougies, puis les moyennes : coupées au bas du volet des prix (une échelle réglée à la main
    // les ferait déborder sur le bandeau du RSI).
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();
    const body = Math.max(1, Math.round(this.barWidth * 0.68));
    for (let i = from; i <= to; i++) {
      const c = this.candles[i];
      const xc = Math.round(this.x(i, plotW)) + 0.5;
      if (xc < -this.barWidth || xc > plotW + this.barWidth) continue;
      const up = c.c >= c.o;
      const color = up ? t.up : t.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(xc, y(c.h));
      ctx.lineTo(xc, y(c.l));
      ctx.stroke();
      const top = y(Math.max(c.o, c.c));
      const height = Math.max(1, y(Math.min(c.o, c.c)) - top);
      if (body <= 1) {
        ctx.fillRect(xc - 0.5, top, 1, height);
      } else {
        ctx.fillRect(Math.round(xc - body / 2), Math.round(top), body, Math.max(1, Math.round(height)));
      }
    }
    this.indicators.forEach((ind, k) => {
      if (isOverlay(ind)) this.drawSeries(this.series[k]?.main, from, to, plotW, y, this.color(ind, k), lineWidth(ind));
    });
    ctx.restore();

    // La carte automatique dessous, les tracés du produit (et celui qu'on pose), les setups proposés ; puis les alertes.
    this.drawAutoMap(L, y);
    this.drawDrawings(L, y);
    this.drawSetups(L, y);
    this.drawAlerts(L, y);

    // Dernier prix : ligne pointillée et étiquette sur l'axe, le temps restant de la bougie en dessous (marché ouvert).
    const last = this.candles[this.candles.length - 1];
    const yl = y(last.c);
    this.countdown = { text: this.countdownText() };
    if (yl >= 0 && yl <= priceH) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = t.accent;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yl) + 0.5);
      ctx.lineTo(plotW, Math.round(yl) + 0.5);
      ctx.stroke();
      ctx.restore();
      this.countdown.rect = this.lastLabel(formatPrice(last.c, this.digits), this.countdown.text, plotW, yl, axisW, priceH);
    }

    // Les prix que Kopilia est en train de dire, par-dessus.
    this.drawSpots(L, y);

    // Bandeau du RSI.
    if (L.rsiH) this.drawRsiPane(L, from, to);

    // Noms et valeurs des indicateurs (la bougie survolée, sinon la dernière).
    this.drawLegend(L);

    // Le coin des axes : « auto » en couleur quand l'échelle des prix suit les bougies, estompé quand elle est réglée à la main.
    ctx.save();
    ctx.font = `600 10px ${t.font}`;
    ctx.textAlign = "center";
    ctx.fillStyle = this.manual ? t.text : t.accent;
    ctx.globalAlpha = this.manual ? 0.55 : 1;
    ctx.fillText("auto", plotW + axisW / 2, plotH + AXIS_H / 2 + 1);
    ctx.restore();

    // Réticule sur la bougie survolée.
    this.drawCrosshair(L, min, max);
  }

  /** Une série d'indicateur, en ligne, sur les bougies visibles. */
  private drawSeries(series: number[] | undefined, from: number, to: number, plotW: number, y: (v: number) => number, color: string, width: number) {
    if (!series) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let pen = false;
    for (let i = Math.max(0, from - 1); i <= Math.min(series.length - 1, to + 1); i++) {
      const v = series[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const xx = this.x(i, plotW);
      if (pen) ctx.lineTo(xx, y(v));
      else ctx.moveTo(xx, y(v));
      pen = true;
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /** La couleur d'un indicateur : la sienne, sinon celle de son rang. */
  private color(ind: Indicator, k: number): string {
    return this.theme.palette[ind.color ?? INDICATOR_COLORS[k % INDICATOR_COLORS.length]] ?? this.theme.accent;
  }

  /**
   * Les RSI sous les bougies : échelle de 0 à 100, seuils de surachat et de
   * survente (ceux du premier RSI affiché), voile sur la zone neutre, la
   * moyenne du RSI en pointillés, la dernière valeur sur l'axe.
   */
  private drawRsiPane(L: Layout, from: number, to: number) {
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, axisW, rsiTop, rsiH } = L;
    const y = (v: number) => rsiTop + ((100 - v) / 100) * rsiH;
    const shown = this.indicators.map((ind, k) => ({ ind, k })).filter((x): x is { ind: RsiIndicator; k: number } => x.ind.kind === "rsi" && !x.ind.hidden);
    const first = shown[0]?.ind;
    if (!first) return;
    ctx.strokeStyle = t.grid;
    ctx.beginPath();
    ctx.moveTo(0, rsiTop - PANE_GAP / 2 + 0.5);
    ctx.lineTo(plotW + axisW, rsiTop - PANE_GAP / 2 + 0.5);
    ctx.stroke();
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = t.text;
    ctx.textAlign = "left";
    for (const level of [first.overbought, first.oversold]) {
      const yy = Math.round(y(level)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(decimalFormat(0).format(level), plotW + 6, yy);
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rsiTop, plotW, rsiH);
    ctx.clip();
    // Entre les seuils, un voile léger : la zone neutre.
    ctx.fillStyle = t.grid;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, y(first.overbought), plotW, y(first.oversold) - y(first.overbought));
    ctx.globalAlpha = 1;
    for (const { ind, k } of shown) {
      const series = this.series[k];
      this.drawSeries(series?.main, from, to, plotW, y, this.color(ind, k), lineWidth(ind));
      if (series?.signal) {
        ctx.setLineDash([4, 3]);
        this.drawSeries(series.signal, from, to, plotW, y, this.color(ind, k), 1.2);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
    // Valeur du dernier RSI sur l'axe.
    for (const { ind, k } of shown) {
      const main = this.series[k]?.main;
      const v = main?.[main.length - 1];
      if (v === undefined || !Number.isFinite(v)) continue;
      const top = Math.round(Math.min(rsiTop + rsiH - 16, Math.max(rsiTop, y(v) - 8)));
      ctx.fillStyle = this.color(ind, k);
      ctx.fillRect(plotW + 1, top, axisW - 2, 16);
      ctx.fillStyle = t.onAccent;
      ctx.textAlign = "left";
      ctx.fillText(decimalFormat(1).format(v), plotW + 6, top + 8);
    }
  }

  /** Les tracés : lignes (et leur prix sur l'axe), obliques, zones ; le sélectionné avec ses poignées. */
  private drawDrawings(L: Layout, y: (p: number) => number) {
    const f = this.frame();
    if (!f) return;
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, axisW, priceH } = L;
    const list: ShownDrawing[] = [...this.shown()];
    // Le tracé qu'on pose : ses points posés, le suivant suit le pointeur.
    if (this.tool && this.placed.length && this.hover) {
      const p = this.cursorPoint(this.hover.x, Math.min(this.hover.y, priceH - 1));
      const ghost = p && ghostShape(this.tool, this.placed, p, f.time);
      if (ghost) list.push({ ...ghost, id: "" });
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();
    for (const d of list) {
      const selected = d.id !== undefined && d.id === this.selected;
      const ghost = d.id === "";
      // Un niveau de travail de l'IA : en violet, en pointillés, marqué « IA » ; il ne se déplace pas (pas de poignées).
      const level = d.createdBy === "ia";
      const color = level ? t.ai : t.accent;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = selected ? 2.4 : 1.5;
      ctx.setLineDash(ghost ? [5, 4] : level ? [6, 4] : []);
      const handles: Array<{ x: number; y: number }> = [];
      const alerts = d.id ? this.drawingAlerts(d.id) : { user: undefined, ai: false };
      const alert = alerts.user;
      const tag = level ? "IA" : this.suggested.has(d.id) ? "IA ?" : alerts.ai ? "IA" : undefined;
      if (d.kind === "hline") {
        const yy = Math.round(y(d.price)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(plotW, yy);
        ctx.stroke();
        // À droite, au-dessus de la ligne, près de son prix (à gauche, il croiserait la légende des indicateurs) ; sa cloche avant son nom, puis la marque de l'IA.
        const labelW = this.drawingLabel(d.label, plotW - 8, yy - 8, "right", color);
        const bellX = labelW ? plotW - 22 - labelW : plotW - 26;
        if (alert) this.bell(bellX, yy - 9, alert);
        if (tag) this.aiTag(bellX - (alert ? 20 : 0), yy - 9, "right", tag);
      } else if (d.kind === "trendline") {
        const a = { x: f.x(f.pos(d.a.t)), y: y(d.a.price) };
        const b = { x: f.x(f.pos(d.b.t)), y: y(d.b.price) };
        const [p0, p1] = trendlineSegment(a, b, d.extend, plotW);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        if (!level) handles.push(a, b);
        const left = a.x <= b.x ? a : b;
        this.drawingLabel(d.label, left.x + 4, left.y - 10, "left", color);
        // La cloche au bout droit visible de l'oblique (là où elle sort du volet, sinon), au-dessus d'elle.
        if (alert) {
          const [l, r] = p0.x <= p1.x ? [p0, p1] : [p1, p0];
          let x = Math.min(r.x, plotW - 26);
          const yAt = (xx: number) => (r.x === l.x ? l.y : l.y + ((r.y - l.y) * (xx - l.x)) / (r.x - l.x));
          const edge = yAt(x) < 14 ? 14 : yAt(x) > priceH - 4 ? priceH - 4 : undefined;
          if (edge !== undefined && r.y !== l.y) x = Math.min(x, l.x + ((edge - l.y) * (r.x - l.x)) / (r.y - l.y) - 10);
          if (x >= 8) this.bell(x, yAt(x) - 11, alert);
        }
        if (tag) this.aiTag(left.x + 4, left.y + 12, "left", tag);
      } else if (d.kind === "position") {
        const show = selected || ghost || d.id === this.hoveredId || d.id === this.editing?.id;
        const g = this.drawPosition(d, f, selected, ghost, plotW, this.boxInfo?.(d), show);
        if (!level) handles.push({ x: g.left, y: g.target }, { x: g.left, y: g.entry }, { x: g.left, y: g.stop }, { x: g.right, y: g.entry });
        this.drawingLabel(d.label, Math.min(g.right, plotW) - 4, Math.min(g.target, g.stop) - 9, "right", t.text);
        if (tag) this.aiTag(Math.min(g.right, plotW) - 4, Math.max(g.target, g.stop) + 11, "right", tag);
      } else if (d.kind === "fib" || d.kind === "fibext") {
        const g = this.drawFib(d, f, color, selected, ghost);
        if (d.id) this.drawFibAlerts(d.id, g, plotW, color);
        if (!level) handles.push(...g.points.map(([, p]) => p));
        // Son nom au-dessus du niveau le plus haut, à droite ; la marque de l'IA à côté.
        const top = Math.min(...g.levels.map((l) => l.y));
        const right = Math.min(g.right, plotW) - 4;
        const labelW = this.drawingLabel(d.label, right, top - 9, "right", color);
        if (tag) this.aiTag(right - labelW - (labelW ? 6 : 0), top - 9, "right", tag);
      } else {
        const r = zoneRect(d, f);
        ctx.globalAlpha = selected ? 0.2 : level ? 0.07 : 0.12;
        ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
        ctx.globalAlpha = 0.7;
        ctx.strokeRect(r.left + 0.5, Math.round(r.top) + 0.5, r.right - r.left - 1, Math.round(r.bottom - r.top));
        ctx.globalAlpha = 1;
        if (!level) {
          if (d.from !== undefined) handles.push({ x: r.left, y: (r.top + r.bottom) / 2 });
          if (d.to !== undefined) handles.push({ x: r.right, y: (r.top + r.bottom) / 2 });
          handles.push({ x: (r.left + r.right) / 2, y: r.top }, { x: (r.left + r.right) / 2, y: r.bottom });
        }
        this.drawingLabel(d.label, Math.max(r.left, 0) + 6, r.top + 10, "left", color);
        // La cloche dans le coin haut droit visible de la zone, la marque de l'IA à côté.
        const corner = Math.min(r.right, plotW) - 14;
        if (alert) this.bell(corner, r.top + 11, alert);
        if (tag) this.aiTag(corner - (alert ? 14 : -8), r.top + 11, "right", tag);
      }
      if (selected || ghost) {
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5;
        for (const hnd of handles) {
          ctx.fillStyle = t.panel;
          ctx.fillRect(hnd.x - 4, hnd.y - 4, 8, 8);
          ctx.strokeStyle = t.accent;
          ctx.strokeRect(hnd.x - 3.5, hnd.y - 3.5, 7, 7);
        }
      }
    }
    ctx.restore();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    // Le prix des lignes sur l'axe, et des bords de la zone sélectionnée.
    for (const d of list) {
      const selected = d.id === this.selected;
      if (d.kind === "hline")
        this.axisLabel(formatPrice(d.price, this.digits), plotW, y(d.price), axisW, d.createdBy === "ia" ? t.ai : t.accent, t.onAccent, undefined, priceH);
      else if (d.kind === "zone" && (selected || d.id === "")) {
        for (const p of [d.top, d.bottom]) this.axisLabel(formatPrice(p, this.digits), plotW, y(p), axisW, t.accent, t.onAccent, undefined, priceH);
      } else if (d.kind === "position" && (selected || d.id === "")) {
        for (const [p, bg] of [
          [d.target, t.up],
          [d.entry, t.text],
          [d.stop, t.down],
        ] as const)
          this.axisLabel(formatPrice(p, this.digits), plotW, y(p), axisW, bg, t.onAccent, undefined, priceH);
      }
    }
  }

  /**
   * Une boîte de trade, comme les positions de TradingView, en sobre : le gain
   * en vert pâle et le risque en rouge pâle (les couleurs des bougies),
   * l'objectif et le stop en traits fins de leur couleur, l'entrée plus
   * franche, en gris ; sur l'entrée, au milieu, le rapport gain / risque, seul
   * au repos (les couleurs disent l'objectif et le stop, l'axe leurs prix
   * quand elle est sélectionnée). Survolée, sélectionnée ou tirée (`show`) :
   * sa taille dans la pastille, le gain dans le vert, la perte et son
   * pourcentage dans le rouge. Son trade : l'entrée en tirets tant que l'ordre
   * attend, le résultat dans la pastille une fois ouvert, le stop du moment
   * s'il a bougé (break-even), la boîte pâlie une fois terminé. Renvoie sa
   * géométrie (ses poignées).
   */
  private drawPosition(d: PositionShape, f: Frame, selected: boolean, ghost: boolean, plotW: number, info?: ChartBoxInfo, show = false) {
    const ctx = this.ctx;
    const t = this.theme;
    const g = positionGeometry(d, f);
    const trade = info?.trade;
    const done = !!trade && trade.state !== "pending" && trade.state !== "open";
    const alpha = (ghost ? 0.7 : 1) * (done ? 0.5 : 1);
    const w = g.right - g.left;
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = (selected ? 0.16 : 0.1) * alpha;
    ctx.fillStyle = t.up;
    ctx.fillRect(g.left, Math.min(g.entry, g.target), w, Math.abs(g.target - g.entry));
    ctx.fillStyle = t.down;
    ctx.fillRect(g.left, Math.min(g.entry, g.stop), w, Math.abs(g.stop - g.entry));
    const level = (yy: number, color: string, a: number, width: number, dash: number[] = []) => {
      const y0 = Math.round(yy) + 0.5;
      ctx.globalAlpha = a * alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(g.left, y0);
      ctx.lineTo(g.right, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    level(g.target, t.up, 0.85, selected ? 1.5 : 1);
    level(g.stop, t.down, 0.85, selected ? 1.5 : 1);
    level(g.entry, t.text, 1, selected ? 2 : 1.5, trade?.state === "pending" ? [5, 4] : []);
    // Le stop du trade, s'il n'est plus celui de la boîte (break-even, stop déplacé).
    const left = Math.max(g.left, 0);
    const right = Math.min(g.right, plotW);
    if (trade?.stop !== undefined && trade.stop !== d.stop && !done) {
      const ys = f.y(trade.stop);
      level(ys, t.text, 0.7, 1, [3, 3]);
      this.boxText(trade.protected ? "BE" : "stop", right - 4, ys - 6, "right", t.text, 0.85 * alpha);
    }
    ctx.font = `600 ${FONT_SIZE}px ${t.font}`;
    ctx.textBaseline = "middle";
    // Les montants, quand on la regarde : le gain dans le vert, la perte dans le rouge (dedans s'il y a la place, sinon au-delà du trait).
    const cx = (left + right) / 2;
    if (show && info && !done) {
      const inside = (from: number, to: number) => Math.abs(to - from) >= FONT_SIZE + 8;
      const at = (edge: number, toward: number) => (inside(edge, toward) ? edge + Math.sign(toward - edge) * 9 : edge - Math.sign(toward - edge) * 9);
      if (info.gain) this.boxText(info.gain, cx, at(g.target, g.entry), "center", t.up, alpha);
      if (info.loss) this.boxText(info.loss, cx, at(g.stop, g.entry), "center", t.down, alpha);
      if (info.problem) this.boxText(info.problem, cx, at(g.stop, g.entry) + Math.sign(g.stop - g.entry) * (FONT_SIZE + 4), "center", t.text, 0.8 * alpha);
    }
    // La pastille sur l'entrée : le rapport (et la taille, quand on la regarde), ou le résultat du trade.
    const ratio = positionRatio(d);
    const parts =
      trade?.result && trade.state !== "pending"
        ? [trade.result]
        : [ratio !== undefined ? ratioLabel(ratio) : "", show && info?.lots && !done ? info.lots : ""].filter(Boolean);
    const label = parts.join(" · ");
    if (label) {
      ctx.font = `600 ${FONT_SIZE}px ${t.font}`;
      ctx.textBaseline = "middle";
      const pw = ctx.measureText(label).width + 10;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = t.text;
      ctx.beginPath();
      ctx.roundRect(Math.round(cx - pw / 2), Math.round(g.entry) - 8, Math.round(pw), 16, 3);
      ctx.fill();
      ctx.fillStyle = t.surface;
      ctx.textAlign = "center";
      ctx.fillText(label, Math.round(cx), Math.round(g.entry) + 0.5);
    }
    ctx.restore();
    return g;
  }

  /** Un texte d'une boîte de trade, avec un halo de la couleur du fond (il passe sur les bougies). */
  private boxText(text: string, x: number, y: number, align: CanvasTextAlign, color: string, alpha: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${FONT_SIZE}px ${this.theme.font}`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.theme.surface;
    ctx.strokeText(text, Math.round(x), Math.round(y));
    ctx.fillStyle = color;
    ctx.fillText(text, Math.round(x), Math.round(y));
    ctx.restore();
  }

  /**
   * Un retracement ou une extension de Fibonacci, dans la couleur des autres
   * tracés : ses niveaux en traits fins, les clés plus francs (bornes, 0,5,
   * 0,618 ; 1,618) ; entre eux, un fond très léger, une bande sur deux un peu
   * plus marquée ; à gauche, le ratio (couleur du tracé) et le prix (discret),
   * en colonnes, ou dedans au-dessus du trait s'il n'y a pas la place ; le
   * mouvement mesuré en pointillés fins. Renvoie sa géométrie (ses points sont
   * ses poignées).
   */
  private drawFib(d: FibShape, f: Frame, color: string, selected: boolean, ghost: boolean) {
    const ctx = this.ctx;
    const g = fibGeometry(d, f);
    const alpha = ghost ? 0.7 : 1;
    const width = g.right - g.left;
    ctx.save();
    ctx.fillStyle = color;
    for (let k = 1; k < g.levels.length; k++) {
      const [y0, y1] = [g.levels[k - 1].y, g.levels[k].y];
      ctx.globalAlpha = (k % 2 ? 0.07 : 0.035) * (selected ? 1.6 : 1) * alpha;
      ctx.fillRect(g.left, Math.min(y0, y1), width, Math.abs(y1 - y0));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.setLineDash(ghost ? [5, 4] : []);
    for (const l of g.levels) {
      const yy = Math.round(l.y) + 0.5;
      ctx.globalAlpha = (isKeyFibLevel(d.kind, l.ratio) ? 0.85 : 0.4) * alpha;
      ctx.beginPath();
      ctx.moveTo(g.left, yy);
      ctx.lineTo(g.right, yy);
      ctx.stroke();
    }
    // Ratios et prix en deux colonnes, alignées à droite contre les niveaux (à gauche dedans).
    const bold = `600 ${FONT_SIZE}px ${this.theme.font}`;
    const plain = `${FONT_SIZE}px ${this.theme.font}`;
    const ratios = g.levels.map((l) => fibRatioLabel(l.ratio));
    const prices = g.levels.map((l) => formatPrice(l.price, this.digits));
    ctx.font = bold;
    const ratioW = Math.max(...ratios.map((s) => ctx.measureText(s).width));
    ctx.font = plain;
    const priceW = Math.max(...prices.map((s) => ctx.measureText(s).width));
    const gap = 5;
    const outside = g.left - ratioW - gap - priceW - 8 >= 2;
    const ratioX = outside ? g.left - 8 - priceW - gap : g.left + 4;
    const priceX = outside ? g.left - 8 : g.left + 4 + ratioW + gap;
    ctx.textAlign = outside ? "right" : "left";
    ctx.textBaseline = "middle";
    // Un halo fin de la couleur du fond les détache des bougies qu'elles recouvrent.
    ctx.strokeStyle = this.theme.surface;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    const write = (text: string, x: number, y: number, fill: string, a: number) => {
      ctx.globalAlpha = 0.85 * alpha;
      ctx.strokeText(text, x, y);
      ctx.globalAlpha = a * alpha;
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
    };
    g.levels.forEach((l, k) => {
      const yy = Math.round(l.y) + 0.5 - (outside ? 0 : 7);
      const key = isKeyFibLevel(d.kind, l.ratio);
      ctx.font = bold;
      write(ratios[k], ratioX, yy, color, key ? 1 : 0.7);
      ctx.font = plain;
      write(prices[k], priceX, yy, this.theme.text, key ? 0.95 : 0.7);
    });
    // Le mouvement mesuré : de a à b, puis à c pour une extension.
    ctx.globalAlpha = 0.45 * alpha;
    ctx.strokeStyle = this.theme.text;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    g.points.forEach(([, p], k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
    return g;
  }

  /**
   * Les alertes de l'utilisateur sur les niveaux d'un Fibonacci : une cloche
   * au bord droit de chaque niveau surveillé et, s'il s'arrête avant, la suite
   * du niveau en pointillés (l'alerte le suit jusqu'à maintenant).
   */
  private drawFibAlerts(id: string, g: ReturnType<typeof fibGeometry>, plotW: number, color: string) {
    const ctx = this.ctx;
    for (const a of this.alerts) {
      const t = a.target;
      if (t.kind !== "drawing" || t.drawingId !== id || a.scenarioId || t.level === undefined) continue;
      const l = g.levels.find((x) => Math.abs(x.ratio - t.level!) < 1e-9);
      if (!l) continue;
      const yy = Math.round(l.y) + 0.5;
      if ((a.state === "active" || a.state === "paused") && g.right < plotW) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, g.right), yy);
        ctx.lineTo(plotW, yy);
        ctx.stroke();
        ctx.restore();
      }
      this.bell(plotW - 16, yy - 9, a);
    }
  }

  /** Le nom d'un tracé, écrit à côté de lui ; renvoie sa largeur (0 sans nom). */
  private drawingLabel(label: string | undefined, x: number, y: number, align: CanvasTextAlign = "left", color = this.theme.accent): number {
    if (!label) return 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.font = `600 ${FONT_SIZE}px ${this.theme.font}`;
    ctx.fillText(label, x, y);
    const w = ctx.measureText(label).width;
    ctx.restore();
    return w;
  }

  /**
   * Les alertes de prix : une ligne en pointillés, une cloche à droite, leur
   * prix sur l'axe (plein si surveillée, en creux si suspendue) ; et la ligne
   * d'une alerte qui vient de partir, qui clignote.
   */
  private drawAlerts(L: Layout, y: (p: number) => number) {
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, axisW, priceH } = L;
    const shown = this.priceAlerts();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();
    for (const { alert, price } of shown) {
      const yy = Math.round(y(price)) + 0.5;
      ctx.strokeStyle = alert.scenarioId ? t.ai : t.alert;
      ctx.globalAlpha = alert.state === "paused" ? 0.45 : 0.9;
      ctx.lineWidth = this.alertDrag?.id === alert.id ? 2 : 1.2;
      ctx.setLineDash(alert.scenarioId ? [2, 4] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // À gauche du « + », qui passe à droite quand le réticule est à sa hauteur ; l'IA n'a pas de cloche, sa marque.
      if (alert.scenarioId) this.aiTag(plotW - 18, yy - 9, "right");
      else this.bell(plotW - 26, yy - 9, alert);
    }
    // Les bandes de l'IA : une zone en pointillés sur toute la largeur.
    for (const a of this.alerts) {
      if (a.target.kind !== "band" || (a.state !== "active" && a.state !== "paused")) continue;
      const top = y(a.target.top);
      const bottom = y(a.target.bottom);
      ctx.fillStyle = t.ai;
      ctx.globalAlpha = a.state === "paused" ? 0.04 : 0.08;
      ctx.fillRect(0, top, plotW, bottom - top);
      ctx.globalAlpha = a.state === "paused" ? 0.45 : 0.8;
      ctx.strokeStyle = t.ai;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.strokeRect(0.5, Math.round(top) + 0.5, plotW - 1, Math.round(bottom - top));
      ctx.globalAlpha = 1;
      this.aiTag(plotW - 18, top + 11, "right");
    }
    ctx.setLineDash([]);
    this.drawFlash(L, y);
    ctx.restore();
    ctx.lineWidth = 1;
    for (const { alert, price } of shown) {
      const paused = alert.state === "paused";
      this.axisLabel(
        formatPrice(price, this.digits),
        plotW,
        y(price),
        axisW,
        paused ? t.panel : alert.scenarioId ? t.ai : t.alert,
        paused ? (alert.scenarioId ? t.ai : t.alert) : t.onAccent,
        paused ? (alert.scenarioId ? t.ai : t.alert) : undefined,
        priceH,
      );
    }
  }

  /** La marque « IA » d'une alerte posée par l'IA pour un de ses scénarios. */
  /** La marque de l'IA (« IA »), ou d'une suggestion de l'IA sur un tracé de l'utilisateur (« IA ? »). */
  private aiTag(x: number, y: number, align: CanvasTextAlign, text = "IA") {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `700 ${FONT_SIZE - 1}px ${this.theme.font}`;
    const w = ctx.measureText(text).width + 6;
    const left = align === "right" ? x - w : x;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = this.theme.ai;
    ctx.fillRect(Math.round(left), Math.round(y - 7), Math.round(w), 13);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.theme.onAccent;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, Math.round(left) + 3, Math.round(y) + 0.5);
    ctx.restore();
  }

  /**
   * Les setups proposés par l'IA : depuis leur proposition (et sur au moins
   * 160 px, pour qu'un setup tout juste proposé se lise), l'entrée (trait
   * plein), le stop (rouge) et les objectifs (verts), en pointillés, avec leur
   * nom à gauche et leur prix sur l'axe.
   */
  private drawSetups(L: Layout, y: (p: number) => number) {
    const f = this.frame();
    if (!f || !this.setups.length) return;
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, axisW, priceH } = L;
    const levels: Array<{ price: number; color: string; dash: number[]; name: string }> = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();
    for (const s of this.setups) {
      const x0 = Math.max(0, Math.min(f.x(f.pos(s.since)), plotW - SETUP_MIN_PX));
      const win = t.up;
      const lose = t.down;
      const lines = [
        ...(s.entry !== undefined
          ? [{ price: s.entry, color: t.ai, dash: [] as number[], name: s.direction === "long" ? "Entrée achat" : "Entrée vente" }]
          : []),
        ...(s.stop !== undefined ? [{ price: s.stop, color: lose, dash: [4, 3], name: "Stop" }] : []),
        ...s.targets.map((p, i) => ({ price: p, color: win, dash: [4, 3], name: s.targets.length > 1 ? `Objectif ${i + 1}` : "Objectif" })),
      ];
      // La zone de risque et celle de gain, très légères, entre l'entrée et le stop, l'entrée et le premier objectif.
      if (s.entry !== undefined && s.stop !== undefined) {
        ctx.fillStyle = lose;
        ctx.globalAlpha = 0.06;
        ctx.fillRect(x0, Math.min(y(s.entry), y(s.stop)), plotW - x0, Math.abs(y(s.stop) - y(s.entry)));
      }
      if (s.entry !== undefined && s.targets.length) {
        ctx.fillStyle = win;
        ctx.globalAlpha = 0.06;
        ctx.fillRect(x0, Math.min(y(s.entry), y(s.targets[0])), plotW - x0, Math.abs(y(s.targets[0]) - y(s.entry)));
      }
      ctx.globalAlpha = 1;
      for (const l of lines) {
        const yy = Math.round(y(l.price)) + 0.5;
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1.4;
        ctx.setLineDash(l.dash);
        ctx.beginPath();
        ctx.moveTo(x0, yy);
        ctx.lineTo(plotW, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `600 ${FONT_SIZE}px ${t.font}`;
        ctx.fillStyle = l.color;
        ctx.textAlign = "left";
        ctx.fillText(l.name, x0 + 6, yy - 4);
        levels.push(l);
      }
    }
    ctx.restore();
    ctx.lineWidth = 1;
    for (const l of levels) this.axisLabel(formatPrice(l.price, this.digits), plotW, y(l.price), axisW, l.color, t.onAccent, undefined, priceH);
  }

  /**
   * La carte automatique, sous les tracés de l'utilisateur : ses zones en
   * pointillés (trait plein quand l'IA les a corrigées), ses obliques, et
   * ses divergences du RSI marquées sur les bougies.
   */
  private drawAutoMap(L: Layout, y: (p: number) => number) {
    const f = this.frame();
    const map = this.autoMap;
    if (!f || !map) return;
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, priceH } = L;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();
    ctx.lineWidth = 1;
    for (const z of map.zones) {
      const top = y(z.top);
      const bottom = y(z.bottom);
      ctx.fillStyle = t.ai;
      ctx.globalAlpha = 0.07;
      ctx.fillRect(0, top, plotW, bottom - top);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = t.ai;
      ctx.setLineDash(z.corrected ? [] : [3, 3]);
      ctx.strokeRect(0.5, Math.round(top) + 0.5, plotW - 1, Math.round(bottom - top));
    }
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([5, 4]);
    for (const l of map.trendlines) {
      const [p0, p1] = trendlineSegment({ x: f.x(f.pos(l.a.t)), y: y(l.a.price) }, { x: f.x(f.pos(l.b.t)), y: y(l.b.price) }, true, plotW);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.6;
    ctx.font = `600 ${FONT_SIZE}px ${t.font}`;
    for (const d of map.divergences) {
      const a = { x: f.x(f.pos(d.from.t)), y: y(d.from.price) };
      const b = { x: f.x(f.pos(d.to.t)), y: y(d.to.price) };
      const color = d.kind === "bullish" ? t.up : t.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(d.kind === "bullish" ? "div ↑" : "div ↓", b.x, d.kind === "bullish" ? b.y + 14 : b.y - 6);
    }
    ctx.restore();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  /** La ligne de l'alerte qui vient de partir, épaisse et pulsée, le temps du clignotement. */
  private drawFlash(L: Layout, y: (p: number) => number) {
    const fl = this.flashing;
    if (!fl) return;
    const left = fl.until - performance.now();
    const a = this.alerts.find((x) => x.id === fl.id);
    const f = this.frame();
    if (left <= 0 || !a || !f) {
      this.flashing = undefined;
      return;
    }
    const ctx = this.ctx;
    let from: { x: number; y: number } | undefined;
    let to: { x: number; y: number } | undefined;
    let band: { top: number; bottom: number } | undefined;
    if (a.target.kind === "price") {
      from = { x: 0, y: y(a.target.price) };
      to = { x: L.plotW, y: from.y };
    } else if (a.target.kind === "band") {
      band = { top: y(a.target.top), bottom: y(a.target.bottom) };
    } else {
      const id = a.target.drawingId;
      const d = this.drawings.find((x) => x.id === id);
      if (d?.kind === "hline")
        [from, to] = [
          { x: 0, y: y(d.price) },
          { x: L.plotW, y: y(d.price) },
        ];
      else if (d?.kind === "trendline") {
        [from, to] = trendlineSegment({ x: f.x(f.pos(d.a.t)), y: y(d.a.price) }, { x: f.x(f.pos(d.b.t)), y: y(d.b.price) }, d.extend, L.plotW);
      } else if (d?.kind === "zone") band = { top: y(d.top), bottom: y(d.bottom) };
      else if (d?.kind === "fib" || d?.kind === "fibext") {
        // Le niveau surveillé, de son début au bord droit.
        const price = fibLevelPrice(d, a.target.level);
        if (price !== undefined)
          [from, to] = [
            { x: Math.max(0, fibGeometry(d, f).left), y: y(price) },
            { x: L.plotW, y: y(price) },
          ];
      }
    }
    if (band) {
      ctx.strokeStyle = a.scenarioId ? this.theme.ai : this.theme.alert;
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.25 + 0.3 * (1 + Math.sin(((FLASH_MS - left) / 1000) * Math.PI * 4)) * 0.5;
      ctx.strokeRect(2, band.top, L.plotW - 4, band.bottom - band.top);
      ctx.globalAlpha = 1;
    }
    if (from && to) {
      ctx.strokeStyle = a.scenarioId ? this.theme.ai : this.theme.alert;
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.25 + 0.3 * (1 + Math.sin(((FLASH_MS - left) / 1000) * Math.PI * 4)) * 0.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Encore à clignoter : l'image suivante est demandée.
    requestAnimationFrame(() => {
      if (!this.ac.signal.aborted) this.schedule();
    });
  }

  /* ------------------------- Prix cités par Kopilia ------------------------ */

  /** Le prix d'une oblique sur la dernière bougie (prolongée s'il le faut : c'est ce qu'on en cite). */
  private priceNow(a: { t: number; price: number }, b: { t: number; price: number }): number | undefined {
    const pa = barPosition(this.times, a.t, this.tf);
    const pb = barPosition(this.times, b.t, this.tf);
    if (!Number.isFinite(pa) || !Number.isFinite(pb) || pa === pb) return undefined;
    return a.price + ((b.price - a.price) * (this.candles.length - 1 - pa)) / (pb - pa);
  }

  /**
   * Ce qui peut s'allumer, avec son prix du moment : les tracés, les alertes
   * de prix, les niveaux des setups, les moyennes, la carte automatique, le
   * dernier prix. À égalité, le premier l'emporte.
   */
  private spotLevels(): Array<SpotLevel<SpotRef>> {
    const out: Array<SpotLevel<SpotRef>> = [];
    for (const d of this.drawings) {
      const id = d.id;
      if (d.kind === "hline") out.push({ key: { kind: "drawing", id }, price: d.price });
      else if (d.kind === "zone") out.push({ key: { kind: "drawing", id }, top: d.top, bottom: d.bottom });
      else if (d.kind === "trendline") {
        const price = this.priceNow(d.a, d.b);
        if (price !== undefined) out.push({ key: { kind: "drawing", id }, price });
      } else if (d.kind === "position") {
        for (const part of ["entry", "stop", "target"] as const) out.push({ key: { kind: "drawing", id, part }, price: d[part] });
      } else if (d.kind === "fib" || d.kind === "fibext") {
        for (const l of fibLevels(d)) out.push({ key: { kind: "drawing", id, ratio: l.ratio }, price: l.price });
      }
    }
    for (const a of this.alerts) {
      if (a.state !== "active" && a.state !== "paused") continue;
      if (a.target.kind === "price") out.push({ key: { kind: "alert", id: a.id }, price: a.target.price });
      else if (a.target.kind === "band") out.push({ key: { kind: "alert", id: a.id }, top: a.target.top, bottom: a.target.bottom });
    }
    for (const s of this.setups) {
      if (s.entry !== undefined) out.push({ key: { kind: "setup", id: s.id, part: "entry" }, price: s.entry });
      if (s.stop !== undefined) out.push({ key: { kind: "setup", id: s.id, part: "stop" }, price: s.stop });
      s.targets.forEach((price, i) => out.push({ key: { kind: "setup", id: s.id, part: i }, price }));
    }
    this.indicators.forEach((ind, index) => {
      const main = this.series[index]?.main;
      if (!isOverlay(ind) || !main) return;
      for (let i = main.length - 1; i >= 0; i--) {
        if (Number.isFinite(main[i])) {
          out.push({ key: { kind: "indicator", index }, price: main[i] });
          return;
        }
      }
    });
    for (const z of this.autoMap?.zones ?? []) out.push({ key: { kind: "auto-zone", key: z.key }, top: z.top, bottom: z.bottom });
    for (const l of this.autoMap?.trendlines ?? []) {
      const price = this.priceNow(l.a, l.b);
      if (price !== undefined) out.push({ key: { kind: "auto-trend", key: l.key }, price });
    }
    out.push({ key: { kind: "last" }, price: this.candles[this.candles.length - 1].c });
    return out;
  }

  /** Ce qu'on dessine d'un prix allumé, à l'échelle du moment ; undefined : l'élément a disparu. */
  private spotShape(ref: SpotRef, L: Layout, y: (p: number) => number, f: Frame): SpotShape | undefined {
    const t = this.theme;
    const { plotW } = L;
    const full = (price: number, x0 = 0) =>
      [
        { x: x0, y: y(price) },
        { x: plotW, y: y(price) },
      ] as const;
    const line = (a: { t: number; price: number }, b: { t: number; price: number }) =>
      trendlineSegment({ x: f.x(f.pos(a.t)), y: y(a.price) }, { x: f.x(f.pos(b.t)), y: y(b.price) }, true, plotW);
    switch (ref.kind) {
      case "drawing": {
        const d = this.shown().find((x) => x.id === ref.id);
        if (!d) return undefined;
        const color = d.createdBy === "ia" ? t.ai : t.accent;
        if (d.kind === "hline") return { color, segs: [full(d.price)] };
        if (d.kind === "zone") return { color, segs: [], band: zoneRect(d, f) };
        if (d.kind === "trendline") return { color, segs: [line(d.a, d.b)] };
        if (d.kind === "position") {
          const g = positionGeometry(d, f);
          const part = ref.part ?? "entry";
          const yy = g[part];
          return {
            color: part === "entry" ? t.text : part === "stop" ? t.down : t.up,
            segs: [
              [
                { x: g.left, y: yy },
                { x: g.right, y: yy },
              ],
            ],
          };
        }
        if (d.kind === "fib" || d.kind === "fibext") {
          const price = fibLevelPrice(d, ref.ratio);
          return price === undefined ? undefined : { color, segs: [full(price, Math.max(0, fibGeometry(d, f).left))] };
        }
        return undefined;
      }
      case "alert": {
        const a = this.alerts.find((x) => x.id === ref.id);
        if (!a) return undefined;
        const color = a.scenarioId ? t.ai : t.alert;
        if (a.target.kind === "price") return { color, segs: [full(a.target.price)] };
        if (a.target.kind === "band") return { color, segs: [], band: { left: 0, right: plotW, top: y(a.target.top), bottom: y(a.target.bottom) } };
        return undefined;
      }
      case "setup": {
        const s = this.setups.find((x) => x.id === ref.id);
        const price = ref.part === "entry" ? s?.entry : ref.part === "stop" ? s?.stop : s?.targets[ref.part];
        if (!s || price === undefined) return undefined;
        const x0 = Math.max(0, Math.min(f.x(f.pos(s.since)), plotW - SETUP_MIN_PX));
        return { color: ref.part === "entry" ? t.ai : ref.part === "stop" ? t.down : t.up, segs: [full(price, x0)] };
      }
      case "auto-zone": {
        const z = this.autoMap?.zones.find((x) => x.key === ref.key);
        return z && { color: t.ai, segs: [], band: { left: 0, right: plotW, top: y(z.top), bottom: y(z.bottom) } };
      }
      case "auto-trend": {
        const l = this.autoMap?.trendlines.find((x) => x.key === ref.key);
        return l && { color: t.ai, segs: [line(l.a, l.b)] };
      }
      case "indicator": {
        const ind = this.indicators[ref.index];
        const series = this.series[ref.index]?.main;
        return ind && series && { color: this.color(ind, ref.index), segs: [], series };
      }
      case "last":
        return { color: t.accent, segs: [full(this.candles[this.candles.length - 1].c)] };
      case "bare":
        return ref.high > ref.low
          ? { color: t.ai, segs: [], band: { left: 0, right: plotW, top: y(ref.high), bottom: y(ref.low) } }
          : { color: t.ai, segs: [full(ref.low)] };
    }
  }

  /**
   * Les prix allumés : un halo qui pulse sur l'élément (le trait d'un prix
   * seul, en violet et en pointillés), son prix sur l'axe ; montée et
   * extinction douces. Hors de la vue, le prix au bord de l'axe, avec sa flèche.
   */
  private drawSpots(L: Layout, y: (p: number) => number) {
    const now = performance.now();
    this.spots = this.spots.filter((s) => s.until > now);
    const f = this.frame();
    if (!this.spots.length || !f) return;
    const ctx = this.ctx;
    const { plotW, priceH } = L;
    const pills: Array<{ prices: number[]; color: string; env: number }> = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();
    for (const s of this.spots) {
      const g = this.spotShape(s.ref, L, y, f);
      if (!g) continue;
      const age = now - s.start;
      const env = Math.max(0, Math.min(1, age / SPOT_IN_MS, (s.until - now) / SPOT_OUT_MS));
      const halo = env * (0.2 + 0.25 * (1 + Math.sin((age / 1000) * Math.PI * 3)) * 0.5);
      const bare = s.ref.kind === "bare";
      ctx.strokeStyle = g.color;
      ctx.fillStyle = g.color;
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      ctx.globalAlpha = halo;
      ctx.lineWidth = 7;
      for (const [a, b] of g.segs) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (g.series) {
        const { from, to } = this.visible(plotW);
        this.drawSeries(g.series, from, to, plotW, y, g.color, 7);
      }
      if (g.band) {
        const { left, right, top, bottom } = g.band;
        ctx.lineWidth = 4;
        ctx.strokeRect(left + 2, top, right - left - 4, bottom - top);
        ctx.globalAlpha = env * 0.1;
        ctx.fillRect(left, top, right - left, bottom - top);
      }
      // Un prix sans tracé : son trait, le temps qu'il est allumé.
      if (bare) {
        ctx.globalAlpha = env * 0.95;
        ctx.lineWidth = 1.4;
        ctx.lineCap = "butt";
        ctx.setLineDash([5, 4]);
        for (const [a, b] of g.segs) {
          ctx.beginPath();
          ctx.moveTo(a.x, Math.round(a.y) + 0.5);
          ctx.lineTo(b.x, Math.round(b.y) + 0.5);
          ctx.stroke();
        }
        if (g.band) ctx.strokeRect(g.band.left + 0.5, Math.round(g.band.top) + 0.5, g.band.right - g.band.left - 1, Math.round(g.band.bottom - g.band.top));
      }
      pills.push({ prices: s.prices, color: g.color, env });
    }
    ctx.restore();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.lineCap = "butt";
    // Les prix sur l'axe ; ceux hors de la vue s'empilent au bord, en haut ou en bas.
    const stack = { up: 0, down: 0 };
    for (const p of pills) {
      const ys = p.prices.map(y);
      const above = ys.every((v) => v < 0);
      const below = ys.every((v) => v > priceH);
      if (above || below) {
        const text =
          p.prices.length > 1
            ? `${formatPrice(Math.min(...p.prices), this.digits)}–${formatPrice(Math.max(...p.prices), this.digits)}`
            : formatPrice(p.prices[0], this.digits);
        const k = above ? stack.up++ : stack.down++;
        this.spotPill(`${above ? "▲" : "▼"} ${text}`, above ? 9 + k * 19 : priceH - 9 - k * 19, p.color, p.env, L, above ? "up" : "down");
      } else {
        p.prices.forEach((price, i) => this.spotPill(formatPrice(price, this.digits), Math.min(priceH - 9, Math.max(9, ys[i])), p.color, p.env, L));
      }
    }
    requestAnimationFrame(() => {
      if (!this.ac.signal.aborted) this.schedule();
    });
  }

  /** Le prix d'un élément allumé sur l'axe, cerclé d'un halo ; `edge` : hors de la vue, une flèche au bord du graphique. */
  private spotPill(text: string, yy: number, color: string, env: number, L: Layout, edge?: "up" | "down") {
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, axisW } = L;
    ctx.save();
    ctx.font = `600 ${FONT_SIZE}px ${t.font}`;
    ctx.textBaseline = "middle";
    const w = Math.max(axisW - 2, Math.ceil(ctx.measureText(text).width) + 10);
    const left = plotW + axisW - 1 - w;
    const top = Math.round(yy - 8);
    ctx.globalAlpha = env * 0.45;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(left - 1.5, top - 1.5, w + 3, 19, 4);
    ctx.stroke();
    ctx.globalAlpha = env;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(left, top, w, 16, 3);
    ctx.fill();
    ctx.fillStyle = color === t.text ? t.surface : t.onAccent;
    ctx.textAlign = "left";
    ctx.fillText(text, left + 5, top + 8.5);
    if (edge) {
      // La flèche, contre le bord du graphique, juste avant l'axe.
      const x = Math.min(left, plotW) - 10;
      const yA = edge === "up" ? top + 3 : top + 13;
      const yB = edge === "up" ? top + 11 : top + 5;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 5, yB);
      ctx.lineTo(x + 5, yB);
      ctx.lineTo(x, yA);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Une petite cloche : pleine quand l'alerte est surveillée, en creux sinon, barrée si suspendue. */
  private bell(x: number, y: number, alert: Alert) {
    const ctx = this.ctx;
    const t = this.theme;
    const on = alert.state === "active";
    ctx.save();
    ctx.translate(Math.round(x) + 0.5, Math.round(y) + 0.5);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = t.panel;
    ctx.beginPath();
    ctx.arc(0, 0.5, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    const color = on ? t.alert : t.text;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-4, 2.5);
    ctx.quadraticCurveTo(-4, -4.5, 0, -4.5);
    ctx.quadraticCurveTo(4, -4.5, 4, 2.5);
    ctx.lineTo(5, 3.5);
    ctx.lineTo(-5, 3.5);
    ctx.closePath();
    if (on) ctx.fill();
    else ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 5.2, 1.2, 0, Math.PI * 2);
    ctx.fill();
    if (alert.state === "paused") {
      ctx.beginPath();
      ctx.moveTo(-5, -5);
      ctx.lineTo(5, 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * « MM 50 2 650,21  MME 21 2 648,90 » en haut à gauche (sous la bougie
   * survolée), « RSI 14 62,3 · MM 14 58,1 » en haut du bandeau : les valeurs de
   * la bougie survolée, sinon de la dernière ; un indicateur masqué, estompé.
   */
  private drawLegend(L: Layout) {
    if (!this.indicators.length) return;
    const ctx = this.ctx;
    const i = this.hoverIndex >= 0 && this.hoverIndex < this.candles.length ? this.hoverIndex : this.candles.length - 1;
    ctx.font = `${FONT_SIZE}px ${this.theme.font}`;
    ctx.textAlign = "left";
    let x = 6;
    let xr = 6;
    this.indicators.forEach((ind, k) => {
      const series = this.series[k];
      const v = series?.main[i];
      const value = v !== undefined && Number.isFinite(v) ? (isOverlay(ind) ? formatPrice(v, this.digits) : decimalFormat(1).format(v)) : "–";
      const sig = ind.kind === "rsi" && ind.signal ? series?.signal?.[i] : undefined;
      const signal =
        ind.kind === "rsi" && ind.signal && sig !== undefined && Number.isFinite(sig)
          ? ` · ${MA_SHORT[ind.signal.type]} ${ind.signal.period} ${decimalFormat(1).format(sig)}`
          : "";
      const text = ind.hidden ? indicatorLabel(ind) : `${indicatorLabel(ind)} ${value}${signal}`;
      ctx.fillStyle = this.color(ind, k);
      ctx.globalAlpha = ind.hidden ? 0.4 : 1;
      if (isOverlay(ind)) {
        ctx.fillText(text, x, 26);
        x += ctx.measureText(text).width + 12;
      } else if (L.rsiH && !ind.hidden) {
        ctx.fillText(text, xr, L.rsiTop + 9);
        xr += ctx.measureText(text).width + 12;
      }
      ctx.globalAlpha = 1;
    });
  }

  private drawCrosshair(L: Layout, min: number, max: number) {
    const ctx = this.ctx;
    const t = this.theme;
    const { plotW, plotH, axisW, priceH, rsiTop, rsiH } = L;
    const h = this.hover;
    this.plus = undefined;
    this.crossY = undefined;
    if (!h || h.x > plotW || h.y > plotH || this.drag || this.pinch) {
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.cb.onHover?.(undefined);
      }
      return;
    }
    const i = Math.round(this.indexAt(h.x, plotW));
    const candle = this.candles[i];
    if (i !== this.hoverIndex) {
      this.hoverIndex = i;
      this.cb.onHover?.(candle);
    }
    const inRsi = rsiH > 0 && h.y >= rsiTop;
    const inPrice = h.y <= priceH;
    // En traçant, le réticule montre le prix que l'aimant retient, et un point sur la bougie quand il colle.
    const drawing = !!(this.tool || this.editing) && inPrice;
    const snapped = drawing ? this.cursorPoint(h.x, h.y) : undefined;
    const ySnap = snapped ? ((max - snapped.price) / (max - min)) * priceH : h.y;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = t.text;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    const yy = Math.round(ySnap) + 0.5;
    if (inPrice || inRsi) {
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
    }
    if (candle) {
      const xx = Math.round(this.x(i, plotW)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, plotH);
      ctx.stroke();
      ctx.restore();
      const label = timeLabel(candle.t, this.tf);
      const w = Math.ceil(ctx.measureText(label).width) + 12;
      const x0 = Math.min(plotW - w, Math.max(0, xx - w / 2));
      ctx.fillStyle = t.panel;
      ctx.fillRect(x0, plotH + 2, w, AXIS_H - 4);
      ctx.strokeStyle = t.grid;
      ctx.globalAlpha = 1;
      ctx.strokeRect(x0 + 0.5, plotH + 2.5, w - 1, AXIS_H - 5);
      ctx.fillStyle = t.text;
      ctx.textAlign = "center";
      ctx.fillText(label, x0 + w / 2, plotH + AXIS_H / 2 + 1);
    } else {
      ctx.restore();
    }
    const xSnap = snapped ? Math.round(this.x(Math.round(snapped.pos), plotW)) + 0.5 : h.x;
    if (snapped && (Math.abs(ySnap - h.y) > 0.5 || Math.abs(xSnap - h.x) > this.barWidth)) {
      ctx.save();
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(xSnap, ySnap, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (inPrice) {
      const price = snapped ? snapped.price : max - (h.y / priceH) * (max - min);
      this.crossY = ySnap;
      this.axisLabel(formatPrice(price, this.digits), plotW, ySnap, axisW, t.panel, t.text, t.grid, priceH);
      // Le « + » contre l'axe, à la hauteur du réticule : une alerte à ce prix (pas en traçant ni en glissant).
      if (!this.tool && !this.editing && !this.alertDrag) this.drawPlus(plotW - PLUS_R - 3, ySnap, Number(price.toFixed(this.digits)));
      else this.plus = undefined;
    } else if (inRsi) {
      const v = 100 - ((h.y - rsiTop) / rsiH) * 100;
      this.crossY = h.y;
      this.axisLabel(decimalFormat(1).format(Math.min(100, Math.max(0, v))), plotW, h.y, axisW, t.panel, t.text, t.grid);
    }
  }

  private drawPlus(x: number, y: number, price: number) {
    const ctx = this.ctx;
    const t = this.theme;
    this.plus = { x, y, price };
    const hot = !!this.hover && Math.hypot(this.hover.x - x, this.hover.y - y) <= PLUS_R + 2;
    ctx.save();
    ctx.fillStyle = hot ? t.alert : t.panel;
    ctx.strokeStyle = hot ? t.alert : t.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, PLUS_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = hot ? t.onAccent : t.text;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - 3.5, y);
    ctx.lineTo(x + 3.5, y);
    ctx.moveTo(x, y - 3.5);
    ctx.lineTo(x, y + 3.5);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * L'étiquette du dernier prix sur l'axe, et dessous, dans la même étiquette,
   * le temps restant de la bougie, estompé (comme sur un graphique de
   * trading) ; renvoie la ligne du compte à rebours, repeinte seule chaque seconde.
   */
  private lastLabel(price: string, countdown: string | undefined, plotW: number, yy: number, axisW: number, paneH: number) {
    if (countdown === undefined) {
      this.axisLabel(price, plotW, yy, axisW, this.theme.accent, this.theme.onAccent, undefined, paneH);
      return undefined;
    }
    const ctx = this.ctx;
    const h = LABEL_H + COUNTDOWN_H;
    const top = Math.round(Math.min(paneH - h, Math.max(0, yy - LABEL_H / 2)));
    ctx.fillStyle = this.theme.accent;
    ctx.fillRect(plotW + 1, top, axisW - 2, h);
    ctx.fillStyle = this.theme.onAccent;
    ctx.textAlign = "left";
    ctx.fillText(price, plotW + 6, top + LABEL_H / 2);
    // Bords entiers : repeinte par-dessus elle-même, la ligne ne fonce pas sur ses bords.
    const x = Math.ceil(plotW + 1);
    const rect = { x, y: top + LABEL_H, w: Math.floor(plotW + axisW - 1) - x, h: COUNTDOWN_H };
    this.paintCountdown(countdown, rect);
    return rect;
  }

  /** La ligne du compte à rebours : le fond de l'étiquette, puis le texte, aux chiffres de largeur fixe. */
  private paintCountdown(text: string, r: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = this.theme.accent;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.font = `${FONT_SIZE}px ${this.theme.font}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.theme.onAccent;
    ctx.globalAlpha = 0.78;
    this.fillTabular(text, r.x + 5, r.y + r.h / 2 - 1);
    ctx.restore();
  }

  /** Un texte aux chiffres de même largeur, à partir de `x` : d'une seconde à l'autre, rien ne bouge que les chiffres. */
  private fillTabular(text: string, x: number, y: number) {
    const ctx = this.ctx;
    const cell = this.digitWidth();
    ctx.textAlign = "center";
    for (const ch of text) {
      const w = /\d/.test(ch) ? cell : ctx.measureText(ch).width;
      ctx.fillText(ch, x + w / 2, y);
      x += w;
    }
  }

  private tabularWidth(text: string): number {
    const cell = this.digitWidth();
    let w = 0;
    for (const ch of text) w += /\d/.test(ch) ? cell : this.ctx.measureText(ch).width;
    return w;
  }

  /** Le plus large des chiffres, dans la police en cours. */
  private digitWidth(): number {
    let w = 0;
    for (let d = 0; d <= 9; d++) w = Math.max(w, this.ctx.measureText(String(d)).width);
    return w;
  }

  /** Étiquette sur l'axe des prix, à la hauteur `yy` (gardée dans le volet de hauteur `paneH`). */
  private axisLabel(text: string, plotW: number, yy: number, axisW: number, bg: string, fg: string, border?: string, paneH = this.plotHeight()) {
    const ctx = this.ctx;
    if (yy < -8 || yy > paneH + 8) return;
    const top = Math.round(Math.min(paneH - 16, Math.max(0, yy - 8)));
    ctx.fillStyle = bg;
    ctx.fillRect(plotW + 1, top, axisW - 2, 16);
    if (border) {
      ctx.strokeStyle = border;
      ctx.strokeRect(plotW + 1.5, top + 0.5, axisW - 3, 15);
    }
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.fillText(text, plotW + 6, top + 8);
  }
}

/** L'épaisseur du trait d'un indicateur (réglée de 1 à 4), en px. */
function lineWidth(ind: Indicator): number {
  return [1.4, 2, 2.6, 3.2][(ind.width ?? 1) - 1] ?? 1.4;
}

/* ----------------------------- Calculs purs ----------------------------- */

/** Pas « rond » (1, 2, 2,5, 5 × 10ⁿ) au moins égal à `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  // Arrondis : 1e-5 / 1e-5 vaut 1,0000000000000002 en flottant.
  const r = Number((raw / p).toPrecision(12));
  const m = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10;
  return Number((m * p).toPrecision(12));
}

const WEEK = 604_800;
const MONTH = 2_592_000;
const QUARTER = 3 * MONTH;
const YEAR = 12 * MONTH;
const TIME_STEPS = [60, 300, 900, 1800, 3600, 7200, 14_400, 43_200, 86_400, WEEK, MONTH, QUARTER, YEAR];

/** Pas des graduations du temps (s) : le plus fin qui laisse `minPx` entre deux étiquettes. */
export function pickTimeStep(tfSeconds: number, barWidth: number, minPx = TIME_TICK_PX): number {
  for (const s of TIME_STEPS) if (s >= tfSeconds && (s / tfSeconds) * barWidth >= minPx) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/**
 * Graduations du temps entre les bougies `from` et `to` : la première bougie
 * de chaque pas, en heure locale ; le jour (« 3 nov. ») quand il change, ou
 * toujours pour un pas d'au moins un jour.
 */
export function timeTicks(candles: Candle[], from: number, to: number, step: number): Tick[] {
  const ticks: Tick[] = [];
  let prevBucket: number | undefined;
  let prevDay: string | undefined;
  for (let i = Math.max(0, from - 1); i <= Math.min(candles.length - 1, to); i++) {
    const d = new Date(candles[i].t * 1000);
    const local = candles[i].t - d.getTimezoneOffset() * 60;
    // Semaines du lundi au dimanche, mois, trimestres et années du calendrier ; sinon des pas réguliers en heure locale.
    const bucket =
      step >= YEAR
        ? d.getFullYear()
        : step >= QUARTER
          ? d.getFullYear() * 4 + Math.floor(d.getMonth() / 3)
          : step >= MONTH
            ? d.getFullYear() * 12 + d.getMonth()
            : step >= WEEK
              ? Math.floor((local + 3 * 86_400) / WEEK)
              : Math.floor(local / step);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (prevBucket !== undefined && bucket !== prevBucket && i >= from) {
      const dayChanged = day !== prevDay;
      ticks.push({ index: i, label: dayChanged || step >= 86_400 ? dayLabel(d, step) : clockLabel(d), day: dayChanged });
    }
    prevBucket = bucket;
    prevDay = day;
  }
  return ticks;
}

/** « 3 nov. 11:45 » (bougies infra-journalières) ou « 3 nov. » : la bougie désignée par le réticule. */
export function timeLabel(tSeconds: number, tfSeconds: number): string {
  const d = new Date(tSeconds * 1000);
  return tfSeconds >= 86_400 ? dayLabel(d, tfSeconds) : `${dayLabel(d, 0)} ${clockLabel(d)}`;
}

function clockLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(d: Date, step: number): string {
  if (step >= YEAR) return dateFormat("year", { year: "numeric" }).format(d);
  if (step >= MONTH) return dateFormat("month", { month: "short", year: "numeric" }).format(d);
  return dateFormat("day", { day: "numeric", month: "short" }).format(d);
}
