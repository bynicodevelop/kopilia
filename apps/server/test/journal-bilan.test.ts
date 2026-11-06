// Journal, lot 3, à plat : les bornes d'une période (jour, semaine du lundi,
// mois), la séance d'un trade, le bilan compté par le serveur (résultat,
// répartitions, ce qui revient, jours, séries, trades sans note) et ses phrases.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JournalFact, JournalTrade, Trade } from "@kopilia/contracts";
import { bilanRange, bilanText, computeBilan, dateKey, eveningPrompt, sessionOf, type BilanTrade } from "../src/journal/journal-bilan.js";
import { eveningReport } from "../src/gateway/messages.js";

const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

test("les bornes d'un bilan : le jour, la semaine du lundi, le mois, les N derniers jours ; la séance d'un trade", () => {
  const ref = new Date(2026, 10, 6, 15, 0); // vendredi 6 novembre
  const day = bilanRange("day", ref);
  assert.equal(day.from, at(6, 0));
  assert.equal(day.to, at(7, 0));
  assert.equal(day.label, "vendredi 6 novembre");
  const week = bilanRange("week", ref);
  assert.equal(week.from, at(2, 0));
  assert.equal(week.to, at(9, 0));
  assert.equal(week.label, "semaine du 2 novembre");
  const month = bilanRange("month", ref);
  assert.equal(month.from, new Date(2026, 10, 1).getTime());
  assert.equal(month.to, new Date(2026, 11, 1).getTime());
  assert.equal(month.label, "novembre 2026");
  assert.equal(bilanRange("days", ref, 7).label, "7 derniers jours");
  // Un dimanche : la semaine commencée le lundi d'avant.
  assert.equal(bilanRange("week", new Date(2026, 10, 8, 10)).from, at(2, 0));
  assert.equal(sessionOf(at(6, 7, 30)), "Asie (avant 9 h)");
  assert.equal(sessionOf(at(6, 10)), "Londres (9 h – 15 h 30)");
  assert.equal(sessionOf(at(6, 15, 30)), "New York (15 h 30 – 22 h)");
  assert.equal(sessionOf(at(6, 23)), "Le soir (après 22 h)");
  assert.equal(dateKey(at(6, 23, 59)), "2026-11-06");
});

function item(o: {
  id: string;
  r: number;
  closed: number;
  opened?: number;
  name?: string;
  fidelity?: "with" | "against" | "none";
  facts?: JournalFact[];
  horizon?: string;
  tier?: string;
  noted?: boolean;
}): BilanTrade {
  const trade = {
    id: o.id,
    symbol: o.name === "or" ? "XAUUSD" : "NAS100",
    name: o.name ?? "Nasdaq 100",
    side: "long",
    execution: "limit",
    entry: 1,
    stop: 0,
    initialStop: 0,
    targets: [2],
    lots: 1,
    risk: 100,
    riskPercent: 1,
    currency: "USD",
    state: "closed",
    legs: [],
    protected: false,
    profit: o.r * 100,
    r: o.r,
    demo: true,
    createdAt: (o.opened ?? o.closed) - 60_000,
    updatedAt: o.closed,
    openedAt: o.opened ?? o.closed - 30_000,
    closedAt: o.closed,
  } as Trade;
  const outcome = Math.abs(o.r) < 0.1 ? "neutral" : o.r > 0 ? "win" : "loss";
  const page = { trade, outcome, fidelity: o.fidelity ?? "with", frozen: true, facts: o.facts ?? [], gestures: [], notes: [], thread: [] } as JournalTrade;
  const line = {
    id: o.id,
    symbol: trade.symbol,
    name: trade.name,
    side: "long",
    state: "closed",
    outcome,
    r: o.r,
    profit: o.r * 100,
    currency: "USD",
    at: o.closed,
    fidelity: page.fidelity,
    demo: true,
  } as BilanTrade["line"];
  return { page, line, ...(o.horizon ? { horizon: o.horizon } : {}), ...(o.tier ? { tier: o.tier } : {}), noted: o.noted ?? true };
}

test("le bilan : résultat, meilleur et pire, série de pertes, répartitions, ce qui revient, jours, sans note", () => {
  const trades = [
    item({
      id: "t_1",
      r: 0.7,
      closed: at(3, 10),
      name: "or",
      horizon: "swing",
      tier: "standard",
      facts: [{ key: "after", tone: "warn", text: "… : 1,3 R laissés." }],
    }),
    item({ id: "t_2", r: 1.2, closed: at(4, 16), horizon: "intraday", tier: "standard" }),
    item({
      id: "t_3",
      r: -1,
      closed: at(5, 16, 5),
      fidelity: "against",
      horizon: "intraday",
      tier: "standard",
      noted: false,
      facts: [
        { key: "changed-mind", tone: "warn", text: "…" },
        { key: "objection", tone: "warn", text: "…" },
      ],
    }),
    item({ id: "t_4", r: -0.03, closed: at(5, 18, 38), fidelity: "none", tier: "standard" }),
    item({
      id: "t_5",
      r: -1,
      closed: at(6, 9, 10),
      name: "or",
      horizon: "swing",
      tier: "A+",
      noted: false,
      facts: [{ key: "stop-widened", tone: "warn", text: "…" }],
    }),
    item({ id: "t_old", r: 3, closed: at(1, 12) }),
  ];
  const range = bilanRange("week", new Date(2026, 10, 6, 15));
  const b = computeBilan(trades, { period: "week", ...range, live: 1 });
  assert.deepEqual(b.totals, { count: 5, wins: 2, losses: 2, neutral: 1, r: -0.13, avgR: -0.03, avgWin: 0.95, avgLoss: -1, profit: -13, currency: "USD" });
  assert.equal(b.best?.id, "t_2");
  assert.equal(b.worst?.id, "t_3", "à égalité, le plus ancien");
  assert.deepEqual(b.streak, { maxLosses: 2, current: -2 }, "le neutre ne casse pas la série");
  assert.deepEqual(
    b.trades.map((t) => t.id),
    ["t_5", "t_4", "t_3", "t_2", "t_1"],
    "le plus récent d'abord ; celui du dimanche d'avant n'y est pas",
  );
  assert.deepEqual(b.missingNotes, ["t_5", "t_3"]);
  assert.equal(b.live, 1);
  assert.deepEqual(b.days, [
    { date: "2026-11-03", count: 1, r: 0.7 },
    { date: "2026-11-04", count: 1, r: 1.2 },
    { date: "2026-11-05", count: 2, r: -1.03 },
    { date: "2026-11-06", count: 1, r: -1 },
  ]);
  const by = (key: string) => b.breakdowns.find((x) => x.key === key)!.rows.map((r) => [r.label, r.count, r.r]);
  assert.deepEqual(by("fidelity"), [
    ["fidèle à la fiche", 3, 0.9],
    ["contre la fiche", 1, -1],
    ["sans fiche", 1, -0.03],
  ]);
  assert.deepEqual(by("horizon"), [
    ["intraday", 2, 0.2],
    ["swing", 2, -0.3],
    ["horizon non dit", 1, -0.03],
  ]);
  assert.deepEqual(by("tier"), [
    ["palier standard", 4, 0.87],
    ["palier A+", 1, -1],
  ]);
  assert.deepEqual(by("session"), [
    ["New York (15 h 30 – 22 h)", 3, 0.17],
    ["Londres (9 h – 15 h 30)", 2, -0.3],
  ]);
  assert.deepEqual(
    b.patterns.map((p) => [p.key, p.count, p.r]),
    [
      ["against", 1, -1],
      ["changed-mind", 1, -1],
      ["objection", 1, -1],
      ["stop-widened", 1, -1],
      ["left", 1, -1.3],
    ],
  );

  const lines = bilanText(b).map(plain);
  assert.equal(
    lines[0],
    "Bilan de la semaine du 2 novembre : 5 trades fermés, 2 gagnants, 2 perdants, 1 neutre ; −0,13 R (−13 $), −0,03 R par trade ; gain moyen +0,95 R, perte moyenne −1 R ; 1 encore en cours ou en attente",
  );
  assert.ok(lines.includes("meilleur : t_2 achat Nasdaq 100, gagnant +1,2 R"));
  assert.ok(lines.includes("plus longue série de pertes : 2"));
  assert.ok(lines.includes("ce qui revient : changement d'avis avant le trade, 1 trade, −1 R"));
  assert.ok(lines.includes("sans note : t_5, t_3"));
  // Une seule répartition sans rien dire (« horizon non dit ») n'est pas montrée.
  const one = computeBilan([item({ id: "t_9", r: 1, closed: at(6, 10) })], { period: "day", ...bilanRange("day", new Date(2026, 10, 6, 15)), live: 0 });
  assert.deepEqual(
    one.breakdowns.map((x) => x.key),
    ["fidelity", "product", "session"],
  );
  assert.equal(one.worst, undefined, "un seul trade gagnant : pas de pire");
  assert.deepEqual(bilanText(computeBilan([], { period: "day", ...bilanRange("day", new Date(2026, 10, 6)), live: 2 })), [
    "Bilan du vendredi 6 novembre : aucun trade fermé (2 en cours ou en attente).",
  ]);

  const evening = eveningPrompt(b);
  assert.match(evening, /^\[Journal\] Bilan de sa journée, programmé à sa demande\. Bilan de la semaine/);
  assert.match(evening, /2 trades sans note \(t_5, t_3\) : demande-lui une fois/);
  assert.equal(eveningReport(b, 1).title, "Bilan de ta journée");
  assert.doesNotMatch(eveningPrompt({ ...b, missingNotes: [] }), /sans note/);
});
