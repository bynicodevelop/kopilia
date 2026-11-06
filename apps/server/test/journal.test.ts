// Journal de trading : le graphique figé au ticket (les tracés de ce moment,
// jamais ceux posés après), les gestes pendant le trade (à sa demande ou sur la
// plateforme), les sorties lues chez le courtier, le résultat (gagnant, perdant,
// neutre), les faits face à la fiche, les notes, le rangement par fiche.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import { exitLabel, tradeOutcome, type Drawing, type Trade } from "@kopilia/contracts";
import { DrawingService } from "../src/dashboard/drawing.service.js";
import type { DashboardService } from "../src/dashboard/dashboard.service.js";
import type { MarketService } from "../src/market/market.service.js";
import { AnalysisService } from "../src/analyses/analysis.service.js";
import { TradingService } from "../src/trading/trading.service.js";
import { manageTicketText } from "../src/trading/trading-texts.js";
import { JournalService, fitTimeframe } from "../src/journal/journal.service.js";
import { durationLabel } from "../src/journal/journal-facts.js";
import { journalText, journalTradeText } from "../src/journal/journal-texts.js";
import { tradeReport } from "../src/gateway/messages.js";
import { tempData } from "./harness.js";
import { FakeBroker } from "./fake-broker.js";

const NAS = { symbol: "NAS100", name: "Nasdaq 100", digits: 2 };
const LONG = { kind: "position", side: "long", entry: 21450, stop: 21410, target: 21570, from: Math.floor(Date.now() / 1000) - 3600 } as const;
const SHORT = { kind: "position", side: "short", entry: 21450, stop: 21490, target: 21330, from: Math.floor(Date.now() / 1000) - 3600 } as const;
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
const pause = () => new Promise((r) => setTimeout(r, 3));

/** Des bougies de 15 minutes autour de 21 450, jusqu'à `before`. */
function candles(before: number, n = 300) {
  const out = [];
  const end = Math.floor(before / 900) * 900;
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * 900;
    const o = 21450 + Math.sin(i / 7) * 30;
    const c = o + Math.cos(i / 5) * 8;
    out.push({ t, o, h: Math.max(o, c) + 4, l: Math.min(o, c) - 4, c });
  }
  return out;
}

function setup() {
  const data = tempData("journal", { KOPILIA_METAAPI_TOKEN: "jeton", KOPILIA_TRADING_ORDERS: "1", KOPILIA_TRADING_LIVE: "0" });
  const broker = new FakeBroker();
  const drawings = new DrawingService(data.db, data.logger);
  const dashboard = {
    drawings,
    on: () => dashboard,
    view: () => ({ panels: [], drawings: drawings.list(), alerts: [] }),
    list: () => [{ id: "p_1", kind: "chart", symbol: "NAS100", name: "Nasdaq 100", title: "Nasdaq 100", digits: 2, timeframe: "15m", indicators: [] }],
    indicatorsFor: () => [],
  } as unknown as DashboardService;
  const trading = new TradingService(data.config, data.db, broker as unknown as MarketService, dashboard, data.logger);
  const analyses = new AnalysisService(data.db);
  const loads: Array<{ timeframe: string; before?: number }> = [];
  /** Les bougies rendues par le faux marché : autour de 21 450 par défaut ; un test peut les dessiner. */
  const feed: { make: (timeframe: string, before: number) => ReturnType<typeof candles> } = { make: (_tf, before) => candles(before) };
  const market = {
    chartCandles: async (symbol: string, timeframe: string, opts: { before?: number } = {}) => {
      loads.push({ timeframe, ...opts });
      return { symbol, timeframe, candles: feed.make(timeframe, (opts.before ?? Date.now() / 1000) as number), more: false };
    },
  } as unknown as MarketService;
  const journal = new JournalService(data.db, trading, analyses, dashboard, market, data.logger);
  journal.onModuleInit();
  const changes: Array<string | undefined> = [];
  journal.on("changed", (id) => changes.push(id));
  /** Prépare et confirme l'ordre d'une boîte ; au marché par défaut. */
  const take = async (box: Drawing, execution: "market" | "pending" = "market"): Promise<Trade> => {
    const ticket = await trading.prepareOpen({ drawingId: box.id, execution });
    const r = await trading.confirm(ticket.id, "click");
    assert.ok(r.ok, r.text);
    await trading.sync();
    return trading.getTrade(r.trade!.id)!;
  };
  return { data, broker, drawings, trading, analyses, journal, loads, changes, feed, take, done: () => data.cleanup() };
}

test("figé au ticket : les tracés de ce moment, jamais ceux posés après ; rattaché à la fiche ouverte, dans son sens", async () => {
  const t = setup();
  try {
    const fiche = t.analyses.note(NAS, {
      fundamental: { bias: "up", reason: "les bénéfices de l'IA" },
      idea: { side: "buy", zone: { low: 21440, high: 21460 } },
    }).analysis;
    t.drawings.create("NAS100", { kind: "zone", top: 21460, bottom: 21440 }, { by: "user", label: "zone A" });
    const box = t.drawings.create("NAS100", LONG, { by: "user" });
    const trade = await t.take(box);
    // Posé après le ticket : il reste sur son graphique, jamais sur la page du trade.
    t.drawings.create("NAS100", { kind: "hline", price: 21530 }, { by: "user", label: "posée après" });
    t.drawings.update(box.id, { shape: { ...LONG, target: 21600 } });

    const snap = t.journal.snapshot(trade.id)!;
    assert.equal(snap.timeframe, "15m");
    assert.equal(snap.fiche?.id, fiche.id);
    assert.deepEqual(
      snap.drawings.map((d) => d.label ?? d.kind),
      ["zone A", "position"],
    );
    assert.equal((snap.drawings.find((d) => d.kind === "position") as Extract<Drawing, { kind: "position" }>).target, 21570, "la boîte telle qu'au ticket");

    const page = t.journal.page(trade.id);
    assert.equal(page.frozen, true);
    assert.equal(page.analysisId, fiche.id);
    assert.equal(page.fidelity, "with");
    const keys = page.facts.map((f) => f.key);
    assert.ok(keys.includes("with-idea"));
    assert.ok(keys.includes("zone"));
    assert.match(plain(page.facts.find((f) => f.key === "zone")!.text), /Entrée à 21 450,50, dans ta zone \(21 440,00 – 21 460,00\)/);
    assert.equal(page.facts.find((f) => f.key === "zone")!.tone, "ok");
    // Au marché : exécuté tout de suite, le ticket suffit.
    assert.deepEqual(
      page.thread.map((i) => i.kind),
      ["view", "ticket"],
    );

    const svg = await t.journal.chart(trade.id);
    assert.equal(typeof svg, "string");
    assert.ok((svg as string).includes("zone A"), "la zone d'avant le ticket est dessinée");
    assert.ok(!(svg as string).includes("posée après"), "la ligne posée après n'y est pas");
    assert.match(svg as string, /figé au ticket/);
    assert.equal(t.loads.at(-1)?.timeframe, "15m");
  } finally {
    t.done();
  }
});

test("gestion : stop remonté à sa demande puis sur la plateforme, objectif déplacé, part fermée au mobile ; sorti au stop remonté", async () => {
  const t = setup();
  try {
    const box = t.drawings.create("NAS100", LONG, { by: "user" });
    let trade = await t.take(box);
    assert.equal(trade.state, "open");
    const pos = () => t.broker.positions[0];

    t.broker.quote = { bid: 21500, ask: 21501 };
    const be = await t.trading.prepareManage({ action: "breakeven", trade: trade.id });
    await t.trading.confirm(be.id, "click");
    await t.trading.sync();
    // Le nouveau stop lu chez le courtier n'est pas un second geste.
    assert.deepEqual(
      t.trading.gestures(trade.id).map((g) => [g.kind, g.source, g.from, g.to]),
      [["stop", "kopilia", 21410, 21450.5]],
    );

    pos().stopLoss = 21480;
    await t.trading.sync();
    pos().takeProfit = 21600;
    await t.trading.sync();
    t.broker.partial(pos().id, 1.2, "DEAL_REASON_MOBILE");
    await t.trading.sync();
    await t.trading.sync();
    const gestures = t.trading.gestures(trade.id);
    assert.deepEqual(
      gestures.map((g) => [g.kind, g.source]),
      [
        ["stop", "kopilia"],
        ["stop", "platform"],
        ["target", "platform"],
        ["partial", "platform"],
      ],
    );
    assert.equal(gestures[1].from, 21450.5);
    assert.equal(gestures[1].to, 21480);
    assert.equal(gestures[1].price, 21500);
    assert.equal(gestures[1].r, 1.22);
    assert.deepEqual([gestures[2].from, gestures[2].to], [21570, 21600]);
    assert.equal(gestures[3].lots, 1.2);
    trade = t.trading.getTrade(trade.id)!;
    assert.deepEqual(trade.targets, [21600]);
    assert.equal(trade.stop, 21480);
    const texts = t.trading
      .events(trade.id)
      .filter((e) => e.kind === "gesture")
      .map((e) => plain(e.text));
    assert.equal(texts[1], "Stop 21 450,50 → 21 480,00, sur la plateforme (le prix à 21 500,00, +1,22 R)");
    assert.equal(texts[3], "1,2 lot fermé à 21 500,00, +59 €, sur la plateforme (+1,22 R)");

    t.broker.close(pos().id, 21480, "DEAL_REASON_SL");
    await t.trading.sync();
    trade = t.trading.getTrade(trade.id)!;
    assert.equal(trade.state, "closed");
    assert.equal(trade.legs[0].exits?.length, 2);
    assert.deepEqual(
      trade.legs[0].exits!.map((e) => e.reason),
      ["manual", "stop"],
    );
    assert.equal(exitLabel(trade), "au stop remonté");
    assert.equal(tradeOutcome(trade), "win");

    const page = t.journal.page(trade.id);
    assert.equal(page.outcome, "win");
    assert.equal(page.exit, "au stop remonté");
    assert.match(plain(page.facts.find((f) => f.key === "gestures")!.text), /stop remonté 2 fois, objectif déplacé une fois, 1 part fermée avant la fin/);
    assert.ok(!page.facts.some((f) => f.key === "stop-widened"));
    assert.equal(page.fidelity, "none");
    // Le fil : le ticket d'ouverture, celui du break-even et son geste, les gestes sur la plateforme, la fermeture.
    assert.deepEqual(
      page.thread.map((i) => i.kind),
      ["ticket", "ticket", "gesture", "gesture", "gesture", "gesture", "closed"],
    );

    const svg = (await t.journal.chart(trade.id)) as string;
    // Le stop en trois marches (départ, break-even, remonté), l'objectif en deux, l'entrée et deux sorties.
    assert.equal((svg.match(/stroke-width="1\.8"/g) ?? []).length, 3, "une entrée et deux sorties");
    assert.ok(!svg.includes('stroke-dasharray="3 3"'), "pas de ligne du dernier prix sur un trade fermé");
  } finally {
    t.done();
  }
});

test("contre la fiche : vente contre le fondamental, idée de départ changée, objection relevée ; stop élargi ; neutre sous 0,1 R", async () => {
  const t = setup();
  try {
    const fiche = t.analyses.note(NAS, { fundamental: { bias: "up" }, idea: { side: "buy", zone: { low: 21300, high: 21320 } } }).analysis;
    await pause();
    t.analyses.note(NAS, { idea: { side: "sell", zone: { low: 21445, high: 21455 } } });
    t.analyses.challenge(fiche.id, [{ key: "flip", text: "Hier tu voyais achat, et ton fondamental reste haussier. Qu'est-ce qui a changé ?" }]);
    t.analyses.answer(fiche.id, "le RSI diverge en 1 heure");
    await pause();
    const box = t.drawings.create("NAS100", SHORT, { by: "user" });
    let trade = await t.take(box);
    t.broker.positions[0].stopLoss = 21520;
    await t.trading.sync();
    t.broker.close(t.broker.positions[0].id, 21450, "DEAL_REASON_CLIENT");
    await t.trading.sync();
    trade = t.trading.getTrade(trade.id)!;
    assert.equal(trade.state, "closed");
    assert.ok(Math.abs(trade.r!) < 0.1, `r ${trade.r}`);

    const page = t.journal.page(trade.id);
    assert.equal(page.outcome, "neutral");
    assert.equal(page.exit, "à la main, sur la plateforme");
    assert.equal(page.fidelity, "against");
    const fact = (k: string) => page.facts.find((f) => f.key === k);
    assert.equal(fact("against-fundamental")?.tone, "warn");
    assert.equal(fact("with-idea")?.tone, "ok", "dans le sens de l'idée du moment (la vente)");
    assert.match(fact("changed-mind")!.text, /ton idée de départ \(.+\) était achat sur 21\s300,00 – 21\s320,00/);
    assert.match(fact("objection")!.text, /Qu'est-ce qui a changé \? » ; ta réponse : « le RSI diverge en 1 heure »/);
    assert.equal(fact("objection")!.tone, "warn");
    assert.match(plain(fact("stop-widened")!.text), /Stop élargi de 21 490,00 à 21 520,00, sur la plateforme/);
    assert.match(plain(fact("outcome")!.text), /^Neutre : −0,0\d R, .+, à la main, sur la plateforme/);
    // Le fil reprend la fiche avant le ticket : ses deux lectures, l'objection, sa réponse.
    assert.deepEqual(
      page.thread.slice(0, 4).map((i) => i.kind),
      ["view", "view", "challenge", "why"],
    );
    const lines = journalTradeText(page);
    assert.ok(lines.some((l) => l.startsWith("fait : Contre ton biais fondamental (haussier)")));
  } finally {
    t.done();
  }
});

test("le journal par fiche : chaque fiche et ses trades, les trades sans fiche, les fiches ouvertes sans trade ; notes ; trouver un trade", async () => {
  const t = setup();
  try {
    // Un ordre en attente pris avant toute fiche.
    const early = await t.take(t.drawings.create("NAS100", LONG, { by: "user" }), "pending");
    await pause();
    const a = t.analyses.note(NAS, { fundamental: { bias: "up" }, idea: { side: "buy" } }).analysis;
    await pause();
    const first = await t.take(t.drawings.create("NAS100", LONG, { by: "user" }));
    t.broker.close(first.legs[0].positionId!, 21570, "DEAL_REASON_TP");
    await t.trading.sync();
    t.analyses.close(a.id, "objectif atteint");
    await pause();
    const b = t.analyses.note(NAS, { fundamental: { bias: "up" }, idea: { side: "sell" } }).analysis;
    await pause();
    const second = await t.take(t.drawings.create("NAS100", SHORT, { by: "user" }));
    t.broker.close(second.legs[0].positionId!, 21490, "DEAL_REASON_SL");
    await t.trading.sync();
    t.analyses.note({ symbol: "XAUUSD", name: "or", digits: 2 }, { idea: { side: "buy" } });

    const noted = t.journal.note("je suis sorti trop tôt, j'avais peur de rendre");
    assert.equal(noted.trade.id, second.id, "par défaut : le dernier trade fermé");
    assert.ok(t.changes.includes(second.id));
    assert.throws(() => t.journal.note("  "), /vide/);

    const j = t.journal.list();
    assert.deepEqual(
      j.groups.map((g) => [g.analysisId ?? "sans", g.trades.map((l) => l.id)]),
      [
        [b.id, [second.id]],
        [a.id, [first.id]],
        ["sans", [early.id]],
        [j.groups[3].analysisId, []],
      ],
    );
    assert.equal(j.groups[3].name, "or");
    assert.equal(j.groups[0].trades[0].outcome, "loss");
    assert.equal(j.groups[0].trades[0].note, "je suis sorti trop tôt, j'avais peur de rendre");
    assert.equal(j.groups[0].trades[0].fidelity, "against", "une vente contre son fondamental haussier");
    assert.equal(j.groups[1].trades[0].outcome, "win");
    assert.equal(j.groups[1].trades[0].remark, "à l'objectif");
    assert.equal(j.groups[1].state, "closed");
    assert.equal(j.groups[2].trades[0].remark, "ordre en attente");
    assert.deepEqual([j.totals.count, j.totals.wins, j.totals.losses, j.totals.neutral], [2, 1, 1, 0]);

    const text = journalText(j, 30).map(plain);
    assert.match(text[0], /^2 trades fermés sur 30 jours : 1 gagnant, 1 perdant, 0 neutre/);
    assert.ok(text.some((l) => l.startsWith("Sans fiche — 1 trade")));
    assert.ok(text.some((l) => /^Fiche or .+ — pas encore de trade$/.test(l)));
    assert.ok(text.some((l) => l.includes("note : « je suis sorti trop tôt")));

    assert.equal(t.journal.find({ product: "nasdaq" }).id, second.id);
    assert.equal(t.journal.find({ trade: first.id }).id, first.id);
    assert.throws(() => t.journal.find({ product: "pétrole" }), /aucun trade sur « pétrole »/);
    const shown: string[] = [];
    t.journal.on("show", (id) => shown.push(id));
    t.journal.show({ product: "Nasdaq" });
    assert.deepEqual(shown, [second.id]);
  } finally {
    t.done();
  }
});

test("un trade d'avant le journal : sa fiche retrouvée par la date, ses niveaux seuls sur le graphique", async () => {
  const t = setup();
  try {
    t.analyses.note(NAS, { idea: { side: "buy" } });
    await pause();
    // Le journal ne l'a pas vu passer : aucun graphique figé.
    t.trading.removeAllListeners("confirmed");
    const old = await t.take(t.drawings.create("NAS100", LONG, { by: "user", label: "boîte" }));
    t.drawings.create("NAS100", { kind: "hline", price: 21530 }, { by: "user", label: "plus tard" });
    const page = t.journal.page(old.id);
    assert.equal(page.frozen, false);
    assert.ok(page.analysisId, "la fiche ouverte à la date du ticket");
    assert.ok(page.facts.some((f) => f.key === "not-frozen"));
    const svg = (await t.journal.chart(old.id)) as string;
    assert.ok(!svg.includes("plus tard"), "aucun tracé d'aujourd'hui");
    assert.match(svg, /trade d'avant le journal/);
    assert.match(svg, /fill-opacity="0.1"/, "sa boîte refaite à ses niveaux");
  } finally {
    t.done();
  }
});

test("à côté : unité du graphique figé, durées, rapport de fermeture qui demande une note, ordre de vente retiré", () => {
  assert.equal(fitTimeframe("15m", 3 * 3_600_000), "15m");
  assert.equal(fitTimeframe("15m", 3 * 86_400_000), "4h");
  assert.equal(fitTimeframe("1d", 400 * 86_400_000), "1w");
  assert.equal(durationLabel(35 * 60_000), "35 min");
  assert.equal(durationLabel(124 * 60_000), "2 h 04");
  assert.equal(durationLabel(76 * 3_600_000), "3 j 4 h");
  const trade = { id: "t_1", state: "closed" } as Trade;
  const closed = tradeReport({ kind: "closed", trade, title: "Nasdaq : achat fermé", line: "Nasdaq : position fermée." });
  assert.match(closed.prompt, /un mot pour son journal/);
  assert.match(closed.prompt, /journal_note/);
  const filled = tradeReport({ kind: "filled", trade: { ...trade, state: "open" }, title: "x", line: "y" });
  assert.doesNotMatch(filled.prompt, /journal/);
  const short = { side: "short", execution: "limit", entry: 177.656, lots: 0.39, name: "euro-yen" } as Trade;
  assert.match(
    manageTicketText({ action: "cancel", name: "euro-yen", digits: 3 } as Parameters<typeof manageTicketText>[0], short),
    /^Retirer ton ordre de vente à cours limité sur euro-yen/,
  );
});

/** Des bougies de 5 minutes dessinées à partir de `base` (epoch ms) : [bas, haut, clôture] ; cinq bougies plates avant. */
function drawn(base: number, rows: Array<[number, number, number]>) {
  const t0 = Math.floor(base / 1000 / 300) * 300;
  const flat = Array.from({ length: 5 }, (_, i) => ({ t: t0 - (5 - i) * 300, o: 21450, h: 21455, l: 21445, c: 21450 }));
  let o = 21450;
  return [
    ...flat,
    ...rows.map(([l, h, c], i) => {
      const bar = { t: t0 + i * 300, o, h, l, c };
      o = c;
      return bar;
    }),
  ];
}

test("page complète : le plan du ticket contre ce qu'il a géré, l'objectif touché après sa sortie, son idée de départ rejouée", async () => {
  const t = setup();
  try {
    t.analyses.note(NAS, { idea: { side: "sell", zone: { low: 21500, high: 21520 } }, invalidation: "au-dessus de 21 560" });
    await pause();
    t.analyses.note(NAS, { fundamental: { bias: "up" }, idea: { side: "buy", zone: { low: 21440, high: 21460 } }, invalidation: "sous 21 400" });
    await pause();
    let trade = await t.take(t.drawings.create("NAS100", LONG, { by: "user" }));
    t.broker.quote = { bid: 21490, ask: 21491 };
    const be = await t.trading.prepareManage({ action: "breakeven", trade: trade.id });
    await t.trading.confirm(be.id, "click");
    await t.trading.sync();
    t.broker.close(t.broker.positions[0].id, 21480, "DEAL_REASON_CLIENT");
    await t.trading.sync();
    trade = t.trading.getTrade(trade.id)!;
    assert.equal(trade.r, 0.7);
    // Après sa sortie, le prix monte jusqu'à l'objectif du ticket (21 570) ; l'idée de départ (vente 21 500 – 21 520) est invalidée au-dessus de 21 560.
    t.feed.make = () =>
      drawn(trade.openedAt!, [
        [21440, 21462, 21455],
        [21450, 21490, 21485],
        [21470, 21505, 21480],
        [21475, 21530, 21525],
        [21520, 21580, 21575],
      ]);
    const page = await t.journal.fullPage(trade.id);
    const fact = (k: string) => page.facts.find((f) => f.key === k);
    assert.match(
      plain(fact("plan")!.text),
      /^Prévu au ticket \(stop 21 410,00, objectif 21 570,00, rien de touché\) : objectif touché .+, \+2,95 R\. Géré : \+0,7 R, −2,25 R par rapport au plan\.$/,
    );
    assert.equal(fact("plan")!.tone, "warn");
    assert.match(
      plain(fact("after")!.text),
      /^Après ta sortie \(à la main, sur la plateforme\), l'objectif du ticket \(21 570,00\) a été touché .+ : 2,25 R laissés\.$/,
    );
    assert.match(
      plain(fact("idea-replay")!.text),
      /^Ton idée de départ \(vente sur 21 500,00 – 21 520,00, .+\), rejouée sur les cours : zone touchée .+, puis invalidation \(21 560,00\) touchée .+, −1 R après \+0,5 R au mieux\.$/,
    );
    // Rangés après ce qu'ils complètent.
    const keys = page.facts.map((f) => f.key);
    assert.ok(keys.indexOf("plan") === keys.indexOf("outcome") + 1 && keys.indexOf("after") === keys.indexOf("plan") + 1);
    assert.equal(keys.indexOf("idea-replay"), keys.indexOf("changed-mind") + 1);
    // Une seconde lecture vient du rejeu gardé (tranché) : aucune bougie de plus.
    const loads = t.loads.length;
    await t.journal.fullPage(trade.id);
    assert.equal(t.loads.length, loads);
    // Une fiche sans trade : son idée rejouée, en une ligne.
    t.analyses.note({ symbol: "XAUUSD", name: "or", digits: 2 }, { idea: { side: "buy", zone: { low: 21440, high: 21460 } }, invalidation: "sous 21 400" });
    const j = await t.journal.listFull();
    const gold = j.groups.find((g) => g.name === "or")!;
    assert.match(gold.untaken ?? "", /^Idée non prise : zone touchée .+ à ce jour/);
  } finally {
    t.done();
  }
});

test("l'analyse de son trading : rien à analyser sans trade ; en arrière-plan, une à la fois ; l'IA reçoit les faits et les graphiques ; gardée et montrée", async () => {
  const t = setup();
  try {
    assert.throws(() => t.journal.review(7), /pas disponible|rien à analyser/);
    const trade = await t.take(t.drawings.create("NAS100", LONG, { by: "user" }));
    t.broker.close(t.broker.positions[0].id, 21390, "DEAL_REASON_SL");
    await t.trading.sync();
    t.journal.note("je suis entré avant la bougie de rejet");
    let seen: import("@kopilia/contracts").ClaudeContentBlock[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.journal.reviewer = async (content) => {
      seen = content;
      await gate;
      return JSON.stringify({
        summary: "Ta seule perte vient d'une entrée avant ta bougie de rejet.",
        findings: [{ title: "Entrée anticipée", text: "Sur ce trade, tu notes être entré avant la bougie de rejet.", trades: [trade.id] }],
        carnet: null,
      });
    };
    const reviewed = new Promise<import("@kopilia/contracts").JournalReview>((r) => t.journal.once("reviewed", r));
    assert.deepEqual(t.journal.review(7), { trades: 1, untaken: 0 });
    assert.equal(t.journal.busy, true);
    assert.throws(() => t.journal.review(7), /déjà en cours/);
    assert.equal((await t.journal.listFull()).reviewing, true);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const review = await reviewed;
    assert.equal(review.summary, "Ta seule perte vient d'une entrée avant ta bougie de rejet.");
    assert.deepEqual(review.findings[0].trades, [trade.id]);
    assert.equal(review.carnet, undefined);
    assert.equal(review.stats[0].key, "total");
    const text = seen.find((b) => b.type === "text") as { text: string };
    assert.ok(text.text.includes(`## ${trade.id}`));
    assert.ok(text.text.includes("sa note : je suis entré avant la bougie de rejet"));
    assert.equal(seen.filter((b) => b.type === "image").length, 1, "son graphique figé");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.journal.busy, false);
    assert.equal(t.journal.latestReview()?.id, review.id);
    assert.equal(t.journal.getReview(review.id)?.summary, review.summary);
    assert.equal((await t.journal.listFull()).review?.id, review.id);
    const shown: string[] = [];
    t.journal.on("showReview", (id) => shown.push(id));
    t.journal.showReview();
    assert.deepEqual(shown, [review.id]);

    // Une réponse illisible : l'échec est dit, rien n'est gardé.
    t.journal.reviewer = async () => "pas de JSON";
    const failed = new Promise<string>((r) => t.journal.once("reviewFailed", r));
    t.journal.review(7);
    assert.match(await failed, /illisible/);
    assert.equal(t.journal.latestReview()?.id, review.id);
  } finally {
    t.done();
  }
});

test("bilans et bilan du soir : le jour et la semaine comptés sur ses trades, palier et horizon ; calendrier ; le soir une fois par jour, s'il a tradé", async () => {
  const t = setup();
  try {
    t.trading.updateSettings({ tier: { name: "A+", percent: 2 } });
    t.analyses.note(NAS, { fundamental: { bias: "up" }, idea: { side: "buy", horizon: "swing" } });
    await pause();
    const ticket = await t.trading.prepareOpen({ drawingId: t.drawings.create("NAS100", LONG, { by: "user" }).id, execution: "market", tier: "A+" });
    const win = (await t.trading.confirm(ticket.id, "click")).trade!;
    assert.equal(t.trading.getTrade(win.id)!.tier, "A+", "le palier gardé dans le trade");
    await t.trading.sync();
    t.broker.close(t.broker.positions[0].id, 21570, "DEAL_REASON_TP");
    await t.trading.sync();
    const loss = await t.take(t.drawings.create("NAS100", LONG, { by: "user" }));
    t.broker.close(t.broker.positions[0].id, 21405, "DEAL_REASON_SL");
    await t.trading.sync();
    t.journal.note("entré trop tôt", { trade: loss.id });

    const week = await t.journal.bilan("week");
    assert.equal(week.totals.count, 2);
    assert.equal(week.totals.wins, 1);
    assert.equal(week.totals.losses, 1);
    assert.deepEqual(
      week.breakdowns.find((b) => b.key === "tier")!.rows.map((r) => r.label),
      ["palier A+", "sans palier"],
    );
    assert.deepEqual(
      week.breakdowns.find((b) => b.key === "horizon")!.rows.map((r) => r.label),
      ["swing"],
    );
    assert.deepEqual(week.missingNotes, [win.id]);
    assert.equal((await t.journal.bilan("day")).totals.count, 2);
    assert.equal((await t.journal.bilan("month", { date: "2020-01" })).totals.count, 0);
    await assert.rejects(t.journal.bilan("day", { date: "2026-13-01" }), /date illisible/);

    const shown: string[] = [];
    t.journal.on("showCalendar", (k) => shown.push(k));
    assert.match(t.journal.showCalendar(), /^\d{4}-\d{2}$/);
    t.journal.showCalendar("2026-11-06");
    assert.equal(shown[1], "2026-11-06");
    assert.throws(() => t.journal.showCalendar("demain"), /date illisible/);

    // Le bilan du soir : réglé à 22 h 30 ce matin ; il part à 22 h 31, une fois.
    const today = new Date();
    const clock = (h: number, m: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime();
    t.journal.now = () => clock(8, 0);
    assert.deepEqual(t.journal.setEvening("22h30"), { evening: "22:30" });
    assert.equal(await t.journal.eveningTick(), undefined, "pas encore l'heure");
    const evenings: number[] = [];
    t.journal.on("evening", (b) => evenings.push(b.totals.count));
    t.journal.now = () => clock(22, 31);
    assert.equal((await t.journal.eveningTick())?.totals.count, 2);
    assert.equal(await t.journal.eveningTick(), undefined, "une seule fois par jour");
    assert.deepEqual(evenings, [2]);
    // Réglé après l'heure : il commence demain.
    assert.equal(t.journal.setEvening("21:00").lastEvening, t.journal.settings().lastEvening);
    assert.throws(() => t.journal.setEvening("25:00"), /heure illisible/);
    assert.deepEqual(t.journal.setEvening(null).evening, undefined);
    assert.equal(await t.journal.eveningTick(), undefined, "arrêté");
  } finally {
    t.done();
  }
});
