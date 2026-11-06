// Calculs de l'analyse technique, partagés par l'écran et le serveur : valeurs
// de référence calculées à la main (moyennes) et sur la série classique de
// Wilder (RSI), positions des tracés en temps de marché.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barPosition,
  barTime,
  completeIndicator,
  drawingShapeSchema,
  ema,
  fibLevelPrice,
  fibLevels,
  fibRatioLabel,
  fibRatios,
  hma,
  indicatorLabel,
  indicatorSeries,
  movingAverage,
  positionDistances,
  positionProblem,
  positionRatio,
  positionSideOf,
  ratioLabel,
  rsi,
  sameIndicator,
  sma,
  smma,
  sourceValues,
  trendlinePrice,
  upgradeIndicator,
  wma,
} from "../src/technical.js";
import { alertTargetSchema, defaultCondition } from "../src/alerts.js";

const round = (xs: number[], d = 2) => xs.map((x) => (Number.isNaN(x) ? NaN : Number(x.toFixed(d))));

test("moyenne simple : NaN tant qu'il manque des valeurs, puis la moyenne glissante", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  assert.deepEqual(sma([1, 2], 3), [NaN, NaN]);
});

test("moyenne exponentielle : amorcée sur la moyenne simple, puis lissée à 2 / (n + 1)", () => {
  // k = 0,5 : 2 (moyenne de 1, 2, 3), puis 2 × 0,5 + 4 × 0,5 = 3, puis 3 × 0,5 + 11 × 0,5 = 7.
  assert.deepEqual(ema([1, 2, 3, 4, 11], 3), [NaN, NaN, 2, 3, 7]);
});

test("RSI de Wilder : l'exemple de référence de StockCharts (14 bougies)", () => {
  // Exemple de StockCharts (méthode de Wilder, 1978) : 70,53 puis 66,32.
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028];
  const r = round(rsi(closes, 14));
  assert.ok(r.slice(0, 14).every(Number.isNaN));
  assert.equal(r[14], 70.53);
  assert.equal(r[15], 66.32);
});

test("RSI : 100 sans aucune baisse, 50 sans aucun mouvement", () => {
  assert.equal(rsi([1, 2, 3, 4], 3)[3], 100);
  assert.equal(rsi([5, 5, 5, 5], 3)[3], 50);
});

test("moyenne pondérée, lissée (Wilder) et de Hull", () => {
  // Pondérée : (3 × 3 + 2 × 2 + 1) / 6, puis (4 × 3 + 3 × 2 + 2) / 6.
  assert.deepEqual(round(wma([1, 2, 3, 4], 3), 3), [NaN, NaN, 2.333, 3.333]);
  // Lissée : 2, puis (4 + 2 × 2) / 3, puis (5 + 2,667 × 2) / 3.
  assert.deepEqual(round(smma([1, 2, 3, 4, 5], 3), 3), [NaN, NaN, 2, 2.667, 3.444]);
  // Hull : sans retard sur une droite.
  const line = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(hma(line, 4)[9], 9);
  assert.ok(Number.isNaN(hma(line, 4)[3]), "il faut n + √n − 1 bougies");
});

test("moyenne d'une série qui commence par des NaN (la moyenne du RSI)", () => {
  assert.deepEqual(movingAverage("sma", [NaN, NaN, 1, 2, 3], 2), [NaN, NaN, NaN, 1.5, 2.5]);
  assert.deepEqual(movingAverage("ema", [NaN, NaN], 2), [NaN, NaN]);
});

test("source d'un indicateur : le prix choisi de chaque bougie", () => {
  const bars = [{ o: 1, h: 4, l: 0, c: 3 }];
  assert.deepEqual(sourceValues(bars, "close"), [3]);
  assert.deepEqual(sourceValues(bars, "hl2"), [2]);
  assert.deepEqual(sourceValues(bars, "hlc3"), [7 / 3]);
  assert.deepEqual(sourceValues(bars, "ohlc4"), [2]);
  const ma = completeIndicator({ kind: "ma", type: "sma", period: 1, source: "high" }, "i1");
  assert.deepEqual(indicatorSeries(ma, bars).main, [4]);
});

test("réglages d'un indicateur : ceux d'usage pour ce qui manque, bornes vérifiées", () => {
  assert.deepEqual(completeIndicator({ kind: "ma" }, "i1"), { kind: "ma", type: "sma", period: 20, source: "close", id: "i1" });
  assert.deepEqual(completeIndicator({ kind: "ema" }, "i2"), { kind: "ma", type: "ema", period: 21, source: "close", id: "i2" });
  assert.deepEqual(completeIndicator({ kind: "rsi", signal: { type: "sma", period: 14 }, color: "violet" }, "i3"), {
    kind: "rsi",
    period: 14,
    source: "close",
    overbought: 70,
    oversold: 30,
    signal: { type: "sma", period: 14 },
    id: "i3",
    color: "violet",
  });
  assert.throws(() => completeIndicator({ kind: "ma", period: 0 }, "i"), /moyenne mal réglée/);
  assert.throws(() => completeIndicator({ kind: "rsi", overbought: 50, oversold: 50 }, "i"), /survente doit être sous le surachat/);
  assert.throws(() => completeIndicator({ kind: "rsi", period: 1 }, "i"), /RSI mal réglé : longueur : au moins 2/);
  assert.throws(() => completeIndicator({ kind: "rsi", oversold: 90 }, "i"), /survente : au plus 50/);
  assert.throws(() => completeIndicator({ kind: "ma", period: 900 }, "i"), /moyenne mal réglée : longueur : au plus 500/);
});

test("indicateurs gardés avant les réglages : complétés, avec un identifiant", () => {
  let n = 0;
  const id = () => `i${++n}`;
  assert.deepEqual(upgradeIndicator({ kind: "ema", period: 50 }, id), { kind: "ma", type: "ema", period: 50, source: "close", id: "i1" });
  assert.equal(upgradeIndicator({ kind: "rsi", period: 14 }, id)?.kind, "rsi");
  assert.equal(upgradeIndicator({ kind: "macd" }, id), undefined);
  const kept = completeIndicator({ kind: "ma" }, "keep");
  assert.deepEqual(upgradeIndicator(kept, id), kept, "déjà complet : tel quel");
});

test("noms des indicateurs, et doublons (le style mis à part)", () => {
  const ma = (type: "sma" | "ema" | "wma" | "smma" | "hma", period: number, source = "close" as const) =>
    completeIndicator({ kind: "ma", type, period, source }, "x");
  assert.equal(indicatorLabel(ma("sma", 50)), "MM 50");
  assert.equal(indicatorLabel(ma("ema", 21)), "MME 21");
  assert.equal(indicatorLabel(ma("wma", 20)), "MMP 20");
  assert.equal(indicatorLabel(ma("smma", 14)), "MML 14");
  assert.equal(indicatorLabel(ma("hma", 9)), "HMA 9");
  assert.equal(indicatorLabel(completeIndicator({ kind: "ma", period: 20, source: "high" }, "x")), "MM 20 · plus haut");
  assert.equal(indicatorLabel(completeIndicator({ kind: "rsi" }, "x")), "RSI 14");
  assert.ok(sameIndicator(ma("sma", 50), { ...ma("sma", 50), id: "autre", color: "red" }));
  assert.ok(!sameIndicator(ma("sma", 50), ma("ema", 50)));
});

test("position d'un instant parmi les bougies : dedans, dans une interruption, avant et après", () => {
  // Bougies d'une heure, avec une nuit sans cotation entre 3 h et 10 h.
  const H = 3600;
  const times = [0, H, 2 * H, 10 * H, 11 * H];
  assert.equal(barPosition(times, H, H), 1);
  assert.equal(barPosition(times, H + 900, H), 1.25, "un quart de bougie");
  assert.equal(barPosition(times, 5 * H, H), 3, "pendant la nuit : la bougie suivante");
  assert.equal(barPosition(times, 13 * H, H), 6, "au-delà de la dernière, au pas de l'unité");
  assert.equal(barPosition(times, -2 * H, H), -2);
  assert.ok(Number.isNaN(barPosition([], 0, H)));
  assert.equal(barTime(times, 3, H), 10 * H);
  assert.equal(barTime(times, 6, H), 13 * H);
});

test("prix d'une oblique : entre ses points, prolongée ou non, dans les deux sens de tracé", () => {
  const line = { a: { t: 0, price: 100 }, b: { t: 1, price: 110 }, extend: false };
  assert.equal(trendlinePrice(line, 0, 2, 1), 105);
  assert.equal(trendlinePrice(line, 0, 2, 3), undefined, "après le second point, sans prolongement");
  assert.equal(trendlinePrice({ ...line, extend: true }, 0, 2, 4), 120);
  assert.equal(trendlinePrice(line, 0, 2, -1), undefined, "avant le premier point");
  assert.equal(trendlinePrice({ ...line, extend: true }, 2, 0, 4), 90, "tracée de droite à gauche : prolongée vers la droite");
  assert.equal(trendlinePrice(line, 2, 2, 2), undefined, "verticale : un instant, pas un prix");
});

test("forme d'un tracé : les genres, et un genre inconnu refusé", () => {
  assert.ok(drawingShapeSchema.safeParse({ kind: "hline", price: 1.1 }).success);
  assert.ok(drawingShapeSchema.safeParse({ kind: "zone", top: 2, bottom: 1 }).success);
  assert.ok(drawingShapeSchema.safeParse({ kind: "trendline", a: { t: 1, price: 1 }, b: { t: 2, price: 2 }, extend: true }).success);
  assert.ok(drawingShapeSchema.safeParse({ kind: "fib", a: { t: 1, price: 1 }, b: { t: 2, price: 2 }, extend: false }).success);
  assert.ok(drawingShapeSchema.safeParse({ kind: "fibext", a: { t: 1, price: 1 }, b: { t: 2, price: 2 }, c: { t: 3, price: 1.5 }, extend: false }).success);
  assert.ok(
    !drawingShapeSchema.safeParse({ kind: "fibext", a: { t: 1, price: 1 }, b: { t: 2, price: 2 }, extend: false }).success,
    "extension sans son troisième point",
  );
  assert.ok(!drawingShapeSchema.safeParse({ kind: "fibonacci", price: 1 }).success);
});

test("boîte de trade : sa forme, son gain, son risque, leur rapport ; ses niveaux dans l'ordre de son sens", () => {
  const long = { kind: "position", side: "long", entry: 2650, stop: 2630, target: 2690, from: 1, to: 2 } as const;
  assert.ok(drawingShapeSchema.safeParse(long).success);
  assert.ok(drawingShapeSchema.safeParse({ ...long, to: undefined }).success, "sans fin : jusqu'au bord droit");
  assert.ok(!drawingShapeSchema.safeParse({ ...long, side: "achat" }).success);
  assert.ok(!drawingShapeSchema.safeParse({ ...long, target: undefined }).success, "sans objectif");
  assert.deepEqual(positionDistances(long), { risk: 20, reward: 40 });
  assert.equal(positionRatio(long), 2);
  assert.equal(positionRatio({ entry: 1, stop: 1, target: 2 }), undefined, "sans risque");
  assert.deepEqual([ratioLabel(2), ratioLabel(2.5), ratioLabel(1.3456), ratioLabel(0.5)], ["2 R", "2,5 R", "1,35 R", "0,5 R"]);
  assert.equal(positionProblem(long), undefined);
  assert.equal(positionProblem({ side: "short", entry: 2650, stop: 2665, target: 2620 }), undefined);
  assert.match(positionProblem({ ...long, stop: 2650 }) ?? "", /stop va sous l'entrée/);
  assert.match(positionProblem({ side: "short", entry: 2650, stop: 2665, target: 2660 }) ?? "", /objectif va sous l'entrée/);
  assert.deepEqual(
    [
      positionSideOf({ entry: 2650, stop: 2640 }),
      positionSideOf({ entry: 2650, stop: 2660 }),
      positionSideOf({ entry: 2650, target: 2600 }),
      positionSideOf({ entry: 2650 }),
    ],
    ["long", "short", "short", undefined],
  );
});

test("Fibonacci : retracement de b (0) vers a (1), dans les deux sens de tracé", () => {
  const up = fibLevels({ kind: "fib", a: { t: 0, price: 2600 }, b: { t: 3600, price: 2700 }, extend: false });
  assert.deepEqual(
    up.map((l) => l.ratio),
    [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  );
  assert.deepEqual(
    up.map((l) => Number(l.price.toFixed(2))),
    [2700, 2676.4, 2661.8, 2650, 2638.2, 2621.4, 2600],
    "du plus bas au plus haut : le 0,618 sous le plus haut",
  );
  const down = fibLevels({ kind: "fib", a: { t: 0, price: 2700 }, b: { t: 3600, price: 2600 }, extend: false });
  assert.deepEqual(
    down.map((l) => Number(l.price.toFixed(2))),
    [2600, 2623.6, 2638.2, 2650, 2661.8, 2678.6, 2700],
    "du plus haut au plus bas : le 0,618 au-dessus du plus bas",
  );
});

test("Fibonacci : extension projetée depuis c avec l'amplitude de a à b", () => {
  const levels = fibLevels({ kind: "fibext", a: { t: 0, price: 100 }, b: { t: 1, price: 200 }, c: { t: 2, price: 150 }, extend: false });
  assert.deepEqual(
    levels.map((l) => [l.ratio, Number(l.price.toFixed(2))]),
    [
      [0, 150],
      [0.382, 188.2],
      [0.618, 211.8],
      [1, 250],
      [1.272, 277.2],
      [1.618, 311.8],
      [2, 350],
      [2.618, 411.8],
    ],
  );
  const short = fibLevels({ kind: "fibext", a: { t: 0, price: 200 }, b: { t: 1, price: 100 }, c: { t: 2, price: 150 }, extend: false });
  assert.equal(short.find((l) => l.ratio === 1)?.price, 50, "impulsion baissière : projetée vers le bas");
  assert.deepEqual([0, 0.618, 1, 2.618].map(fibRatioLabel), ["0", "0,618", "1", "2,618"]);
  // Le prix d'un niveau (celui d'une alerte) : undefined pour un ratio que ce Fibonacci n'a pas.
  const ext = { kind: "fibext", a: { t: 0, price: 100 }, b: { t: 1, price: 200 }, c: { t: 2, price: 150 }, extend: false } as const;
  assert.equal(fibLevelPrice(ext, 2), 350);
  assert.equal(fibLevelPrice(ext, 0.5), undefined, "pas de 0,5 dans une extension");
  assert.equal(fibLevelPrice(ext, undefined), undefined);
  assert.deepEqual(fibRatios("fib"), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
});

test("alertes : sens par défaut d'une alerte de prix, d'après le cours", () => {
  assert.equal(defaultCondition(3950, 3940), "up", "au-dessus du cours : la hausse");
  assert.equal(defaultCondition(3930, 3940), "down");
  assert.equal(defaultCondition(3940, 3940), "cross", "au cours même : les deux sens");
  assert.equal(defaultCondition(3940), "cross", "sans cours");
  assert.equal(alertTargetSchema.safeParse({ kind: "price", price: 0 }).success, false, "un prix positif");
  assert.equal(alertTargetSchema.safeParse({ kind: "drawing", drawingId: "d_1" }).success, true);
  assert.equal(alertTargetSchema.safeParse({ kind: "drawing", drawingId: "d_1", level: 0.618 }).success, true, "un niveau d'un Fibonacci");
});
