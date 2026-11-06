// Le laboratoire de stratégies : la réserve de bougies et son chargeur bridé
// (pagination vers le passé, complément vers le présent, passé épuisé), la
// bibliothèque (robots, versions, backtests, fil, leçons, meilleur essai), et
// un backtest de bout en bout sur un courtier simulé : coupe, verdict, budget
// d'essais, trades d'apprentissage seuls pour l'agent. Le contrôleur rend les
// erreurs corrigibles en { error }.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartCandlesResult } from "../src/market/market.service.js";
import type { MarketService } from "../src/market/market.service.js";
import { BROKER_SOURCE, CandleStore } from "../src/algo/candle-store.js";
import { CandleLoader, type CandleSource } from "../src/algo/candle-loader.js";
import { RobotError, RobotService, betterBacktest, defaultName } from "../src/algo/robot.service.js";
import { BacktestService, MAX_TRIALS_PER_JOB } from "../src/algo/backtest.service.js";
import type { CandleLoaderService } from "../src/algo/candle-loader.service.js";
import { AlgoController } from "../src/algo/algo.controller.js";
import type { AlgoAgentsService } from "../src/algo/algo-agents.service.js";
import type { DashboardService } from "../src/dashboard/dashboard.service.js";
import { algoSystemPrompt, developPrompt } from "../src/algo/algo-prompts.js";
import { backtestText, robotLine } from "../src/algo/algo-texts.js";
import { tempData } from "./harness.js";

const TF = 900;
/** Deux ans de quarts d'heure synthétiques, une sinusoïde bruitée mais déterministe, en bid, jusqu'à `now`. */
function synthetic(nowSec: number, days: number): Array<{ t: number; o: number; h: number; l: number; c: number }> {
  const n = Math.floor((days * 86_400) / TF);
  const out = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 30;
  const start = Math.floor(nowSec / TF) * TF - n * TF;
  let p = 20_000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 40) * 6 + rnd();
    const o = p;
    const c = p + drift;
    out.push({ t: start + i * TF, o, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, c });
    p = c;
  }
  return out;
}

const NOW = Date.UTC(2026, 10, 6, 10, 0) / 1000;
const ALL = synthetic(NOW, 740);

/** Un courtier simulé : les bougies jusqu'à `before`, par paquets, comme MetaApi. */
function source(calls: Array<{ before?: number; limit: number }> = []): CandleSource {
  return async (_symbol, timeframe, opts) => {
    calls.push(opts);
    if (timeframe !== "15m") return { symbol: "NAS100", timeframe, candles: [], more: false };
    const until = opts.before ?? NOW;
    const slice = ALL.filter((c) => c.t <= until).slice(-opts.limit);
    return { symbol: "NAS100", timeframe, candles: slice, more: slice.length >= opts.limit } as ChartCandlesResult;
  };
}

test("réserve : le chargeur pagine vers le passé, marque le passé épuisé, puis complète vers le présent sans redemander l'ancien", async () => {
  const data = tempData("algo-store");
  try {
    const store = new CandleStore(data.db);
    const calls: Array<{ before?: number; limit: number }> = [];
    const loader = new CandleLoader(source(calls), store, undefined, 0);
    loader.now = () => (NOW - 30 * 86_400) * 1000; // il y a un mois : 710 jours chargés
    const first = await loader.ensure("NAS100", "15m", { depthDays: 730 });
    assert.equal(first.error, undefined);
    assert.ok(first.requests >= 60 && first.requests < 90, `${first.requests} requêtes`);
    const cov = store.coverage(BROKER_SOURCE, "NAS100", "15m")!;
    assert.ok(cov.count > 60_000, `${cov.count} bougies`);
    assert.equal(cov.complete, true, "le dernier paquet court dit que le courtier n'a rien avant");
    assert.ok(cov.last <= Math.floor(loader.now() / 1000 / TF) * TF - TF, "la bougie en cours n'est pas gardée");
    // Un mois plus tard : seulement le présent manque.
    calls.length = 0;
    loader.now = () => NOW * 1000;
    const second = await loader.ensure("NAS100", "15m", { depthDays: 730 });
    assert.ok(second.loaded > 2500 && second.loaded < 3100, `${second.loaded} bougies complétées`);
    assert.ok(second.requests <= 4, `${second.requests} requêtes pour un mois`);
    assert.equal(store.coverage(BROKER_SOURCE, "NAS100", "15m")!.count, ALL.length);
    // Rien de nouveau : une seule requête, rien d'écrit.
    const third = await loader.ensure("NAS100", "15m", { depthDays: 730 });
    assert.equal(third.loaded, 0);
    // range : les plus anciennes d'abord, bornes comprises.
    const range = store.range(BROKER_SOURCE, "NAS100", "15m", ALL[10].t, ALL[12].t);
    assert.deepEqual(
      range.map((c) => c.t),
      [ALL[10].t, ALL[11].t, ALL[12].t],
    );
    // Une source en erreur : ce qui est écrit reste, l'erreur est dite.
    const broken = new CandleLoader(async () => ({ error: "trop de requêtes" }), store, undefined, 0);
    const r = await broken.ensure("XAUUSD", "1h");
    assert.equal(r.error, "trop de requêtes");
    assert.equal(r.loaded, 0);
  } finally {
    data.cleanup();
  }
});

const ROBOT_TS = `
export default {
  name: "croisement",
  params: { fast: 9, slow: 21, atr: 1.5 },
  warmup: 40,
  onBar(ctx) {
    const f = ctx.series.ema(ctx.params.fast), s = ctx.series.ema(ctx.params.slow);
    const pf = ctx.series.ema(ctx.params.fast, 1), ps = ctx.series.ema(ctx.params.slow, 1);
    if (ctx.position) { if (f < s) ctx.close("croisement inverse"); return; }
    if (pf <= ps && f > s && ctx.clock.session !== "off") ctx.buy({ stop: ctx.bar.c - ctx.params.atr * ctx.series.atr(14), target: ctx.bar.c + 2 * ctx.params.atr * ctx.series.atr(14) });
  },
};`;

function fakeMarket(): MarketService {
  return {
    resolve: async (q: string) =>
      /nasdaq|NAS100/i.test(q) ? { symbol: "NAS100", name: "Nasdaq", digits: 2 } : { error: `« ${q} » introuvable chez le courtier` },
    brokerTerms: async () => ({ terms: { tickSize: 0.01, tickValue: 0.01, volumeStep: 0.1, minVolume: 0.1, maxVolume: 100 }, bid: 20_000, ask: 20_002 }),
    chartCandles: source(),
  } as unknown as MarketService;
}

test("bibliothèque et backtest : hypothèse, versions, essais comptés, coupe, verdict, meilleur, fil, leçons ; l'agent ne voit que l'apprentissage", async () => {
  const data = tempData("algo-lab");
  try {
    const store = new CandleStore(data.db);
    const market = fakeMarket();
    const loader = new CandleLoader((s, tf, o) => market.chartCandles(s, tf, o), store, undefined, 0) as unknown as CandleLoaderService;
    loader.now = () => NOW * 1000;
    const robots = new RobotService(data.db);
    const backtests = new BacktestService(market, store, loader, robots, data.logger);
    backtests.now = () => NOW * 1000;
    let changes = 0;
    robots.on("changed", () => changes++);

    const robot = robots.create({ idea: "croisement de moyennes sur le Nasdaq en 15 minutes", products: ["NAS100"], timeframe: "15m", sessionId: "s1" });
    assert.equal(robot.status, "idea");
    assert.throws(() => robots.version(robot.id), /pas encore de code/);
    robots.update(robot.id, { hypothesis: "le croisement MME 9/21 a une espérance positive avec un stop ATR", name: "Croisement MME 9/21" });
    const v1 = robots.saveVersion(robot.id, ROBOT_TS, "entrée au croisement, stop 1,5 ATR, objectif 3 ATR, sortie au croisement inverse");
    assert.equal(v1, 1);
    assert.equal(robots.summary(robot.id)!.status, "testing");

    const run = await backtests.run({ robotId: robot.id, jobId: "job1", note: "baseline" });
    const b = run.summary;
    assert.equal(b.trial, 1);
    assert.equal(b.products[0], "NAS100");
    assert.equal(b.source, BROKER_SOURCE);
    assert.equal(b.costs?.spread, 2);
    assert.ok(b.inSample.trades > 20, `${b.inSample.trades} trades en apprentissage`);
    assert.ok(b.outOfSample!.trades > 5 && b.reserved!.trades > 0, "des trades en vérification et dans les mois réservés");
    assert.ok(b.inEnd! < b.outEnd! && b.outEnd! < b.to);
    assert.ok(["promising", "fragile", "rejected"].includes(b.verdict));
    assert.ok(b.verdictReasons.length >= 2);
    assert.ok(b.breakdown && Object.keys(b.breakdown).some((k) => k.startsWith("séance : ")));
    assert.ok(b.equity && b.equity.length > 0 && b.equity.length <= 120);
    assert.ok(run.coverage[0].bars > 60_000);
    // L'agent : seulement l'apprentissage ; l'écran : tout.
    const forAgent = robots.trades(b.id, { phase: "inSample" });
    const forScreen = robots.trades(b.id);
    assert.equal(forAgent.length, b.inSample.trades);
    assert.equal(forScreen.length, b.inSample.trades + b.outOfSample!.trades + b.reserved!.trades);
    assert.ok(forAgent.every((t) => t.entryAt < b.inEnd!));

    // Une variante par paramètres, sans nouveau code : essai 2 ; le meilleur est revu.
    const run2 = await backtests.run({ robotId: robot.id, jobId: "job1", params: { atr: 3 } });
    assert.equal(run2.summary.trial, 2);
    assert.deepEqual(run2.summary.params, { atr: 3 });
    const after = robots.summary(robot.id)!;
    assert.equal(after.trials, 2);
    assert.equal(after.best!.id, betterBacktest(b, run2.summary).id);
    assert.equal(robots.trialsOf("job1"), 2);

    // Fil et leçons.
    robots.note(robot.id, "decision", "je teste un stop plus large", { backtestId: run2.summary.id, jobId: "job1" });
    const lesson = robots.lesson({
      text: "sur NAS100 en 15 min, la sortie au croisement inverse bat l'objectif fixe",
      products: ["NAS100"],
      timeframe: "15m",
      robotId: robot.id,
      backtestId: b.id,
    });
    assert.equal(robots.lessons()[0].id, lesson.id);
    const sheet = robots.sheet(robot.id);
    assert.equal(sheet.backtests.length, 2);
    assert.ok(sheet.notes.some((n) => n.kind === "hypothesis") && sheet.notes.some((n) => n.kind === "lesson") && sheet.notes[0].kind === "idea");
    assert.equal(sheet.code, ROBOT_TS);
    assert.ok(changes >= 5);

    // Fin de recherche : le statut suit le verdict du meilleur.
    const done = robots.finishResearch(robot.id);
    assert.equal(done.status, after.best!.verdict);
    assert.equal(done.jobId, undefined);

    // find : par nom, par bout, « dernier » ; erreurs corrigibles.
    assert.equal(robots.find("croisement").id, robot.id);
    assert.equal(robots.find("dernier").id, robot.id);
    assert.throws(() => robots.find("inconnu"), RobotError);

    // Erreurs du backtest : produit inconnu, code qui ne compile pas, budget.
    await assert.rejects(backtests.run({ robotId: robot.id, products: ["Dow Jones"] }), /aucun produit reconnu/);
    assert.equal(await backtests.check("export default { onBar() { require('fs') } }"), "refusé : require : aucun module");

    // Textes : lisibles, en R.
    assert.match(robotLine(after), /Croisement MME 9\/21 \(rb_.*NAS100 en 15 minutes ; meilleur essai/);
    assert.match(backtestText(b).join(" "), /Apprentissage : \d+ trades, \d+ % gagnants, [+−]?\d+,\d\d R par trade.*Verdict du code/);

    // Le contrôleur : une erreur corrigible revient en { error }, une fiche se lit par nom.
    const controller = new AlgoController(
      robots,
      backtests,
      {} as AlgoAgentsService,
      { openRobots: () => ({ panel: { id: "p1" } }) } as unknown as DashboardService,
      market,
    );
    const missing = (await controller.robot("inconnu", undefined, undefined)) as { error: string };
    assert.match(missing.error, /aucun robot ne correspond/);
    const fiche = (await controller.robot("croisement", "1", "worst")) as { code: string; trades: unknown[]; backtests: unknown[] };
    assert.equal(fiche.code, ROBOT_TS);
    assert.equal(fiche.backtests.length, 2);
    assert.ok(fiche.trades.length > 0);
    const noSession = (await controller.develop({ idea: "x" })) as { error: string };
    assert.match(noSession.error, /session absente/);

    // Le budget d'essais d'une recherche (des essais simulés, après les lectures de la fiche).
    for (let k = robots.trialsOf("job2"); k < MAX_TRIALS_PER_JOB; k++) {
      data.db.db
        .prepare("INSERT INTO backtests (id, robot_id, version, job_id, trial, data, created_at) VALUES (?, ?, 1, 'job2', ?, '{}', ?)")
        .run(`bt_fake${k}`, robot.id, 100 + k, NOW * 1000);
    }
    await assert.rejects(backtests.run({ robotId: robot.id, jobId: "job2" }), /budget d'essais épuisé/);
  } finally {
    data.cleanup();
  }
});

test("consignes : la consigne de l'agent quant porte le protocole, l'API et les règles du verdict ; la tâche nomme le robot", () => {
  const prompt = algoSystemPrompt({
    facts: ["il trade le Nasdaq"],
    trading: ["le swing, c'est 1 h, 4 h ou daily"],
    library: ["Croisement (rb_1, rejeté)"],
    lessons: ["la sortie inverse bat l'objectif fixe (NAS100, 15m)"],
  });
  for (const needle of [
    "l'IA cherche, le code juge",
    "hypothèse préenregistrée",
    "baseline",
    "plan d'exploration",
    "30 essais",
    "au moins 100 trades",
    "interface Ctx",
    "buy(req",
    "Interdits",
    "Façon de trader",
    "la sortie inverse bat",
    "deux à quatre phrases",
  ]) {
    assert.ok(prompt.includes(needle), needle);
  }
  const task = developPrompt({ robotId: "rb_1", idea: "croisement de moyennes", products: ["NAS100"], timeframe: "15m", details: "stop sous la mèche" });
  assert.match(task, /rb_1/);
  assert.match(task, /stop sous la mèche/);
});

test("nom par défaut d'un robot : sans l'article, coupé à un mot", () => {
  assert.equal(defaultName("un croisement de moyennes mobiles sur le Nasdaq en 15 minutes"), "Croisement de moyennes mobiles sur le Nasdaq en 15 minutes");
  assert.equal(
    defaultName("une stratégie de rejet de la plage asiatique sur l'or, avec un stop sous la mèche et un objectif à l'autre borne"),
    "Stratégie de rejet de la plage asiatique sur l'or, avec un…",
  );
});
