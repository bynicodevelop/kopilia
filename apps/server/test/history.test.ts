// Heures attendues en heure de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Candle,
  cleanCandles,
  dailyRequest,
  dayReport,
  frenchChange,
  frenchDay,
  pickDays,
  resolveSpan,
  sessionDay,
  sessionReport,
  sessionWindow,
} from "../src/market/history.js";

/** Mardi 3 novembre 2026, 11 h 15 (heure de Paris). */
const NOW = new Date(2026, 10, 3, 11, 15);
const PRODUCT = { query: "Nasdaq", symbol: "NAS100", name: "Nasdaq 100", digits: 2 };

/** Bougie quotidienne d'un courtier à GMT+2 (hiver) : la journée commence à 23 h la veille, heure de Paris. */
function day(date: string, open: number, high: number, low: number, close: number, offsetHours = 2): Candle {
  const start = Date.parse(`${date}T00:00:00Z`) - offsetHours * 3_600_000;
  return { time: new Date(start).toISOString(), brokerTime: `${date} 00:00:00.000`, open, high, low, close };
}

/** Bougie de 5 minutes à une heure UTC donnée. */
function m5(iso: string, open: number, high: number, low: number, close: number): Candle {
  return { time: iso, brokerTime: iso.replace("T", " ").slice(0, 19), open, high, low, close };
}

// Semaine réelle du Nasdaq chez un courtier MetaTrader (passage à l'heure d'hiver américaine le 1er novembre : GMT+3 puis GMT+2).
const NASDAQ = [
  day("2026-10-29", 29616.11, 29634.03, 28956.34, 29060.82, 3),
  day("2026-10-30", 28995.55, 29019.59, 28077.01, 28388.86, 3),
  day("2026-11-02", 28501.9, 28746.93, 27958.7, 28081.15),
  day("2026-11-03", 28063.25, 28141.66, 27897.88, 28093.51),
];

test("ce qui est demandé : jour, veille, semaine, mois, date, plage", () => {
  assert.deepEqual(resolveSpan({}, NOW), { single: true, target: "2026-11-03" });
  assert.deepEqual(resolveSpan({ period: "yesterday" }, NOW), { single: true, target: "2026-11-02" });
  assert.deepEqual(resolveSpan({ date: "2026-10-30" }, NOW), { single: true, target: "2026-10-30" });
  assert.deepEqual(resolveSpan({ period: "week" }, NOW), {
    single: false,
    from: "2026-11-02",
    to: "2026-11-03",
    label: "cette semaine (depuis le lundi 2 novembre)",
  });
  assert.deepEqual(resolveSpan({ period: "last_week" }, NOW), {
    single: false,
    from: "2026-10-26",
    to: "2026-11-01",
    label: "la semaine dernière (du lundi 26 octobre au dimanche 1er novembre)",
  });
  assert.deepEqual(resolveSpan({ period: "last_month" }, NOW), {
    single: false,
    from: "2026-10-01",
    to: "2026-10-31",
    label: "le mois dernier (du jeudi 1er octobre au samedi 31 octobre)",
  });
  assert.deepEqual(resolveSpan({ from: "2026-10-01" }, NOW), {
    single: false,
    from: "2026-10-01",
    to: "2026-11-03",
    label: "du jeudi 1er octobre au mardi 3 novembre",
  });
  // Un dimanche, la semaine en cours est celle qui finit ce jour-là.
  assert.equal((resolveSpan({ period: "week" }, new Date(2026, 10, 8, 12)) as { from: string }).from, "2026-11-02");
});

test("ce qui est demandé : erreurs lisibles", () => {
  assert.throws(() => resolveSpan({ date: "30/10/2026" }, NOW), /date invalide \(« 30\/10\/2026 »\) : format AAAA-MM-JJ attendu/);
  assert.throws(() => resolveSpan({ date: "2026-02-30" }, NOW), /date invalide/);
  assert.throws(() => resolveSpan({ date: "2026-11-05" }, NOW), /jeudi 5 novembre est dans le futur/);
  assert.throws(() => resolveSpan({ from: "2026-11-05" }, NOW), /plage vide/);
  assert.throws(() => resolveSpan({ from: "2025-01-01", to: "2026-11-01" }, NOW), /366 jours au plus/);
});

test("requête au courtier : jusqu'au dernier jour demandé, avec la séance d'avant", () => {
  assert.deepEqual(dailyRequest({ single: true, target: "2026-10-30" }), { startTime: "2026-10-30T12:00:00.000Z", limit: 8 });
  assert.deepEqual(dailyRequest({ single: false, from: "2026-10-26", to: "2026-11-01", label: "" }), { startTime: "2026-11-01T12:00:00.000Z", limit: 14 });
});

test("bougies : triées, sans doublon ni valeur inexploitable", () => {
  const [a, b] = NASDAQ;
  const clean = cleanCandles([b, a, { ...b }, { ...a, close: "x" }, null]);
  assert.deepEqual(clean, [a, b]);
  assert.throws(() => cleanCandles({ error: 1 }), /illisibles/);
});

test("un jour : la séance du courtier ; un jour sans séance donne la dernière avant", () => {
  const friday = pickDays(NASDAQ, { single: true, target: "2026-10-30" }, NOW);
  assert.equal(friday.days[0].close, 28388.86);
  assert.equal(friday.previous?.close, 29060.82);
  assert.equal(friday.note, undefined);
  const sunday = pickDays(NASDAQ, { single: true, target: "2026-11-01" }, NOW);
  assert.equal(sunday.days[0].brokerTime.slice(0, 10), "2026-10-30");
  assert.equal(sunday.note, "pas de séance le dimanche 1er novembre : voici la dernière avant, le vendredi 30 octobre");
  assert.throws(() => pickDays(NASDAQ, { single: true, target: "2026-10-01" }, NOW), /aucune séance connue jusqu'au jeudi 1er octobre/);
});

test("rapport d'un jour : extrêmes avec leur heure (la veille au soir comprise), variation, séance en cours", () => {
  const friday = pickDays(NASDAQ, { single: true, target: "2026-10-30" }, NOW);
  // Journée du vendredi chez le courtier : du jeudi 22 h au vendredi 22 h (heure de Paris).
  const intraday = [m5("2026-10-29T22:10:00Z", 29000, 29019.59, 28990, 29010), m5("2026-10-30T18:50:00Z", 28100, 28120, 28077.01, 28110)];
  const r = dayReport(PRODUCT, { single: true, target: "2026-10-30" }, friday, intraday, NOW);
  assert.deepEqual(r, {
    query: "Nasdaq",
    symbol: "NAS100",
    name: "Nasdaq 100",
    period: "vendredi 30 octobre",
    reference: "journée du courtier, comme les bougies quotidiennes de MetaTrader : de 22 h la veille à 22 h, heure de Paris",
    open: "28 995,55",
    high: "29 019,59",
    highAt: "23 h 10 la veille",
    low: "28 077,01",
    lowAt: "19 h 50",
    close: "28 388,86",
    previousClose: "29 060,82",
    change: "-671,96 (-2,31 %)",
    state: "clôturée",
  });
  const today = dayReport(PRODUCT, { single: true, target: "2026-11-03" }, pickDays(NASDAQ, { single: true, target: "2026-11-03" }, NOW), [], NOW);
  assert.equal(today.state, "en cours : close est le dernier prix");
  assert.equal(today.reference, "journée du courtier, comme les bougies quotidiennes de MetaTrader : de 23 h la veille à 23 h, heure de Paris");
  assert.ok(!("highAt" in today), "sans bougies de 5 minutes, pas d'heure");
});

test("rapport d'une période : extrêmes avec leur jour, détail jour par jour", () => {
  const span = resolveSpan({ period: "last_week" }, NOW);
  const r = dayReport(PRODUCT, span, pickDays(NASDAQ, span, NOW), [], NOW) as Record<string, unknown>;
  assert.equal(r.open, "29 616,11", "la première séance connue de la plage");
  assert.equal(r.highDay, "jeudi 29 octobre");
  assert.equal(r.lowDay, "vendredi 30 octobre");
  assert.equal(r.close, "28 388,86");
  assert.ok(!("previousClose" in r), "pas de séance connue avant la plage");
  assert.deepEqual(
    (r.days as Array<{ day: string }>).map((d) => d.day),
    ["jeudi 29 octobre", "vendredi 30 octobre"],
  );
  assert.throws(() => pickDays(NASDAQ, { single: false, from: "2026-10-31", to: "2026-11-01", label: "ce week-end" }, NOW), /aucune séance ce week-end/);
});

test("séances : heures de Paris, changements d'heure compris", () => {
  assert.equal(sessionWindow("new_york", "2026-11-02", NOW).label, "séance de New York du lundi 2 novembre (15 h 30 – 22 h, heure de Paris)");
  // Fin octobre, New York est encore à l'heure d'été mais plus Paris : Wall Street ouvre à 14 h 30.
  assert.equal(sessionWindow("new_york", "2026-10-27", NOW).label, "séance de New York du mardi 27 octobre (14 h 30 – 21 h, heure de Paris)");
  assert.equal(sessionWindow("london", "2026-11-03", NOW).label, "séance de Londres du mardi 3 novembre (9 h – 17 h 30, heure de Paris)");
  assert.equal(sessionWindow("asia", "2026-11-03", NOW).label, "séance asiatique du mardi 3 novembre (1 h – 9 h, heure de Paris)");
  assert.equal(sessionWindow("new_york", "2026-07-15", NOW).label, "séance de New York du mercredi 15 juillet (15 h 30 – 22 h, heure de Paris)");
  assert.equal(sessionDay({ single: true, target: "2026-11-01" }), "2026-10-30", "un dimanche : la séance du vendredi");
  assert.throws(() => sessionDay({ single: false, from: "2026-11-02", to: "2026-11-03", label: "" }), /un seul jour/);
});

test("rapport d'une séance : bougies de la fenêtre seulement, variation depuis l'ouverture", () => {
  const window = sessionWindow("new_york", "2026-11-02", NOW);
  const candles = [
    m5("2026-11-02T14:25:00Z", 28616.13, 28618.86, 28574.79, 28578.2), // avant 15 h 30
    m5("2026-11-02T14:30:00Z", 28575.67, 28594.47, 28530.08, 28565.29),
    m5("2026-11-02T15:25:00Z", 28600, 28746.93, 28590, 28700),
    m5("2026-11-02T20:40:00Z", 28000, 28010, 27958.7, 27991.57),
    m5("2026-11-02T21:00:00Z", 27990, 27995, 27900, 27950), // après 22 h
  ];
  assert.deepEqual(sessionReport(PRODUCT, window, candles, NOW), {
    query: "Nasdaq",
    symbol: "NAS100",
    name: "Nasdaq 100",
    period: "séance de New York du lundi 2 novembre (15 h 30 – 22 h, heure de Paris)",
    open: "28 575,67",
    high: "28 746,93",
    highAt: "16 h 25",
    low: "27 958,70",
    lowAt: "21 h 40",
    close: "27 991,57",
    change: "-584,10 (-2,04 %) depuis l'ouverture de la séance",
    state: "clôturée",
  });
  assert.throws(() => sessionReport(PRODUCT, window, [candles[0]], NOW), /aucune cotation pendant la séance de New York/);
});

test("variation et jours en français", () => {
  assert.equal(frenchChange(1.11779, 1.11579, 5), "-0,00200 (-0,18 %)");
  assert.equal(frenchChange(100, 100, 2), "0,00 (0,00 %)");
  assert.equal(frenchDay("2026-11-01", NOW), "dimanche 1er novembre");
  assert.equal(frenchDay("2025-12-31", NOW), "mercredi 31 décembre 2025", "l'année quand ce n'est pas celle en cours");
});
