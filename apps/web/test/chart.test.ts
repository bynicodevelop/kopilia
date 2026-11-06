// Heures attendues en heure de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import { niceStep, pickTimeStep, timeLabel, timeTicks } from "../src/app/dashboard/candle-chart";

/** Bougies de 15 minutes du lundi 2 novembre 21 h au mardi 3 novembre 6 h (heure de Paris). */
const START = Date.parse("2026-11-02T20:00:00Z") / 1000;
const CANDLES = Array.from({ length: 36 }, (_, i) => ({ t: START + i * 900, o: 1, h: 1, l: 1, c: 1 }));

test("graduations des prix : un pas rond (1, 2, 2,5, 5 × 10ⁿ)", () => {
  assert.equal(niceStep(0.00037), 0.0005);
  assert.equal(niceStep(0.0012), 0.002);
  assert.equal(niceStep(0.0021), 0.0025);
  assert.equal(niceStep(23), 25);
  assert.equal(niceStep(60), 100);
  assert.equal(niceStep(0.00001), 0.00001);
  assert.equal(niceStep(0), 1, "pas de plage : un pas quand même");
});

test("graduations du temps : le pas le plus fin qui laisse de la place entre deux étiquettes", () => {
  assert.equal(pickTimeStep(900, 7), 14_400, "15 min à 7 px : une étiquette par 4 h");
  assert.equal(pickTimeStep(900, 24), 3600, "bougies larges : toutes les heures");
  assert.equal(pickTimeStep(60, 10), 900, "1 min à 10 px : tous les quarts d'heure");
  assert.equal(pickTimeStep(86_400, 7), 2_592_000, "1 jour serré : tous les mois");
  assert.equal(pickTimeStep(86_400, 48), 604_800, "1 jour large : toutes les semaines");
  assert.equal(pickTimeStep(86_400, 14), 604_800, "jamais tous les deux jours : la semaine, calée sur le lundi");
  assert.equal(pickTimeStep(604_800, 10), 2_592_000 * 3, "semaines serrées : tous les trimestres");
  assert.equal(pickTimeStep(2_592_000, 6), 2_592_000 * 12, "mois serrés : tous les ans");
});

test("graduations du temps : semaines du lundi, mois du calendrier", () => {
  // Bougies quotidiennes du jeudi 29 octobre au jeudi 12 novembre.
  const days = Array.from({ length: 15 }, (_, i) => ({ t: Date.parse("2026-10-29T00:00:00Z") / 1000 + i * 86_400, o: 1, h: 1, l: 1, c: 1 }));
  const weekly = timeTicks(days, 0, days.length - 1, 604_800);
  assert.deepEqual(
    weekly.map((t) => [new Date(days[t.index].t * 1000).getDay(), t.label]),
    [
      [1, "2 nov."],
      [1, "9 nov."],
    ],
  );
  const monthly = timeTicks(days, 0, days.length - 1, 2_592_000);
  assert.deepEqual(
    monthly.map((t) => [t.index, t.label]),
    [[3, "nov. 2026"]],
  );
});

test("graduations du temps : la première bougie de chaque pas, le jour quand il change", () => {
  const ticks = timeTicks(CANDLES, 0, CANDLES.length - 1, 14_400);
  // 21 h -> minuit (jour nouveau), puis 4 h.
  assert.deepEqual(
    ticks.map((t) => [t.index, t.label, t.day]),
    [
      [12, "3 nov.", true],
      [28, "04:00", false],
    ],
  );
  // Un pas d'un jour : toujours le jour.
  const daily = timeTicks(CANDLES, 0, CANDLES.length - 1, 86_400);
  assert.deepEqual(
    daily.map((t) => [t.index, t.label, t.day]),
    [[12, "3 nov.", true]],
  );
  // La fenêtre visible seulement : une graduation juste avant `from` n'est pas rendue, une à `from` l'est.
  assert.deepEqual(
    timeTicks(CANDLES, 13, 30, 14_400).map((t) => t.index),
    [28],
  );
  assert.deepEqual(
    timeTicks(CANDLES, 12, 30, 14_400).map((t) => t.index),
    [12, 28],
  );
});

test("étiquette du réticule : jour et heure, ou le jour seul pour des bougies quotidiennes", () => {
  assert.equal(timeLabel(Date.parse("2026-11-03T10:45:00Z") / 1000, 900), "3 nov. 11:45");
  assert.equal(timeLabel(Date.parse("2026-11-03T10:45:00Z") / 1000, 86_400), "3 nov.");
});
