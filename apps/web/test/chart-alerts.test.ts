// Les alertes vues du graphique, sans écran : l'alerte qu'on règle (à un prix,
// sur une ligne, existante), son titre, sa ligne dans la liste, les erreurs.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert, Drawing } from "@kopilia/contracts";
import { alertLabel, alertOn, alertStatus, canWatch, draftError, draftOf, draftTitle, lineDraft, priceDraft } from "../src/app/dashboard/chart-alerts";

const meta = { symbol: "XAUUSD", createdBy: "user", createdAt: 1, updatedAt: 1 } as const;
const resistance: Drawing = { ...meta, id: "d_1", kind: "hline", price: 3950, label: "résistance" };
const trend: Drawing = { ...meta, id: "d_2", kind: "trendline", a: { t: 0, price: 3900 }, b: { t: 3600, price: 3910 }, extend: true };
const vertical: Drawing = { ...meta, id: "d_3", kind: "trendline", a: { t: 0, price: 3900 }, b: { t: 0, price: 3910 }, extend: false };
const zone: Drawing = { ...meta, id: "d_4", kind: "zone", top: 3960, bottom: 3950 };

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: "a_1",
  symbol: "XAUUSD",
  name: "or",
  digits: 2,
  target: { kind: "price", price: 3960 },
  condition: "up",
  trigger: "once",
  timeframe: "1h",
  state: "active",
  createdBy: "user",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const chip = (tf: string) => ({ "1h": "1h", "15m": "15m" })[tf] ?? tf;

test("alerte à un prix : son sens d'après le cours, dans l'unité du graphique", () => {
  assert.deepEqual(priceDraft(3960, 3940, "15m"), { target: { kind: "price", price: 3960 }, condition: "up", trigger: "once", timeframe: "15m", message: "" });
  assert.equal(priceDraft(3930, 3940, "15m").condition, "down");
  assert.equal(priceDraft(3930, undefined, "15m").condition, "cross", "sans cours : les deux sens");
  assert.equal(draftTitle(priceDraft(3960, 3940, "15m"), [], 2), "Nouvelle alerte à 3\u202f960,00");
});

test("alerte sur un tracé : les deux sens ; lignes horizontales, obliques et zones en portent, pas une verticale", () => {
  assert.deepEqual(lineDraft(resistance, "1h"), {
    target: { kind: "drawing", drawingId: "d_1" },
    condition: "cross",
    trigger: "once",
    timeframe: "1h",
    message: "",
  });
  assert.equal(draftTitle(lineDraft(resistance, "1h"), [resistance], 2), "Nouvelle alerte sur la ligne « résistance »");
  assert.equal(draftTitle(lineDraft(trend, "1h"), [trend], 2), "Nouvelle alerte sur l'oblique");
  assert.equal(draftTitle(lineDraft(zone, "1h"), [zone], 2), "Nouvelle alerte sur la zone");
  assert.deepEqual([canWatch(resistance), canWatch(trend), canWatch(vertical), canWatch(zone)], [true, true, false, true], "une zone aussi : on y entre");
  assert.equal(canWatch({ ...zone, createdBy: "ia", scenarioId: "sc_1" }), false, "un niveau de l'IA se garde d'abord");
  const fib: Drawing = { ...meta, id: "d_5", kind: "fib", a: trend.a, b: trend.b, extend: false };
  assert.equal(canWatch(fib), true, "sur un de ses niveaux");
  assert.equal(canWatch({ ...fib, kind: "fibext", c: trend.a }), true);
});

test("alerte existante : réglée telle quelle ; partie, l'enregistrer la réarme", () => {
  const a = alert({ message: "regarde le RSI", state: "triggered", triggeredAt: Date.now() });
  const d = draftOf(a);
  assert.deepEqual(d, {
    id: "a_1",
    target: { kind: "price", price: 3960 },
    condition: "up",
    trigger: "once",
    timeframe: "1h",
    message: "regarde le RSI",
    stopped: "triggered",
  });
  assert.equal(draftTitle(d, [], 2), "Alerte à 3\u202f960,00");
});

test("la liste : ce que surveille l'alerte, son sens, son mode, son état", () => {
  assert.equal(alertLabel(alert(), [], 2), "3\u202f960,00 · à la hausse");
  assert.equal(
    alertLabel(alert({ target: { kind: "drawing", drawingId: "d_1" }, condition: "cross" }), [resistance], 2),
    "Ligne « résistance » · les deux sens",
  );
  assert.equal(alertLabel(alert({ target: { kind: "drawing", drawingId: "d_2" }, condition: "down" }), [trend], 2), "Oblique · à la baisse");
  assert.equal(alertStatus(alert(), chip), "une seule fois");
  assert.equal(alertStatus(alert({ trigger: "close", state: "paused" }), chip), "sur clôture 1h · suspendue");
  assert.equal(alertStatus(alert({ trigger: "bar" }), chip), "une fois par bougie 1h");
  assert.equal(alertStatus(alert({ trigger: "touch_close" }), chip), "clôture après contact 1h");
  assert.match(alertStatus(alert({ state: "triggered", triggeredAt: Date.now() }), chip), /^partie à \d\d:\d\d$/);
  assert.equal(alertStatus(alert({ state: "expired" }), chip), "expirée");
});

test("réglages : un prix positif, une consigne de 300 caractères au plus", () => {
  assert.equal(draftError(priceDraft(3960, 3940, "15m")), undefined);
  assert.match(draftError({ ...priceDraft(3960, 3940, "15m"), target: { kind: "price", price: NaN } })!, /nombre positif/);
  assert.match(draftError({ ...priceDraft(3960, 3940, "15m"), message: "x".repeat(301) })!, /300 caractères/);
});

test("Fibonacci : une alerte par niveau, nommée par son ratio et son prix", () => {
  // Retracement de 3 900 (a) à 3 910 (b) : le 0,618 à 3 903,82.
  const fib: Drawing = { ...meta, id: "d_5", kind: "fib", a: trend.a, b: trend.b, extend: false, label: "swing" };
  const draft = lineDraft(fib, "1h", 0.618);
  assert.deepEqual(draft.target, { kind: "drawing", drawingId: "d_5", level: 0.618 });
  assert.equal(draftTitle(draft, [fib], 2), "Nouvelle alerte sur le niveau 0,618 (3\u202f903,82) du retracement « swing »");
  const ext: Drawing = { ...meta, id: "d_6", kind: "fibext", a: trend.a, b: trend.b, c: { t: 7200, price: 3905 }, extend: false };
  const onExt = alert({ id: "a_6", target: { kind: "drawing", drawingId: "d_6", level: 1.618 }, condition: "cross" });
  assert.equal(alertLabel(onExt, [ext], 2), "Niveau 1,618 (3\u202f921,18) de l'extension · les deux sens");
  assert.deepEqual(draftOf(onExt).target, { kind: "drawing", drawingId: "d_6", level: 1.618 }, "réglée, elle garde son niveau");
  const onFib = alert({ id: "a_5", target: { kind: "drawing", drawingId: "d_5", level: 0.618 } });
  assert.equal(alertOn([onExt, onFib], "d_5", 0.618)?.id, "a_5");
  assert.equal(alertOn([onExt, onFib], "d_5", 0.5), undefined, "un autre niveau : pas encore d'alerte");
  assert.equal(alertOn([onFib], "d_5"), undefined);
});
