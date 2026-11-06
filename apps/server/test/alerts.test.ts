// Alertes du graphique : franchissement d'un prix ou d'une ligne (toucher
// compte), une seule fois ou une fois par bougie, mèche entre deux cotations,
// clôture de bougie, oblique en position de bougie, ligne déplacée ou effacée,
// redémarrage, déclenchements à dire. Le flux de cotations et les bougies du
// courtier sont simulés ; l'horloge des alertes est injectée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { MarketService, type ChartCandle } from "../src/market/market.service.js";
import type { Quote } from "../src/market/quote-feed.js";
import { DrawingService } from "../src/dashboard/drawing.service.js";
import { AlertService, type AlertFired } from "../src/alerts/alert.service.js";
import { barStart, crossing, sideOf } from "../src/alerts/crossing.js";
import { alertNewsLine, describeAlert, firedTexts } from "../src/alerts/alert-texts.js";
import { alertReportPrompt } from "../src/session/prompts.js";
import { appleText } from "../src/alerts/desktop-notifier.js";
import { tempData, type TempData } from "./harness.js";

const GOLD = { symbol: "XAUUSD", name: "or", digits: 2 };
const HOUR = 3600;

/** Le service d'alertes sur un courtier simulé : cotations et extrêmes de la minute poussés à la main, bougies données par `candles`. */
function setup(opts: { candles?: (timeframe: string, limit: number) => ChartCandle[]; data?: TempData } = {}) {
  const data = opts.data ?? tempData("alerts", { KOPILIA_METAAPI_TOKEN: "jeton" });
  const { config, logger, db } = data;
  const market = new MarketService(config, logger);
  const watched: string[][] = [];
  market.feed.setAlertSymbols = (symbols: string[]) => void watched.push(symbols);
  let last: Quote | undefined;
  market.feed.latest = (symbol: string) => (last?.symbol === symbol ? last : undefined);
  const asked: string[] = [];
  market.chartCandles = async (symbol, timeframe, o = {}) => {
    asked.push(`${timeframe}:${o.limit}`);
    const all = opts.candles?.(timeframe, o.limit ?? 400) ?? [];
    return { symbol, timeframe, candles: all.slice(-(o.limit ?? 400)), more: false };
  };
  const drawings = new DrawingService(db, logger);
  const alerts = new AlertService(db, market, drawings, logger);
  // Un peu dans le passé : les tracés, datés à l'heure réelle, sont toujours plus récents.
  let clock = Date.now() - 60_000;
  alerts.now = () => clock;
  alerts.onModuleInit();
  const fired: AlertFired[] = [];
  alerts.on("triggered", (f) => fired.push(f));
  return {
    data,
    market,
    drawings,
    alerts,
    fired,
    watched,
    asked,
    now: () => clock,
    setClock: (t: number) => (clock = t),
    /** Une cotation de l'or (bid) à l'instant `at` (l'horloge avance jusque-là). */
    quote(bid: number, at = clock) {
      clock = Math.max(clock, at);
      last = { symbol: "XAUUSD", bid, time: at };
      market.feed.emit("quote", last);
    },
    /** Les extrêmes de la minute commencée à `start` (epoch ms). */
    range: (start: number, high: number, low: number) => market.feed.emit("range", "XAUUSD", { start, high, low }),
  };
}

/** Bougies d'une heure de l'or : `n` jusqu'à `last` (epoch s), en hausse de 10 par bougie depuis 3 900. */
function hourly(last: number, n: number, close?: (t: number) => number): ChartCandle[] {
  return Array.from({ length: n }, (_, k) => {
    const t = last - (n - 1 - k) * HOUR;
    const c = close?.(t) ?? 3900 + 10 * k;
    return { t, o: c, h: c + 2, l: c - 2, c };
  });
}

test("franchissement : le côté du prix ; toucher le niveau compte ; depuis le niveau même, rien", () => {
  assert.equal(sideOf(3951, 3950), 1);
  assert.equal(sideOf(3949, 3950), -1);
  assert.equal(sideOf(3950, 3950), 0);
  assert.equal(crossing(-1, 3950, 3950), "up", "toucher par-dessous");
  assert.equal(crossing(-1, 3949.99, 3950), undefined);
  assert.equal(crossing(1, 3950, 3950), "down");
  assert.equal(crossing(0, 3951, 3950), undefined, "il faut d'abord s'écarter du niveau");
  assert.equal(crossing(null, 3951, 3950), undefined, "côté pas encore connu");
  // Bougies d'une heure : celle qui contient l'instant, au pas au-delà de la dernière, les trous (nuit) gardés.
  const times = [0, HOUR, 2 * HOUR, 10 * HOUR];
  assert.equal(barStart(times, HOUR + 5, HOUR), HOUR);
  assert.equal(barStart(times, 5 * HOUR, HOUR), 2 * HOUR, "dans un trou : la dernière bougie ouverte");
  assert.equal(barStart(times, 12 * HOUR + 10, HOUR), 12 * HOUR, "au-delà : au pas de l'unité");
  assert.equal(barStart([], 7300, HOUR), 2 * HOUR, "sans bougie connue : alignée sur l'heure");
});

test("alerte de prix : sens déduit du cours, part une seule fois en touchant le niveau, puis s'arrête", () => {
  const t = setup();
  try {
    t.quote(3940);
    const a = t.alerts.create(GOLD, { target: { kind: "price", price: 3950 } }, "user");
    assert.match(a.id, /^a_[0-9a-f]{6}$/);
    assert.deepEqual([a.condition, a.trigger, a.timeframe, a.state], ["up", "once", "15m", "active"], "au-dessus du cours : la hausse");
    assert.deepEqual(t.watched.at(-1), ["XAUUSD"], "le flux suit le produit, même sans écran");

    t.quote(3949.99);
    assert.equal(t.fired.length, 0);
    t.quote(3950);
    assert.equal(t.fired.length, 1, "toucher suffit");
    assert.deepEqual([t.fired[0].direction, t.fired[0].price, t.fired[0].level], ["up", 3950, 3950]);
    const stopped = t.alerts.get(a.id)!;
    assert.deepEqual([stopped.state, stopped.triggeredPrice], ["triggered", 3950]);
    assert.deepEqual(t.watched.at(-1), [], "arrêtée : plus rien à suivre");
    t.quote(3940);
    t.quote(3960);
    assert.equal(t.fired.length, 1, "une seule fois");

    // À dire : une fois, puis plus.
    const news = t.alerts.undelivered();
    assert.deepEqual(
      news.map((n) => n.eventId),
      [t.fired[0].eventId],
    );
    t.alerts.markDelivered([news[0].eventId]);
    assert.deepEqual(t.alerts.undelivered(), []);

    // Réactivée : elle repart du prix du moment (au-dessus) ; il faut redescendre puis remonter.
    t.alerts.update(a.id, { state: "active" });
    t.quote(3961);
    t.quote(3945);
    assert.equal(t.fired.length, 1, "la baisse n'est pas attendue");
    t.quote(3951);
    assert.equal(t.fired.length, 2);
  } finally {
    t.data.cleanup();
  }
});

test("une fois par bougie : au plus un déclenchement par bougie, dans les deux sens", async () => {
  const t = setup();
  try {
    const bar = Math.floor(t.now() / 900_000) * 900_000 + 900_000;
    t.quote(3940, bar - 60_000);
    const a = t.alerts.create(GOLD, { target: { kind: "price", price: 3950 }, condition: "cross", trigger: "bar" }, "user");
    await sleep(5);
    t.quote(3951, bar + 60_000);
    t.quote(3949, bar + 120_000);
    assert.equal(t.fired.length, 1, "la baisse dans la même bougie de 15 minutes ne repart pas");
    t.quote(3951, bar + 16 * 60_000);
    assert.equal(t.fired.length, 2, "bougie suivante");
    assert.equal(t.alerts.get(a.id)!.state, "active", "elle continue");
  } finally {
    t.data.cleanup();
  }
});

test("ligne horizontale : l'alerte suit la ligne ; déplacée de l'autre côté du prix, rien ne part ; effacée, l'alerte aussi", () => {
  const t = setup();
  try {
    t.quote(3940);
    const d = t.drawings.create("XAUUSD", { kind: "hline", price: 3950 }, { by: "user", label: "résistance" });
    const a = t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: d.id } }, "user");
    assert.equal(a.condition, "cross", "une ligne : les deux sens");
    assert.throws(() => t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: d.id } }, "user"), /déjà une alerte/);

    t.drawings.update(d.id, { shape: { kind: "hline", price: 3930 } });
    t.quote(3941);
    assert.equal(t.fired.length, 0, "déplacée sous le prix : réarmée, pas déclenchée");
    t.quote(3929.5);
    assert.equal(t.fired.length, 1);
    assert.deepEqual([t.fired[0].direction, t.fired[0].level, t.fired[0].drawing?.label], ["down", 3930, "résistance"]);
    const { title, detail } = firedTexts(t.fired[0]);
    assert.equal(title, "Or : ligne « résistance » franchie à la baisse");
    assert.match(detail, /^3\s929,50 à \d\d:\d\d:\d\d · niveau 3\s930,00$/);

    t.drawings.remove([d.id]);
    assert.equal(t.alerts.get(a.id), undefined, "partie avec sa ligne");
  } finally {
    t.data.cleanup();
  }
});

test("Fibonacci : une alerte par niveau ; elle suit son niveau quand le tracé bouge, même au-delà de ses points", () => {
  const t = setup();
  try {
    t.quote(3990);
    // Un retracement s'arrête toujours dans le passé : ses niveaux restent surveillés après lui.
    const at = Math.floor(t.now() / 1000) - 6 * HOUR;
    const shape = (low: number) => ({ kind: "fib", a: { t: at, price: low }, b: { t: at + 2 * HOUR, price: low + 100 }, extend: false });
    const fib = t.drawings.create("XAUUSD", shape(3900), { by: "user", label: "swing" });
    const on = (level?: number) => ({ target: { kind: "drawing", drawingId: fib.id, ...(level !== undefined ? { level } : {}) } });
    assert.throws(() => t.alerts.create(GOLD, on(), "user"), /quel niveau de ce Fibonacci surveiller \(level\) : 0, 0,236, 0,382, 0,5, 0,618, 0,786, 1$/);
    assert.throws(() => t.alerts.create(GOLD, on(1.618), "user"), /pas de niveau 1,618/);
    const a = t.alerts.create(GOLD, on(0.382), "user");
    assert.deepEqual([a.target, a.condition], [{ kind: "drawing", drawingId: fib.id, level: 0.382 }, "cross"]);
    assert.throws(() => t.alerts.create(GOLD, on(0.382), "user"), /ce niveau a déjà une alerte/);
    const deep = t.alerts.create(GOLD, on(0.618), "user");
    assert.match(
      describeAlert(a, fib),
      /^sur le niveau 0,382 \(3\s961,80\) du retracement de Fibonacci de 3\s900,00 \(.+\) à 4\s000,00 \(.+\) « swing » \(d_[0-9a-f]{6}\) : franchissement/,
    );

    t.quote(3970);
    assert.equal(t.fired.length, 0);
    t.quote(3961);
    assert.equal(t.fired.length, 1, "le 0,382 (3 961,80) touché à la baisse");
    assert.deepEqual([t.fired[0].alert.id, t.fired[0].direction, Number(t.fired[0].level.toFixed(2))], [a.id, "down", 3961.8]);
    assert.equal(firedTexts(t.fired[0]).title, "Or : niveau 0,382 du retracement « swing » franchi à la baisse");
    assert.match(
      alertNewsLine(t.fired[0]),
      /le prix a franchi à la baisse le niveau 0,382 du retracement de Fibonacci de 3\s900,00 .+ « swing », à 3\s961,80 ;/,
    );

    // Monté de 50 : le 0,618 passe à 3 988,20, réarmé depuis le prix du moment.
    t.drawings.update(fib.id, { shape: shape(3950) });
    t.quote(3980);
    assert.equal(t.fired.length, 1);
    t.quote(3989);
    assert.equal(t.fired.length, 2);
    assert.deepEqual([t.fired[1].alert.id, t.fired[1].direction, Number(t.fired[1].level.toFixed(2))], [deep.id, "up", 3988.2]);

    const line = t.drawings.create("XAUUSD", { kind: "hline", price: 3000 }, { by: "user" });
    assert.throws(() => t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: line.id, level: 0.5 } }, "user"), /seul un Fibonacci a des niveaux/);
    t.drawings.remove([fib.id]);
    assert.equal(t.alerts.get(deep.id), undefined, "parties avec leur Fibonacci");
  } finally {
    t.data.cleanup();
  }
});

test("Fibonacci : une extension, ses niveaux au-delà de 1 ; dite « de l'extension »", () => {
  const t = setup();
  try {
    t.quote(4000);
    const at = Math.floor(t.now() / 1000) - 6 * HOUR;
    const ext = t.drawings.create(
      "XAUUSD",
      { kind: "fibext", a: { t: at, price: 3900 }, b: { t: at + HOUR, price: 3950 }, c: { t: at + 2 * HOUR, price: 3940 }, extend: false },
      { by: "user" },
    );
    const a = t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: ext.id, level: 1.618 } }, "user");
    assert.match(describeAlert(a, ext), /^sur le niveau 1,618 \(4\s020,90\) de l'extension de Fibonacci de l'impulsion/);
    t.quote(4021);
    assert.equal(firedTexts(t.fired[0]).title, "Or : niveau 1,618 de l'extension franchi à la hausse");
  } finally {
    t.data.cleanup();
  }
});

test("oblique : niveau calculé en position de bougie, comme sur le graphique ; non prolongée, elle expire à son bout", async () => {
  const last = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const t = setup({ candles: (tf) => (tf === "1h" ? hourly(last, 11) : []) });
  try {
    t.setClock((last + HOUR / 2) * 1000);
    // De 3 900 (il y a 10 bougies) à 4 000 (la dernière) : +10 par bougie ; prolongée, 4 005 à la moitié de la bougie en cours.
    const d = t.drawings.create(
      "XAUUSD",
      { kind: "trendline", a: { t: last - 10 * HOUR, price: 3900 }, b: { t: last, price: 4000 }, extend: true },
      { by: "user" },
    );
    t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: d.id }, timeframe: "1h" }, "user");
    t.quote(3990);
    await sleep(5); // bougies chargées
    t.quote(3990);
    t.quote(4004.9);
    assert.equal(t.fired.length, 0);
    t.quote(4005);
    assert.equal(t.fired.length, 1);
    assert.equal(t.fired[0].level, 4005);
    assert.ok(
      t.asked.every((q) => q.startsWith("1h:")),
      "dans l'unité de l'alerte",
    );
    assert.match(
      alertNewsLine(t.fired[0], t.now()),
      /^or \(XAUUSD\) : le prix a franchi à la hausse l'oblique de 3\s900,00 .*, qui passait à 4\s005,00 ; il était à 4\s005,00, à \d\d:\d\d:\d\d$/,
    );

    // Une oblique qui s'arrête avant maintenant ne peut pas en porter.
    const short = t.drawings.create(
      "XAUUSD",
      { kind: "trendline", a: { t: last - 3 * HOUR, price: 3990 }, b: { t: last - HOUR, price: 3995 }, extend: false },
      { by: "user" },
    );
    assert.throws(() => t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: short.id } }, "user"), /prolonge-la/);

    // Qui s'arrête dans une heure : l'alerte expire à son bout, et repart si on la prolonge.
    const ending = t.drawings.create(
      "XAUUSD",
      { kind: "trendline", a: { t: last - HOUR, price: 3000 }, b: { t: last + HOUR, price: 3002 }, extend: false },
      { by: "user" },
    );
    const e = t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: ending.id }, timeframe: "1h" }, "user");
    t.quote(4010, (last + 2 * HOUR) * 1000);
    assert.equal(t.alerts.get(e.id)!.state, "expired");
    t.drawings.update(ending.id, { shape: { ...ending, extend: true } });
    assert.equal(t.alerts.get(e.id)!.state, "active", "prolongée : elle repart");
  } finally {
    t.data.cleanup();
  }
});

test("mèche : le plus haut de la minute atteint le niveau entre deux cotations", () => {
  const t = setup();
  try {
    t.quote(3940);
    t.alerts.create(GOLD, { target: { kind: "price", price: 3950 } }, "user");
    // Une minute commencée avant l'alerte : son plus haut a pu être atteint avant, il ne compte pas.
    const before = Math.floor(t.now() / 60_000) * 60_000;
    t.range(before, 3955, 3938);
    assert.equal(t.fired.length, 0, "plus haut peut-être antérieur à l'alerte");

    const minute = before + 60_000;
    t.setClock(minute + 1_000);
    t.quote(3941);
    t.range(minute, 3945, 3939);
    assert.equal(t.fired.length, 0);
    t.range(minute, 3951.5, 3939);
    assert.equal(t.fired.length, 1);
    assert.deepEqual([t.fired[0].wick, t.fired[0].price], [true, 3951.5]);
    assert.match(firedTexts(t.fired[0]).detail, /\(mèche\)/);
  } finally {
    t.data.cleanup();
  }
});

test("sur clôture : seule la bougie close au-delà compte, relue chez le courtier", async () => {
  const last = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  // La bougie de `last` clôture à 3 952, au-dessus du niveau ; les précédentes, en dessous.
  const t = setup({ candles: () => hourly(last + HOUR, 12, (k) => (k === last ? 3952 : k > last ? 3956 : 3940)) });
  try {
    t.setClock((last + 600) * 1000);
    t.quote(3940);
    t.alerts.create(GOLD, { target: { kind: "price", price: 3950 }, trigger: "close", timeframe: "1h" }, "user");
    t.quote(3955, (last + 1800) * 1000);
    await sleep(5);
    assert.equal(t.fired.length, 0, "une mèche au-dessus ne compte pas");
    t.quote(3956, (last + HOUR + 10) * 1000);
    await sleep(10);
    assert.equal(t.fired.length, 1);
    assert.deepEqual([t.fired[0].close, t.fired[0].price, t.fired[0].at], [true, 3952, (last + HOUR) * 1000]);
    assert.match(alertNewsLine(t.fired[0], t.now()), /une bougie de 1 heure a clôturé de l'autre côté, à 3\s952,00/);
  } finally {
    t.data.cleanup();
  }
});

test("sur clôture : une clôture que le courtier n'a pas rendue (coupure) est redemandée, puis jugée dans l'ordre, sans sauter de bougie", async () => {
  const last = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  // La bougie de `last` clôture à 3 952, au-dessus du niveau ; celle d'après revient dessous, à 3 945.
  const t = setup({ candles: () => hourly(last + 2 * HOUR, 12, (k) => (k === last ? 3952 : k > last ? 3945 : 3940)) });
  const served = t.market.chartCandles;
  let down = true;
  let refused = 0;
  t.market.chartCandles = async (symbol, timeframe, o) => {
    if (down && o?.limit !== undefined && o.limit < 30) {
      refused++;
      return { error: "MetaApi momentanément indisponible (HTTP 504 : le compte se reconnecte au courtier)" };
    }
    return served(symbol, timeframe, o);
  };
  try {
    t.setClock((last + 600) * 1000);
    t.quote(3940);
    t.alerts.create(GOLD, { target: { kind: "price", price: 3950 }, trigger: "close", timeframe: "1h" }, "user");
    t.quote(3946, (last + 1800) * 1000);
    await sleep(5);
    // La bougie de `last` clôture pendant la coupure : sa clôture n'est pas lue.
    t.quote(3946, (last + HOUR + 10) * 1000);
    await sleep(10);
    assert.equal(refused, 1);
    t.quote(3946, (last + HOUR + 20) * 1000);
    await sleep(10);
    assert.equal(refused, 1, "pas redemandée avant 15 s");
    // Toujours coupé quand la bougie suivante clôture ; puis le courtier répond.
    t.quote(3945, (last + 2 * HOUR + 10) * 1000);
    await sleep(10);
    assert.equal(refused, 2);
    assert.equal(t.fired.length, 0);
    down = false;
    t.quote(3945, (last + 2 * HOUR + 30) * 1000);
    await sleep(10);
    assert.equal(t.fired.length, 1, "la bougie manquée est jugée, pas sautée");
    assert.deepEqual([t.fired[0].close, t.fired[0].price, t.fired[0].at], [true, 3952, (last + HOUR) * 1000]);
  } finally {
    t.data.cleanup();
  }
});

test("à la clôture après contact : rien au contact ; à la clôture de la bougie qui a touché, une fois, avec la bougie et son verdict", async () => {
  const last = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  // La bougie du contact (`last`) : descendue à 3 946 dans la zone 3 940 – 3 950, close à 3 955, revenue au-dessus.
  const candles = (closeOf: number) => () =>
    hourly(last + HOUR, 12, (k) => (k === last ? closeOf : 3960)).map((c) => (c.t === last ? { ...c, o: 3961, h: 3962, l: 3946 } : c));
  for (const [close, verdict, said] of [
    [3955, "rejection", /bougie de rejet : mèche dans la zone, clôture revenue au-dessus/],
    [3945, "inside", /clôture dans la zone, pas de rejet pour l'instant/],
    [3935, "break", /clôture sous la zone : cassure/],
  ] as const) {
    const t = setup({ candles: candles(close) });
    try {
      t.setClock((last + 600) * 1000);
      const zone = t.drawings.create("XAUUSD", { kind: "zone", top: 3950, bottom: 3940 }, { by: "user", label: "support" });
      t.quote(3960);
      const a = t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: zone.id }, trigger: "touch_close", timeframe: "1h" }, "user");
      t.quote(3946, (last + 1200) * 1000); // le contact : rien ne part encore
      t.quote(3958, (last + 1800) * 1000);
      t.quote(3944, (last + 2400) * 1000); // un second contact dans la même bougie ne compte pas en plus
      await sleep(5);
      assert.equal(t.fired.length, 0, `${verdict} : rien au contact`);
      t.quote(3958, (last + HOUR + 10) * 1000); // la bougie suivante commence : celle du contact est close
      await sleep(10);
      assert.equal(t.fired.length, 1, verdict);
      const f = t.fired[0];
      assert.deepEqual([f.verdict, f.close, f.price, f.at, f.direction, f.touchPrice], [verdict, true, close, (last + HOUR) * 1000, "down", 3946]);
      assert.deepEqual(f.candle, { t: last, o: 3961, h: 3962, l: 3946, c: close });
      assert.equal(t.alerts.get(a.id)!.state, "triggered", "elle part une fois, puis s'arrête");
      const news = alertNewsLine(f, t.now());
      assert.match(news, /le prix est entré dans la zone 3\s940,00 – 3\s950,00 « support » \(3\s946,00\), puis la bougie de 1 heure du contact a clôturé à/);
      assert.match(news, said);
      assert.match(
        firedTexts(f).title,
        verdict === "rejection"
          ? /^Or : bougie de rejet sur la zone « support »$/
          : verdict === "break"
            ? /^Or : cassure de la zone « support »$/
            : /^Or : bougie close dans la zone « support »$/,
      );
      assert.match(firedTexts(f).detail, /bougie 1 heure : ouverture 3\s961,00, plus haut 3\s962,00, plus bas 3\s946,00/);
      assert.match(describeAlert(t.alerts.get(a.id)!, zone), /à la clôture de la bougie de 1 heure qui la touche/);
      t.quote(3946, (last + HOUR + 600) * 1000);
      await sleep(5);
      assert.equal(t.fired.length, 1, "déclenchée : plus rien");
    } finally {
      t.data.cleanup();
    }
  }
});

test("à la clôture après contact : un contact par une mèche arme aussi l'attente ; sur une ligne venue d'en bas, une clôture revenue dessous est un rejet", async () => {
  const last = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const t = setup({ candles: () => hourly(last + HOUR, 12, (k) => (k === last ? 3946 : 3940)).map((c) => (c.t === last ? { ...c, h: 3953 } : c)) });
  try {
    t.setClock((last + 600) * 1000);
    const line = t.drawings.create("XAUUSD", { kind: "hline", price: 3950 }, { by: "user", label: "résistance" });
    t.quote(3940);
    t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: line.id }, trigger: "touch_close", timeframe: "1h" }, "user");
    t.quote(3945, (last + 1200) * 1000);
    t.range((last + 1200) * 1000, 3953, 3944); // la mèche touche la ligne entre deux cotations
    t.quote(3945, (last + 1300) * 1000);
    await sleep(5);
    assert.equal(t.fired.length, 0);
    t.quote(3944, (last + HOUR + 5) * 1000);
    await sleep(10);
    assert.equal(t.fired.length, 1);
    assert.deepEqual([t.fired[0].verdict, t.fired[0].direction, t.fired[0].touchPrice], ["rejection", "up", 3953]);
    assert.match(alertNewsLine(t.fired[0], t.now()), /bougie de rejet : mèche sur la ligne, clôture revenue en dessous/);
    assert.equal(firedTexts(t.fired[0]).title, "Or : bougie de rejet sur la ligne « résistance »");
  } finally {
    t.data.cleanup();
  }
});

test("redémarrage : le côté du prix est gardé ; franchie pendant l'arrêt, elle part au premier prix, en le disant", () => {
  const t = setup();
  try {
    t.quote(3940);
    t.alerts.create(GOLD, { target: { kind: "price", price: 3950 }, message: "regarde le RSI 1 heure" }, "kopilia");
    // Un autre serveur sur la même base : le flux de l'ancien ne parle plus.
    const reborn = setup({ data: t.data });
    reborn.quote(3962);
    assert.equal(t.fired.length, 0);
    assert.equal(reborn.fired.length, 1);
    assert.equal(reborn.fired[0].whileAway, true);
    assert.match(firedTexts(reborn.fired[0]).detail, /pendant l'arrêt du serveur/);
    const prompt = alertReportPrompt([{ line: alertNewsLine(reborn.fired[0]), message: reborn.fired[0].alert.message }]);
    assert.match(prompt, /^\[Alerte\] Une alerte que l'utilisateur a posée vient de partir :/);
    assert.match(prompt, /Sa consigne pour cette alerte : « regarde le RSI 1 heure »/);
    assert.match(prompt, /pendant que le serveur était arrêté/);
    assert.match(alertReportPrompt([{ line: "x" }], true), /« Pendant ton absence »/);
  } finally {
    t.data.cleanup();
  }
});

test("refus lisibles : zone terminée, verticale, Fibonacci, tracé inconnu, prix, réglages ; plafond par produit", () => {
  const t = setup();
  try {
    const zone = t.drawings.create("XAUUSD", { kind: "zone", top: 3960, bottom: 3950, to: 1000 }, { by: "user" });
    const vertical = t.drawings.create("XAUUSD", { kind: "trendline", a: { t: 1000, price: 1 }, b: { t: 1000, price: 2 }, extend: false }, { by: "user" });
    const create =
      (target: unknown, extra = {}) =>
      () =>
        t.alerts.create(GOLD, { target, ...extra }, "user");
    assert.throws(create({ kind: "drawing", drawingId: zone.id }), /cette zone s'arrête avant maintenant/);
    assert.throws(create({ kind: "drawing", drawingId: vertical.id }), /verticale/);
    // Sur un Fibonacci, il faut dire quel niveau.
    const fib = t.drawings.create("XAUUSD", { kind: "fib", a: { t: 1000, price: 3900 }, b: { t: 4600, price: 4000 }, extend: true }, { by: "user" });
    assert.throws(create({ kind: "drawing", drawingId: fib.id }), /quel niveau de ce Fibonacci/);
    // Une boîte de trade : l'alerte se pose au prix de son entrée, de son stop ou de son objectif.
    const box = t.drawings.create("XAUUSD", { kind: "position", side: "long", entry: 3950, stop: 3940, target: 3970, from: 1000 }, { by: "user" });
    assert.throws(create({ kind: "drawing", drawingId: box.id }), /boîte de trade ne porte pas d'alerte/);
    assert.throws(create({ kind: "drawing", drawingId: "d_000000" }), /aucun tracé/);
    assert.throws(create({ kind: "price", price: -1 }), /dis où poser l'alerte/);
    assert.throws(create({ kind: "price", price: 1 }, { condition: "touche" }), /condition inconnue/);
    assert.throws(create({ kind: "price", price: 1 }, { trigger: "souvent" }), /déclenchement inconnu/);
    assert.throws(create({ kind: "price", price: 1 }, { timeframe: "2h" }), /unité de temps inconnue/);
    // Les bougies d'un mois n'ont pas de durée fixe : pas d'alerte à la bougie ni à la clôture en mensuel ; en hebdo, si.
    for (const trigger of ["bar", "close", "touch_close"]) {
      assert.throws(create({ kind: "price", price: 1 }, { trigger, timeframe: "1mn" }), /pas du mois/, trigger);
    }
    const weekly = t.alerts.create(GOLD, { target: { kind: "price", price: 3900 }, trigger: "close", timeframe: "1w" }, "user");
    assert.equal(weekly.timeframe, "1w");
    t.alerts.remove([weekly.id]);
    assert.equal(t.alerts.create(GOLD, { target: { kind: "price", price: 3900 }, timeframe: "1mn" }, "user").trigger, "once");
    assert.throws(create({ kind: "price", price: 1 }, { message: "x".repeat(301) }), /300 caractères/);
    for (let k = 0; k < 19; k++) t.alerts.create(GOLD, { target: { kind: "price", price: 4000 + k } }, "user");
    assert.throws(create({ kind: "price", price: 1 }), /20 alertes au plus/);
    const a = t.alerts.list(["XAUUSD"])[0];
    assert.throws(() => t.alerts.update(a.id, { price: 0 }), /nombre positif/);
    assert.throws(() => t.alerts.update("a_nope", { state: "paused" }), /aucune alerte/);
  } finally {
    t.data.cleanup();
  }
});

test("textes : l'alerte pour Kopilia ; suspendue, plus rien ne part", () => {
  const t = setup();
  try {
    t.quote(3960);
    const a = t.alerts.create(GOLD, { target: { kind: "price", price: 3950 }, trigger: "close", timeframe: "1h", message: "dis-moi si ça tient" }, "user");
    assert.equal(describeAlert(a), "à 3\u202f950,00 : franchit à la baisse, sur clôture de bougie de 1 heure, active ; consigne : « dis-moi si ça tient »");
    const paused = t.alerts.update(a.id, { state: "paused", message: null });
    assert.equal(describeAlert(paused), "à 3\u202f950,00 : franchit à la baisse, sur clôture de bougie de 1 heure, suspendue");
    assert.deepEqual(t.watched.at(-1), [], "suspendue : plus suivie");
    t.quote(3900);
    assert.equal(t.fired.length, 0);
    assert.equal(appleText('Or : "R1" \\ franchie'), '"Or : \\"R1\\" \\\\ franchie"');
  } finally {
    t.data.cleanup();
  }
});
