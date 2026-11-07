// Heures de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import { inWeekend, manualPauseEnd, nextChange, pauseWindow, whenLabel } from "../src/market/broker-schedule.js";

/** Un instant à l'heure de Paris : novembre 2026 (les deux pays à l'heure d'hiver depuis le 1er). */
const paris = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const WEEKEND = { weekend: true, nights: false };
const BOTH = { weekend: true, nights: true };

test("week-end : du vendredi 23 h 05 au dimanche 22 h 30 à Paris (17 h 05 → 16 h 30 à New York)", () => {
  assert.equal(inWeekend(paris(11, 6, 23, 4)), false, "vendredi 23 h 04 : marchés encore ouverts");
  assert.equal(inWeekend(paris(11, 6, 23, 5)), true);
  assert.equal(inWeekend(paris(11, 7, 12)), true, "samedi");
  assert.equal(inWeekend(paris(11, 8, 22, 29)), true);
  assert.equal(inWeekend(paris(11, 8, 22, 30)), false, "dimanche 22 h 30 : rallumé une demi-heure avant le forex");
  assert.equal(inWeekend(paris(11, 4, 3)), false, "un mercredi de nuit");
});

test("week-end : suit New York quand les deux pays n'ont pas changé d'heure ensemble", () => {
  // Fin octobre : Paris à l'heure d'hiver, New York encore à l'heure d'été (5 h d'écart au lieu de 6).
  assert.equal(inWeekend(paris(10, 30, 22, 4)), false);
  assert.equal(inWeekend(paris(10, 30, 22, 5)), true, "vendredi 30 octobre 22 h 05 = 17 h 05 à New York");
  // Dimanche 1er novembre : New York est repassé à l'heure d'hiver à 2 h, la reprise retombe à 22 h 30.
  assert.equal(inWeekend(paris(11, 1, 22, 29)), true);
  assert.equal(inWeekend(paris(11, 1, 22, 30)), false);
});

test("fenêtres : la nuit en option, et le week-end allongé jusqu'au lundi 5 h", () => {
  assert.equal(pauseWindow(paris(11, 3, 23), WEEKEND), undefined, "sans l'option, la nuit reste allumée");
  assert.equal(pauseWindow(paris(11, 3, 23), BOTH), "night");
  assert.equal(pauseWindow(paris(11, 4, 4, 59), BOTH), "night");
  assert.equal(pauseWindow(paris(11, 4, 5), BOTH), undefined);
  assert.equal(pauseWindow(paris(11, 3, 22, 59), BOTH), undefined);
  // Dimanche 22 h 45 : pas de rallumage pour éteindre un quart d'heure après.
  assert.equal(pauseWindow(paris(11, 8, 22, 45), BOTH), "weekend");
  assert.equal(pauseWindow(paris(11, 9, 3), BOTH), "weekend", "lundi 3 h : la fin du week-end");
  assert.equal(pauseWindow(paris(11, 9, 23), BOTH), "night", "lundi 23 h : une nuit de semaine");
  assert.equal(pauseWindow(paris(11, 7, 12), { weekend: false, nights: false }), undefined, "règles coupées : toujours allumé");
  assert.equal(pauseWindow(paris(11, 7, 2), { weekend: false, nights: true }), "night");
});

test("prochain changement : la sortie d'une fenêtre, l'entrée dans la suivante", () => {
  assert.equal(nextChange(paris(11, 7, 10), WEEKEND), paris(11, 8, 22, 30), "samedi : reprise dimanche 22 h 30");
  assert.equal(nextChange(paris(11, 6, 15), WEEKEND), paris(11, 6, 23, 5), "vendredi après-midi : pause à 23 h 05");
  assert.equal(nextChange(paris(11, 7, 10), BOTH), paris(11, 9, 5), "avec les nuits : reprise lundi 5 h");
  assert.equal(nextChange(paris(11, 3, 15), BOTH), paris(11, 3, 23));
  assert.equal(nextChange(paris(11, 3, 15), { weekend: false, nights: false }), undefined);
});

test("pause demandée à la main : jusqu'à la fin de la fenêtre, sinon jusqu'au prochain matin de semaine", () => {
  assert.equal(manualPauseEnd(paris(11, 3, 15), WEEKEND), paris(11, 4, 6, 30), "mardi 15 h : jusqu'à mercredi 6 h 30");
  assert.equal(manualPauseEnd(paris(11, 7, 10), WEEKEND), paris(11, 8, 22, 30), "samedi : jusqu'à la fin du week-end");
  assert.equal(manualPauseEnd(paris(11, 6, 15), WEEKEND), paris(11, 8, 22, 30), "vendredi 15 h : jusqu'à la fin du week-end qui suit");
  assert.equal(manualPauseEnd(paris(11, 3, 15), BOTH), paris(11, 4, 5), "avec les nuits : jusqu'à la fin de la nuit qui suit");
  assert.equal(manualPauseEnd(paris(11, 3, 15), { weekend: false, nights: false }), paris(11, 4, 6, 30));
});

test("libellé d'un instant proche, heure de Paris", () => {
  assert.equal(whenLabel(paris(11, 8, 22, 30), paris(11, 7, 10)), "demain à 22 h 30");
  assert.equal(whenLabel(paris(11, 8, 22, 30), paris(11, 6, 23, 5)), "dimanche à 22 h 30");
  assert.equal(whenLabel(paris(11, 4, 5), paris(11, 4, 1)), "aujourd'hui à 5 h");
});
