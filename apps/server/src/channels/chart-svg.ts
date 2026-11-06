import {
  Alert,
  Drawing,
  FibShape,
  INDICATOR_COLORS,
  Indicator,
  IndicatorColor,
  RsiIndicator,
  barPosition,
  fibLevels,
  fibRatioLabel,
  indicatorLabel,
  indicatorSeries,
  isOverlay,
  positionRatio,
  ratioLabel,
} from "@kopilia/contracts";
import type { PositionShape } from "@kopilia/contracts";
import { frenchPrice } from "../market/metaapi.js";
import { ChartTimeframe, TIMEFRAME_LABELS, TIMEFRAME_SECONDS } from "../market/timeframes.js";
import type { ChartCandle } from "../market/market.service.js";

/*
 * Le graphique d'un produit en image (SVG), pour un canal extérieur : les
 * bougies du courtier, l'axe des prix et celui du temps, le dernier prix, les
 * moyennes et le RSI de l'encart, les tracés du produit et ses alertes, et
 * l'alerte qui vient de partir. Aux couleurs du thème sombre de l'écran, dans
 * son style sobre : une couleur par tracé (l'accent ; l'IA en violet ; le gain
 * et le risque d'une boîte de trade, en vert et rouge pâles), la hiérarchie
 * par l'opacité. Pur, testé à plat ; rasterisé ailleurs.
 */

export interface ChartImageInput {
  /** Nom courant (« Or ») et symbole du courtier. */
  name: string;
  symbol: string;
  timeframe: ChartTimeframe;
  digits?: number;
  /** Les plus anciennes d'abord ; les premières servent à amorcer les moyennes. */
  candles: ChartCandle[];
  drawings?: Drawing[];
  /** Les alertes surveillées du produit (actives ou suspendues). */
  alerts?: Alert[];
  /** Les indicateurs de l'encart du produit (les masqués sont ignorés). */
  indicators?: Indicator[];
  /** L'alerte qui vient de partir : son niveau, le prix et l'instant (epoch ms). */
  fired?: { level: number; price: number; at: number };
  /** Instant de l'image (epoch ms), écrit en haut à droite. */
  now?: number;
  /** À la place de l'instant, en haut à droite (« figé au ticket, ven. 6 nov. 09:12 »). */
  caption?: string;
  /** Sans la ligne et l'étiquette du dernier prix (le graphique d'un trade passé). */
  hideLast?: boolean;
  /** Un trade du journal par-dessus : son stop et son objectif marche par marche, son entrée et ses sorties. */
  trade?: TradeOverlay;
  /** Bougies montrées (CHART_BARS au plus) : moins pour un trade court, qu'il ne se perde pas au bord. */
  bars?: number;
}

/** Ce que le journal dessine d'un trade (instants en epoch s). */
export interface TradeOverlay {
  /** Ses niveaux dans le temps : chaque point vaut jusqu'au suivant, le dernier jusqu'à `end`. */
  stops: Array<{ t: number; price: number }>;
  targets: Array<{ t: number; price: number }>;
  /** Ses entrées exécutées, et ses sorties (gagnante ou non). */
  fills: Array<{ t: number; price: number }>;
  exits: Array<{ t: number; price: number; gain: boolean }>;
  /** Fin des marches : la dernière sortie, ou maintenant. */
  end: number;
}

/** Taille logique de l'image ; rasterisée deux fois plus grande. */
export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 400;
/** Bougies montrées au plus. */
export const CHART_BARS = 110;
/** Bougies d'air laissées au moins à droite de la dernière, pour qu'elle ne colle pas à l'axe des prix. */
export const FUTURE_BARS = 10;
/** Part du volet des prix laissée au plus à l'avenir, pour montrer une boîte posée loin devant les bougies. */
export const MAX_FUTURE_SHARE = 0.4;

/** Le thème sombre de l'écran (styles.css, chart-panel). */
const T = {
  bg: "#171a21",
  text: "#9aa0ab",
  strong: "#e8eaed",
  grid: "#2a2f3a",
  up: "#38d39f",
  down: "#ff6b6b",
  accent: "#5b8cff",
  alert: "#ffb454",
  ai: "#b48cff",
  font: "Helvetica Neue, Helvetica, Arial, sans-serif",
};

/** Les couleurs des indicateurs, celles de l'écran en thème sombre. */
const PALETTE: Record<IndicatorColor, string> = {
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

const HEADER_H = 34;
/** Pas de l'axe du temps, en secondes : de 5 minutes à une semaine. */
const TIME_STEPS = [300, 900, 1800, 3600, 7200, 10_800, 14_400, 21_600, 43_200, 86_400, 172_800, 604_800];
const AXIS_W = 64;
const TIME_H = 20;
const RSI_H = 74;
const PAD = 0.06;
const FONT = 11;

/** Les niveaux clés d'un Fibonacci, plus appuyés (comme à l'écran). */
const KEY_FIB: Record<FibShape["kind"], number[]> = { fib: [0, 0.5, 0.618, 1], fibext: [0, 1, 1.618] };

/** Le graphique en SVG. */
export function chartSvg(input: ChartImageInput): string {
  const W = CHART_WIDTH;
  const H = CHART_HEIGHT;
  const tf = TIMEFRAME_SECONDS[input.timeframe];
  const all = input.candles;
  const p = (v: number) => clean(frenchPrice(v, input.digits));
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${T.font}" font-size="${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${T.bg}"/>`);
  // En-tête : le produit et l'unité de temps ; à droite, l'instant.
  out.push(
    text(12, 21, `${capitalize(input.name)}`, { fill: T.strong, size: 15, weight: 600 }) +
      text(12 + measure(capitalize(input.name), 15, true) + 8, 21, `${input.symbol} · ${TIMEFRAME_LABELS[input.timeframe]}`, { fill: T.text, size: 12 }),
  );
  out.push(text(W - 12, 21, input.caption ?? momentText(input.now ?? Date.now()), { fill: T.text, size: 11, anchor: "end" }));
  if (!all.length) {
    out.push(text(W / 2, H / 2, "Pas de bougies pour ce produit", { fill: T.text, size: 13, anchor: "middle" }));
    out.push("</svg>");
    return out.join("");
  }

  const visible = (input.indicators ?? []).filter((i) => !i.hidden);
  const rsi = visible.find((i): i is RsiIndicator => i.kind === "rsi");
  const plotW = W - AXIS_W;
  const top = HEADER_H;
  const rsiH = rsi ? RSI_H : 0;
  const priceH = H - top - TIME_H - rsiH;
  const n = Math.min(all.length, Math.max(10, Math.min(CHART_BARS, input.bars ?? CHART_BARS)));
  const from = all.length - n;
  const bars = all.slice(from);
  // De l'air à droite de la dernière bougie, comme à l'écran ; davantage pour qu'un tracé posé devant elle (une boîte de trade) se voie en entier.
  const bw = plotW / (n + futureBars(input.drawings ?? [], all[all.length - 1].t, tf, n));
  const x = (i: number) => (i - from + 0.5) * bw;
  const times = all.map((c) => c.t);
  const xAt = (t: number) => x(barPosition(times, t, tf));

  let min = Math.min(...bars.map((c) => c.l));
  let max = Math.max(...bars.map((c) => c.h));
  if (input.fired) {
    min = Math.min(min, input.fired.level);
    max = Math.max(max, input.fired.level);
  }
  // Une boîte de trade du moment se voit en entier : son objectif et son stop restent dans le cadre.
  for (const d of input.drawings ?? []) {
    if (d.kind !== "position" || (d.to !== undefined && d.to < bars[0].t)) continue;
    min = Math.min(min, d.entry, d.stop, d.target);
    max = Math.max(max, d.entry, d.stop, d.target);
  }
  // Les niveaux d'un trade restent dans le cadre, même loin des bougies.
  if (input.trade) {
    const o = input.trade;
    for (const v of [...o.stops, ...o.targets, ...o.fills, ...o.exits].map((q) => q.price)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const span = max - min || Math.abs(max) * 0.001 || 1;
  max += span * PAD;
  min -= span * PAD;
  const y = (v: number) => top + ((max - v) / (max - min)) * priceH;

  // Grille et axe des prix.
  const step = niceStep((max - min) / Math.max(2, Math.floor(priceH / 44)));
  for (let k = Math.ceil(min / step); k * step <= max; k++) {
    const v = Number((k * step).toFixed(10));
    const yy = round(y(v));
    if (yy < top + 6 || yy > top + priceH - 6) continue;
    out.push(line(0, yy, plotW, yy, T.grid));
    out.push(text(plotW + 6, yy + 4, p(v), { fill: T.text }));
  }
  // Axe du temps : des heures rondes, à 90 px au moins les unes des autres ; le jour, en gras, quand il change.
  const bottom = H - TIME_H;
  const stepS = TIME_STEPS.find((st) => st >= Math.max(tf, (90 / bw) * tf)) ?? TIME_STEPS.at(-1)!;
  let lastX = -Infinity;
  for (let i = Math.max(1, from); i < all.length; i++) {
    const d = new Date(all[i].t * 1000);
    const newDay = new Date(all[i - 1].t * 1000).toDateString() !== d.toDateString();
    const seconds = d.getHours() * 3600 + d.getMinutes() * 60;
    if (!(stepS >= 86_400 ? newDay : newDay || seconds % stepS === 0)) continue;
    const xx = round(x(i));
    if (xx < 24 || xx > plotW - 24 || xx - lastX < 60) continue;
    lastX = xx;
    out.push(line(xx, top, xx, bottom, T.grid, { opacity: newDay ? 1 : 0.6 }));
    const label = tf >= 86_400 ? shortDate(d) : newDay ? dayText(d) : clock(d);
    out.push(text(xx, H - 6, label, { fill: T.text, anchor: "middle", weight: newDay && tf < 86_400 ? 600 : undefined }));
  }

  // Ce qui se dessine dans le volet des prix y reste.
  out.push(`<defs><clipPath id="plot"><rect x="0" y="${top}" width="${plotW}" height="${priceH}"/></clipPath></defs>`);
  out.push(`<g clip-path="url(#plot)">`);
  // Bougies.
  const body = Math.max(1, bw * 0.68);
  bars.forEach((c, k) => {
    const xc = x(from + k);
    const color = c.c >= c.o ? T.up : T.down;
    out.push(line(xc, y(c.h), xc, y(c.l), color));
    const yt = y(Math.max(c.o, c.c));
    const hgt = Math.max(1, y(Math.min(c.o, c.c)) - yt);
    out.push(`<rect x="${f(xc - body / 2)}" y="${f(yt)}" width="${f(body)}" height="${f(hgt)}" fill="${color}"/>`);
  });
  // Moyennes, sur toutes les bougies chargées (amorcées avant la première montrée).
  visible.forEach((ind, k) => {
    if (!isOverlay(ind)) return;
    const series = indicatorSeries(ind, all).main;
    out.push(polyline(series, from, x, y, colorOf(ind, k), widthOf(ind)));
  });
  // Les tracés du produit par-dessus, comme à l'écran.
  for (const d of input.drawings ?? []) out.push(drawingSvg(d, { x: xAt, y, plotW, top, priceH, p }));
  // Les alertes surveillées : en pointillés, orange (l'IA : violet, plus fins).
  for (const a of input.alerts ?? []) {
    const level = alertLevel(a);
    if (level === undefined) continue;
    const yy = round(y(level));
    const ai = !!a.scenarioId;
    out.push(line(0, yy, plotW, yy, ai ? T.ai : T.alert, { dash: ai ? "2 4" : "6 4", opacity: a.state === "paused" ? 0.45 : 0.9 }));
  }
  if (input.trade) out.push(tradeSvg(input.trade, { x: xAt, y, plotW, top, priceH, p }));
  out.push(`</g>`);

  // L'alerte qui vient de partir : son niveau en plein, et le point du franchissement.
  if (input.fired) {
    const yy = round(y(input.fired.level));
    out.push(line(0, yy, plotW, yy, T.alert, { width: 1.5 }));
    const xf = Math.min(plotW - 4, Math.max(4, xAt(Math.floor(input.fired.at / 1000))));
    out.push(`<circle cx="${f(xf)}" cy="${f(y(input.fired.price))}" r="4" fill="none" stroke="${T.alert}" stroke-width="1.5"/>`);
    out.push(axisLabel(plotW, yy, p(input.fired.level), T.alert, "#171a21"));
  }

  // Dernier prix : pointillés et étiquette sur l'axe.
  if (!input.hideLast) {
    const last = all[all.length - 1];
    const yl = round(y(last.c));
    out.push(line(0, yl, plotW, yl, T.accent, { dash: "3 3", opacity: 0.8 }));
    out.push(axisLabel(plotW, yl, p(last.c), T.accent, "#ffffff"));
  }

  // Légende des moyennes, en haut à gauche du volet.
  let lx = 10;
  visible.forEach((ind, k) => {
    if (!isOverlay(ind)) return;
    const label = indicatorLabel(ind);
    out.push(text(lx, top + 14, label, { fill: colorOf(ind, k), weight: 600 }));
    lx += measure(label, FONT, true) + 12;
  });

  if (rsi) out.push(rsiSvg(rsi, all, from, x, { top: top + priceH, h: rsiH, plotW, color: colorOf(rsi, visible.indexOf(rsi)) }));
  out.push(line(plotW + 0.5, top, plotW + 0.5, bottom, T.grid));
  out.push("</svg>");
  return out.join("");
}

/**
 * Les bougies d'avenir laissées vides à droite de la dernière : FUTURE_BARS
 * au moins, et assez pour qu'une boîte de trade posée devant les bougies se
 * voie jusqu'à son bord droit, qu'un autre tracé qui y commence s'y voie sur
 * quelques bougies, avec une bougie d'air ; au plus MAX_FUTURE_SHARE du volet.
 */
export function futureBars(drawings: readonly Drawing[], lastT: number, tf: number, n: number): number {
  const ahead = drawings.map((d) => (shownUntil(d, tf) - lastT) / tf + 1).filter((v) => Number.isFinite(v));
  const most = (n * MAX_FUTURE_SHARE) / (1 - MAX_FUTURE_SHARE);
  return Math.min(most, Math.max(FUTURE_BARS, Math.ceil(Math.max(0, ...ahead))));
}

/** L'instant (epoch s) jusqu'où un tracé doit se voir : le bord droit d'une boîte ; le début d'un autre, et quelques bougies. */
function shownUntil(d: Drawing, tf: number): number {
  const lead = 5 * tf;
  switch (d.kind) {
    case "hline":
      return NaN;
    case "position":
      return d.to ?? d.from + lead;
    case "zone":
      return d.from !== undefined ? d.from + lead : NaN;
    case "trendline":
    case "fib":
      return Math.min(d.a.t, d.b.t) + lead;
    case "fibext":
      return d.c.t + lead;
  }
}

interface Frame {
  x: (t: number) => number;
  y: (v: number) => number;
  plotW: number;
  top: number;
  priceH: number;
  p: (v: number) => string;
}

/**
 * Un trade du journal : son stop (rouge) et son objectif (vert) en marches,
 * une marche par déplacement, en pointillés après le premier ; son entrée
 * (cercle clair) et ses sorties (cercle vert ou rouge).
 */
function tradeSvg(o: TradeOverlay, fr: Frame): string {
  const out: string[] = [];
  const steps = (pts: TradeOverlay["stops"], color: string) => {
    pts.forEach((pt, k) => {
      const x0 = Math.max(0, fr.x(pt.t));
      const x1 = Math.min(fr.plotW, fr.x(k + 1 < pts.length ? pts[k + 1].t : o.end));
      if (x1 <= x0) return;
      const yy = round(fr.y(pt.price));
      out.push(line(x0, yy, x1, yy, color, { width: 1.5, dash: k ? "4 3" : undefined }));
      if (k + 1 < pts.length) out.push(line(x1, yy, x1, round(fr.y(pts[k + 1].price)), color, { opacity: 0.5 }));
    });
  };
  steps(o.targets, T.up);
  steps(o.stops, T.down);
  const dot = (t: number, price: number, color: string) =>
    `<circle cx="${f(Math.min(fr.plotW - 4, Math.max(4, fr.x(t))))}" cy="${f(fr.y(price))}" r="4.5" fill="${T.bg}" stroke="${color}" stroke-width="1.8"/>`;
  for (const q of o.fills) out.push(dot(q.t, q.price, T.strong));
  for (const q of o.exits) out.push(dot(q.t, q.price, q.gain ? T.up : T.down));
  return out.join("");
}

/** Un tracé du produit, à l'accent (l'IA : violet, en pointillés). */
function drawingSvg(d: Drawing, fr: Frame): string {
  const ia = d.createdBy === "ia";
  const color = ia ? T.ai : T.accent;
  const dash = ia ? "6 4" : undefined;
  const out: string[] = [];
  const label = (s: string | undefined, xx: number, yy: number, anchor: "start" | "end" = "end") =>
    s ? text(xx, yy, s, { fill: color, anchor, weight: 600, halo: true }) : "";
  if (d.kind === "hline") {
    const yy = round(fr.y(d.price));
    out.push(line(0, yy, fr.plotW, yy, color, { dash, width: 1.5 }));
    out.push(label(d.label, fr.plotW - 8, yy - 5));
  } else if (d.kind === "zone") {
    const left = d.from !== undefined ? Math.max(0, fr.x(d.from)) : 0;
    const right = d.to !== undefined ? Math.min(fr.plotW, fr.x(d.to)) : fr.plotW;
    const y0 = fr.y(Math.max(d.top, d.bottom));
    const y1 = fr.y(Math.min(d.top, d.bottom));
    if (right > left) {
      out.push(
        `<rect x="${f(left)}" y="${f(y0)}" width="${f(right - left)}" height="${f(Math.max(1, y1 - y0))}" fill="${color}" fill-opacity="${ia ? 0.07 : 0.12}" stroke="${color}" stroke-opacity="0.7"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
      );
      out.push(label(d.label, right - 6, y0 + 13));
    }
  } else if (d.kind === "trendline") {
    const a = { x: fr.x(d.a.t), y: fr.y(d.a.price) };
    const b = { x: fr.x(d.b.t), y: fr.y(d.b.price) };
    const [p0, end] = a.x <= b.x ? [a, b] : [b, a];
    let p1 = end;
    if (d.extend && p1.x !== p0.x) {
      const slope = (p1.y - p0.y) / (p1.x - p0.x);
      p1 = { x: fr.plotW, y: p0.y + slope * (fr.plotW - p0.x) };
    }
    out.push(line(p0.x, p0.y, p1.x, p1.y, color, { dash, width: 1.5 }));
    out.push(label(d.label, p0.x + 4, p0.y - 6, "start"));
  } else if (d.kind === "position") {
    out.push(positionSvg(d, fr));
  } else {
    const g = fibSvg(d, fr, color, dash);
    out.push(g.svg);
    out.push(label(d.label, Math.min(g.right, fr.plotW) - 4, g.top - 5));
  }
  return out.join("");
}

/**
 * Une boîte de trade, comme à l'écran : le gain en vert pâle, le risque en
 * rouge pâle, l'objectif et le stop dans leur couleur, l'entrée en gris, et
 * sur l'entrée, seul, le rapport gain / risque.
 */
function positionSvg(d: PositionShape & { label?: string }, fr: Frame): string {
  // Sans fin, sur 160 px au moins, comme à l'écran : une boîte tracée maintenant ne reste pas coincée contre l'axe.
  const left = Math.max(0, d.to !== undefined ? fr.x(d.from) : Math.min(fr.x(d.from), fr.plotW - 160));
  const right = Math.max(left + 40, d.to !== undefined ? Math.min(fr.plotW, fr.x(d.to)) : fr.plotW);
  const [ye, ys, yt] = [round(fr.y(d.entry)), round(fr.y(d.stop)), round(fr.y(d.target))];
  const out: string[] = [];
  const rect = (y0: number, y1: number, color: string) =>
    `<rect x="${f(left)}" y="${f(Math.min(y0, y1))}" width="${f(right - left)}" height="${f(Math.max(1, Math.abs(y1 - y0)))}" fill="${color}" fill-opacity="0.1"/>`;
  out.push(rect(ye, yt, T.up), rect(ye, ys, T.down));
  out.push(line(left, yt, right, yt, T.up, { opacity: 0.85 }), line(left, ys, right, ys, T.down, { opacity: 0.85 }));
  out.push(line(left, ye, right, ye, T.text, { width: 1.5 }));
  const ratio = positionRatio(d);
  if (ratio !== undefined) {
    const label = ratioLabel(ratio);
    const w = measure(label, FONT, true) + 10;
    const cx = (left + right) / 2;
    out.push(`<rect x="${f(cx - w / 2)}" y="${f(ye - 8)}" width="${f(w)}" height="16" rx="3" fill="${T.text}"/>`);
    out.push(text(cx, ye + 4, label, { fill: T.bg, weight: 600, anchor: "middle" }));
  }
  if (d.label) out.push(text(right - 4, Math.min(yt, ys) - 5, d.label, { fill: T.strong, weight: 600, anchor: "end", halo: true }));
  return out.join("");
}

/** Un Fibonacci : ses bandes, ses niveaux (les clés plus appuyés), ratio et prix à gauche. */
function fibSvg(d: FibShape, fr: Frame, color: string, dash: string | undefined): { svg: string; right: number; top: number } {
  let left: number;
  let right: number;
  if (d.kind === "fib") {
    left = Math.min(fr.x(d.a.t), fr.x(d.b.t));
    right = Math.max(fr.x(d.a.t), fr.x(d.b.t));
  } else {
    left = fr.x(d.c.t);
    right = left + Math.abs(fr.x(d.b.t) - fr.x(d.a.t));
  }
  if (d.extend) right = fr.plotW;
  right = Math.max(right, left + 40);
  const levels = fibLevels(d).map((l) => ({ ...l, y: fr.y(l.price) }));
  const out: string[] = [];
  for (let k = 1; k < levels.length; k++) {
    const [y0, y1] = [levels[k - 1].y, levels[k].y];
    out.push(
      `<rect x="${f(left)}" y="${f(Math.min(y0, y1))}" width="${f(right - left)}" height="${f(Math.abs(y1 - y0))}" fill="${color}" fill-opacity="${k % 2 ? 0.07 : 0.035}"/>`,
    );
  }
  for (const l of levels) {
    const key = KEY_FIB[d.kind].some((r) => Math.abs(r - l.ratio) < 1e-9);
    const yy = round(l.y);
    out.push(line(left, yy, right, yy, color, { dash, opacity: key ? 0.85 : 0.4 }));
    const tx = Math.max(4, left + 4);
    out.push(text(tx, yy - 3, `${fibRatioLabel(l.ratio)}  ${fr.p(l.price)}`, { fill: color, size: 10, opacity: key ? 1 : 0.7, halo: true }));
  }
  return { svg: out.join(""), right, top: Math.min(...levels.map((l) => l.y)) };
}

/** Le bandeau du RSI : 0 à 100, ses seuils en pointillés, sa moyenne s'il en a une, sa dernière valeur. */
function rsiSvg(
  ind: RsiIndicator,
  all: ChartCandle[],
  from: number,
  x: (i: number) => number,
  o: { top: number; h: number; plotW: number; color: string },
): string {
  const y = (v: number) => o.top + 8 + ((100 - v) / 100) * (o.h - 14);
  const { main, signal } = indicatorSeries(ind, all);
  const out: string[] = [line(0, o.top + 0.5, o.plotW, o.top + 0.5, T.grid)];
  for (const level of [ind.overbought, ind.oversold]) {
    const yy = round(y(level));
    out.push(line(0, yy, o.plotW, yy, T.text, { dash: "4 3", opacity: 0.5 }));
    out.push(text(o.plotW + 6, yy + 4, String(level), { fill: T.text, size: 10 }));
  }
  out.push(polyline(main, from, x, y, o.color, widthOf(ind)));
  if (signal) out.push(polyline(signal, from, x, y, o.color, 1, "3 3", 0.7));
  const last = main.at(-1);
  const value = last !== undefined && Number.isFinite(last) ? ` : ${last.toFixed(1).replace(".", ",")}` : "";
  out.push(text(10, o.top + 16, `${indicatorLabel(ind)}${value}`, { fill: o.color, weight: 600 }));
  return out.join("");
}

/** Le niveau d'une alerte de prix ou de bande (une alerte sur un tracé suit le tracé, déjà dessiné). */
function alertLevel(a: Alert): number | undefined {
  if (a.target.kind === "price") return a.target.price;
  return undefined;
}

function axisLabel(plotW: number, yy: number, label: string, fill: string, color: string): string {
  const w = measure(label, FONT, true) + 10;
  return (
    `<rect x="${f(plotW + 1)}" y="${f(yy - 9)}" width="${f(w)}" height="18" rx="3" fill="${fill}"/>` +
    text(plotW + 6, yy + 4, label, { fill: color, weight: 600 })
  );
}

function polyline(
  series: number[],
  from: number,
  x: (i: number) => number,
  y: (v: number) => number,
  color: string,
  width: number,
  dash?: string,
  opacity = 1,
): string {
  const runs: string[][] = [[]];
  for (let i = from; i < series.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) {
      if (runs.at(-1)!.length) runs.push([]);
      continue;
    }
    runs.at(-1)!.push(`${f(x(i))},${f(y(v))}`);
  }
  return runs
    .filter((r) => r.length > 1)
    .map(
      (r) =>
        `<polyline points="${r.join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${opacity < 1 ? ` stroke-opacity="${opacity}"` : ""}/>`,
    )
    .join("");
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, o: { dash?: string; opacity?: number; width?: number } = {}): string {
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${o.width ?? 1}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}${o.opacity !== undefined && o.opacity < 1 ? ` stroke-opacity="${o.opacity}"` : ""}/>`;
}

function text(
  x: number,
  y: number,
  s: string,
  o: { fill: string; size?: number; weight?: number; anchor?: "start" | "middle" | "end"; opacity?: number; halo?: boolean },
): string {
  const attrs = [
    `x="${f(x)}"`,
    `y="${f(y)}"`,
    `fill="${o.fill}"`,
    o.size ? `font-size="${o.size}"` : "",
    o.weight ? `font-weight="${o.weight}"` : "",
    o.anchor && o.anchor !== "start" ? `text-anchor="${o.anchor}"` : "",
    o.opacity !== undefined && o.opacity < 1 ? `fill-opacity="${o.opacity}"` : "",
    // Un halo de la couleur du fond détache le texte des bougies qu'il recouvre.
    o.halo ? `stroke="${T.bg}" stroke-width="3" stroke-opacity="0.85" paint-order="stroke" stroke-linejoin="round"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${xml(s)}</text>`;
}

function colorOf(ind: Indicator, k: number): string {
  return PALETTE[ind.color ?? INDICATOR_COLORS[k % INDICATOR_COLORS.length]] ?? T.accent;
}

function widthOf(ind: Indicator): number {
  return [1.4, 2, 2.6, 3.2][(ind.width ?? 1) - 1] ?? 1.4;
}

/** Pas « rond » (1, 2, 2,5, 5 × 10ⁿ) au moins égal à `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw - 1e-12) return m * pow;
  return 10 * pow;
}

/** Largeur approchée d'un texte (pour placer ce qui le suit). */
function measure(s: string, size: number, bold = false): number {
  return s.length * size * (bold ? 0.6 : 0.56);
}

/** « 14:32 » (heure du Mac, celle de Paris). */
function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** « jeu. 5 ». */
function dayText(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric" }).format(d);
}

/** « 5 nov. ». */
function shortDate(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(d);
}

/** « jeudi 5 novembre, 14:32 ». */
function momentText(at: number): string {
  const d = new Date(at);
  return `${new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(d)}, ${clock(d)}`;
}

/** Les espaces insécables des nombres à la française, en espaces simples (toutes les polices les ont). */
function clean(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, " ");
}

function xml(s: string): string {
  return clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function round(v: number): number {
  return Math.round(v) + 0.5;
}

function f(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "0";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
