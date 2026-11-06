// Le journal rangé par état, sans écran : les lignes mises à jour par la prise de position, la barre stop → objectif, les prix et les distances.
process.env.TZ = "Europe/Paris";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Journal, JournalLine, Trade } from "@kopilia/contracts";
import { distanceText, exitPrice, ficheChip, fillPrice, journalByState, liveTotals, orderText, tickerLabel, tradeBar } from "../src/app/journal/journal-live";

const line = (over: Partial<JournalLine> & Pick<JournalLine, "id" | "symbol" | "state">): JournalLine => ({
  name: over.symbol,
  side: "short",
  currency: "USD",
  at: 1_000,
  fidelity: "none",
  demo: true,
  ...over,
});

const journal: Journal = {
  since: 0,
  groups: [
    {
      analysisId: "a_or",
      symbol: "XAUUSD",
      name: "or",
      state: "open",
      openedAt: 500,
      idea: "vente",
      r: 0.05,
      trades: [
        line({ id: "t_or_open", symbol: "XAUUSD", state: "open", r: 0.1, profit: 9.66, openedAt: 3_000, at: 3_000, fidelity: "with", risk: 97.89 }),
        line({ id: "t_or_closed", symbol: "XAUUSD", state: "closed", outcome: "neutral", r: 0.05, at: 2_000, fidelity: "with" }),
      ],
    },
    {
      name: "Sans fiche",
      r: -0.03,
      trades: [
        line({ id: "t_aud", symbol: "AUDNZD.i", state: "open", r: 0.2, profit: 20, openedAt: 4_000, at: 4_000, risk: 99.79 }),
        line({ id: "t_gbp", symbol: "GBPJPY.i", side: "long", state: "pending", createdAt: 3_500, at: 3_500, risk: 98.28, entry: 211.99 }),
        line({ id: "t_eur_x", symbol: "EURJPY.i", state: "cancelled", at: 2_500 }),
        line({ id: "t_eur", symbol: "EURJPY.i", state: "closed", outcome: "neutral", r: -0.03, at: 1_500 }),
      ],
    },
    {
      analysisId: "a_nzdjpy",
      symbol: "NZDJPY.i",
      name: "dollar néo-zélandais contre yen",
      state: "open",
      r: 0,
      trades: [],
      untaken: "zone pas encore touchée",
    },
  ],
  totals: { count: 2, wins: 0, losses: 0, neutral: 2, r: 0.02 },
};

test("journal par état : ouvertes, en attente, fermés et retirés, idées non prises ; la fiche suit chaque ligne", () => {
  const s = journalByState(journal);
  assert.deepEqual(
    s.open.map((l) => l.id),
    ["t_aud", "t_or_open"],
    "la dernière ouverte d'abord",
  );
  assert.deepEqual(
    s.pending.map((l) => l.id),
    ["t_gbp"],
  );
  assert.deepEqual(
    s.closed.map((l) => l.id),
    ["t_eur_x", "t_or_closed", "t_eur"],
    "fermés et retirés mêlés, du plus récent au plus ancien",
  );
  assert.deepEqual(
    s.ideas.map((g) => g.analysisId),
    ["a_nzdjpy"],
  );
  assert.deepEqual(s.open[1].fiche, { name: "or", idea: "vente" });
  assert.equal(s.open[0].fiche, undefined, "sans fiche");
  assert.deepEqual(liveTotals(s), { openR: 0.3, openProfit: 29.66, pendingRisk: 98.28, currency: "USD" });
});

test("journal par état : la prise de position, plus fraîche, met à jour le résultat flottant, le stop et un ordre exécuté", () => {
  const trade = (over: Partial<Trade> & Pick<Trade, "id" | "symbol" | "state">): Trade =>
    ({
      name: "x",
      side: "short",
      execution: "limit",
      entry: 1,
      stop: 2,
      initialStop: 2,
      targets: [0.5],
      lots: 1,
      risk: 100,
      riskPercent: 1,
      currency: "USD",
      legs: [],
      protected: false,
      demo: true,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as Trade;
  const s = journalByState(journal, [
    trade({ id: "t_aud", symbol: "AUDNZD.i", state: "open", r: 0.41, profit: 41.37, entry: 1.24065, stop: 1.24, initialStop: 1.24279, targets: [1.23735] }),
    trade({
      id: "t_gbp",
      symbol: "GBPJPY.i",
      side: "long",
      state: "open",
      r: 0,
      profit: 0,
      openedAt: 5_000,
      entry: 211.99,
      stop: 211.545,
      initialStop: 211.545,
      targets: [213.544],
    }),
  ]);
  assert.deepEqual(
    s.open.map((l) => l.id),
    ["t_gbp", "t_aud", "t_or_open"],
    "l'ordre exécuté passe dans les ouvertes, en tête",
  );
  assert.equal(s.pending.length, 0);
  const aud = s.open.find((l) => l.id === "t_aud")!;
  assert.equal(aud.r, 0.41);
  assert.equal(aud.stop, 1.24, "le stop déplacé");
  assert.equal(aud.initialStop, 1.24279);
  assert.equal(aud.target, 1.23735);
  assert.equal(s.open[0].remark, "en cours");
});

test("barre d'une position : du stop à l'objectif, l'entrée et le prix dedans, bornés ; stop remonté : tout en vert", () => {
  const short = tradeBar("short", 1.24279, 1.24065, 1.23735, 1.23977)!;
  assert.ok(Math.abs(short.entry - 214 / 544) < 1e-9);
  assert.ok(Math.abs(short.price! - 302 / 544) < 1e-9);
  const long = tradeBar("long", 100, 110, 130, 140)!;
  assert.ok(Math.abs(long.entry - 1 / 3) < 1e-9);
  assert.equal(long.price, 1, "au-delà de l'objectif : au bout");
  assert.equal(tradeBar("long", 112, 110, 130)!.entry, 0, "stop au-delà de l'entrée");
  assert.equal(tradeBar("long", 100, 110, undefined), undefined, "sans objectif, pas de barre");
  assert.equal(tradeBar("long", 100, 110, 90), undefined, "objectif du mauvais côté");
});

test("prix du moment : un achat se ferme au bid et s'exécute à l'ask, une vente l'inverse ; distance en pips ou en prix", () => {
  const q = { bid: 1.2, ask: 1.21 };
  assert.equal(exitPrice("long", q), 1.2);
  assert.equal(exitPrice("short", q), 1.21);
  assert.equal(fillPrice("long", q), 1.21);
  assert.equal(fillPrice("short", q), 1.2);
  assert.equal(exitPrice("short", { bid: 3 }), 3, "sans ask : le bid");
  assert.equal(exitPrice("long", undefined), undefined);
  assert.equal(distanceText("NZDUSD.i", 0.55411, 0.55502), "à 9,1 pips");
  assert.equal(distanceText("GBPJPY.i", 211.81, 211.99), "à 18 pips");
  assert.equal(distanceText("EURUSD", 1.1, 1.10005), "à 0,5 pip");
  assert.equal(distanceText("XAUUSD", 4046.28, 4049.54, 2), "à 3,26");
});

test("ticker, ordre et étiquette de fiche", () => {
  assert.equal(tickerLabel("AUDNZD.i"), "AUD/NZD");
  assert.equal(tickerLabel("XAUUSD"), "XAUUSD");
  assert.equal(tickerLabel("NAS100.x"), "NAS100");
  assert.equal(orderText("short", "limit"), "vente limite");
  assert.equal(orderText("long", "stop"), "achat stop");
  assert.equal(orderText("long", "market"), "achat au marché");
  assert.equal(orderText("long", undefined), "achat");
  assert.deepEqual(ficheChip("against", true), { text: "contre la fiche", against: true });
  assert.deepEqual(ficheChip("with", true), { text: "fiche", against: false });
  assert.equal(ficheChip("none", false), undefined, "sans fiche : pas d'étiquette");
});
