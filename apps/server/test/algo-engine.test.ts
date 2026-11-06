// Le moteur de backtest : décisions à la clôture exécutées à l'ouverture
// suivante, écart et glissement comptés, stop et objectif sur les extrêmes,
// même bougie départagée par les minutes ou par le stop, ordres en attente,
// aucune bougie future visible ; les mesures et la coupe ; le bac à sable
// (compilation TypeScript, interdits, délai).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/algo/engine/engine.js";
import { breakdown, equityCurve, metrics, quarterOf, thinCurve } from "../src/algo/engine/metrics.js";
import { splitPeriod, splitTrades } from "../src/algo/engine/split.js";
import { parisClock, sessionOf } from "../src/algo/engine/paris.js";
import type { Bar, Ctx, Robot, RunInput } from "../src/algo/engine/types.js";
import { compileRobot, runRobot } from "../src/algo/sandbox.js";
import { judge } from "@kopilia/contracts";

/** Lundi 3 novembre 2025, 9 h 00 à Paris (8 h UTC). */
const T0 = Date.UTC(2025, 10, 3, 8, 0) / 1000;
const TF = 900;
const COSTS = { spread: 2, commission: 0, slippage: 0 };

/** Des bougies plates à `price`, une par quart d'heure. */
function flat(n: number, price = 20_000, from = T0): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: from + i * TF, o: price, h: price + 1, l: price - 1, c: price }));
}

function input(bars: Bar[], extra: Partial<RunInput> = {}): RunInput {
  return { symbol: "NAS100", timeframe: "15m", bars, costs: COSTS, seconds: { "15m": 900, "1h": 3600, "1m": 60 }, ...extra };
}

/** Un robot qui achète une fois, à la bougie `at`, avec un stop et un objectif donnés. */
function buyer(at: number, stop: number, target?: number, extra: Partial<Robot> = {}): Robot {
  return { warmup: 0, onBar: (ctx: Ctx) => ctx.index === at && !ctx.position && ctx.buy({ stop, target }), ...extra };
}

test("moteur : une décision à la clôture entre à l'ouverture suivante, au bid + écart ; le stop touché rend −1 R net", () => {
  const bars = flat(10);
  // La bougie 6 descend jusqu'au stop.
  bars[6] = { ...bars[6], l: 19_950 };
  const out = runBacktest(buyer(4, 19_960), input(bars));
  assert.equal(out.error, undefined);
  assert.equal(out.trades.length, 1);
  const t = out.trades[0];
  assert.equal(t.entryIndex, 5);
  assert.equal(t.entry, 20_002); // ouverture 20 000 + écart 2
  assert.equal(t.exitIndex, 6);
  assert.equal(t.exit, 19_960);
  assert.equal(t.reason, "stop");
  assert.equal(t.r, -1); // (19 960 − 20 002) / (20 002 − 19 960)
});

test("moteur : l'objectif touché rend son multiple ; le stop d'une vente se lit à l'ask ; un gap sur le stop sort à l'ouverture", () => {
  const bars = flat(10);
  bars[7] = { ...bars[7], h: 20_090 };
  const long = runBacktest(buyer(4, 19_962, 20_082), input(bars)); // risque 40, objectif 80 : 2 R
  assert.equal(long.trades[0].reason, "objectif");
  assert.equal(long.trades[0].r, 2);

  const sell: Robot = { warmup: 0, onBar: (ctx) => ctx.index === 4 && !ctx.position && ctx.sell({ stop: 20_040 }) };
  const b2 = flat(10);
  b2[6] = { ...b2[6], h: 20_039 }; // bid 20 039, ask 20 041 ≥ stop 20 040 : touché par l'ask
  const short = runBacktest(sell, input(b2));
  assert.equal(short.trades[0].reason, "stop");
  assert.equal(short.trades[0].exit, 20_040);

  const b3 = flat(10);
  b3[6] = { ...b3[6], o: 19_900, h: 19_901, l: 19_899, c: 19_900 }; // gap sous le stop
  const gap = runBacktest(buyer(4, 19_960), input(b3));
  assert.equal(gap.trades[0].exit, 19_900);
  assert.ok(gap.trades[0].r < -1);
});

test("moteur : stop et objectif dans la même bougie, c'est le stop sans les minutes, et les minutes départagent", () => {
  const bars = flat(10);
  bars[6] = { ...bars[6], h: 20_100, l: 19_900 };
  const prudent = runBacktest(buyer(4, 19_962, 20_082), input(bars));
  assert.equal(prudent.trades[0].reason, "stop");
  // Les minutes de la bougie 6 : l'objectif d'abord, le stop ensuite.
  const minute: Bar[] = [];
  for (let k = 0; k < 15; k++) {
    const t = bars[6].t + k * 60;
    minute.push(k < 5 ? { t, o: 20_000, h: 20_100, l: 20_000, c: 20_050 } : { t, o: 20_050, h: 20_050, l: 19_900, c: 19_950 });
  }
  const resolved = runBacktest(buyer(4, 19_962, 20_082), input(bars, { minute }));
  assert.equal(resolved.trades[0].reason, "objectif");
  assert.equal(resolved.trades[0].r, 2);
});

test("moteur : un ordre à cours limité se remplit quand l'ask descend dessus, sans glissement, et expire", () => {
  const bars = flat(12);
  bars[7] = { ...bars[7], l: 19_940 }; // ask bas 19 942 ≤ limite 19 950
  const limit: Robot = { warmup: 0, onBar: (ctx) => ctx.index === 4 && !ctx.position && !ctx.pending && ctx.buy({ limit: 19_950, stop: 19_900 }) };
  const out = runBacktest(limit, input(bars, { costs: { ...COSTS, slippage: 1 } }));
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0].entryIndex, 7);
  assert.equal(out.trades[0].entry, 19_950);
  assert.equal(out.trades[0].reason, "fin");

  const expiring: Robot = {
    warmup: 0,
    onBar: (ctx) => ctx.index === 4 && !ctx.position && !ctx.pending && ctx.buy({ limit: 19_950, stop: 19_900, expires: 1 }),
  };
  assert.equal(runBacktest(expiring, input(bars)).trades.length, 0);
});

test("moteur : le robot ne voit que des bougies closes, le contexte 1 h seulement ses bougies closes, et l'heure de Paris", () => {
  const bars = flat(12);
  const hourly = flat(3, 20_000, T0).map((b, i) => ({ ...b, t: T0 + i * 3600 }));
  const seen: Array<{ index: number; length: number; ctx: number; session: string; hour: number }> = [];
  const spy: Robot = {
    warmup: 0,
    onBar: (ctx) => {
      assert.equal(ctx.series.length, ctx.index + 1);
      assert.equal(ctx.series.bar(0).t, ctx.time);
      assert.throws(() => ctx.series.bar(ctx.index + 1));
      seen.push({ index: ctx.index, length: ctx.series.length, ctx: ctx.context("1h").length, session: ctx.clock.session, hour: ctx.clock.hour });
    },
  };
  const out = runBacktest(spy, input(bars, { context: { "1h": hourly } }));
  assert.equal(out.error, undefined);
  // La première bougie 1 h (8 h → 9 h UTC) n'est close qu'à la clôture de la 4e bougie de 15 min.
  assert.deepEqual(
    seen.slice(0, 5).map((s) => s.ctx),
    [0, 0, 0, 1, 1],
  );
  assert.equal(seen[0].hour, 9);
  assert.equal(seen[0].session, "london");
  assert.match(runBacktest(spy, input(bars)).error ?? "", /contexte 1h non chargée/);
});

test("moteur : une erreur du robot arrête le backtest en disant la bougie ; un stop du mauvais côté est refusé", () => {
  const broken: Robot = {
    warmup: 0,
    onBar: (ctx) => {
      if (ctx.index === 3) throw new Error("boum");
    },
  };
  const out = runBacktest(broken, input(flat(10)));
  assert.match(out.error ?? "", /boum \(bougie 3/);
  const wrong = runBacktest(buyer(2, 20_500), input(flat(10)));
  assert.equal(wrong.trades.length, 0);
  assert.match(wrong.logs[0], /refusée/);
  assert.throws(() => {
    const r = runBacktest({ warmup: 0, onBar: (ctx) => ctx.buy({ stop: NaN }) }, input(flat(3)));
    if (r.error) throw new Error(r.error);
  }, /exige un stop/);
});

test("mesures : espérance, gagnants, facteur de profit, drawdown, pire série, trimestres ; courbe allégée ; tranches", () => {
  const mk = (r: number, at: number, side: "long" | "short" = "long") => ({
    symbol: "X",
    side,
    entryIndex: 0,
    exitIndex: 1,
    entryAt: at,
    exitAt: at + 900,
    entry: 1,
    exit: 1,
    stop: 0,
    r,
    reason: r > 0 ? "objectif" : "stop",
    mae: 0,
    mfe: 0,
    bars: 1,
  });
  const q1 = Date.UTC(2025, 0, 15) / 1000;
  const q2 = Date.UTC(2025, 4, 15) / 1000;
  const trades = [mk(2, q1), mk(-1, q1 + 3600), mk(-1, q1 + 7200), mk(-1, q2), mk(3, q2 + 3600, "short")];
  const m = metrics(trades);
  assert.equal(m.trades, 5);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 3);
  assert.equal(m.winRate, 0.4);
  assert.equal(Math.round(m.avgR * 100) / 100, 0.4);
  assert.equal(m.totalR, 2);
  assert.equal(m.profitFactor, 5 / 3);
  assert.equal(m.maxDrawdownR, -3);
  assert.equal(m.longestLosingStreak, 3);
  assert.equal(m.windows, 2);
  assert.equal(m.positiveWindows, 0.5); // T1 : −1 ; T2 : +2
  assert.equal(quarterOf(q2), "2025-T2");
  assert.deepEqual(equityCurve(trades), [2, 1, 0, -1, 2]);
  assert.deepEqual(thinCurve([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 3, 6, 10]);
  const b = breakdown(trades);
  assert.equal(b["sens : vente"].trades, 1);
  assert.equal(b["sortie : stop"].trades, 3);
  assert.ok(Object.keys(b).some((k) => k.startsWith("séance : ")));
  assert.deepEqual(metrics([]), { ...metrics([]), trades: 0 });
});

test("coupe : trois mois réservés, puis 70 / 30 ; les trades sont rangés par leur entrée ; le verdict du code", () => {
  const from = Date.UTC(2024, 0, 1) / 1000;
  const to = Date.UTC(2026, 0, 1) / 1000;
  const s = splitPeriod(from, to);
  assert.ok(s.outEnd < to && s.outEnd > Date.UTC(2025, 8, 15) / 1000);
  assert.ok(s.inEnd > from && s.inEnd < s.outEnd);
  const mk = (at: number) => ({
    symbol: "X",
    side: "long" as const,
    entryIndex: 0,
    exitIndex: 1,
    entryAt: at,
    exitAt: at,
    entry: 1,
    exit: 1,
    stop: 0,
    r: 1,
    reason: "fin",
    mae: 0,
    mfe: 0,
    bars: 1,
  });
  const parts = splitTrades([mk(from + 10), mk(s.inEnd + 10), mk(s.outEnd + 10)], s);
  assert.equal(parts.inSample.length, 1);
  assert.equal(parts.outOfSample.length, 1);
  assert.equal(parts.reserved.length, 1);

  const good = {
    trades: 200,
    wins: 90,
    losses: 110,
    winRate: 0.45,
    avgR: 0.2,
    totalR: 40,
    maxDrawdownR: -8,
    longestLosingStreak: 6,
    avgBars: 10,
    positiveWindows: 0.8,
    windows: 5,
  };
  assert.equal(judge({ inSample: good, outOfSample: { ...good, trades: 80 } }).verdict, "promising");
  assert.equal(judge({ inSample: { ...good, trades: 40 }, outOfSample: { ...good, trades: 20 } }).verdict, "fragile");
  const bad = judge({ inSample: good, outOfSample: { ...good, avgR: -0.1 } });
  assert.equal(bad.verdict, "rejected");
  assert.ok(bad.reasons.some((r) => /vérification/.test(r)));
  assert.equal(judge({ inSample: good }).verdict, "fragile");
});

test("heure de Paris : séances et changement d'heure", () => {
  assert.equal(sessionOf(0, 30), "off");
  assert.equal(sessionOf(1, 0), "asia");
  assert.equal(sessionOf(15, 29), "london");
  assert.equal(sessionOf(15, 30), "new_york");
  assert.equal(sessionOf(22, 0), "off");
  // 3 novembre 2025 8 h UTC = 9 h à Paris (heure d'hiver) ; 1er juillet 2025 8 h UTC = 10 h (heure d'été).
  assert.equal(parisClock(T0).hour, 9);
  assert.equal(parisClock(T0).weekday, 1);
  assert.equal(parisClock(Date.UTC(2025, 6, 1, 8, 0) / 1000).hour, 10);
  assert.equal(parisClock(T0).date, "2025-11-03");
});

test("bac à sable : un robot TypeScript compile et tourne dans le worker ; les interdits sont refusés avec leur raison", async () => {
  const ts = `
    import type { Ctx, Robot } from "kopilia";
    const robot = {
      name: "croisement",
      params: { fast: 3, slow: 5 },
      warmup: 6,
      onBar(ctx: Ctx) {
        const fast = ctx.series.sma(ctx.params.fast as number), slow = ctx.series.sma(ctx.params.slow as number);
        const pf = ctx.series.sma(ctx.params.fast as number, 1), ps = ctx.series.sma(ctx.params.slow as number, 1);
        if (!ctx.position && pf <= ps && fast > slow) ctx.buy({ stop: ctx.bar.c - 2 * ctx.series.atr(3), tag: "cross" });
        if (ctx.position && fast < slow) ctx.close("croisement inverse");
        ctx.log("bar " + ctx.index);
      },
    } satisfies Robot;
    export default robot;
  `;
  const compiled = await compileRobot(ts);
  assert.ok("js" in compiled, "error" in compiled ? compiled.error : "");
  // Baisse, hausse, baisse : les moyennes se croisent à la hausse (le robot entre), puis à la baisse (il sort).
  const bars: Bar[] = [];
  let p = 20_000;
  for (let i = 0; i < 60; i++) {
    const d = i < 20 || i >= 45 ? -10 : 10;
    bars.push({ t: T0 + i * TF, o: p, h: Math.max(p, p + d) + 1, l: Math.min(p, p + d) - 1, c: p + d });
    p += d;
  }
  const [out] = await runRobot(compiled.js, [input(bars)], { timeoutMs: 20_000 });
  assert.equal(out.error, undefined);
  assert.ok(out.trades.length >= 1, "au moins un trade");
  assert.equal(out.trades[0].tag, "cross");
  assert.equal(out.trades[0].reason, "croisement inverse");
  assert.ok(out.logs.length > 0 && out.logs.length <= 200);

  for (const [code, why] of [
    ['import fs from "node:fs"; export default { onBar() {} };', /import/],
    ["export default { onBar() { require('fs'); } };", /require/],
    ["export default { onBar() { return process.env; } };", /process/],
    ["export default { onBar() { return Math.random(); } };", /déterministe/],
    ["export default { onBar() { const x: = 1; } };", /ligne/],
  ] as const) {
    const r = await compileRobot(code);
    assert.ok("error" in r && why.test(r.error), `${code} → ${JSON.stringify(r)}`);
  }
  const noDefault = await compileRobot("export const x = 1;");
  assert.ok("js" in noDefault);
  await assert.rejects(runRobot(noDefault.js, [input(flat(3))]), /onBar/);
});

test("bac à sable : un robot qui boucle est arrêté au délai", async () => {
  const compiled = await compileRobot("export default { warmup: 0, onBar() { for (;;) {} } };");
  assert.ok("js" in compiled);
  await assert.rejects(runRobot(compiled.js, [input(flat(3))], { timeoutMs: 1500 }), /délai dépassé/);
});
