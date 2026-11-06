// Heures attendues en heure de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyQuote,
  candleEnd,
  candleTimeLeft,
  changeSince,
  formatTimeLeft,
  formatPrice,
  isStale,
  mergeCandles,
  nextMonthStart,
  quoteDate,
  resyncCandles,
  timeframeLabel,
} from "../src/app/dashboard/candles";

/** Bougies de 15 minutes du 3 novembre 2026, 10 h 00 et 10 h 15 (heure de Paris). */
const T0 = Date.parse("2026-11-03T09:00:00Z") / 1000;
const CANDLES = [
  { t: T0, o: 1.082, h: 1.0825, l: 1.0818, c: 1.0823 },
  { t: T0 + 900, o: 1.0823, h: 1.0824, l: 1.0821, c: 1.0822 },
];

test("une cotation dans la bougie en cours la prolonge : plus haut, plus bas, dernier prix", () => {
  const r = applyQuote(CANDLES, 1.0827, (T0 + 900 + 400) * 1000, 900);
  assert.deepEqual(r, { candle: { t: T0 + 900, o: 1.0823, h: 1.0827, l: 1.0821, c: 1.0827 }, isNew: false });
  const low = applyQuote(CANDLES, 1.0819, (T0 + 900 + 899) * 1000, 900);
  assert.equal(low?.candle.l, 1.0819);
});

test("une cotation après la bougie en cours en ouvre une nouvelle, calée sur celles du courtier", () => {
  const next = applyQuote(CANDLES, 1.083, (T0 + 1800 + 5) * 1000, 900);
  assert.deepEqual(next, { candle: { t: T0 + 1800, o: 1.083, h: 1.083, l: 1.083, c: 1.083 }, isNew: true });
  // Marché fermé un moment : la nouvelle bougie saute les créneaux vides, mais reste en phase.
  const later = applyQuote(CANDLES, 1.084, (T0 + 900 + 4 * 900 + 100) * 1000, 900);
  assert.equal(later?.candle.t, T0 + 900 + 4 * 900);
  // Bougies de 4 heures du courtier (00:00 à son heure, pas 00:00 UTC) : la suivante part de la dernière, pas d'un multiple d'UTC.
  const fourH = [{ t: Date.parse("2026-11-03T06:00:00Z") / 1000, o: 1, h: 1, l: 1, c: 1 }];
  const r = applyQuote(fourH, 2, Date.parse("2026-11-03T10:30:00Z"), 14_400);
  assert.equal(r?.candle.t, Date.parse("2026-11-03T10:00:00Z") / 1000);
});

test("une cotation plus ancienne que la bougie en cours ne change rien ; sans bougie, elle en fait une", () => {
  assert.equal(applyQuote(CANDLES, 1.08, (T0 + 100) * 1000, 900), undefined);
  const first = applyQuote([], 1.08, (T0 + 100) * 1000, 900);
  assert.deepEqual(first, { candle: { t: T0, o: 1.08, h: 1.08, l: 1.08, c: 1.08 }, isNew: true });
});

test("fusion : une bougie par instant, la plus récente version l'emporte, dans l'ordre", () => {
  const older = [{ t: T0 - 900, o: 1, h: 1, l: 1, c: 1 }];
  const fixed = { ...CANDLES[1], c: 1.0829 };
  const merged = mergeCandles(CANDLES, [...older, fixed]);
  assert.deepEqual(
    merged.map((c) => c.t),
    [T0 - 900, T0, T0 + 900],
  );
  assert.equal(merged[2].c, 1.0829);
});

test("prix et variation en français ; heure locale", () => {
  assert.equal(formatPrice(1.08342, 5), "1,08342");
  assert.equal(formatPrice(28093.5, 2).replace(/\s/g, " "), "28 093,50", "espace fine insécable des milliers");
  assert.equal(formatPrice(1.0834), "1,0834");
  assert.deepEqual(changeSince(1.08, 1.0813), { text: "+0,12 %", sign: 1 });
  assert.deepEqual(changeSince(28100, 28037.8), { text: "−0,22 %", sign: -1 });
  assert.deepEqual(changeSince(1.08, 1.08), { text: "0,00 %", sign: 0 });
  assert.equal(changeSince(undefined, 1), undefined);
  assert.equal(timeframeLabel("15m"), "15 min");
  assert.equal(timeframeLabel("1d"), "1 j");
  assert.equal(timeframeLabel("1w"), "1 sem.");
  assert.equal(timeframeLabel("1mn"), "1 mois");
  assert.equal(quoteDate(Date.parse("2026-10-30T21:59:00Z")), "30 oct., 22:59");
});

test("marché fermé : cotation de plus de 5 minutes", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  assert.equal(isStale(now - 2_000, now), false, "cotation récente : en direct");
  assert.equal(isStale(now - 5 * 60_000, now), false, "pile 5 minutes : encore en direct");
  assert.equal(isStale(now - 5 * 60_000 - 1, now), true);
  assert.equal(isStale(now - 3 * 86_400_000, now), true, "week-end");
});

test("bougie mensuelle : la suivante s'ouvre au même moment du mois suivant, quelle que soit sa durée", () => {
  // Le courtier à UTC+2 : son mois de novembre commence le 31 octobre à 22 h UTC.
  const nov = Date.parse("2026-10-31T22:00:00Z") / 1000;
  assert.equal(nextMonthStart(nov), Date.parse("2026-11-30T22:00:00Z") / 1000);
  assert.equal(nextMonthStart(Date.parse("2027-02-01T00:00:00Z") / 1000), Date.parse("2027-03-01T00:00:00Z") / 1000);
  const month = [{ t: nov, o: 4000, h: 4100, l: 3950, c: 4050 }];
  const month30 = 30 * 86_400;
  // Le 30 novembre à 21 h UTC : encore novembre (30 jours de plus l'auraient fait changer de bougie à 22 h).
  const late = applyQuote(month, 4060, Date.parse("2026-11-30T21:00:00Z"), month30, true);
  assert.equal(late?.isNew, false);
  const dec = applyQuote(month, 4070, Date.parse("2026-11-30T22:30:00Z"), month30, true);
  assert.deepEqual(dec, { candle: { t: Date.parse("2026-11-30T22:00:00Z") / 1000, o: 4070, h: 4070, l: 4070, c: 4070 }, isNew: true });
  // Plusieurs mois sans cotation : la bougie du mois en cours, pas une de plus.
  const jan = applyQuote(month, 4080, Date.parse("2027-01-15T12:00:00Z"), month30, true);
  assert.equal(jan?.candle.t, Date.parse("2026-12-31T22:00:00Z") / 1000);
  assert.equal(applyQuote(month, 4080, Date.parse("2026-10-30T12:00:00Z"), month30, true), undefined);
});

test("recalage sur le courtier : sa plage remplace celle de l'écran, une bougie ouverte une heure trop tôt ne reste pas en double", () => {
  const k = (t: number, c: number) => ({ t, o: c, h: c, l: c, c });
  // L'écran a ouvert la bougie du mois à 21 h UTC ; le courtier, passé à l'heure d'hiver, l'ouvre à 22 h.
  const screen = [k(100, 1), k(200, 2), k(300, 3), k(399, 4)];
  const broker = [k(200, 2.5), k(300, 3.5), k(400, 4.5)];
  assert.deepEqual(
    resyncCandles(screen, broker).map((c) => [c.t, c.c]),
    [
      [100, 1],
      [200, 2.5],
      [300, 3.5],
      [400, 4.5],
    ],
  );
  // Une bougie que le courtier n'a pas encore reste.
  assert.deepEqual(
    resyncCandles([...screen, k(500, 5)], broker).map((c) => c.t),
    [100, 200, 300, 400, 500],
  );
  assert.equal(resyncCandles(screen, []), screen);
});

test("fin de la bougie en cours : sur la grille de la dernière bougie reçue, pas sur celle d'UTC", () => {
  const at = (iso: string) => Date.parse(iso);
  const s = (iso: string) => Date.parse(iso) / 1000;
  // 15 minutes : la bougie de 10 h 15 (Paris) finit à 10 h 30, même sans cotation depuis son ouverture.
  assert.equal(candleEnd(T0 + 900, (T0 + 900 + 400) * 1000, 900), T0 + 1800);
  // Plus de cotation depuis sa fin : celle qui s'ouvrira sur la même grille.
  assert.equal(candleEnd(T0 + 900, (T0 + 1800 + 5) * 1000, 900), T0 + 2700);
  // Pile à la frontière : la nouvelle bougie a commencé.
  assert.equal(candleEnd(T0 + 900, (T0 + 1800) * 1000, 900), T0 + 2700);
  // 4 heures du courtier ouvertes à 06:00 UTC : fin à 14:00 UTC (la grille d'UTC dirait 12:00).
  assert.equal(candleEnd(s("2026-11-05T06:00:00Z"), at("2026-11-05T10:30:00Z"), 14_400), s("2026-11-05T14:00:00Z"));
  // Journée du courtier (UTC+2) : de 22 h UTC à 22 h UTC.
  assert.equal(candleEnd(s("2026-11-04T22:00:00Z"), at("2026-11-05T15:00:00Z"), 86_400), s("2026-11-05T22:00:00Z"));
  // Courtier qui ne suit pas New York (UTC+1 fixe ici) : la semaine dure sept jours, le mois suit le calendrier.
  assert.equal(candleEnd(s("2026-11-01T23:00:00Z"), at("2026-11-05T15:00:00Z"), 604_800), s("2026-11-08T23:00:00Z"));
  const nov = s("2026-10-31T22:00:00Z");
  assert.equal(candleEnd(nov, at("2026-11-05T12:00:00Z"), 2_592_000, true), s("2026-11-30T22:00:00Z"));
  assert.equal(candleEnd(nov, at("2026-12-02T12:00:00Z"), 2_592_000, true), s("2026-12-31T22:00:00Z"));
});

test("semaine et mois : jusqu'à la clôture du vendredi, 17 h à New York (23 h à Paris), comme sur TradingView", () => {
  const at = (iso: string) => Date.parse(iso);
  const s = (iso: string) => Date.parse(iso) / 1000;
  const week = 604_800;
  const month = 2_592_000;
  // L'hebdo du courtier ouverte le samedi 31 octobre à 21 h UTC (17 h à New York, heure d'été) : elle ferme le
  // vendredi 6 novembre à 17 h à New York, 22 h UTC depuis le passage à l'heure d'hiver (pas samedi 21 h UTC).
  const oct31 = s("2026-10-31T21:00:00Z");
  assert.equal(candleEnd(oct31, at("2026-11-05T17:00:00Z"), week), s("2026-11-06T22:00:00Z"));
  // Pas encore de bougie pour la semaine (lundi matin) : la clôture de cette semaine-ci.
  assert.equal(candleEnd(s("2026-10-24T21:00:00Z"), at("2026-11-02T15:00:00Z"), week), s("2026-11-06T22:00:00Z"));
  // Courtier dont la semaine s'ouvre le lundi à minuit (dimanche 17 h à New York) : même vendredi.
  assert.equal(candleEnd(s("2026-11-01T22:00:00Z"), at("2026-11-05T15:00:00Z"), week), s("2026-11-06T22:00:00Z"));
  // Passage à l'heure d'été le 14 mars 2027 : ouverte à 22 h UTC, elle ferme à 21 h UTC.
  assert.equal(candleEnd(s("2027-03-13T22:00:00Z"), at("2027-03-16T12:00:00Z"), week), s("2027-03-19T21:00:00Z"));
  // Novembre 2026 finit un lundi : le 30 à 17 h à New York, 22 h UTC (l'heure d'hiver comprise).
  assert.equal(candleEnd(oct31, at("2026-11-05T17:00:00Z"), month, true), s("2026-11-30T22:00:00Z"));
  // Octobre 2026 finit un samedi : le mois ferme le vendredi 30.
  assert.equal(candleEnd(s("2026-09-30T21:00:00Z"), at("2026-10-20T12:00:00Z"), month, true), s("2026-10-30T21:00:00Z"));
  // Janvier 2027 finit un dimanche : vendredi 29.
  assert.equal(candleEnd(s("2026-12-31T22:00:00Z"), at("2027-01-10T12:00:00Z"), month, true), s("2027-01-29T22:00:00Z"));
  // Pas encore de bougie pour décembre : la clôture de décembre (jeudi 31).
  assert.equal(candleEnd(oct31, at("2026-12-02T12:00:00Z"), month, true), s("2026-12-31T22:00:00Z"));
  // Jeudi 18 h à Paris : 1 j 05:00 avant la clôture de la semaine ; juste après la clôture, plus rien à attendre.
  const thu = at("2026-11-05T17:00:00Z");
  assert.equal(candleTimeLeft(oct31, thu, thu, week), 29 * 3600 - 1);
  const fri = at("2026-11-06T22:02:00Z");
  assert.equal(candleTimeLeft(oct31, fri - 60_000, fri, week), 0);
});

test("temps restant : en secondes entières, rien quand le marché est fermé", () => {
  // Une cotation reçue il y a une seconde : le marché est ouvert.
  const left = (nowMs: number) => candleTimeLeft(T0 + 900, nowMs - 1_000, nowMs, 900);
  const now = (T0 + 900 + 400) * 1000;
  assert.equal(left(now - 300), 500, "500,3 s restantes : 08:20");
  assert.equal(left(now), 499, "pile à la seconde : elle est entamée");
  assert.equal(left((T0 + 1800) * 1000 - 1), 0);
  assert.equal(left((T0 + 1800) * 1000), 899, "nouvelle bougie : 14:59, jamais 15:00");
  assert.equal(candleTimeLeft(T0 + 900, undefined, now, 900), undefined, "pas encore de cotation");
  assert.equal(candleTimeLeft(T0 + 900, now - 6 * 60_000, now, 900), undefined, "cotation de plus de 5 minutes : marché fermé");
  // Horloge de la page en retard sur le courtier : jamais plus que la durée de la bougie.
  assert.equal(left((T0 + 800) * 1000), 899);
  const nov = Date.parse("2026-10-31T22:00:00Z") / 1000;
  const t = Date.parse("2026-11-28T16:47:29.500Z");
  assert.equal(candleTimeLeft(nov, t, t, 2_592_000, true), 2 * 86_400 + 5 * 3600 + 12 * 60 + 30);
});

test("texte du compte à rebours : court selon l'unité, de largeur stable", () => {
  assert.equal(formatTimeLeft(45, 60), "00:45");
  assert.equal(formatTimeLeft(754, 900), "12:34");
  assert.equal(formatTimeLeft(3599, 3600), "59:59");
  assert.equal(formatTimeLeft(11_565, 14_400), "03:12:45");
  assert.equal(formatTimeLeft(2700, 14_400), "00:45:00", "les 4 heures gardent leurs heures jusqu'au bout");
  assert.equal(formatTimeLeft(86_399, 86_400), "23:59:59");
  assert.equal(formatTimeLeft(2 * 86_400 + 5 * 3600 + 12 * 60 + 30, 604_800), "2 j 05:12");
  assert.equal(formatTimeLeft(30 * 86_400 + 23 * 3600 + 59 * 60 + 59, 2_592_000), "30 j 23:59");
  assert.equal(formatTimeLeft(3600, 604_800), "01:00:00", "le dernier jour de la semaine : les secondes reviennent");
  assert.equal(formatTimeLeft(-3, 900), "00:00");
  // Sans clignotement : jusqu'à la journée, le texte garde le même nombre de caractères d'un bout à l'autre de la bougie.
  for (const tf of [60, 300, 900, 1800, 3600, 14_400, 86_400]) {
    const lengths = new Set([tf - 1, Math.floor(tf / 2), 59, 0].filter((x) => x < tf).map((x) => formatTimeLeft(x, tf).length));
    assert.equal(lengths.size, 1, `unité de ${tf} s`);
  }
});
