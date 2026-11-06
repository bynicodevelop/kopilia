/**
 * Les tracés sur un graphique, à la souris : quel tracé est sous le pointeur
 * (et quelle partie : un point, un bord, le corps), la forme d'un tracé posé
 * en un, deux ou trois clics, et celle d'un tracé qu'on déplace. Fonctions pures,
 * testées sans écran ; le moteur du graphique (CandleChart) les dessine.
 */
import { fibLevels } from "@kopilia/contracts";
import type { Drawing, DrawingShape, FibShape, PositionShape, PositionSide } from "@kopilia/contracts";
import type { Candle } from "./candles";

/**
 * Les outils de tracé : ligne horizontale, oblique, zone, retracement et
 * extension de Fibonacci, et les deux boîtes de trade (position longue,
 * position courte), un seul genre de tracé (« position ») de deux sens.
 */
export type DrawTool = Exclude<DrawingShape["kind"], "position"> | PositionSide;

/** Les points à poser pour un tracé : un pour une ligne ou une boîte de trade, trois pour une extension de Fibonacci, deux sinon. */
export function pointsNeeded(tool: DrawTool): number {
  return tool === "hline" || tool === "long" || tool === "short" ? 1 : tool === "fibext" ? 3 : 2;
}

/** L'outil d'une boîte de trade : son sens (undefined pour les autres outils). */
export function positionTool(tool: DrawTool | null | undefined): PositionSide | undefined {
  return tool === "long" || tool === "short" ? tool : undefined;
}

/** Passage des bougies et des prix aux pixels du volet des prix, et des instants aux positions. */
export interface Frame {
  /** Abscisse d'une position (en bougies, fractionnaire). */
  x(pos: number): number;
  /** Ordonnée d'un prix. */
  y(price: number): number;
  /** Largeur du volet des prix. */
  width: number;
  /** Position d'un instant (epoch s) parmi les bougies. */
  pos(t: number): number;
  /** Instant de la position entière `pos`. */
  time(pos: number): number;
}

/**
 * Ce que saisit la souris : un point d'une oblique ou d'un Fibonacci, un bord
 * d'une zone, l'entrée, le stop ou l'objectif d'une boîte de trade (son bord
 * droit : « to »), ou le tracé entier.
 */
export type Part = "body" | "a" | "b" | "c" | "top" | "bottom" | "from" | "to" | "entry" | "stop" | "target";

/** Un point du graphique : position (en bougies) et prix. */
export interface ChartPoint {
  pos: number;
  price: number;
}

/** Distance en pixels sous laquelle le pointeur saisit un tracé. */
export const HIT_PX = 6;

/** Le tracé sous le pointeur (le plus récent d'abord, comme il est dessiné par-dessus) et la partie saisie. */
export function hitTest(drawings: readonly (DrawingShape & { id: string })[], f: Frame, px: number, py: number, tol = HIT_PX) {
  for (let k = drawings.length - 1; k >= 0; k--) {
    const d = drawings[k];
    const part = hitPart(d, f, px, py, tol);
    if (part) return { id: d.id, part };
  }
  return undefined;
}

function hitPart(d: DrawingShape, f: Frame, px: number, py: number, tol: number): Part | undefined {
  if (px < 0 || px > f.width) return undefined;
  if (d.kind === "hline") return Math.abs(py - f.y(d.price)) <= tol ? "body" : undefined;
  if (d.kind === "trendline") {
    const a = { x: f.x(f.pos(d.a.t)), y: f.y(d.a.price) };
    const b = { x: f.x(f.pos(d.b.t)), y: f.y(d.b.price) };
    if (Math.hypot(px - a.x, py - a.y) <= tol + 2) return "a";
    if (Math.hypot(px - b.x, py - b.y) <= tol + 2) return "b";
    const [from, to] = trendlineSegment(a, b, d.extend, f.width);
    return distanceToSegment(px, py, from, to) <= tol ? "body" : undefined;
  }
  if (d.kind === "position") {
    // Ses poignées d'abord (l'objectif, l'entrée et le stop à gauche, la largeur à droite), puis ses lignes, puis la boîte.
    const g = positionGeometry(d, f);
    const near = (x: number, y: number) => Math.hypot(px - x, py - y) <= tol + 2;
    if (near(g.left, g.target)) return "target";
    if (near(g.left, g.stop)) return "stop";
    if (near(g.left, g.entry)) return "entry";
    if (near(g.right, g.entry)) return "to";
    if (px < g.left - tol || px > g.right + tol) return undefined;
    if (Math.abs(py - g.target) <= tol) return "target";
    if (Math.abs(py - g.stop) <= tol) return "stop";
    return py >= Math.min(g.target, g.stop) && py <= Math.max(g.target, g.stop) && px >= g.left && px <= g.right ? "body" : undefined;
  }
  if (d.kind === "fib" || d.kind === "fibext") {
    // Ses points d'abord, puis ses niveaux et le tracé du mouvement (en pointillés) : son fond teinté ne se saisit pas, le graphique y défile.
    const g = fibGeometry(d, f);
    for (const [part, p] of g.points) if (Math.hypot(px - p.x, py - p.y) <= tol + 2) return part;
    if (px >= g.left - tol && px <= g.right + tol && g.levels.some((l) => Math.abs(py - l.y) <= tol)) return "body";
    for (let k = 1; k < g.points.length; k++) if (distanceToSegment(px, py, g.points[k - 1][1], g.points[k][1]) <= tol) return "body";
    return undefined;
  }
  const r = zoneRect(d, f);
  const inX = px >= r.left - tol && px <= r.right + tol;
  const inY = py >= r.top - tol && py <= r.bottom + tol;
  if (!inX || !inY) return undefined;
  if (Math.abs(py - r.top) <= tol) return "top";
  if (Math.abs(py - r.bottom) <= tol) return "bottom";
  if (d.from !== undefined && Math.abs(px - r.left) <= tol) return "from";
  if (d.to !== undefined && Math.abs(px - r.right) <= tol) return "to";
  return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom ? "body" : undefined;
}

/** Le segment dessiné d'une oblique : de son point le plus à gauche à l'autre, ou jusqu'au bord droit si elle est prolongée. */
export function trendlineSegment(a: { x: number; y: number }, b: { x: number; y: number }, extend: boolean, width: number) {
  const [l, r] = a.x <= b.x ? [a, b] : [b, a];
  if (!extend || r.x >= width || r.x === l.x) return [l, r] as const;
  const slope = (r.y - l.y) / (r.x - l.x);
  return [l, { x: width, y: r.y + slope * (width - r.x) }] as const;
}

/** Le rectangle d'une zone, en pixels : sans début, depuis le bord gauche ; sans fin, jusqu'au bord droit. */
export function zoneRect(z: Extract<DrawingShape, { kind: "zone" }>, f: Frame) {
  const left = z.from !== undefined ? f.x(f.pos(z.from)) : 0;
  const right = z.to !== undefined ? f.x(f.pos(z.to)) : f.width;
  return { left: Math.min(left, right), right: Math.max(left, right), top: f.y(z.top), bottom: f.y(z.bottom) };
}

/** Hauteur (px) du risque d'une boîte qu'on pose d'un clic, largeur (px) de la boîte (ses étiquettes y tiennent), et son rapport gain / risque. */
export const POSITION_RISK_PX = 40;
export const POSITION_WIDTH_PX = 160;
export const POSITION_RATIO = 2;

/**
 * Une boîte de trade en pixels : ses bords gauche (la bougie d'entrée) et
 * droit (sa fin, ou le bord du volet), et la hauteur de son entrée, de son
 * stop et de son objectif. Sans fin, elle se lit sur 160 px au moins, comme
 * un setup de l'IA tout juste proposé : une boîte tracée à la voix, qui part
 * de maintenant, ne reste pas coincée contre l'axe des prix.
 */
export function positionGeometry(d: PositionShape, f: Frame) {
  const start = f.x(f.pos(d.from));
  if (d.to === undefined) {
    return { left: Math.min(start, f.width - POSITION_WIDTH_PX), right: f.width, entry: f.y(d.entry), stop: f.y(d.stop), target: f.y(d.target) };
  }
  const end = f.x(f.pos(d.to));
  return { left: Math.min(start, end), right: Math.max(start, end), entry: f.y(d.entry), stop: f.y(d.stop), target: f.y(d.target) };
}

/** Un pas « rond » (1, 2, 2,5, 5 × 10ⁿ) proche de `raw` : l'écart par défaut d'une boîte qu'on pose. */
export function niceDistance(raw: number): number {
  if (!(raw > 0)) return 0;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = [1, 2, 2.5, 5, 10].reduce((best, k) => (Math.abs(k * pow - raw) < Math.abs(best * pow - raw) ? k : best));
  return m * pow;
}

/**
 * La boîte de trade posée d'un clic, comme sur TradingView : l'entrée au point
 * cliqué (sur sa bougie), le stop à un écart rond d'environ 40 px, l'objectif
 * à deux fois cet écart (2 R), sur environ 160 px vers la droite (5 bougies
 * au moins). Prix aux décimales du produit.
 */
export function positionFrom(side: PositionSide, p: ChartPoint, f: Pick<Frame, "x" | "y" | "time">, digits: number): PositionShape {
  const tick = 10 ** -digits;
  const pxPerPrice = Math.abs(f.y(p.price + 1) - f.y(p.price)) || 1;
  const risk = Math.max(tick, Number(niceDistance(POSITION_RISK_PX / pxPerPrice).toFixed(digits)));
  const sign = side === "long" ? 1 : -1;
  const round = (v: number) => Number(v.toFixed(digits));
  const bar = Math.abs(f.x(1) - f.x(0)) || 1;
  const i = Math.round(p.pos);
  return {
    kind: "position",
    side,
    entry: p.price,
    stop: round(p.price - sign * risk),
    target: round(p.price + sign * risk * POSITION_RATIO),
    from: f.time(i),
    to: f.time(i + Math.max(5, Math.round(POSITION_WIDTH_PX / bar))),
  };
}

/**
 * Les niveaux clés d'un Fibonacci, tracés plus francs que les autres (tous
 * sont de la couleur des tracés) : ses bornes, 0,5 et 0,618 d'un retracement,
 * 1,618 d'une extension.
 */
export function isKeyFibLevel(kind: FibShape["kind"], ratio: number): boolean {
  const key = kind === "fib" ? [0, 0.5, 0.618, 1] : [0, 1, 1.618];
  return key.some((r) => Math.abs(r - ratio) < 1e-9);
}

/**
 * Un Fibonacci en pixels : ses points (a, b, et c pour une extension), dans
 * l'ordre du tracé ; l'étendue de ses niveaux (d'un point à l'autre pour un
 * retracement, de c vers la droite sur la largeur de l'impulsion pour une
 * extension ; jusqu'au bord droit s'il est prolongé) ; ses niveaux, du
 * premier ratio au dernier.
 */
export function fibGeometry(d: FibShape, f: Frame) {
  const at = (p: { t: number; price: number }) => ({ x: f.x(f.pos(p.t)), y: f.y(p.price) });
  const points: Array<["a" | "b" | "c", { x: number; y: number }]> = [
    ["a", at(d.a)],
    ["b", at(d.b)],
  ];
  let left: number;
  let right: number;
  if (d.kind === "fib") {
    left = Math.min(points[0][1].x, points[1][1].x);
    right = Math.max(points[0][1].x, points[1][1].x);
  } else {
    const c = at(d.c);
    points.push(["c", c]);
    const span = Math.abs(f.pos(d.b.t) - f.pos(d.a.t));
    left = c.x;
    right = f.x(f.pos(d.c.t) + span);
  }
  if (d.extend) right = Math.max(right, f.width);
  return { points, left, right, levels: fibLevels(d).map((l) => ({ ...l, y: f.y(l.price) })) };
}

/** Le niveau d'un Fibonacci le plus près de la hauteur `py` (celui d'un clic droit, d'une alerte). */
export function fibLevelAt(d: FibShape, f: Pick<Frame, "y">, py: number): { ratio: number; price: number } {
  return nearestLevel(fibLevels(d), (l) => Math.abs(f.y(l.price) - py));
}

/** Le niveau d'un Fibonacci le plus près de ce prix (Alt+A : celui du pointeur). */
export function fibLevelNear(d: FibShape, price: number): { ratio: number; price: number } {
  return nearestLevel(fibLevels(d), (l) => Math.abs(l.price - price));
}

function nearestLevel<T>(levels: T[], distance: (l: T) => number): T {
  return levels.reduce((best, l) => (distance(l) < distance(best) ? l : best));
}

function distanceToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  return Math.hypot(px - (a.x + k * dx), py - (a.y + k * dy));
}

/**
 * La forme d'un tracé posé à la souris : un clic pour une ligne, deux pour
 * une oblique (prolongée vers la droite, sauf verticale), une zone ou un
 * retracement de Fibonacci, trois pour une extension (`p3`, d'où les niveaux
 * sont projetés). Les points tombent sur des bougies ; undefined pour un
 * tracé sans étendue (deux fois le même point, une zone sans largeur ou sans
 * hauteur, un Fibonacci sans mouvement).
 */
export function shapeFrom(
  tool: DrawTool,
  p1: ChartPoint,
  p2: ChartPoint | undefined,
  time: (pos: number) => number,
  p3?: ChartPoint,
): DrawingShape | undefined {
  if (tool === "hline") return { kind: "hline", price: p1.price };
  // Une boîte de trade se pose d'un clic, avec ses écarts par défaut (positionFrom).
  if (!p2 || positionTool(tool)) return undefined;
  const [i1, i2] = [Math.round(p1.pos), Math.round(p2.pos)];
  if (tool === "trendline") {
    if (i1 === i2 && p1.price === p2.price) return undefined;
    return { kind: "trendline", a: { t: time(i1), price: p1.price }, b: { t: time(i2), price: p2.price }, extend: i1 !== i2 };
  }
  if (tool === "fib" || tool === "fibext") {
    if (!isMove(p1, p2)) return undefined;
    const [a, b] = [
      { t: time(i1), price: p1.price },
      { t: time(i2), price: p2.price },
    ];
    if (tool === "fib") return { kind: "fib", a, b, extend: false };
    return p3 ? { kind: "fibext", a, b, c: { t: time(Math.round(p3.pos)), price: p3.price }, extend: false } : undefined;
  }
  if (i1 === i2 || p1.price === p2.price) return undefined;
  return {
    kind: "zone",
    top: Math.max(p1.price, p2.price),
    bottom: Math.min(p1.price, p2.price),
    from: time(Math.min(i1, i2)),
    to: time(Math.max(i1, i2)),
  };
}

/** Un mouvement que mesure un Fibonacci : deux bougies et deux prix différents. */
export function isMove(p1: ChartPoint, p2: ChartPoint): boolean {
  return Math.round(p1.pos) !== Math.round(p2.pos) && p1.price !== p2.price;
}

/**
 * Le tracé en pointillés pendant qu'on le pose : `placed`, les points déjà
 * posés, et le pointeur en `p`. Une extension n'a d'abord que son impulsion
 * (une oblique), puis ses niveaux suivent le troisième point.
 */
export function ghostShape(tool: DrawTool, placed: readonly ChartPoint[], p: ChartPoint, time: (pos: number) => number): DrawingShape | undefined {
  if (!placed.length) return undefined;
  if (tool === "fibext" && placed.length === 1) {
    const s = shapeFrom("trendline", placed[0], p, time);
    return s?.kind === "trendline" ? { ...s, extend: false } : undefined;
  }
  if (tool === "fibext") return shapeFrom(tool, placed[0], placed[1], time, p);
  return shapeFrom(tool, placed[0], p, time);
}

/**
 * La forme d'un tracé saisi en `start` et amené en `now` : un point ou un bord
 * suit le pointeur ; le corps se déplace d'autant de bougies et de prix. Les
 * instants restent ceux de bougies.
 */
export function dragShape(shape: DrawingShape, part: Part, start: ChartPoint, now: ChartPoint, f: Pick<Frame, "pos" | "time">, tick = 0): DrawingShape {
  const dPrice = now.price - start.price;
  const dPos = Math.round(now.pos) - Math.round(start.pos);
  const shift = (t: number) => f.time(Math.round(f.pos(t)) + dPos);
  const moved = (p: { t: number; price: number }) => ({ t: shift(p.t), price: p.price + dPrice });
  if (shape.kind === "hline") return { ...shape, price: shape.price + dPrice };
  if (shape.kind === "position") return dragPosition(shape, part, now, dPrice, shift, f, tick);
  if (shape.kind === "trendline" || shape.kind === "fib" || shape.kind === "fibext") {
    const here = { t: f.time(Math.round(now.pos)), price: now.price };
    if (part === "a") return { ...shape, a: here };
    if (part === "b") return { ...shape, b: here };
    if (part === "c" && shape.kind === "fibext") return { ...shape, c: here };
    if (shape.kind === "fibext") return { ...shape, a: moved(shape.a), b: moved(shape.b), c: moved(shape.c) };
    return { ...shape, a: moved(shape.a), b: moved(shape.b) };
  }
  if (part === "top" || part === "bottom") {
    const other = part === "top" ? shape.bottom : shape.top;
    return { ...shape, top: Math.max(other, now.price), bottom: Math.min(other, now.price) };
  }
  if (part === "from" || part === "to") return { ...shape, [part]: f.time(Math.round(now.pos)) };
  return {
    ...shape,
    top: shape.top + dPrice,
    bottom: shape.bottom + dPrice,
    ...(shape.from !== undefined ? { from: shift(shape.from) } : {}),
    ...(shape.to !== undefined ? { to: shift(shape.to) } : {}),
  };
}

/**
 * Une boîte de trade qu'on règle : l'objectif et le stop suivent le pointeur
 * sans passer l'entrée (un écart d'un `tick` au moins) ; l'entrée suit le
 * pointeur entre les deux, et sa bougie devient le début de la boîte ; le bord
 * droit suit le pointeur (une bougie après le début au moins) ; le corps
 * déplace tout. Rien ne change de sens : un achat reste un achat. Les prix
 * restent aux décimales du produit (celles du `tick`).
 */
function dragPosition(
  p: PositionShape,
  part: Part,
  now: ChartPoint,
  dPrice: number,
  shift: (t: number) => number,
  f: Pick<Frame, "pos" | "time">,
  tick: number,
): PositionShape {
  const gap = tick > 0 ? tick : Math.abs(p.entry) * 1e-6 || 1e-9;
  // 4 013,91 et non 4 013,9100000000003, après une addition.
  const digits = tick > 0 ? Math.max(0, Math.round(-Math.log10(tick))) : undefined;
  const round = (v: number) => (digits === undefined ? v : Number(v.toFixed(digits)));
  const up = p.side === "long" ? 1 : -1;
  // Au-delà de l'entrée du côté du gain (dir 1) ou du risque (dir −1), d'un écart au moins.
  const beyond = (v: number, dir: 1 | -1) => round(dir * up > 0 ? Math.max(v, p.entry + gap) : Math.min(v, p.entry - gap));
  const i = Math.round(now.pos);
  const fromPos = Math.round(f.pos(p.from));
  if (part === "target") return { ...p, target: beyond(now.price, 1) };
  if (part === "stop") return { ...p, stop: beyond(now.price, -1) };
  if (part === "entry") {
    const [lo, hi] = p.side === "long" ? [p.stop + gap, p.target - gap] : [p.target + gap, p.stop - gap];
    const last = p.to !== undefined ? Math.round(f.pos(p.to)) - 1 : Infinity;
    return { ...p, entry: round(Math.min(hi, Math.max(lo, now.price))), from: f.time(Math.min(i, last)) };
  }
  if (part === "to") return { ...p, to: f.time(Math.max(i, fromPos + 1)) };
  return {
    ...p,
    entry: round(p.entry + dPrice),
    stop: round(p.stop + dPrice),
    target: round(p.target + dPrice),
    from: shift(p.from),
    ...(p.to !== undefined ? { to: shift(p.to) } : {}),
  };
}

/** Direction d'une oblique tracée avec Maj : horizontale, verticale, ou à 45°. */
export type Direction = "h" | "v" | "d";

/**
 * Maj maintenu, comme sur TradingView : la direction du point `a` vers le
 * pointeur `b` (en pixels) est ramenée au multiple de 45° le plus proche
 * (horizontale, verticale ou diagonale), et le pointeur projeté sur elle.
 */
export function constrainAngle(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; dir: Direction } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const k = Math.round(angle / step);
  const snapped = k * step;
  const len = Math.hypot(dx, dy) * Math.cos(angle - snapped);
  const dir: Direction = k % 2 !== 0 ? "d" : k % 4 === 0 ? "h" : "v";
  // Arrondis : une horizontale reste exactement à la hauteur de `a`, une verticale à son abscisse.
  return {
    x: dir === "v" ? a.x : a.x + len * Math.cos(snapped),
    y: dir === "h" ? a.y : a.y + len * Math.sin(snapped),
    dir,
  };
}

/** La forme d'un tracé, sans ce qui n'en fait pas partie (identifiant, nom, dates de création). */
export function shapeOf(d: Drawing): DrawingShape {
  if (d.kind === "hline") return { kind: "hline", price: d.price };
  if (d.kind === "trendline") return { kind: "trendline", a: d.a, b: d.b, extend: d.extend };
  if (d.kind === "fib") return { kind: "fib", a: d.a, b: d.b, extend: d.extend };
  if (d.kind === "fibext") return { kind: "fibext", a: d.a, b: d.b, c: d.c, extend: d.extend };
  if (d.kind === "position")
    return {
      kind: "position",
      side: d.side,
      entry: d.entry,
      stop: d.stop,
      target: d.target,
      from: d.from,
      ...(d.to !== undefined ? { to: d.to } : {}),
      ...(d.risk ? { risk: d.risk } : {}),
    };
  return { kind: "zone", top: d.top, bottom: d.bottom, ...(d.from !== undefined ? { from: d.from } : {}), ...(d.to !== undefined ? { to: d.to } : {}) };
}

/**
 * Aimant, comme sur TradingView : `off`, le prix sous le pointeur (arrondi aux
 * décimales du produit) ; `weak`, il prend l'ouverture, le plus haut, le plus
 * bas ou la clôture de la bougie visée quand il en est à moins de `tol`
 * pixels ; `strong`, toujours la plus proche des quatre.
 */
export type Magnet = "off" | "weak" | "strong";

/** L'aimant en vigueur : Cmd (Mac) ou Ctrl maintenu l'inverse le temps du tracé (désactivé -> fort, sinon désactivé). */
export function effectiveMagnet(mode: Magnet, modifier: boolean): Magnet {
  if (!modifier) return mode;
  return mode === "off" ? "strong" : "off";
}

export function snapPrice(price: number, candle: Candle | undefined, y: (p: number) => number, digits: number, mode: Magnet = "weak", tol = 8): number {
  if (candle && mode !== "off") {
    let best: number | undefined;
    let bestPx = mode === "strong" ? Infinity : tol;
    for (const v of [candle.o, candle.h, candle.l, candle.c]) {
      const px = Math.abs(y(v) - y(price));
      if (px <= bestPx) {
        best = v;
        bestPx = px;
      }
    }
    if (best !== undefined) return best;
  }
  return Number(price.toFixed(digits));
}
