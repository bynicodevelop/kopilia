// Carte technique automatique : zones, obliques et divergences repérées sur des
// bougies synthétiques déterministes (des allers-retours en ligne droite, aux
// mèches légèrement irrégulières par un générateur amorcé), ATR calculé à la main.
import { test } from "node:test";
import assert from "node:assert/strict";
import { atr, autoMap, autoTrendlines, autoZones, pivots, rsiDivergences, type OhlcBar } from "../src/levels.js";

/** Générateur pseudo-aléatoire amorcé (congruentiel linéaire) : les mêmes mèches à chaque passage. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/**
 * Bougies de 5 minutes dont les clôtures vont en ligne droite d'un point à
 * l'autre (`[prix visé, en tant de bougies]`) ; chaque bougie ouvre à la
 * clôture précédente, avec une mèche de `wick` de part et d'autre (± 20 % si
 * `seed` est donné).
 */
function legs(start: number, points: [number, number][], wick = 0.5, seed?: number): OhlcBar[] {
  const rnd = seed === undefined ? () => 0.5 : seeded(seed);
  const closes = [start];
  for (const [to, k] of points) {
    const from = closes[closes.length - 1];
    for (let j = 1; j <= k; j++) closes.push(from + ((to - from) * j) / k);
  }
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: 1_700_000_000 + i * 300, o, h: Math.max(o, c) + wick * (0.8 + 0.4 * rnd()), l: Math.min(o, c) - wick * (0.8 + 0.4 * rnd()), c };
  });
}

/** Les mêmes bougies, la tête en bas (autour de `axis`) : un support devient résistance, une hausse une baisse. */
function mirror(bars: readonly OhlcBar[], axis: number): OhlcBar[] {
  return bars.map((b) => ({ t: b.t, o: axis - b.o, h: axis - b.l, l: axis - b.h, c: axis - b.c }));
}

/** Bougies à la suite des autres (5 minutes plus tard chacune). */
function append(bars: readonly OhlcBar[], more: readonly OhlcBar[]): OhlcBar[] {
  const t = bars[bars.length - 1].t;
  return [...bars, ...more.map((b, k) => ({ ...b, t: t + 300 * (k + 1) }))];
}

const round = (xs: number[], d = 3) => xs.map((x) => (Number.isNaN(x) ? NaN : Number(x.toFixed(d))));

test("ATR de Wilder : étendue vraie (écart avec la clôture précédente compris), lissée à 1 / période", () => {
  const bars = [
    { o: 9, h: 10, l: 8, c: 9 }, // 2 (pas de clôture précédente)
    { o: 9, h: 11, l: 9, c: 10 }, // 2
    { o: 10, h: 12, l: 9, c: 11 }, // 3
    { o: 13, h: 15, l: 13, c: 14 }, // 4 : écart d'ouverture, 15 − 11
    { o: 14, h: 14, l: 12, c: 12.5 }, // 2
  ];
  // (2 + 2 + 3) / 3 = 7 / 3 ; puis (7 / 3 × 2 + 4) / 3 = 26 / 9 ; puis (26 / 9 × 2 + 2) / 3 = 70 / 27.
  assert.deepEqual(round(atr(bars, 3)), [NaN, NaN, 2.333, 2.889, 2.593]);
  assert.deepEqual(atr(bars.slice(0, 2), 3), [NaN, NaN]);
  assert.deepEqual(atr([], 3), []);
});

test("pivots : plus haut strictement au-dessus des précédents, au moins égal aux suivants ; les dernières bougies non confirmées", () => {
  const hl = (h: number, l: number, i: number): OhlcBar => ({ t: i, o: l, h, l, c: h });
  const bars = [
    [1, 0],
    [2, 1],
    [5, 2],
    [5, 3],
    [3, 1],
    [2, 0.5],
    [4, 2],
    [6, 3],
  ].map(([h, l], i) => hl(h, l, i));
  // Double sommet exact à 5 : le premier seulement. Creux à 0,5 (bougie 5). La bougie 7 (6) n'a pas de suivantes.
  assert.deepEqual(pivots(bars, 2, 2), [
    { i: 2, t: 2, kind: "high", price: 5 },
    { i: 5, t: 5, kind: "low", price: 0.5 },
  ]);
});

/** Trois sommets vers 110 (109,5, 109,6, 109,4 en clôture), des creux qui remontent, et le prix qui finit à 103. */
const triple = legs(
  100,
  [
    [109.5, 8],
    [101, 8],
    [109.6, 8],
    [102, 8],
    [109.4, 8],
    [103, 8],
  ],
  0.5,
  1,
);

test("zones : une résistance touchée trois fois vers 110, sous laquelle le prix finit", () => {
  const zones = autoZones(triple);
  const z = zones.find((z) => z.bottom <= 110 && z.top >= 110);
  assert.ok(z, `pas de zone autour de 110 : ${JSON.stringify(zones)}`);
  assert.equal(z.touches, 3);
  assert.equal(z.role, "resistance");
  assert.equal(z.first, triple[8].t);
  assert.equal(z.last, triple[40].t);
  // L'estimation (médianes) reste dans l'enveloppe brute des mèches et des corps.
  assert.ok(z.wickBottom <= z.bottom && z.top <= z.wickTop);
  assert.ok(z.top - z.bottom < 1, "une zone, pas tout le range");
  assert.match(z.key, /^z:\d+(\.\d+)?$/);
  // Les creux (100,4 puis 101,4) sont trop écartés pour faire un support à deux contacts.
  assert.equal(zones.length, 1);
});

test("zones : la clé ne change pas quand une nouvelle bougie ne touche pas la zone", () => {
  const before = autoZones(triple).find((z) => z.bottom <= 110 && z.top >= 110);
  const after = autoZones(append(triple, [{ t: 0, o: 103, h: 103.3, l: 101.9, c: 102.2 }])).find((z) => z.bottom <= 110 && z.top >= 110);
  assert.ok(before && after);
  assert.equal(after.key, before.key);
  assert.equal(after.touches, before.touches);
  assert.ok(after.score < before.score, "les contacts vieillissent d'une bougie");
});

test("zones : un ancien support cassé, retesté par-dessous, devient une résistance (creux et sommets ensemble)", () => {
  // Deux creux vers 100, cassure jusqu'à 92, retour sous 100, puis rechute.
  const bars = legs(110, [
    [100, 8],
    [108, 8],
    [100.2, 8],
    [106, 8],
    [92, 8],
    [99.6, 8],
    [94, 6],
  ]);
  const z = autoZones(bars).find((z) => z.bottom <= 100 && z.top >= 100);
  assert.ok(z);
  assert.equal(z.touches, 3);
  assert.equal(z.role, "resistance");
  // Le dernier contact est le sommet du retest, le premier un creux.
  assert.equal(z.first, bars[8].t);
  assert.equal(z.last, bars[48].t);
});

/** Creux montants de 4 toutes les 20 bougies (100, 104, 108), sommets entre deux, et le prix qui finit à 120. */
const rising = legs(
  110,
  [
    [100, 8],
    [112, 10],
    [104, 10],
    [116, 10],
    [108, 10],
    [120, 10],
  ],
  0.5,
  2,
);

test("obliques : un support montant à trois contacts", () => {
  const lines = autoTrendlines(rising);
  const s = lines.find((l) => l.kind === "support");
  assert.ok(s, `pas de support : ${JSON.stringify(lines)}`);
  assert.equal(s.touches, 3);
  assert.equal(s.a.i, 9);
  assert.ok(Math.abs(s.slope - 0.2) < 0.02, `pente ${s.slope}`);
  assert.equal(s.last, rising[49].t);
  assert.ok(Math.abs(s.priceNow - (s.a.price + s.slope * (rising.length - 1 - s.a.i))) < 1e-9);
  assert.ok(s.priceNow < rising[rising.length - 1].c);
  assert.match(s.key, /^s:\d+-\d+$/);
});

test("obliques : le support est rejeté quand une clôture passe nettement dessous", () => {
  const broken = append(rising, legs(120, [[100, 6]]).slice(1));
  assert.deepEqual(
    autoTrendlines(broken).filter((l) => l.kind === "support"),
    [],
  );
});

test("obliques : une résistance descendante (le même graphique, la tête en bas)", () => {
  const lines = autoTrendlines(mirror(rising, 220));
  assert.equal(lines.filter((l) => l.kind === "support").length, 0);
  const r = lines.find((l) => l.kind === "resistance");
  assert.ok(r);
  assert.equal(r.touches, 3);
  assert.ok(Math.abs(r.slope + 0.2) < 0.02);
});

test("divergence haussière : creux plus bas du prix, creux du RSI plus haut", () => {
  // Prix calme à 120 (le RSI s'amorce), chute rapide à 100 (RSI au plancher), rebond, lente rechute à 99, reprise.
  const calm = Array.from({ length: 8 }, (): [number, number][] => [
    [120.5, 1],
    [120, 1],
  ]).flat();
  const bars = legs(120, [...calm, [100, 20], [106, 6], [99, 14], [104, 6]], 0.5, 4);
  const divs = rsiDivergences(bars);
  assert.equal(divs.length, 1, JSON.stringify(divs));
  const [d] = divs;
  assert.equal(d.kind, "bullish");
  assert.ok(d.to.i > d.from.i);
  assert.ok(d.to.price < d.from.price);
  assert.ok(d.to.rsi > d.from.rsi + 10, `RSI ${d.from.rsi} puis ${d.to.rsi}`);
  assert.equal(d.to.t, bars[d.to.i].t);
});

test("divergences : aucune sur une tendance régulière, à la hausse comme à la baisse", () => {
  // Six bougies de hausse, trois de baisse, vingt fois : des sommets et des creux toujours plus hauts, au même rythme.
  const up = legs(
    100,
    Array.from({ length: 20 }, (_, k): [number, number][] => [
      [106 + 3 * k, 6],
      [103 + 3 * k, 3],
    ]).flat(),
  );
  assert.ok(pivots(up).filter((p) => p.i >= up.length - 60).length >= 10);
  assert.deepEqual(rsiDivergences(up), []);
  assert.deepEqual(rsiDivergences(mirror(up, 300)), []);
  // Sans seuil, le lissage de Wilder qui converge ferait voir des « divergences » de quelques millièmes de point.
  assert.ok(rsiDivergences(up, { minRsiGap: 0 }).length > 0);
});

test("trop peu de bougies : listes vides, sans erreur", () => {
  for (const bars of [[], triple.slice(0, 5), triple.slice(0, 14)]) {
    const map = autoMap(bars);
    assert.deepEqual([map.zones, map.trendlines, map.divergences], [[], [], []]);
  }
  assert.ok(Number.isNaN(autoMap(triple.slice(0, 5)).atr));
  assert.deepEqual(pivots(triple.slice(0, 6)), []);
});

test("carte complète : l'ATR de la dernière bougie, les zones, obliques et divergences", () => {
  const map = autoMap(triple);
  assert.equal(map.atr, atr(triple)[triple.length - 1]);
  assert.deepEqual(map.zones, autoZones(triple));
  assert.deepEqual(map.trendlines, autoTrendlines(triple));
  assert.deepEqual(map.divergences, rsiDivergences(triple));
});
