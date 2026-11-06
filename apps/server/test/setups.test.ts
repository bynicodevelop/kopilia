// Recherche d'opportunités : alertes sur une zone ou une bande, alertes de
// l'IA (échéance, plafond à part, retirées avec leur scénario), dossiers de
// scénarios (exigences, niveaux, abandon, échéances, réactions), suivi des
// setups proposés, carte automatique corrigée, et la continuité : un
// changement de contexte réveille le dossier, et l'agent reçoit le dossier,
// son fil et ce qui a changé. Le courtier et les agents sont simulés.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { MarketService, type ChartCandle } from "../src/market/market.service.js";
import type { Quote } from "../src/market/quote-feed.js";
import { DrawingService } from "../src/dashboard/drawing.service.js";
import { AlertService, type AlertFired } from "../src/alerts/alert.service.js";
import { ScenarioService, SetupError, type ScenarioInput } from "../src/setups/scenario.service.js";
import { SetupAgentsService, type PassDone } from "../src/setups/setup-agents.service.js";
import { ExampleService } from "../src/setups/example.service.js";
import { MapService } from "../src/setups/map.service.js";
import { LevelService } from "../src/setups/level.service.js";
import { sameBand, sameLine } from "../src/setups/overlap.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { trackOutcome } from "../src/setups/outcome.js";
import { dossierText, levelsText, scanText, searchedTexts } from "../src/setups/setup-texts.js";
import { opportunityReport, searchReport } from "../src/gateway/messages.js";
import { tradingSignals } from "../src/setups/signals.js";
import type { StartJobInput } from "../src/jobs/job.service.js";
import { tempData } from "./harness.js";

const GOLD = { symbol: "XAUUSD", name: "or", digits: 2 };
/** Les prix français ont une espace fine insécable entre les milliers : les attendus s'écrivent avec une espace simple. */
const plain = (text: string) => text.replace(/\u202f/g, " ");
const HOUR = 3_600_000;

/** Le courtier simulé, les tracés, les alertes et les dossiers sur une base neuve. */
function setup(opts: { candles?: (timeframe: string, limit: number) => ChartCandle[] } = {}) {
  const data = tempData("setups", { KOPILIA_METAAPI_TOKEN: "jeton", KOPILIA_METAAPI_STREAM: "0" });
  const { config, logger, db } = data;
  const market = new MarketService(config, logger);
  market.feed.setAlertSymbols = () => undefined;
  let last: Quote | undefined;
  market.feed.latest = (symbol: string) => (last?.symbol === symbol ? last : undefined);
  market.chartCandles = async (symbol, timeframe, o = {}) => {
    const all = opts.candles?.(timeframe, o.limit ?? 400) ?? [];
    return { symbol, timeframe, candles: all.slice(-(o.limit ?? 400)), more: false };
  };
  market.resolve = async (query: string) => (/or|gold|xau/i.test(query) ? GOLD : { error: `introuvable : ${query}` });
  const drawings = new DrawingService(db, logger);
  const alerts = new AlertService(db, market, drawings, logger);
  alerts.onModuleInit();
  const fired: AlertFired[] = [];
  alerts.on("triggered", (f) => fired.push(f));
  const scenarios = new ScenarioService(db, alerts, logger);
  scenarios.onModuleInit();
  return {
    data,
    market,
    drawings,
    alerts,
    scenarios,
    fired,
    quote(bid: number, at = Date.now()) {
      last = { symbol: "XAUUSD", bid, time: at };
      market.feed.emit("quote", last);
    },
    cleanup() {
      scenarios.onModuleDestroy();
      alerts.onModuleDestroy();
      data.cleanup();
    },
  };
}

/** Un dossier complet sur l'or, à compléter. */
function dossier(extra: Partial<ScenarioInput> = {}): ScenarioInput {
  return {
    product: GOLD,
    direction: "short",
    horizon: "intraday",
    timeframe: "15m",
    contextTimeframe: "4h",
    title: "Or : rejet de la résistance 4 h",
    why: "Le dollar reprend avant le CPI ; zone 4 h de l'utilisateur.",
    snapshot: "Cours 3 940 à 08:10, à 0,3 % sous la zone 3 950 – 3 960 ; RSI 15 min 64.",
    plan: "Si le prix entre dans la zone : attendre la clôture 15 min ; mèche haute et clôture dedans : proposer la vente. Clôture au-dessus : abandonner.",
    invalidation: "Clôture 15 min au-dessus de 3 960, ou CPI froid.",
    expiresAt: Date.now() + 6 * HOUR,
    ...extra,
  };
}

test("zone et bande : on y entre par-dessus (à la baisse) ou par-dessous (à la hausse) ; dedans, rien jusqu'à en sortir", () => {
  const t = setup();
  try {
    const zone = t.drawings.create("XAUUSD", { kind: "zone", top: 3960, bottom: 3950 }, { by: "user" });
    t.quote(3970);
    const a = t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: zone.id }, trigger: "bar" }, "user");
    t.quote(3961);
    assert.equal(t.fired.length, 0, "au-dessus de la zone : rien");
    t.quote(3959.5);
    assert.equal(t.fired.length, 1, "entrée par le haut");
    assert.equal(t.fired[0].direction, "down");
    assert.equal(t.fired[0].level, 3960, "le bord atteint : le haut de la zone");
    t.quote(3955);
    assert.equal(t.fired.length, 1, "dedans : rien de plus");
    t.alerts.update(a.id, { state: "paused" });
    t.quote(3925);
    const band = t.alerts.create(GOLD, { target: { kind: "band", top: 3930, bottom: 3920 } }, "user");
    t.quote(3922);
    assert.equal(t.fired.length, 1, "armée dans la bande : il faut d'abord en sortir");
    t.quote(3915);
    t.quote(3920);
    assert.equal(t.fired.at(-1)!.alert.id, band.id);
    assert.equal(t.fired.at(-1)!.direction, "up");
    assert.equal(t.fired.at(-1)!.level, 3920, "le bord atteint : le bas de la bande");
    assert.throws(() => t.alerts.create(GOLD, { target: { kind: "band", top: 3900, bottom: 3910 } }, "user"), /haut au-dessus de son bas/);
  } finally {
    t.cleanup();
  }
});

test("alertes de l'IA : échéance obligatoire, plafond à part, expirées à l'échéance, retirées avec leur scénario", () => {
  const t = setup();
  try {
    t.quote(3940);
    const s = t.scenarios.open(dossier(), { by: "agent" });
    assert.throws(() => t.alerts.create(GOLD, { target: { kind: "price", price: 3950 }, scenarioId: s.id }, "kopilia"), /toujours une échéance/);
    // Les vingt alertes de l'utilisateur ne bloquent pas celles de l'IA.
    for (let k = 0; k < 20; k++) t.alerts.create(GOLD, { target: { kind: "price", price: 4000 + k } }, "user");
    const a = t.scenarios.watch(
      s.id,
      { target: { kind: "band", top: 3960, bottom: 3950 }, trigger: "close", intention: "juger la clôture 15 min dans la zone" },
      { by: "agent" },
    );
    assert.equal(a.scenarioId, s.id);
    assert.equal(a.expiresAt, s.expiresAt, "pas au-delà de l'échéance du scénario");
    assert.equal(a.message, "juger la clôture 15 min dans la zone", "l'intention est sa consigne");
    assert.throws(() => t.scenarios.watch(s.id, { target: { kind: "price", price: 3945 }, intention: "" }, { by: "agent" }), /intention/);
    assert.equal(t.alerts.clear("XAUUSD").length, 20, "effacer les alertes d'un produit laisse celles de l'IA");
    assert.equal(t.alerts.ofScenario(s.id).length, 1);
    // Échéance passée : expirée, et elle ne part plus.
    const soon = t.scenarios.watch(s.id, { target: { kind: "price", price: 3945 }, intention: "contact", expiresAt: Date.now() + 1000 }, { by: "agent" });
    t.alerts.now = () => Date.now() + 5000;
    t.quote(3946);
    t.quote(3944);
    assert.equal(t.fired.length, 0, "échue : elle ne part plus");
    assert.deepEqual(
      t.alerts.expireDue().map((x) => x.id),
      [soon.id],
    );
    assert.equal(t.alerts.get(soon.id)!.state, "expired");
    t.alerts.now = () => Date.now();
    t.scenarios.abandon(s.id, "hypothèse invalidée", { by: "agent" });
    assert.equal(t.alerts.ofScenario(s.id).length, 0, "abandonné : ses alertes partent");
  } finally {
    t.cleanup();
  }
});

test("dossier : tout ce qui servira au réveil est exigé ; niveaux cohérents pour proposer ; fil", () => {
  const t = setup();
  try {
    assert.throws(() => t.scenarios.open(dossier({ plan: " " }), { by: "agent" }), /plan/);
    assert.throws(() => t.scenarios.open(dossier({ expiresAt: Date.now() - 1 }), { by: "agent" }), /dans le futur/);
    assert.throws(() => t.scenarios.open(dossier({ depends: { hypotheses: ["h_nope"] } }), { by: "agent" }), /hypothèse\(s\) inconnue/);
    assert.throws(() => t.scenarios.open(dossier({ timeframe: "2h" }), { by: "agent" }), /unité de temps/);
    const s = t.scenarios.open(dossier(), { by: "agent", jobId: "job_1" });
    assert.equal(s.state, "watching");
    assert.throws(
      () => t.scenarios.propose(s.id, { summary: "vente", entry: 3955, stop: 3950, targets: [3930] }, { by: "agent" }),
      /stop au-dessus de l'entrée/,
    );
    const p = t.scenarios.propose(s.id, { summary: "Rejet net de la zone en 15 min : vente.", entry: 3955, stop: 3962, targets: [3930] }, { by: "agent" });
    assert.equal(p.state, "proposed");
    assert.match(plain(levelsText(p)), /entrée 3 955,00, stop 3 962,00, objectif 3 930,00 \(rapport 3,6\)/);
    assert.throws(() => t.scenarios.propose(s.id, { summary: "encore" }, { by: "agent" }), /déjà proposé/);
    const fil = t.scenarios.events(s.id).map((e) => e.kind);
    assert.deepEqual(fil, ["opened", "proposed"]);
    assert.equal(t.scenarios.untold().length, 1, "proposé, pas encore dit");
    t.scenarios.markTold(s.id);
    assert.equal(t.scenarios.untold().length, 0);
  } finally {
    t.cleanup();
  }
});

test("hypothèses : l'IA ne réécrit pas celles de l'utilisateur ; un changement d'état exige sa raison ; doublon mis à jour", () => {
  const t = setup();
  try {
    const mine = t.scenarios.addHypothesis({ statement: "L'or rebondit sur 3 900", products: [GOLD], bias: "up", horizon: "swing" }, "user");
    assert.equal(mine.invalidation, "non précisée par l'utilisateur");
    assert.throws(() => t.scenarios.updateHypothesis(mine.id, { state: "invalidated", reason: "cassure" }, "kopilia"), /hypothèse de l'utilisateur/);
    const ai = t.scenarios.addHypothesis(
      { statement: "Le dollar reprend avant le CPI", products: [GOLD], bias: "down", horizon: "intraday", invalidation: "CPI froid" },
      "kopilia",
    );
    assert.throws(() => t.scenarios.updateHypothesis(ai.id, { state: "invalidated" }, "kopilia"), /pourquoi/);
    const again = t.scenarios.addHypothesis(
      { statement: "le dollar reprend avant le CPI", bias: "down", horizon: "intraday", catalysts: "CPI 14 h 30" },
      "kopilia",
    );
    assert.equal(again.id, ai.id, "même énoncé, même auteur : mise à jour");
    assert.equal(again.catalysts, "CPI 14 h 30");
    assert.throws(() => t.scenarios.addHypothesis({ statement: "x", bias: "monte", horizon: "intraday", invalidation: "y" }, "kopilia"), /sens/);
  } finally {
    t.cleanup();
  }
});

test("échéances : un scénario surveillé expire, un setup proposé sans entrée est clos « entrée jamais atteinte », une hypothèse expire", () => {
  const t = setup();
  try {
    const watching = t.scenarios.open(dossier({ expiresAt: Date.now() + 1000 }), { by: "agent" });
    const proposed = t.scenarios.open(dossier({ title: "Or : cassure", direction: "long", expiresAt: Date.now() + 1000 }), { by: "agent" });
    t.scenarios.propose(proposed.id, { summary: "achat", entry: 3965, stop: 3955, targets: [3990] }, { by: "agent" });
    const h = t.scenarios.addHypothesis(
      { statement: "Séance calme", bias: "neutral", horizon: "intraday", invalidation: "volatilité", expiresAt: Date.now() + 1000 },
      "kopilia",
    );
    const closed: string[] = [];
    t.scenarios.on("closed", (s) => closed.push(`${s.id}:${s.state}:${s.outcome?.result ?? ""}`));
    t.scenarios.now = () => Date.now() + 5000;
    t.scenarios.expireDue();
    assert.deepEqual(closed.sort(), [`${proposed.id}:closed:missed`, `${watching.id}:expired:`].sort());
    assert.equal(t.scenarios.hypothesis(h.id)!.state, "expired");
  } finally {
    t.cleanup();
  }
});

test("réactions : pris, pas pour moi, modifié ; une remarque fait relire le dossier ; la relecture voit les signaux", () => {
  const t = setup();
  try {
    const s = t.scenarios.open(dossier(), { by: "agent" });
    const wakes: string[] = [];
    t.scenarios.on("feedback", (e) => {
      if (e.wake) wakes.push(e.text);
    });
    t.scenarios.feedback(s.id, "comment", "je ne crois plus à la baisse de l'or");
    assert.equal(wakes.length, 1);
    assert.match(wakes[0], /je ne crois plus/);
    t.scenarios.feedback(s.id, "declined", "trop près de la news");
    assert.equal(t.scenarios.get(s.id)!.feedback!.reaction, "declined");
    assert.throws(() => t.scenarios.feedback(s.id, "comment", ""), /quelle remarque/);
    t.drawings.create("XAUUSD", { kind: "zone", top: 3960, bottom: 3950 }, { by: "user" });
    const signals = tradingSignals(t.data.db, 0, Date.now() + 1000);
    assert.ok(signals.some((l) => /trop près de la news/.test(l)));
    assert.ok(signals.some((l) => /1 zone\(s\) sur XAUUSD/.test(l)));
  } finally {
    t.cleanup();
  }
});

test("suivi d'un setup proposé : entrée puis objectif ; stop et objectif dans la même bougie : le stop ; avant la proposition, rien", () => {
  const proposedAt = Date.UTC(2026, 10, 5, 10, 0);
  const t0 = proposedAt / 1000;
  const s = { direction: "short" as const, entry: 3955, stop: 3962, targets: [3930], proposedAt };
  const bar = (k: number, h: number, l: number) => ({ t: t0 + k * 60, o: l, h, l, c: l });
  assert.deepEqual(trackOutcome(s, [bar(-1, 3956, 3920), bar(0, 3950, 3940)], 60), {}, "la bougie d'avant ne compte pas ; entrée pas atteinte");
  const won = trackOutcome(s, [bar(0, 3956, 3950), bar(1, 3952, 3940), bar(2, 3945, 3929)], 60);
  assert.equal(won.result, "target");
  assert.equal(won.enteredAt, proposedAt);
  assert.ok(Math.abs(won.r! - 25 / 7) < 1e-9);
  const both = trackOutcome(s, [bar(0, 3956, 3950), bar(1, 3963, 3929)], 60);
  assert.equal(both.result, "stop", "prudent : le stop d'abord");
  assert.equal(both.r, -1);
  const open = trackOutcome({ ...s, outcome: { result: "open", enteredAt: proposedAt + 120_000 } }, [bar(0, 3963, 3950), bar(2, 3958, 3950)], 60);
  assert.deepEqual(open, { enteredAt: proposedAt + 120_000 }, "entrée déjà constatée : rien avant elle ne compte");
});

test("carte automatique : la correction de l'IA est bornée à un ATR et gardée avec sa raison ; une oblique s'écarte", async () => {
  // Une résistance touchée trois fois vers 110, puis le prix redescend.
  const candles: ChartCandle[] = [];
  const path = [100, 104, 108, 110.4, 108, 104, 100, 104, 108, 110.6, 108, 104, 100, 104, 108, 110.5, 108, 104, 100, 98, 99, 97, 98, 96];
  path.forEach((c, i) => candles.push({ t: 1_700_000_000 + i * 3600, o: c - 0.5, h: c + 0.8, l: c - 1, c }));
  const t = setup({ candles: () => candles });
  try {
    const maps = new MapService(t.data.db, t.market, t.drawings, t.alerts, t.data.logger);
    const view = await maps.view("XAUUSD", "1h");
    assert.ok(!("error" in view));
    const zone = view.zones.find((z) => z.top > 109 && z.bottom < 111);
    assert.ok(zone, "la résistance vers 110 est trouvée");
    const atr = view.atr!;
    await assert.rejects(maps.adjust("XAUUSD", "1h", { key: zone.key, action: "adjust", top: zone.top + 3 * atr, reason: "trop haut" }), /un ATR au plus/);
    await assert.rejects(maps.adjust("XAUUSD", "1h", { key: "z:0", action: "remove", reason: "x" }), /aucun élément/);
    await assert.rejects(maps.adjust("XAUUSD", "1h", { key: zone.key, action: "adjust", reason: " " }), /pourquoi/);
    const fixed = await maps.adjust("XAUUSD", "1h", { key: zone.key, action: "adjust", top: zone.wickTop, reason: "reprendre les mèches hautes" });
    assert.ok(!("removed" in fixed));
    const after = await maps.view("XAUUSD", "1h");
    assert.ok(!("error" in after));
    const corrected = after.zones.find((z) => z.key === zone.key)!;
    assert.equal(corrected.top, zone.wickTop);
    assert.equal(corrected.corrected, "reprendre les mèches hautes");
    assert.equal(corrected.auto!.top, zone.top, "l'estimation de l'algorithme reste lisible");
    const levels = await maps.levels(GOLD, "1h");
    assert.equal(levels.userDrawings, "aucun tracé de l'utilisateur sur ce produit");

    // Tour d'horizon : un refus du courtier (trop de demandes) est redemandé une fois, après une pause.
    let refused = 0;
    const real = t.market.chartCandles;
    t.market.chartCandles = async (symbol, timeframe, o) => {
      if (symbol === "XAGUSD" && refused++ === 0) return { error: "trop de requêtes MetaApi : réessaie dans un instant" };
      return real(symbol, timeframe, o);
    };
    maps.scanRetryMs = 1;
    const scan = await maps.scan(["XAUUSD", "XAGUSD"], "4h");
    assert.ok(
      scan.every((m) => !("error" in m)),
      "les deux cartes sont là",
    );
    assert.equal(refused, 2, "XAGUSD redemandé une fois");
  } finally {
    t.cleanup();
  }
});

test("tour d'horizon : du produit le plus près d'un niveau au plus loin, avec ses tracés et ses dossiers ; un produit introuvable à la fin", () => {
  const now = 1_700_100_000_000;
  const zone = (bottom: number, top: number, touches = 3) => ({
    key: `z:${bottom}`,
    bottom,
    top,
    wickBottom: bottom,
    wickTop: top,
    touches,
    first: 0,
    last: 0,
    role: "support" as const,
    score: 1,
  });
  const map = (price: number, zones: ReturnType<typeof zone>[], divergences: never[] = []) => ({
    symbol: "X",
    timeframe: "1h",
    atr: 10,
    price,
    zones,
    trendlines: [],
    divergences,
    removed: [],
    absorbed: [],
  });
  const pivot = (t: number, price: number, rsi: number) => ({ i: 0, t, price, rsi });
  const bearish = { kind: "bearish", from: pivot(now / 1000 - 7200, 25000, 70), to: pivot(now / 1000 - 3600, 25010, 60) } as never;
  const text = plain(
    scanText(
      [
        { name: "or", symbol: "XAUUSD", digits: 2, map: map(4000, [zone(3900, 3910), zone(4100, 4110)]), drawings: [], open: 0 },
        {
          name: "Nasdaq 100",
          symbol: "NAS100",
          digits: 1,
          map: map(25000, [zone(24990, 25010, 4)], [bearish]),
          drawings: [{ kind: "hline", price: 25050 } as never, { kind: "trendline" } as never],
          open: 1,
        },
        { name: "COTTON", map: { error: "« COTTON » introuvable chez le courtier" }, drawings: [], open: 0 },
      ],
      "1h",
      3600,
      now,
    ),
  );
  const [head, first, second, last] = text.split("\n");
  assert.match(head, /^Tour d'horizon en 1h/);
  assert.match(first, /^- Nasdaq 100 \(NAS100\) : 25 000,0, ATR 10,0 ; DANS la zone 24 990,0–25 010,0 \(4 contacts\)/);
  assert.match(first, /divergence RSI baissière/);
  assert.match(first, /son tracé le plus proche : ligne 25 050,0 \(5,0 ATR\) ; 1 oblique tracée/);
  assert.match(first, /1 dossier ouvert$/);
  assert.match(second, /^- Or \(XAUUSD\) : .*zone au-dessous 3 900,00–3 910,00 à 9,0 ATR .*zone au-dessus 4 100,00–4 110,00 à 10,0 ATR/);
  assert.doesNotMatch(second, /divergence|tracé|dossier/);
  assert.equal(last, "- COTTON : « COTTON » introuvable chez le courtier");
});

test("même niveau : deux bandes qui se chevauchent ou presque ; deux obliques au même tracé prolongé", () => {
  assert.ok(sameBand({ lo: 100, hi: 101 }, { lo: 100.5, hi: 102 }, 0));
  assert.ok(sameBand({ lo: 100, hi: 100 }, { lo: 100.2, hi: 100.2 }, 0.25), "deux lignes à moins de la tolérance");
  assert.ok(!sameBand({ lo: 100, hi: 101 }, { lo: 101.5, hi: 102 }, 0.25));
  const times = Array.from({ length: 50 }, (_, i) => 1_700_000_000 + i * 3600);
  const up = { a: { t: times[0], price: 100 }, b: { t: times[10], price: 110 } };
  assert.ok(sameLine(up, { a: { t: times[20], price: 120.1 }, b: { t: times[30], price: 130 } }, times, 3600, 0.5), "la même pente, plus loin");
  assert.ok(!sameLine(up, { a: { t: times[20], price: 125 }, b: { t: times[30], price: 135 } }, times, 3600, 0.5), "parallèle, décalée");
  assert.ok(!sameLine(up, { a: { t: times[0], price: 100 }, b: { t: times[10], price: 105 } }, times, 3600, 0.5), "même départ, autre pente");
});

test("niveaux de l'IA : un candidat contrôlé devient un niveau du dossier ; jamais par-dessus un tracé de l'utilisateur ; partagé, gardé, retiré, remplacé, parti avec son dossier", async () => {
  // Une résistance touchée trois fois vers 110, puis le prix redescend vers 96.
  const candles: ChartCandle[] = [];
  const path = [100, 104, 108, 110.4, 108, 104, 100, 104, 108, 110.6, 108, 104, 100, 104, 108, 110.5, 108, 104, 100, 98, 99, 97, 98, 96];
  path.forEach((c, i) => candles.push({ t: 1_700_000_000 + i * 3600, o: c - 0.5, h: c + 0.8, l: c - 1, c }));
  const t = setup({ candles: () => candles });
  const maps = new MapService(t.data.db, t.market, t.drawings, t.alerts, t.data.logger);
  const levels = new LevelService(t.data.db, t.drawings, t.scenarios, maps, t.alerts, t.data.logger);
  levels.onModuleInit();
  const settled = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await sleep(10);
  };
  try {
    const view = await maps.view("XAUUSD", "4h");
    assert.ok(!("error" in view));
    const zone = view.zones.find((z) => z.top > 109 && z.bottom < 111)!;
    assert.ok(zone, "le candidat : la résistance vers 110");
    const s1 = t.scenarios.open(dossier(), { by: "agent" });

    // Le candidat contrôlé devient un niveau du dossier, et la carte s'efface derrière lui.
    await assert.rejects(levels.draw(s1.id, { from: zone.key, label: "résistance 4h" }), /pourquoi/);
    // Une alerte posée sur une bande aux mêmes bornes, avant le tracé : elle passera sur le niveau (une seule zone à l'écran).
    t.scenarios.watch(
      s1.id,
      { target: { kind: "band", top: zone.top, bottom: zone.bottom }, intention: "entrée dans la résistance", expiresAt: Date.now() + HOUR },
      { by: "agent" },
    );
    const { drawing } = await levels.draw(s1.id, { from: zone.key, label: "résistance 4h", reason: "trois rejets en 4 h" }, "job_1");
    const watched = t.alerts.ofScenario(s1.id).filter((a) => a.state === "active");
    assert.deepEqual(
      watched.map((a) => (a.target.kind === "drawing" ? a.target.drawingId : a.target.kind)),
      [drawing.id],
      "la bande aux mêmes bornes est passée sur le niveau",
    );
    assert.equal(levels.zoneFor(s1.id, zone.top + 0.01, zone.bottom)?.id, drawing.id, "une bande qui reprend le niveau se posera sur lui");
    assert.equal(drawing.createdBy, "ia");
    assert.equal(drawing.scenarioId, s1.id);
    assert.ok(t.scenarios.get(s1.id)!.depends.drawings.includes(drawing.id));
    const after = await maps.view("XAUUSD", "4h");
    assert.ok(!("error" in after));
    assert.ok(!after.zones.some((z) => z.key === zone.key), "plus de doublon sur la carte");
    assert.ok(after.absorbed.some((a) => a.key === zone.key && a.drawingId === drawing.id));
    await assert.rejects(levels.draw(s1.id, { from: zone.key, top: zone.top + 20, label: "x", reason: "x" }), /déjà tracé|même endroit/);

    // Un second dossier au même endroit le partage au lieu de le doubler.
    const s2 = t.scenarios.open(dossier({ title: "Or : cassure de la résistance", direction: "long" }), { by: "agent" });
    const shared = await levels.draw(s2.id, { kind: "zone", top: zone.top, bottom: zone.bottom, label: "même zone", reason: "cassure attendue" });
    assert.equal(shared.shared, true);
    assert.equal(shared.drawing.id, drawing.id);

    // Jamais par-dessus un tracé de l'utilisateur : l'IA s'appuie sur le sien, ou lui suggère une correction.
    const mine = t.drawings.create("XAUUSD", { kind: "hline", price: 100 }, { by: "user" });
    await assert.rejects(
      levels.draw(s1.id, { kind: "line", price: 100.05, label: "support", reason: "creux" }),
      new RegExp(`déjà tracé par l'utilisateur \\(${mine.id}`),
    );
    levels.now = () => Date.now() - 1000;
    levels.suggest(mine.id, "ta ligne coupe les mèches à 99 : la descendre ?", s1.id, "job_1");
    levels.now = () => Date.now();
    assert.equal(levels.suggestions("XAUUSD").length, 1);
    assert.throws(() => levels.suggest(drawing.id, "x", undefined), /niveau de l'IA/);
    t.drawings.update(mine.id, { shape: { kind: "hline", price: 99 } });
    assert.equal(levels.suggestions("XAUUSD").length, 0, "faite : il a déplacé son tracé");

    // Le dossier qui l'a tracé se ferme : le niveau passe à celui qui s'y appuie encore.
    t.scenarios.abandon(s1.id, "essai", { by: "agent" });
    assert.equal(t.drawings.get(drawing.id)!.scenarioId, s2.id);

    // « Pas cette zone » : retiré, le dossier le perd et est relu ; noté pour sa façon de trader.
    const woke: string[] = [];
    t.scenarios.on("feedback", (e) => {
      if (e.wake) woke.push(e.scenario.id);
    });
    levels.dismiss(drawing.id, "pas cette zone");
    assert.equal(t.drawings.get(drawing.id), undefined);
    assert.ok(!t.scenarios.get(s2.id)!.depends.drawings.includes(drawing.id));
    assert.deepEqual(woke, [s2.id]);

    // « Garde cette zone » : elle devient la sienne, et ne partira plus avec le dossier.
    const free = await levels.draw(s2.id, { kind: "zone", top: 96, bottom: 95, label: "demande", reason: "base du dernier creux" });
    const kept = levels.keep(free.drawing.id, "je la garde");
    assert.equal(kept.createdBy, "user");
    assert.equal(kept.scenarioId, undefined);
    assert.deepEqual(woke, [s2.id], "garder ne fait pas relire le dossier");
    const { drawing: pivot } = await levels.draw(s2.id, { kind: "line", price: 104, label: "pivot", reason: "milieu du range" });
    assert.throws(() => t.alerts.create(GOLD, { target: { kind: "drawing", drawingId: pivot.id } } as never, "user"), /niveau de l'IA/);

    // Son tracé au même endroit qu'un niveau de l'IA le remplace dans le dossier.
    const over = t.drawings.create("XAUUSD", { kind: "zone", top: 104.3, bottom: 103.8 }, { by: "user" });
    await settled(() => !t.drawings.get(pivot.id));
    assert.equal(t.drawings.get(pivot.id), undefined);
    assert.ok(t.scenarios.get(s2.id)!.depends.drawings.includes(over.id));

    const signals = tradingSignals(t.data.db, 0, Date.now() + 1);
    assert.ok(signals.some((l) => /Niveau de l'IA retiré par l'utilisateur .*« pas cette zone »/.test(l)));
    assert.ok(signals.some((l) => /Niveau de l'IA gardé par l'utilisateur .*« je la garde »/.test(l)));
    assert.ok(signals.some((l) => /Niveau de l'IA gardé .*retracé par l'utilisateur/.test(l)));

    // Le dernier dossier se ferme : ses niveaux restants partent, les tracés de l'utilisateur restent.
    const last = await levels.draw(s2.id, { kind: "line", price: 107, label: "relais", reason: "milieu de la jambe" });
    t.scenarios.abandon(s2.id, "essai", { by: "agent" });
    assert.equal(t.drawings.get(last.drawing.id), undefined);
    assert.ok(t.drawings.get(kept.id) && t.drawings.get(over.id) && t.drawings.get(mine.id));
  } finally {
    t.cleanup();
  }
});

/** Un JobService simulé : il note les travaux lancés, et on les termine à la main. */
function fakeJobs() {
  const started: Array<StartJobInput & { id: string }> = [];
  const jobs = Object.assign(new EventEmitter(), {
    started,
    start(input: StartJobInput) {
      const row = { id: `job_${started.length + 1}`, session_id: input.sessionId, kind: "agent", title: input.title, state: "running", created_at: Date.now() };
      started.push({ ...input, id: row.id });
      return row;
    },
    finish(id: string, result: string, state = "succeeded") {
      const s = started.find((j) => j.id === id)!;
      jobs.emit("job.finished", {
        job: { id, session_id: s.sessionId, kind: "agent", title: s.title, state, summary: result, created_at: Date.now() - 1000 },
        announce: false,
        result,
      });
    },
  });
  return jobs;
}

/** Les agents de la recherche d'opportunités, sur des services simulés (agents, calendrier, wrap). */
function agents(t: ReturnType<typeof setup>) {
  const jobs = fakeJobs();
  const briefs = Object.assign(new EventEmitter(), { latest: () => undefined });
  const calendar = { events: () => [] };
  const config = Object.assign(Object.create(Object.getPrototypeOf(t.data.config)), t.data.config, {
    setupWakesPerDay: 40,
    setupProducts: ["or"],
  });
  Object.defineProperty(config, "setupsReady", { value: true });
  const memory = new MemoryService(t.data.db, t.data.config);
  const examples = new ExampleService(t.data.db, t.market, t.drawings, t.data.logger);
  const skills = { activeFor: () => [] };
  const svc = new SetupAgentsService(
    config,
    t.data.db,
    jobs as never,
    t.scenarios,
    t.alerts,
    t.drawings,
    t.market,
    calendar as never,
    briefs as never,
    memory,
    skills as never,
    examples,
    t.data.logger,
  );
  svc.onModuleInit();
  return { svc, jobs };
}

test("continuité : une hypothèse invalidée réveille le dossier, et l'agent reçoit le dossier, son fil et ce qui a changé", async () => {
  const t = setup({ candles: (tf) => [{ t: Math.floor(Date.now() / 1000) - 900, o: 3950, h: 3958, l: 3949, c: 3953 }].filter(() => tf !== "") });
  const { svc, jobs } = agents(t);
  try {
    t.quote(3940);
    const h = t.scenarios.addHypothesis(
      { statement: "Le dollar reprend avant le CPI", products: [GOLD], bias: "down", horizon: "intraday", invalidation: "CPI froid" },
      "kopilia",
    );
    const zone = t.drawings.create("XAUUSD", { kind: "zone", top: 3960, bottom: 3950 }, { label: "R 4h", by: "user" });
    const s = t.scenarios.open(dossier({ depends: { hypotheses: [h.id], drawings: [zone.id] } }), { by: "agent", jobId: "job_pass" });
    t.scenarios.watch(s.id, { target: { kind: "drawing", drawingId: zone.id }, intention: "vérifier le rejet de la zone en 15 min" }, { by: "agent" });
    t.scenarios.markChecked(s.id, Date.now() - 10);
    await sleep(5);

    // L'utilisateur, ou une donnée, invalide l'hypothèse : le dossier est revu sans attendre son alerte.
    t.scenarios.updateHypothesis(h.id, { state: "invalidated", reason: "CPI sorti froid : 0,1 % contre 0,3 % attendu" }, "user");
    await sleep(30);
    assert.equal(jobs.started.length, 1, "un agent réveillé");
    const wake = { ...jobs.started[0], prompt: plain(jobs.started[0].prompt) };
    assert.equal(wake.internal?.setups, true, "avec ses outils");
    assert.match(
      wake.prompt,
      /\[Réveil\] l'hypothèse h_\w+ \(« Le dollar reprend avant le CPI »\) est maintenant invalidée : par l'utilisateur : CPI sorti froid/,
    );
    assert.match(wake.prompt, /Plan : Si le prix entre dans la zone/, "le dossier entier");
    assert.match(wake.prompt, /Fil du dossier[\s\S]*\[ouvert · IA\]/, "son fil");
    assert.match(wake.prompt, /Ce qui a changé depuis ta dernière lecture :\n- Hypothèse modifiée : h_\w+ .*INVALIDÉE : par l'utilisateur : CPI sorti froid/);
    assert.match(wake.prompt, /1\. Le pourquoi de ce dossier tient-il encore[\s\S]*Sinon, abandonne-le/, "le pourquoi d'abord");
    assert.match(wake.prompt, /Alertes de l'IA en place :\n- a_\w+ : sur la zone 3 950,00 – 3 960,00 « R 4h »/);
    assert.match(wake.prompt, /Dernières bougies de l'unité de l'entrée/);
    assert.ok(
      t.scenarios.events(s.id).some((e) => e.kind === "context" && /invalidée/.test(e.text)),
      "le changement est écrit au fil",
    );

    // Pendant le réveil, l'alerte part : elle attend la fin de ce réveil, et ne se perd pas.
    t.quote(3951);
    await sleep(30);
    assert.equal(jobs.started.length, 1, "un seul réveil à la fois par dossier");
    jobs.finish("job_1", "J'abandonne : l'hypothèse est invalidée.");
    await sleep(30);
    assert.ok(
      t.scenarios.events(s.id).some((e) => e.kind === "decision" && /J'abandonne/.test(e.text)),
      "la conclusion reste au fil",
    );
    assert.equal(jobs.started.length, 2, "le réveil suivant part ensuite");
    assert.match(jobs.started[1].prompt, /ton alerte a_\w+ vient de partir[\s\S]*ton intention en la posant : « vérifier le rejet de la zone en 15 min »/);
    assert.doesNotMatch(jobs.started[1].prompt, /Hypothèse modifiée/, "déjà lu au réveil précédent : plus « nouveau »");

    // L'utilisateur efface la zone dont dépend le dossier : il est revu.
    jobs.finish("job_2", "J'attends.");
    await sleep(30);
    t.drawings.remove([zone.id]);
    await sleep(30);
    assert.equal(jobs.started.length, 3);
    assert.match(jobs.started[2].prompt, /Le tracé d_\w+ dont dépend le dossier a été effacé/);
  } finally {
    svc.onModuleDestroy();
    t.cleanup();
  }
});

test("garder un niveau de l'IA ne réveille pas son dossier ; le déplacer ensuite, si", async () => {
  const candles: ChartCandle[] = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 101, 100, 99, 100, 101, 100].map((c, i) => ({
    t: 1_700_000_000 + i * 900,
    o: c,
    h: c + 1,
    l: c - 1,
    c,
  }));
  const t = setup({ candles: () => candles });
  const { svc, jobs } = agents(t);
  const maps = new MapService(t.data.db, t.market, t.drawings, t.alerts, t.data.logger);
  const levels = new LevelService(t.data.db, t.drawings, t.scenarios, maps, t.alerts, t.data.logger);
  levels.onModuleInit();
  try {
    const s = t.scenarios.open(dossier(), { by: "agent" });
    const { drawing } = await levels.draw(s.id, { kind: "zone", top: 99.5, bottom: 98.5, label: "demande", reason: "base du range" });
    levels.keep(drawing.id);
    await sleep(30);
    assert.equal(jobs.started.length, 0, "gardé tel quel : rien à relire");
    await sleep(5);
    t.drawings.update(drawing.id, { shape: { kind: "zone", top: 99.8, bottom: 98.5 } });
    await sleep(30);
    assert.equal(jobs.started.length, 1, "déplacé par l'utilisateur : le dossier est relu");
  } finally {
    svc.onModuleDestroy();
    t.cleanup();
  }
});

test("budget : au-delà des réveils du jour, le réveil est reporté et le dossier marqué à revoir", async () => {
  const t = setup();
  const { svc, jobs } = agents(t);
  try {
    (svc as unknown as { config: { setupWakesPerDay: number } }).config.setupWakesPerDay = 0;
    const s = t.scenarios.open(dossier(), { by: "agent" });
    svc.wake(s.id, "test");
    await sleep(30);
    assert.equal(jobs.started.length, 0);
    assert.match(t.scenarios.get(s.id)!.review ?? "", /test/);
    assert.ok(t.scenarios.events(s.id).some((e) => /budget du jour/.test(e.text)));
  } finally {
    svc.onModuleDestroy();
    t.cleanup();
  }
});

test("rapport au dialogue : le setup proposé, ses niveaux, l'analyse de l'agent, puis l'avis objectif de Kopilia, sans ordre", () => {
  const t = setup();
  try {
    const s = t.scenarios.open(dossier(), { by: "agent" });
    t.scenarios.propose(
      s.id,
      { summary: "Mèche haute rejetée dans la zone 4 h, clôture 15 min à 3 953.", entry: 3955, stop: 3962, targets: [3930] },
      { by: "agent" },
    );
    const r = opportunityReport([t.scenarios.get(s.id, true)!]);
    assert.equal(r.urgent, true);
    assert.deepEqual(r.scenarioIds, [s.id]);
    assert.match(r.prompt, /^\[Opportunité\] Un setup se déclenche/);
    assert.match(plain(r.prompt), /entrée 3 955,00, stop 3 962,00/);
    assert.match(r.prompt, /Mèche haute rejetée dans la zone 4 h/);
    assert.match(r.prompt, /Termine par ton avis objectif en une phrase/);
    assert.match(r.prompt, /Tu ne prépares aucun ordre sans qu'il le demande/);
    assert.doesNotMatch(r.prompt, /conseil/);
    const text = dossierText(t.scenarios.get(s.id)!, []);
    assert.match(plain(text), /Invalidé si : Clôture 15 min au-dessus de 3 960/);
    assert.throws(() => t.scenarios.abandon("sc_nope", "x", { by: "agent" }), SetupError);
  } finally {
    t.cleanup();
  }
});

test("fin de recherche : ce qu'elle a repéré (en attente) et abandonné, son compte rendu ; dite même sans rien si l'utilisateur l'a lancée", async () => {
  const t = setup();
  const { svc, jobs } = agents(t);
  const done: PassDone[] = [];
  svc.on("pass", (d) => done.push(d));
  try {
    const old = t.scenarios.open(dossier({ title: "Or : cassure de la résistance 4 h", direction: "long" }), { by: "agent" });
    assert.equal(svc.search({ reason: "à la demande de l'utilisateur", byUser: true }).started, true);
    const s = t.scenarios.open(dossier(), { by: "agent", jobId: "job_1" });
    t.scenarios.abandon(old.id, "la résistance a rejeté le prix", { by: "agent", jobId: "job_1" });
    jobs.finish("job_1", "Un setup en attente sur l'or, rien d'autre près d'un niveau.");
    await sleep(10);
    assert.equal(done.length, 1);
    const d = done[0];
    assert.equal(d.byUser, true);
    assert.deepEqual(
      d.opened.map((x) => x.id),
      [s.id],
    );
    assert.deepEqual(
      d.closed.map((x) => x.id),
      [old.id],
    );
    const banner = searchedTexts(d);
    assert.equal(banner.title, "Recherche finie : 1 setup en attente");
    assert.equal(banner.detail, "Or, vendeur : rejet de la résistance 4 h");
    const r = searchReport(d);
    assert.equal(r.urgent, undefined, "pas urgent : après la phrase en cours");
    assert.match(r.prompt, /^\[Opportunité\] La recherche de setups que l'utilisateur a demandée est finie\./);
    assert.match(r.prompt, /Setups en attente qu'elle a repérés :\n- sc_\w+ — Or : rejet de la résistance 4 h \(or, vendeur, 15m \/ 4h, en attente, échéance/);
    assert.match(r.prompt, /Ce qui le déclencherait : Si le prix entre dans la zone/);
    assert.match(r.prompt, /Abandonnés pendant la recherche :\n- .*cassure.* : la résistance a rejeté le prix/);
    assert.match(r.prompt, /Compte rendu de l'IA : Un setup en attente sur l'or/);
    assert.match(r.prompt, /Ils ne sont pas encore déclenchés/);

    // Une recherche après le wrap qui ne repère rien : rien à dire (la gateway ne la signale pas) ; lancée par lui : « rien de nouveau ».
    svc.search({ reason: "après le wrap programmé" });
    jobs.finish("job_2", "Rien près d'un niveau avant le CPI.");
    await sleep(10);
    assert.equal(done[1].byUser, false);
    assert.equal(done[1].opened.length, 0);
    const nothing = searchReport({ ...done[1], byUser: true });
    assert.match(nothing.prompt, /aucun nouveau setup/);
    assert.match(nothing.prompt, /Déjà en cours avant elle :\n- sc_\w+ — Or : rejet/);
    assert.equal(searchedTexts(done[1]).title, "Recherche finie : rien de nouveau");
    assert.equal(searchedTexts(done[1]).detail, "1 setup toujours en cours");
  } finally {
    svc.onModuleDestroy();
    t.cleanup();
  }
});
