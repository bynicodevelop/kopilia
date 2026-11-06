// La liste des setups repérés, sans écran : ce qui y figure, dans quel ordre, et ses mots.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Scenario } from "@kopilia/contracts";
import { setupLabel, setupState, watchlist } from "../src/app/setups/watchlist";

const base: Scenario = {
  id: "sc_1",
  symbol: "XAUUSD",
  name: "or",
  direction: "long",
  horizon: "intraday",
  timeframe: "15m",
  contextTimeframe: "1h",
  title: "Or : rebond sur le support 1h 4 021–4 028",
  why: "Support 1h à 10 contacts.",
  snapshot: "",
  plan: "Si une bougie 15m rejette la zone : proposer long.",
  invalidation: "Clôture 1h sous 4 021",
  depends: { hypotheses: [], drawings: [], events: [] },
  targets: [],
  state: "watching",
  checkedAt: 1,
  createdAt: 10,
  updatedAt: 10,
  expiresAt: 100,
};

test("setups repérés : les déclenchés d'abord, puis les plus récents ; pas les fermés", () => {
  const list = watchlist([
    { ...base, id: "sc_old", createdAt: 5 },
    { ...base, id: "sc_new", createdAt: 20 },
    { ...base, id: "sc_on", state: "proposed", createdAt: 1 },
    { ...base, id: "sc_off", state: "invalidated", createdAt: 30 },
    { ...base, id: "sc_end", state: "expired", createdAt: 31 },
  ]);
  assert.deepEqual(
    list.map((s) => s.id),
    ["sc_on", "sc_new", "sc_old"],
  );
});

test("setups repérés : ce qu'il attend sans le nom du produit, et l'état dans ses mots", () => {
  assert.equal(setupLabel(base), "rebond sur le support 1h 4 021–4 028");
  assert.equal(setupLabel({ ...base, title: "Rejet de la résistance 4h" }), "Rejet de la résistance 4h");
  assert.equal(setupState(base), "en attente");
  assert.equal(setupState({ state: "proposed" }), "déclenché");
});
