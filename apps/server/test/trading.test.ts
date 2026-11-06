// Prise de position : tickets préparés depuis une boîte de trade, envoyés
// seulement sur confirmation, suivis chez un faux courtier (ordres, positions,
// transactions), limites du money management, break-even et bilan.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Drawing } from "@kopilia/contracts";
import { DrawingService } from "../src/dashboard/drawing.service.js";
import type { DashboardService } from "../src/dashboard/dashboard.service.js";
import type { MarketService } from "../src/market/market.service.js";
import { MarketError } from "../src/market/metaapi.js";
import { commissionFromDeals, parseAccountInfo, parseTerms, parseTradeResult, type BrokerDeal } from "../src/market/broker.js";
import { TICKET_TTL_MS, TradingService, splitLegs, tradeState, type TradingSignal } from "../src/trading/trading.service.js";
import { ticketAnswer } from "../src/trading/ticket-answer.js";
import { rLabel } from "../src/trading/trading-texts.js";
import { tempData } from "./harness.js";
import { FakeBroker } from "./fake-broker.js";

const BOX = { kind: "position", side: "long", entry: 21450, stop: 21410, target: 21570, from: 1_800_000_000 } as const;

function setup(opts: { orders?: boolean; settings?: Parameters<TradingService["updateSettings"]>[0] } = {}) {
  const data = tempData("trading", { KOPILIA_METAAPI_TOKEN: "jeton", KOPILIA_TRADING_ORDERS: opts.orders === false ? "0" : "1", KOPILIA_TRADING_LIVE: "0" });
  const broker = new FakeBroker();
  const drawings = new DrawingService(data.db, data.logger);
  const dashboard = {
    drawings,
    on: () => dashboard,
    view: () => ({ panels: [], drawings: drawings.list(), alerts: [] }),
    list: () => [{ id: "p_1", kind: "chart", symbol: "NAS100", name: "Nasdaq 100", title: "Nasdaq 100", digits: 2 }],
  } as unknown as DashboardService;
  const trading = new TradingService(data.config, data.db, broker as unknown as MarketService, dashboard, data.logger);
  const signals: TradingSignal[] = [];
  trading.on("signal", (s) => signals.push(s));
  if (opts.settings) trading.updateSettings(opts.settings);
  const box = drawings.create("NAS100", BOX, { by: "user" }) as Extract<Drawing, { kind: "position" }>;
  return { data, broker, drawings, trading, signals, box, done: () => data.cleanup() };
}

test("ticket d'ouverture : taille selon le risque, commission lue sur les transactions, rien ne part avant la confirmation", async () => {
  const t = setup();
  try {
    // Une position fermée le mois dernier : 0,96 € de commission aller-retour par lot.
    t.broker.open({ id: "old", clientId: "manuel", side: "long", volume: 1, price: 21000, stop: 20900 });
    t.broker.close("old", 21010);
    const ticket = await t.trading.prepareOpen({ drawingId: t.box.id });
    assert.equal(ticket.action, "open");
    assert.equal(ticket.execution, "limit", "entrée sous le prix : à cours limité");
    // 100 € ÷ (40 + 0,96) = 2,44 → 2,4 lots.
    assert.equal(ticket.lots, 2.4);
    assert.ok(Math.abs(ticket.loss - 98.3) < 0.01);
    assert.match(
      ticket.text,
      /^Achat à cours limité sur Nasdaq 100 : 2,4 lots à 21\s450,00, stop 21\s410,00, objectif 21\s570,00\. Perte au stop 98\s€ \(0,98 % du capital\), gain à l'objectif 286\s€, commission de 2,30\s€ comprise\. Marge demandée 2\s574\s€\. Sur le compte de démonstration « Compte démo »\.$/,
    );
    assert.deepEqual(t.broker.sent, [], "rien d'envoyé");
    assert.equal(t.trading.state().ticket?.id, ticket.id);
    assert.equal(t.trading.liveTrades().length, 0);
  } finally {
    t.done();
  }
});

test("confirmé, l'ordre part une fois ; exécuté puis fermé à l'objectif, le trade donne son résultat net et son R", async () => {
  const t = setup();
  try {
    const ticket = await t.trading.prepareOpen({ drawingId: t.box.id });
    const r = await t.trading.confirm(ticket.id, "click");
    assert.ok(r.ok);
    assert.equal(t.broker.sent.length, 1);
    assert.deepEqual(t.broker.sent[0], {
      actionType: "ORDER_TYPE_BUY_LIMIT",
      symbol: "NAS100",
      volume: 2.5,
      openPrice: 21450,
      stopLoss: 21410,
      takeProfit: 21570,
      clientId: `ec_${r.trade!.id.slice(2)}_1`,
      comment: "Kopilia",
    });
    assert.ok(String(t.broker.sent[0].clientId).length + "Kopilia".length <= 30, "clientId et commentaire tiennent dans MetaTrader");
    await assert.rejects(t.trading.confirm(ticket.id, "click"), /n'existe plus/, "un second clic n'envoie rien");
    assert.equal(t.broker.sent.length, 1);
    assert.equal(t.signals.at(-1)?.kind, "placed");

    await t.trading.sync();
    let trade = t.trading.getTrade(r.trade!.id)!;
    assert.equal(trade.state, "pending");

    t.broker.fill(trade.legs[0].clientId);
    await t.trading.sync();
    trade = t.trading.getTrade(trade.id)!;
    assert.equal(trade.state, "open");
    assert.equal(trade.legs[0].openPrice, 21450);
    assert.equal(t.signals.at(-1)?.kind, "filled");

    t.broker.close(trade.legs[0].positionId!, 21570);
    await t.trading.sync();
    trade = t.trading.getTrade(trade.id)!;
    assert.equal(trade.state, "closed");
    // 120 points × 2,5 lots − 2 × 0,48 × 2,5 de commission.
    assert.equal(trade.profit, 297.6);
    assert.equal(trade.r, 2.98);
    assert.equal(t.signals.at(-1)?.kind, "closed");
    assert.match(t.signals.at(-1)!.detail ?? "", /\+298\s€ · \+2,98 R/);
    assert.deepEqual(
      t.trading.events(trade.id).map((e) => e.kind),
      ["ticket", "order", "filled", "closed"],
      "le journal de chaque ordre",
    );
  } finally {
    t.done();
  }
});

test("ordres coupés, compte réel ou mot de passe investisseur : aucun ticket", async () => {
  const off = setup({ orders: false });
  try {
    await assert.rejects(off.trading.prepareOpen({ drawingId: off.box.id }), /KOPILIA_TRADING_ORDERS=1/);
    assert.equal(off.trading.state().ordersEnabled, false);
  } finally {
    off.done();
  }
  const t = setup();
  try {
    t.broker.account.demo = false;
    await assert.rejects(t.trading.prepareOpen({ drawingId: t.box.id }), /compte de démonstration/);
    t.broker.account.demo = true;
    t.broker.account.tradeAllowed = false;
    await assert.rejects(t.trading.prepareOpen({ drawingId: t.box.id }), /mot de passe investisseur/);
  } finally {
    t.done();
  }
});

test("un ticket expiré ne part pas", async () => {
  const t = setup();
  try {
    const ticket = await t.trading.prepareOpen({ drawingId: t.box.id });
    const real = t.trading.now;
    t.trading.now = () => real() + TICKET_TTL_MS + 1;
    await assert.rejects(t.trading.confirm(ticket.id, "voice"), /expiré/);
    assert.equal(t.broker.sent.length, 0);
  } finally {
    t.done();
  }
});

test("au marché, la taille se calcule au prix du moment ; deux objectifs, deux ordres au même stop", async () => {
  const t = setup();
  try {
    const ticket = await t.trading.prepareOpen({ drawingId: t.box.id, execution: "market", targets: [21520, 21570] });
    assert.equal(ticket.execution, "market");
    assert.equal(ticket.entry, 21450.5, "achat au prix vendeur du moment");
    // 100 € ÷ 40,5 points = 2,47 → 2,4 lots, partagés 1,2 + 1,2.
    assert.equal(ticket.lots, 2.4);
    assert.deepEqual(ticket.legs, [
      { lots: 1.2, target: 21520 },
      { lots: 1.2, target: 21570 },
    ]);
    assert.match(
      ticket.text,
      /^Achat au marché sur Nasdaq 100 : 2,4 lots vers 21\s450,50, stop 21\s410,00, objectifs 21\s520,00 \(1,2 lot\) et 21\s570,00 \(1,2 lot\)/,
    );
    assert.ok(ticket.warnings.some((w) => /au marché/.test(w)));
    const r = await t.trading.confirm(ticket.id, "voice");
    assert.equal(t.broker.sent.length, 2);
    assert.deepEqual(
      t.broker.sent.map((s) => [s.actionType, s.volume, s.takeProfit, s.stopLoss, "openPrice" in s]),
      [
        ["ORDER_TYPE_BUY", 1.2, 21520, 21410, false],
        ["ORDER_TYPE_BUY", 1.2, 21570, 21410, false],
      ],
    );
    assert.equal(r.trade?.state, "open");
    assert.equal(t.signals.at(-1)?.quiet, true, "confirmé à la voix : Kopilia le dit déjà");
  } finally {
    t.done();
  }
});

test("les limites du money management : plafond par trade, risque ouvert, perte du jour", async () => {
  const t = setup({ settings: { maxOpenRiskPercent: null } });
  try {
    const big = await t.trading.prepareOpen({ drawingId: t.box.id, risk: { mode: "percent", value: 5 } });
    assert.equal(big.lots, 7.5, "réduite au plafond de 3 %");
    assert.ok(big.warnings.some((w) => /plafond de 3 %/.test(w)));
    t.trading.cancelTicket();
    await assert.rejects(t.trading.prepareOpen({ drawingId: t.box.id, risk: { mode: "lots", value: 10 } }), /dépasse ton plafond/);

    t.trading.updateSettings({ maxOpenRiskPercent: 1.5 });
    const first = await t.trading.prepareOpen({ drawingId: t.box.id });
    await t.trading.confirm(first.id, "click");
    await assert.rejects(t.trading.prepareOpen({ drawingId: t.box.id }), /risque ouvert passerait à 2 %.*limite de 1,5 %/);

    // Une perte de 250 € aujourd'hui (2,5 % de 10 000 €) : plus d'ouverture.
    const t2 = setup({ settings: { maxDailyLossPercent: 2 } });
    try {
      t2.broker.open({ id: "x", clientId: "manuel", side: "long", volume: 5, price: 21500, stop: 21400 });
      t2.broker.close("x", 21450);
      await assert.rejects(t2.trading.prepareOpen({ drawingId: t2.box.id }), /perte du jour atteint 255\s€.*plus d'ouverture du jour/);
    } finally {
      t2.done();
    }
  } finally {
    t.done();
  }
});

test("break-even commission comprise, refusé si le prix ne l'a pas dépassé ; sortie partielle ; clôture", async () => {
  const t = setup();
  try {
    t.broker.deals.push(
      {
        id: "c1",
        symbol: "NAS100",
        entryType: "DEAL_ENTRY_IN",
        volume: 1,
        price: 1,
        profit: 0,
        commission: -0.48,
        swap: 0,
        positionId: "c",
        time: Date.now() - 86_400_000,
      },
      {
        id: "c2",
        symbol: "NAS100",
        entryType: "DEAL_ENTRY_OUT",
        volume: 1,
        price: 1,
        profit: 0,
        commission: -0.48,
        swap: 0,
        positionId: "c",
        time: Date.now() - 86_400_000,
      },
    );
    const open = await t.trading.prepareOpen({ drawingId: t.box.id, execution: "market" });
    const { trade } = await t.trading.confirm(open.id, "click");
    await t.trading.sync();
    // Entrée à 21 450,50 ; le prix (21 449,50) est sous le break-even.
    await assert.rejects(t.trading.prepareManage({ action: "breakeven", trade: trade!.id }), /n'a pas dépassé ton break-even \(21\s451,46\)/);
    t.broker.quote = { bid: 21500, ask: 21501 };
    const be = await t.trading.prepareManage({ action: "breakeven", trade: trade!.id });
    assert.equal(be.newStop, 21451.46);
    assert.match(be.text, /Monter le stop de ton achat Nasdaq 100 \(2,4 lots\) à 21\s451,46, ton break-even commission comprise/);
    await t.trading.confirm(be.id, "click");
    assert.deepEqual(t.broker.sent.at(-1), { actionType: "POSITION_MODIFY", positionId: trade!.legs[0].positionId, stopLoss: 21451.46, takeProfit: 21570 });
    await t.trading.sync();
    assert.equal(t.trading.getTrade(trade!.id)!.protected, true);
    assert.equal(t.trading.getTrade(trade!.id)!.stop, 21451.46);

    const half = await t.trading.prepareManage({ action: "partial", fraction: 0.5 });
    assert.equal(half.lots, 1.2);
    await t.trading.confirm(half.id, "click");
    assert.deepEqual(t.broker.sent.at(-1), { actionType: "POSITION_PARTIAL", positionId: trade!.legs[0].positionId, volume: 1.2 });

    const close = await t.trading.prepareManage({ action: "close", trade: trade!.id });
    assert.match(close.text, /^Fermer ton achat Nasdaq 100 \(2,4 lots\) au marché, vers 21\s500,00/);
    await t.trading.confirm(close.id, "click");
    await t.trading.sync();
    assert.equal(t.trading.getTrade(trade!.id)!.state, "closed");
  } finally {
    t.done();
  }
});

test("un ordre refusé par le courtier ne laisse rien d'ouvert ; sans réponse, la relecture tranche par le clientId", async () => {
  const t = setup();
  try {
    t.broker.reply = () => ({ ok: false, numericCode: 10016, stringCode: "TRADE_RETCODE_INVALID_STOPS", message: "Invalid stops" });
    const a = await t.trading.prepareOpen({ drawingId: t.box.id });
    const r = await t.trading.confirm(a.id, "click");
    assert.equal(r.ok, false);
    assert.match(r.text, /stop ou objectif trop près du prix/);
    assert.equal(t.trading.getTrade(r.trade!.id)!.state, "rejected");
    assert.equal(t.signals.at(-1)?.kind, "rejected");

    // Pas de réponse : l'ordre est quand même arrivé chez le courtier.
    t.broker.reply = (req) => {
      t.broker.reply = undefined;
      void t.broker.brokerTrade(req);
      t.broker.sent.pop(); // l'ordre arrivé chez le courtier n'est envoyé qu'une fois
      return new MarketError("le courtier n'a pas répondu : l'ordre est peut-être parti");
    };
    const b = await t.trading.prepareOpen({ drawingId: t.box.id });
    const lost = await t.trading.confirm(b.id, "click");
    assert.equal(t.trading.getTrade(lost.trade!.id)!.state, "pending");
    await t.trading.sync();
    const found = t.trading.getTrade(lost.trade!.id)!;
    assert.equal(found.state, "pending");
    assert.ok(found.legs[0].orderId, "retrouvé chez le courtier par son clientId");
    // Jamais renvoyé de lui-même : un seul envoi par ordre.
    assert.equal(t.broker.sent.filter((s) => s.clientId === found.legs[0].clientId).length, 1);
  } finally {
    t.done();
  }
});

test("rappel de break-even une fois, à 1 R ; un ordre retiré sur la plateforme est vu comme retiré", async () => {
  const t = setup();
  try {
    const open = await t.trading.prepareOpen({ drawingId: t.box.id, execution: "market" });
    const { trade } = await t.trading.confirm(open.id, "click");
    t.broker.quote = { bid: 21512, ask: 21513 };
    await t.trading.sync();
    const reminders = () => t.signals.filter((s) => s.kind === "reminder");
    assert.equal(reminders().length, 1);
    assert.match(reminders()[0].detail!, /Break-even à 21\s450,50/);
    await t.trading.sync();
    assert.equal(reminders().length, 1, "une seule fois");
    assert.equal(t.trading.getTrade(trade!.id)!.reminded, true);

    const pending = await t.trading.prepareOpen({ drawingId: t.box.id });
    const p = await t.trading.confirm(pending.id, "click");
    t.broker.orders = [];
    await t.trading.sync();
    assert.equal(t.trading.getTrade(p.trade!.id)!.state, "cancelled");
  } finally {
    t.done();
  }
});

test("réglages : risque par défaut, limites retirées par null, commission d'un produit ; refus incohérents", () => {
  const t = setup();
  try {
    let s = t.trading.updateSettings({ defaultRisk: { mode: "percent", value: 2 }, maxDailyLossPercent: 4 });
    assert.deepEqual(s.defaultRisk, { mode: "percent", value: 2 });
    assert.equal(s.maxDailyLossPercent, 4);
    s = t.trading.updateSettings({ maxDailyLossPercent: null, commission: { symbol: "NAS100", value: 1.2 } });
    assert.equal(s.maxDailyLossPercent, undefined);
    assert.equal(s.commissions.NAS100, 1.2);
    assert.throws(() => t.trading.updateSettings({ defaultRisk: { mode: "percent", value: 5 } }), /dépasse le plafond par trade/);
    assert.equal(t.trading.settings().defaultRisk.value, 2, "gardé tel quel après un refus");
  } finally {
    t.done();
  }
});

test("bilan : résultat en devise et en R, par niveau de risque", async () => {
  const t = setup();
  try {
    const a = await t.trading.prepareOpen({ drawingId: t.box.id, execution: "market" });
    const ra = await t.trading.confirm(a.id, "click");
    t.broker.close(ra.trade!.legs[0].positionId!, 21411);
    await t.trading.sync();
    const review = t.trading.review(7);
    assert.equal(review.total, 1);
    assert.match(review.lines[0], /^1 trade fermé sur 7 jours : 0 gagnant, 1 perdant ; résultat −\d+\s€/);
    assert.match(review.lines[1], /^risque jusqu'à 1 % : 1 trade/);
  } finally {
    t.done();
  }
});

test("reconnaître la réponse à un ticket : confirmer, refuser, ou autre chose", () => {
  for (const s of ["Je confirme.", "oui je confirme", "Confirmé !", "je confirme l'ordre"]) assert.equal(ticketAnswer(s), "confirm", s);
  for (const s of ["Non.", "Annule", "laisse tomber", "je ne confirme pas", "Non, mets le stop plus bas"]) assert.equal(ticketAnswer(s), "cancel", s);
  for (const s of ["je confirme mais avec un stop à 21 400", "quel est le risque ?", "c'est confirmé que le CPI sort à 14 h 30 aujourd'hui ?"])
    assert.equal(ticketAnswer(s), undefined, s);
});

test("lecture de MetaApi : compte, fiche, réponse d'un ordre, commission sur les transactions", () => {
  assert.deepEqual(parseAccountInfo({ balance: 1000, equity: 990, currency: "EUR", type: "ACCOUNT_TRADE_MODE_DEMO", platform: "mt5" }, "Démo"), {
    name: "Démo",
    currency: "EUR",
    balance: 1000,
    equity: 990,
    tradeAllowed: true,
    demo: true,
    platform: "mt5",
  });
  assert.equal(parseAccountInfo({ balance: 1000, currency: "USD", investorMode: true, type: "ACCOUNT_TRADE_MODE_REAL" }, "R")?.tradeAllowed, false);
  assert.equal(parseAccountInfo({ balance: 1000, currency: "USD" }, "R", "Courtier-Demo")?.demo, true);
  assert.deepEqual(
    parseTerms(
      { tickSize: 0.01, volumeStep: 0.01, minVolume: 0.01, maxVolume: 100, contractSize: 1, digits: 2 },
      { lossTickValue: 0.0093, profitTickValue: 0.0093 },
    ),
    {
      tickSize: 0.01,
      tickValue: 0.0093,
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: 100,
      contractSize: 1,
      digits: 2,
    },
  );
  assert.equal(parseTerms({ tickSize: 0.01 }, {}), undefined);
  assert.equal(parseTradeResult({ numericCode: 10009, stringCode: "TRADE_RETCODE_DONE", positionId: "7" }).ok, true);
  assert.equal(parseTradeResult({ numericCode: 10016, stringCode: "TRADE_RETCODE_INVALID_STOPS" }).ok, false);
  const deal = (id: string, entryType: string, volume: number, commission: number, positionId: string): BrokerDeal => ({
    id,
    symbol: "EURUSD",
    entryType,
    volume,
    price: 1,
    profit: 0,
    commission,
    swap: 0,
    positionId,
    time: 1,
  });
  assert.equal(commissionFromDeals([deal("1", "DEAL_ENTRY_IN", 2, -7, "a"), deal("2", "DEAL_ENTRY_OUT", 2, -7, "a")], "EURUSD"), 7);
  assert.equal(commissionFromDeals([deal("1", "DEAL_ENTRY_IN", 2, -7, "a")], "EURUSD"), undefined, "encore ouverte : pas comptée");
});

test("jambes et état d'un trade", () => {
  const terms = {
    symbol: "X",
    tickSize: 0.01,
    tickValue: 0.01,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 50,
    commission: 0,
    commissionSource: "none" as const,
  };
  assert.deepEqual(splitLegs(1, [10, 20, 30], undefined, terms), [
    { target: 10, lots: 0.33 },
    { target: 20, lots: 0.33 },
    { target: 30, lots: 0.34 },
  ]);
  assert.throws(() => splitLegs(0.01, [10, 20], undefined, terms), /ne se partage pas/);
  assert.equal(
    tradeState([
      { clientId: "a", lots: 1, state: "closed" },
      { clientId: "b", lots: 1, state: "open" },
    ]),
    "open",
  );
  assert.equal(tradeState([{ clientId: "a", lots: 1, state: "rejected" }]), "rejected");
  assert.equal(rLabel(-1), "−1 R");
  assert.equal(rLabel(2.5), "+2,5 R");
});

test("marge : dite dans le ticket, et un ordre au-delà de la marge libre est refusé ; sans calcul du courtier, le ticket se prépare quand même", async () => {
  const t = setup();
  try {
    const ok = await t.trading.prepareOpen({ drawingId: t.box.id });
    assert.equal(ok.margin, (2.5 * 21450) / 20);
    t.trading.cancelTicket();
    t.broker.account.freeMargin = 1_000;
    await assert.rejects(t.trading.prepareOpen({ drawingId: t.box.id }), /marge insuffisante : il faudrait 2\s681\s€, il reste 1\s000\s€ de marge libre/);
    t.broker.marginOf = () => new Error("HTTP 404");
    const blind = await t.trading.prepareOpen({ drawingId: t.box.id });
    assert.equal(blind.margin, undefined);
    assert.doesNotMatch(blind.text, /Marge/);
    assert.deepEqual(await t.trading.margin({ symbol: "NAS100", side: "long", lots: 1, price: 21000 }).catch((e: Error) => e.message), "HTTP 404");
  } finally {
    t.done();
  }
});

test("paliers : ajoutés avec ses mots, triés, plafonnés ; un ticket au palier en prend le pourcentage, la boîte aussi", async () => {
  const t = setup();
  try {
    t.trading.updateSettings({ tier: { name: "A+", percent: 3, when: "quand le 4 h et le 15 min vont dans le même sens" } });
    let s = t.trading.updateSettings({ tier: { name: "standard", percent: 1 } });
    assert.deepEqual(
      s.tiers.map((x) => x.name),
      ["standard", "A+"],
    );
    s = t.trading.updateSettings({ tier: { name: "a+", percent: 2.5 } });
    assert.deepEqual(s.tiers[1], { name: "a+", percent: 2.5, when: "quand le 4 h et le 15 min vont dans le même sens" }, "même palier : ses mots restent");
    assert.throws(() => t.trading.updateSettings({ tier: { name: "B", percent: 4 } }), /le palier B \(4 %\) dépasse le plafond par trade \(3 %\)/);
    assert.throws(() => t.trading.updateSettings({ maxRiskPercent: 2 }), /le palier a\+ \(2,5 %\) dépasse le plafond/);
    const ticket = await t.trading.prepareOpen({ drawingId: t.box.id, tier: "A+" });
    assert.equal(ticket.tier, "a+");
    assert.equal(ticket.lots, 6.2, "2,5 % de 10 000 € ÷ 40 € par lot");
    assert.match(ticket.text, /\(2,48 % du capital, palier a\+\)/);
    t.trading.cancelTicket();
    await assert.rejects(t.trading.prepareOpen({ drawingId: t.box.id, tier: "C" }), /aucun palier « C » ; les siens : standard 1 %, a\+ 2,5 % \(quand le 4 h/);
    assert.deepEqual(t.trading.tierRisk("STANDARD"), { mode: "percent", value: 1, tier: "standard" });
    // Une boîte au palier suit le palier quand il change.
    const box = t.drawings.update(t.box.id, { shape: { ...BOX, risk: t.trading.tierRisk("a+") } });
    await t.trading.ensureTerms("NAS100");
    await t.trading.readAccount();
    assert.match(t.trading.sizingText(box) ?? "", /^taille 6,2 lots pour son palier a\+/);
    t.trading.updateSettings({ tier: { name: "a+", percent: 1.5 } });
    assert.match(t.trading.sizingText(box) ?? "", /^taille 3,7 lots pour son palier a\+/);
    s = t.trading.updateSettings({ removeTier: "Standard" });
    assert.deepEqual(
      s.tiers.map((x) => x.name),
      ["a+"],
    );
    assert.throws(() => t.trading.updateSettings({ removeTier: "Z" }), /aucun palier « Z » ; les tiens : a\+/);
  } finally {
    t.done();
  }
});

test("l'ordre suit la boîte : au marché seulement si son entrée est au prix du moment, sinon refusé (c'est un ordre en attente)", async () => {
  const t = setup();
  try {
    // Le prix est monté à 21 470 : la boîte (entrée 21 450) décrit un achat à cours limité, pas un achat au marché.
    t.broker.quote = { bid: 21470, ask: 21471 };
    await assert.rejects(
      t.trading.prepareOpen({ drawingId: t.box.id, execution: "market" }),
      /la boîte attend une entrée à 21\s450,00 et le prix est à 21\s471,00 : un ordre au marché ne correspondrait pas à la boîte/,
    );
    const pending = await t.trading.prepareOpen({ drawingId: t.box.id });
    assert.equal(pending.execution, "limit");
    assert.match(pending.text, /^Achat à cours limité sur Nasdaq 100 : 2,5 lots à 21\s450,00/);
    t.trading.cancelTicket();
    // Une vente dont l'entrée est sous le prix : vente à cours limité refusée, c'est une vente stop en attente.
    const short = t.drawings.create(
      "NAS100",
      { kind: "position", side: "short", entry: 21440, stop: 21480, target: 21360, from: 1_800_000_000 },
      { by: "user" },
    );
    await assert.rejects(t.trading.prepareOpen({ drawingId: short.id, execution: "market" }), /attend une entrée à 21\s440,00/);
    assert.equal((await t.trading.prepareOpen({ drawingId: short.id })).execution, "stop");
    assert.equal(t.broker.sent.length, 0, "rien d'envoyé");
  } finally {
    t.done();
  }
});
