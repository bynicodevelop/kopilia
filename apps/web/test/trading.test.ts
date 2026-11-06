// La prise de position vue de l'écran, sans serveur : la taille d'une boîte
// pendant qu'on la tire, le trade qui en est parti, et la forme gardée quand
// on la déplace (son risque la suit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MONEY_SETTINGS, type Trade, type TradingState } from "@kopilia/contracts";
import { TradingStore, latestTrade } from "../src/app/trading/trading.store";
import { currencySymbol } from "../src/app/trading/risk-menu.component";
import { dragShape, shapeOf } from "../src/app/dashboard/chart-tools";

const STATE: TradingState = {
  ordersEnabled: true,
  account: { name: "Compte démo", currency: "EUR", balance: 10_000, equity: 10_000, tradeAllowed: true, demo: true, at: 1 },
  settings: DEFAULT_MONEY_SETTINGS,
  terms: {
    NAS100: {
      symbol: "NAS100",
      tickSize: 0.01,
      tickValue: 0.01,
      volumeStep: 0.1,
      minVolume: 0.1,
      maxVolume: 50,
      digits: 2,
      commission: 0,
      commissionSource: "none",
    },
  },
  trades: [],
};
const BOX = { entry: 21450, stop: 21410, target: 21570 };

function trade(over: Partial<Trade>): Trade {
  return {
    id: "t_1",
    symbol: "NAS100",
    name: "Nasdaq 100",
    side: "long",
    drawingId: "d_1",
    execution: "limit",
    entry: 21450,
    stop: 21410,
    initialStop: 21410,
    targets: [21570],
    lots: 2.5,
    risk: 100,
    riskPercent: 1,
    currency: "EUR",
    state: "pending",
    legs: [{ clientId: "ec_1_1", lots: 2.5, state: "pending" }],
    protected: false,
    demo: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("la taille d'une boîte suit sa forme (pendant qu'on la tire) et son risque", () => {
  const store = new TradingStore({} as never, () => undefined);
  assert.equal(store.boxInfo("NAS100", BOX), undefined, "rien tant que l'état n'est pas arrivé");
  store.updated(STATE);
  assert.equal(store.boxInfo("NAS100", BOX)?.sizing?.lots, 2.5);
  // Le stop éloigné de moitié : même risque, taille plus petite.
  assert.equal(store.boxInfo("NAS100", { ...BOX, stop: 21390 })?.sizing?.lots, 1.6);
  assert.equal(store.boxInfo("NAS100", { ...BOX, risk: { mode: "lots", value: 1 } })?.sizing?.loss, 40);
  assert.equal(store.boxInfo("XAUUSD", BOX), undefined, "conditions du produit pas encore lues");
});

test("le trade d'une boîte : celui en cours d'abord, sinon le dernier fermé (un refus ou un retrait ne compte pas)", () => {
  const store = new TradingStore({} as never, () => undefined);
  const old = trade({ id: "t_old", state: "closed", updatedAt: 5, profit: 120, r: 1.2 });
  const live = trade({ id: "t_live", state: "open", updatedAt: 3 });
  store.updated({ ...STATE, trades: [old, live] });
  assert.equal(store.boxInfo("NAS100", BOX, "d_1")?.trade?.id, "t_live");
  assert.equal(latestTrade([old, trade({ id: "t_new", state: "closed", updatedAt: 9 })], "d_1")?.id, "t_new");
  assert.equal(latestTrade([old, trade({ id: "t_ko", state: "rejected", updatedAt: 9 })], "d_1")?.id, "t_old", "un refus ne compte pas");
  assert.equal(latestTrade([old], "d_2"), undefined);
});

test("une boîte déplacée ou relue garde son risque", () => {
  const d = {
    id: "d_1",
    symbol: "NAS100",
    kind: "position",
    side: "long",
    ...BOX,
    from: 100,
    risk: { mode: "percent", value: 2 },
    createdBy: "user",
    createdAt: 1,
    updatedAt: 1,
  } as const;
  const shape = shapeOf(d);
  assert.deepEqual(shape.kind === "position" && shape.risk, { mode: "percent", value: 2 });
  const f = { pos: (t: number) => t / 60, time: (p: number) => Math.round(p) * 60 };
  const moved = dragShape(shape, "stop", { pos: 1, price: 21410 }, { pos: 1, price: 21400 }, f, 0.01);
  assert.deepEqual(moved.kind === "position" && moved.risk, { mode: "percent", value: 2 });
});

test("le symbole de la devise du compte", () => {
  assert.equal(currencySymbol("EUR"), "€");
  assert.equal(currencySymbol("USD"), "$");
  assert.equal(currencySymbol("??"), "??");
});

test("la marge d'une boîte est demandée au serveur avec sa taille et son prix", async () => {
  const asked: string[] = [];
  const api = { json: async (path: string) => (asked.push(path), { margin: 673.74, freeMargin: 10_000 }) };
  const store = new TradingStore(api as never, () => undefined);
  assert.deepEqual(await store.margin({ symbol: "NAS100", side: "long", lots: 0.5, price: 26949.69 }), { margin: 673.74, freeMargin: 10_000 });
  assert.deepEqual(asked, ["/api/trading/margin?symbol=NAS100&side=long&lots=0.5&price=26949.69"]);
});
