// Les tracés à la souris, sans écran : saisie (quel tracé, quelle partie),
// forme d'un tracé posé, déplacement, aimant sur les prix d'une bougie.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DrawingShape } from "@kopilia/contracts";
import {
  constrainAngle,
  dragShape,
  effectiveMagnet,
  fibGeometry,
  fibLevelAt,
  fibLevelNear,
  ghostShape,
  hitTest,
  isKeyFibLevel,
  niceDistance,
  pointsNeeded,
  positionFrom,
  positionTool,
  shapeFrom,
  shapeOf,
  snapPrice,
  trendlineSegment,
  type Frame,
} from "../src/app/dashboard/chart-tools";

/** Bougies d'une heure ; 10 px par bougie, 1 px par unité de prix (prix 0 à 200 de bas en haut, 200 px). */
const H = 3600;
const frame: Frame = {
  x: (pos) => pos * 10,
  y: (price) => 200 - price,
  width: 300,
  pos: (t) => t / H,
  time: (pos) => pos * H,
};

test("saisie : ligne horizontale à quelques pixels près, rien ailleurs", () => {
  const line = { id: "d1", kind: "hline", price: 100 } as const;
  assert.deepEqual(hitTest([line], frame, 50, 103), { id: "d1", part: "body" });
  assert.equal(hitTest([line], frame, 50, 110), undefined);
  assert.equal(hitTest([line], frame, 350, 100), undefined, "hors du volet des prix (sur l'axe)");
});

test("saisie : oblique par ses points ou son tracé, prolongée jusqu'au bord", () => {
  const trend = { id: "d2", kind: "trendline", a: { t: 0, price: 100 }, b: { t: 10 * H, price: 150 }, extend: true } as const;
  assert.deepEqual(hitTest([trend], frame, 1, 101), { id: "d2", part: "a" });
  assert.deepEqual(hitTest([trend], frame, 100, 50), { id: "d2", part: "b" });
  assert.deepEqual(hitTest([trend], frame, 50, 75), { id: "d2", part: "body" });
  assert.deepEqual(hitTest([trend], frame, 200, 0), { id: "d2", part: "body" }, "au-delà du second point : prolongée");
  assert.equal(hitTest([{ ...trend, extend: false }], frame, 200, 0), undefined);
  const [l, r] = trendlineSegment({ x: 100, y: 50 }, { x: 0, y: 100 }, true, 300);
  assert.deepEqual(
    [l, r],
    [
      { x: 0, y: 100 },
      { x: 300, y: -50 },
    ],
  );
});

test("saisie : zone par ses bords ou son corps ; un bord ouvert ne se saisit pas", () => {
  const zone = { id: "d3", kind: "zone", top: 120, bottom: 100, from: 5 * H, to: 15 * H } as const;
  assert.deepEqual(hitTest([zone], frame, 100, 80), { id: "d3", part: "top" });
  assert.deepEqual(hitTest([zone], frame, 100, 100), { id: "d3", part: "bottom" });
  assert.deepEqual(hitTest([zone], frame, 50, 90), { id: "d3", part: "from" });
  assert.deepEqual(hitTest([zone], frame, 150, 90), { id: "d3", part: "to" });
  assert.deepEqual(hitTest([zone], frame, 100, 90), { id: "d3", part: "body" });
  const open = { id: "d4", kind: "zone", top: 120, bottom: 100 } as const;
  assert.deepEqual(hitTest([open], frame, 2, 90), { id: "d4", part: "body" }, "sans début : du bord gauche, sans poignée");
  assert.deepEqual(hitTest([zone, open], frame, 100, 90), { id: "d4", part: "body" }, "le plus récent, dessiné par-dessus, d'abord");
});

test("tracé posé : un clic pour une ligne, deux pour une oblique ou une zone, sur des bougies", () => {
  const time = (pos: number) => pos * H;
  assert.deepEqual(shapeFrom("hline", { pos: 3.4, price: 101 }, undefined, time), { kind: "hline", price: 101 });
  assert.equal(shapeFrom("trendline", { pos: 3, price: 1 }, undefined, time), undefined, "il manque le second point");
  assert.deepEqual(shapeFrom("trendline", { pos: 3.4, price: 100 }, { pos: 7.6, price: 110 }, time), {
    kind: "trendline",
    a: { t: 3 * H, price: 100 },
    b: { t: 8 * H, price: 110 },
    extend: true,
  });
  assert.deepEqual(
    shapeFrom("trendline", { pos: 3.1, price: 1 }, { pos: 2.9, price: 2 }, time),
    { kind: "trendline", a: { t: 3 * H, price: 1 }, b: { t: 3 * H, price: 2 }, extend: false },
    "même bougie : une verticale, jamais prolongée",
  );
  assert.equal(shapeFrom("trendline", { pos: 3.1, price: 1 }, { pos: 2.9, price: 1 }, time), undefined, "deux fois le même point");
  assert.deepEqual(shapeFrom("zone", { pos: 9, price: 100 }, { pos: 4, price: 120 }, time), {
    kind: "zone",
    top: 120,
    bottom: 100,
    from: 4 * H,
    to: 9 * H,
  });
});

test("déplacement : un point suit le pointeur, le corps glisse d'autant de bougies et de prix", () => {
  const trend: DrawingShape = { kind: "trendline", a: { t: 0, price: 100 }, b: { t: 10 * H, price: 150 }, extend: false };
  const start = { pos: 5, price: 125 };
  assert.deepEqual(dragShape(trend, "b", start, { pos: 12.2, price: 160 }, frame), { ...trend, b: { t: 12 * H, price: 160 } });
  assert.deepEqual(dragShape(trend, "body", start, { pos: 7, price: 130 }, frame), {
    ...trend,
    a: { t: 2 * H, price: 105 },
    b: { t: 12 * H, price: 155 },
  });
  const zone: DrawingShape = { kind: "zone", top: 120, bottom: 100, from: 5 * H };
  assert.deepEqual(dragShape(zone, "top", start, { pos: 0, price: 90 }, frame), { ...zone, top: 100, bottom: 90 }, "le haut passé sous le bas : rangée");
  assert.deepEqual(dragShape(zone, "body", start, { pos: 6, price: 130 }, frame), { kind: "zone", top: 125, bottom: 105, from: 6 * H });
  assert.deepEqual(dragShape({ kind: "hline", price: 100 }, "body", start, { pos: 9, price: 127.5 }, frame), { kind: "hline", price: 102.5 });
});

test("Fibonacci : niveaux d'un point à l'autre pour un retracement, depuis c sur la largeur de l'impulsion pour une extension", () => {
  const fib = { kind: "fib", a: { t: 12 * H, price: 150 }, b: { t: 2 * H, price: 50 }, extend: false } as const;
  const g = fibGeometry(fib, frame);
  assert.deepEqual([g.left, g.right], [20, 120], "tracé de droite à gauche : de son point le plus à gauche à l'autre");
  assert.deepEqual(
    g.levels.map((l) => [l.ratio, Number(l.y.toFixed(1))]),
    [
      [0, 150],
      [0.236, 126.4],
      [0.382, 111.8],
      [0.5, 100],
      [0.618, 88.2],
      [0.786, 71.4],
      [1, 50],
    ],
  );
  assert.equal(fibGeometry({ ...fib, extend: true }, frame).right, 300, "prolongé : jusqu'au bord droit");
  const ext = { kind: "fibext", a: { t: 0, price: 100 }, b: { t: 10 * H, price: 150 }, c: { t: 15 * H, price: 125 }, extend: false } as const;
  const e = fibGeometry(ext, frame);
  assert.deepEqual([e.left, e.right], [150, 250]);
  assert.deepEqual(
    e.points.map(([part, p]) => [part, p.x, p.y]),
    [
      ["a", 0, 100],
      ["b", 100, 50],
      ["c", 150, 75],
    ],
  );
});

test("Fibonacci : le niveau visé par un clic droit (le plus proche en hauteur), ou le plus proche d'un prix", () => {
  const fib = { kind: "fib", a: { t: 2 * H, price: 50 }, b: { t: 12 * H, price: 150 }, extend: false } as const;
  // Niveaux à l'écran : 0 à y 50, 0,5 à y 100, 0,618 à y 111,8.
  assert.equal(fibLevelAt(fib, frame, 104).ratio, 0.5);
  assert.equal(fibLevelAt(fib, frame, 108).ratio, 0.618);
  assert.equal(fibLevelAt(fib, frame, 0).ratio, 0, "au-dessus de tout : le plus haut");
  assert.deepEqual(fibLevelNear(fib, 130), { ratio: 0.236, price: 126.4 });
});

test("Fibonacci : les niveaux clés, tracés plus francs que les autres", () => {
  assert.deepEqual(
    [0, 0.236, 0.5, 0.618, 0.786, 1].map((r) => isKeyFibLevel("fib", r)),
    [true, false, true, true, false, true],
  );
  assert.deepEqual(
    [0, 0.618, 1, 1.618, 2.618].map((r) => isKeyFibLevel("fibext", r)),
    [true, false, true, true, false],
  );
});

test("saisie : Fibonacci par ses points, ses niveaux ou le mouvement en pointillés ; pas par son fond", () => {
  const fib = { id: "f1", kind: "fib", a: { t: 2 * H, price: 50 }, b: { t: 12 * H, price: 150 }, extend: false } as const;
  assert.deepEqual(hitTest([fib], frame, 21, 149), { id: "f1", part: "a" });
  assert.deepEqual(hitTest([fib], frame, 120, 52), { id: "f1", part: "b" });
  assert.deepEqual(hitTest([fib], frame, 100, 102), { id: "f1", part: "body" }, "sur le niveau 0,5");
  assert.deepEqual(hitTest([fib], frame, 30, 140), { id: "f1", part: "body" }, "sur le mouvement, entre deux niveaux");
  assert.equal(hitTest([fib], frame, 40, 80.5), undefined, "dans le fond teinté : le graphique y défile");
  assert.equal(hitTest([fib], frame, 200, 100), undefined, "après son second point");
  assert.deepEqual(hitTest([{ ...fib, extend: true }], frame, 200, 100), { id: "f1", part: "body" }, "prolongé vers la droite");
  const ext = { id: "f2", kind: "fibext", a: { t: 0, price: 100 }, b: { t: 10 * H, price: 150 }, c: { t: 15 * H, price: 125 }, extend: false } as const;
  assert.deepEqual(hitTest([ext], frame, 151, 76), { id: "f2", part: "c" });
  assert.deepEqual(hitTest([ext], frame, 200, 25), { id: "f2", part: "body" }, "sur le niveau 1, projeté depuis c");
  assert.deepEqual(hitTest([ext], frame, 125, 62.5), { id: "f2", part: "body" }, "sur le repli de b à c");
  assert.equal(hitTest([ext], frame, 270, 25), undefined, "au-delà de la largeur de l'impulsion");
});

test("Fibonacci posé : deux points pour un retracement, trois pour une extension ; un mouvement, pas un point", () => {
  const time = (pos: number) => pos * H;
  assert.deepEqual([pointsNeeded("hline"), pointsNeeded("zone"), pointsNeeded("fib"), pointsNeeded("fibext")], [1, 2, 2, 3]);
  const low = { pos: 2.4, price: 50 };
  const high = { pos: 11.6, price: 150 };
  assert.deepEqual(shapeFrom("fib", low, high, time), { kind: "fib", a: { t: 2 * H, price: 50 }, b: { t: 12 * H, price: 150 }, extend: false });
  assert.equal(shapeFrom("fib", low, { pos: 2.2, price: 150 }, time), undefined, "même bougie");
  assert.equal(shapeFrom("fib", low, { pos: 9, price: 50 }, time), undefined, "même prix");
  assert.equal(shapeFrom("fibext", low, high, time), undefined, "il manque le troisième point");
  assert.deepEqual(shapeFrom("fibext", low, high, time, { pos: 15.2, price: 100 }), {
    kind: "fibext",
    a: { t: 2 * H, price: 50 },
    b: { t: 12 * H, price: 150 },
    c: { t: 15 * H, price: 100 },
    extend: false,
  });
  // En pointillés pendant qu'on le pose : l'impulsion seule, puis l'extension qui suit le pointeur.
  assert.deepEqual(ghostShape("fibext", [low], high, time), { kind: "trendline", a: { t: 2 * H, price: 50 }, b: { t: 12 * H, price: 150 }, extend: false });
  assert.equal(ghostShape("fibext", [low, high], { pos: 14, price: 120 }, time)?.kind, "fibext");
  assert.equal(ghostShape("fib", [low], high, time)?.kind, "fib");
  assert.equal(ghostShape("fib", [], high, time), undefined);
});

test("déplacement d'un Fibonacci : chaque point suit le pointeur, le corps glisse en entier", () => {
  const ext: DrawingShape = { kind: "fibext", a: { t: 0, price: 100 }, b: { t: 10 * H, price: 150 }, c: { t: 15 * H, price: 125 }, extend: false };
  const start = { pos: 20, price: 175 };
  assert.deepEqual(dragShape(ext, "c", start, { pos: 17.4, price: 130 }, frame), { ...ext, c: { t: 17 * H, price: 130 } });
  assert.deepEqual(dragShape(ext, "a", start, { pos: 1, price: 90 }, frame), { ...ext, a: { t: H, price: 90 } });
  assert.deepEqual(dragShape(ext, "body", start, { pos: 22, price: 170 }, frame), {
    ...ext,
    a: { t: 2 * H, price: 95 },
    b: { t: 12 * H, price: 145 },
    c: { t: 17 * H, price: 120 },
  });
  const fib: DrawingShape = { kind: "fib", a: { t: 0, price: 100 }, b: { t: 10 * H, price: 150 }, extend: true };
  assert.deepEqual(dragShape(fib, "b", start, { pos: 11, price: 160 }, frame), { ...fib, b: { t: 11 * H, price: 160 } });
  assert.deepEqual(
    dragShape(fib, "c", start, { pos: 11, price: 160 }, frame),
    { ...fib, a: { t: -9 * H, price: 85 }, b: { t: H, price: 135 } },
    "un retracement n'a pas de c : le corps",
  );
});

test("boîte de trade posée d'un clic : l'entrée au point cliqué, le stop à un écart rond, l'objectif à 2 R, sur environ 160 px", () => {
  assert.deepEqual([pointsNeeded("long"), pointsNeeded("short")], [1, 1]);
  assert.deepEqual([positionTool("long"), positionTool("short"), positionTool("fib"), positionTool(null)], ["long", "short", undefined, undefined]);
  assert.equal(
    shapeFrom("long", { pos: 3, price: 100 }, { pos: 8, price: 120 }, (pos) => pos * H),
    undefined,
    "pas en deux clics",
  );
  assert.deepEqual([niceDistance(40), niceDistance(23), niceDistance(0.0012), niceDistance(0)], [50, 25, 0.001, 0]);
  // 1 px par unité de prix : 40 px font 40, arrondis à 50 ; 10 px par bougie : 16 bougies de large.
  assert.deepEqual(positionFrom("long", { pos: 10.3, price: 100 }, frame, 2), {
    kind: "position",
    side: "long",
    entry: 100,
    stop: 50,
    target: 200,
    from: 10 * H,
    to: 26 * H,
  });
  const short = positionFrom("short", { pos: 10, price: 100 }, { ...frame, y: (p) => 2000 - p * 10, x: (pos) => pos * 40 }, 2);
  assert.deepEqual(
    { stop: short.stop, target: short.target, to: short.to },
    { stop: 105, target: 90, to: 15 * H },
    "10 px par unité : 4 arrondis à 5 ; des bougies larges : 5 au moins",
  );
});

test("boîte de trade : saisie par ses poignées, son objectif, son stop ou son corps", () => {
  // Achat : entrée 100 (y 100), stop 80 (y 120), objectif 140 (y 60), de la bougie 5 (x 50) à la 15 (x 150).
  const box = { id: "p1", kind: "position", side: "long", entry: 100, stop: 80, target: 140, from: 5 * H, to: 15 * H } as const;
  assert.deepEqual(hitTest([box], frame, 50, 60), { id: "p1", part: "target" });
  assert.deepEqual(hitTest([box], frame, 51, 121), { id: "p1", part: "stop" });
  assert.deepEqual(hitTest([box], frame, 49, 100), { id: "p1", part: "entry" });
  assert.deepEqual(hitTest([box], frame, 150, 100), { id: "p1", part: "to" });
  assert.deepEqual(hitTest([box], frame, 100, 61), { id: "p1", part: "target" }, "sur la ligne de l'objectif");
  assert.deepEqual(hitTest([box], frame, 100, 119), { id: "p1", part: "stop" }, "sur la ligne du stop");
  assert.deepEqual(hitTest([box], frame, 100, 90), { id: "p1", part: "body" });
  assert.equal(hitTest([box], frame, 200, 90), undefined, "après sa fin");
  assert.equal(hitTest([box], frame, 100, 135), undefined, "sous le stop");
  assert.deepEqual(hitTest([{ ...box, to: undefined }], frame, 250, 90), { id: "p1", part: "body" }, "sans fin : jusqu'au bord droit");
  // Tracée à la voix, elle part de maintenant : sans fin, elle se lit quand même sur 160 px.
  const now = { ...box, from: 29 * H, to: undefined };
  assert.deepEqual(hitTest([now], frame, 140, 60), { id: "p1", part: "target" }, "sa poignée, 160 px avant le bord droit");
  assert.deepEqual(hitTest([now], frame, 200, 90), { id: "p1", part: "body" });
});

test("boîte de trade réglée : l'objectif et le stop ne passent pas l'entrée, l'entrée reste entre eux, le corps glisse en entier", () => {
  const box: DrawingShape = { kind: "position", side: "long", entry: 100, stop: 80, target: 140, from: 5 * H, to: 15 * H };
  const start = { pos: 10, price: 100 };
  const tick = 10 ** -2;
  const drag = (part: Parameters<typeof dragShape>[1], now: { pos: number; price: number }, shape = box) => dragShape(shape, part, start, now, frame, tick);
  assert.deepEqual(drag("target", { pos: 3, price: 130 }), { ...box, target: 130 });
  assert.deepEqual(drag("target", { pos: 3, price: 90 }), { ...box, target: 100.01 }, "pas sous l'entrée d'un achat");
  assert.deepEqual(drag("stop", { pos: 3, price: 70 }), { ...box, stop: 70 });
  assert.deepEqual(drag("stop", { pos: 3, price: 110 }), { ...box, stop: 99.99 }, "pas au-dessus de l'entrée d'un achat");
  assert.deepEqual(drag("entry", { pos: 7.4, price: 120 }), { ...box, entry: 120, from: 7 * H }, "l'entrée et sa bougie");
  assert.deepEqual(drag("entry", { pos: 20, price: 150 }), { ...box, entry: 139.99, from: 14 * H }, "entre le stop et l'objectif, avant la fin");
  assert.deepEqual(drag("to", { pos: 18.4, price: 0 }), { ...box, to: 18 * H });
  assert.deepEqual(drag("to", { pos: 2, price: 0 }), { ...box, to: 6 * H }, "une bougie après le début au moins");
  assert.deepEqual(drag("body", { pos: 12, price: 110 }), { ...box, entry: 110, stop: 90, target: 150, from: 7 * H, to: 17 * H });
  assert.deepEqual(
    drag("body", { pos: 10, price: 100.07 }, { ...box, entry: 4013.84, stop: 3977.69, target: 4087.23 }),
    { ...box, entry: 4013.91, stop: 3977.76, target: 4087.3 },
    "aux décimales du produit, sans reste d'addition",
  );
  const short: DrawingShape = { kind: "position", side: "short", entry: 100, stop: 120, target: 60, from: 5 * H };
  assert.deepEqual(drag("target", { pos: 3, price: 110 }, short), { ...short, target: 99.99 }, "pas au-dessus de l'entrée d'une vente");
  assert.deepEqual(drag("stop", { pos: 3, price: 90 }, short), { ...short, stop: 100.01 }, "pas sous l'entrée d'une vente");
  assert.deepEqual(drag("entry", { pos: 30, price: 50 }, short), { ...short, entry: 60.01, from: 30 * H }, "sans fin : l'entrée va où l'on veut");
});

test("forme d'un tracé gardé : sans identifiant, nom ni dates", () => {
  const d = { id: "d1", symbol: "XAUUSD", kind: "zone", top: 2, bottom: 1, label: "R", createdBy: "user", createdAt: 1, updatedAt: 1 } as const;
  assert.deepEqual(shapeOf(d), { kind: "zone", top: 2, bottom: 1 });
  const meta = { id: "d2", symbol: "XAUUSD", label: "impulsion", createdBy: "kopilia", createdAt: 1, updatedAt: 2 } as const;
  const a = { t: 0, price: 1 };
  const b = { t: 3600, price: 2 };
  const c = { t: 7200, price: 1.5 };
  assert.deepEqual(shapeOf({ ...meta, kind: "fib", a, b, extend: true }), { kind: "fib", a, b, extend: true });
  assert.deepEqual(shapeOf({ ...meta, kind: "fibext", a, b, c, extend: false }), { kind: "fibext", a, b, c, extend: false });
  const box = { kind: "position", side: "short", entry: 2, stop: 2.5, target: 1, from: 0 } as const;
  assert.deepEqual(shapeOf({ ...meta, ...box }), box, "une boîte sans fin n'en gagne pas");
});

test("aimant : un prix proche de l'ouverture, du plus haut, du plus bas ou de la clôture la prend ; sinon arrondi", () => {
  const candle = { t: 0, o: 100, h: 110, l: 95, c: 104 };
  const y = (p: number) => 600 - p * 4; // 4 px par unité
  assert.equal(snapPrice(108.5, candle, y, 2), 110, "6 px du plus haut");
  assert.equal(snapPrice(107.123, candle, y, 2), 107.12, "trop loin de tout : arrondi aux décimales");
  assert.equal(snapPrice(96.9, undefined, y, 1), 96.9, "sans bougie visée");
});

test("aimant fort : toujours le prix le plus proche de la bougie ; désactivé : le prix sous le pointeur", () => {
  const candle = { t: 0, o: 100, h: 110, l: 95, c: 104 };
  const y = (p: number) => 600 - p * 4;
  assert.equal(snapPrice(107.123, candle, y, 2, "strong"), 110, "loin de tout, mais le plus haut est le plus proche");
  assert.equal(snapPrice(96.4, candle, y, 2, "strong"), 95);
  assert.equal(snapPrice(108.5, candle, y, 2, "off"), 108.5, "désactivé : même tout près du plus haut");
  assert.equal(snapPrice(108.5, undefined, y, 2, "strong"), 108.5, "sans bougie visée : arrondi");
});

test("Cmd ou Ctrl maintenu inverse l'aimant le temps du tracé", () => {
  assert.equal(effectiveMagnet("weak", false), "weak");
  assert.equal(effectiveMagnet("weak", true), "off");
  assert.equal(effectiveMagnet("strong", true), "off");
  assert.equal(effectiveMagnet("off", true), "strong");
});

test("Maj : l'oblique ramenée à l'horizontale, à la verticale ou à 45°, selon le pointeur", () => {
  const a = { x: 100, y: 100 };
  const h = constrainAngle(a, { x: 200, y: 112 });
  assert.equal(h.dir, "h");
  assert.equal(h.y, 100, "exactement à la hauteur du premier point");
  assert.equal(h.x, 200, "projeté sur l'horizontale : l'écart en largeur reste");
  const v = constrainAngle(a, { x: 92, y: 20 });
  assert.equal(v.dir, "v");
  assert.equal(v.x, 100, "exactement sur la bougie du premier point");
  assert.equal(v.y, 20);
  const d = constrainAngle(a, { x: 170, y: 40 });
  assert.equal(d.dir, "d");
  assert.ok(Math.abs(d.x - 100 - (100 - d.y)) < 1e-9, "45° : autant en largeur qu'en hauteur (vers le haut à droite)");
  const back = constrainAngle(a, { x: 40, y: 165 });
  assert.equal(back.dir, "d");
  assert.ok(Math.abs(100 - back.x - (back.y - 100)) < 1e-9, "vers le bas à gauche aussi");
  assert.equal(constrainAngle(a, { x: 10, y: 95 }).dir, "h", "vers la gauche aussi");
});
