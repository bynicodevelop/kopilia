// Journal, lot 2, à plat : les rejeux sur les bougies (plan du ticket, après la
// sortie, idée d'une fiche), leurs phrases, et l'analyse de l'IA (sa consigne,
// les chiffres du serveur, la lecture de sa réponse).
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JournalTrade, Trade } from "@kopilia/contracts";
import { invalidationPrice, replayIdea, replayPlan, replayTimeframe, zoneFromText } from "../src/journal/replay.js";
import { afterFact, ideaFact, ideaZone, planFact, untakenLine, wasManaged } from "../src/journal/replay-facts.js";
import { REVIEW_PROMPT, parseReview, reviewStats, reviewTurn } from "../src/journal/journal-review.js";
import { reviewFailedReport, reviewReport } from "../src/gateway/messages.js";

const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
const T0 = new Date(2026, 10, 6, 9, 0).getTime();
const TF = 900;
/** Des bougies de 15 minutes à partir de T0 : [bas, haut, clôture] chacune (l'ouverture : la clôture d'avant). */
function bars(rows: Array<[number, number, number]>, open = 100) {
  let o = open;
  return rows.map(([l, h, c], i) => {
    const bar = { t: T0 / 1000 + i * TF, o, h, l, c };
    o = c;
    return bar;
  });
}

test("rejeu du plan : l'objectif ou le stop d'abord, le stop si les deux dans la même bougie, sinon à ce jour", () => {
  const plan = { side: "long" as const, entry: 100, stop: 90, target: 120, from: T0 };
  assert.deepEqual(
    replayPlan(
      plan,
      bars([
        [99, 104, 103],
        [101, 112, 110],
        [108, 121, 119],
      ]),
      TF,
    ),
    { result: "target", at: T0 + 2 * TF * 1000, r: 2, best: 2 },
  );
  assert.equal(
    replayPlan(
      plan,
      bars([
        [95, 105, 96],
        [89, 98, 91],
      ]),
      TF,
    )?.result,
    "stop",
  );
  assert.deepEqual(replayPlan(plan, bars([[89, 121, 100]]), TF), { result: "stop", at: T0, r: -1, best: -1, ambiguous: true });
  assert.deepEqual(
    replayPlan(
      plan,
      bars([
        [98, 108, 104],
        [101, 115, 105],
      ]),
      TF,
    ),
    { result: "open", r: 0.5, best: 1.5 },
  );
  // Une vente : le stop au-dessus.
  assert.equal(
    replayPlan(
      { side: "short", entry: 100, stop: 110, target: 80, from: T0 },
      bars([
        [95, 104, 96],
        [79, 97, 82],
      ]),
      TF,
    )?.result,
    "target",
  );
  // Les bougies d'avant ne comptent pas.
  assert.equal(
    replayPlan(
      { ...plan, from: T0 + 2 * TF * 1000 },
      bars([
        [89, 99, 95],
        [95, 100, 99],
        [99, 104, 103],
      ]),
      TF,
    )?.result,
    "open",
  );
  assert.equal(replayPlan({ ...plan, stop: 100 }, bars([[99, 104, 103]]), TF), undefined, "risque nul");
});

test("rejeu d'une idée : zone touchée (entrée à son bord), invalidation, au mieux et à ce jour", () => {
  const buy = { side: "buy" as const, low: 95, high: 97, invalidation: 90, from: T0 };
  // Elle descend dans la zone, puis monte à 105 et clôt à 103.
  const up = replayIdea(
    buy,
    bars(
      [
        [98, 101, 99],
        [96, 99, 98],
        [97, 105, 103],
      ],
      100,
    ),
    TF,
  );
  assert.equal(up.touchedAt, T0 + TF * 1000);
  assert.equal(up.entry, 97);
  assert.equal(up.invalidatedAt, undefined);
  assert.equal(up.bestR, 1.14);
  assert.equal(up.nowR, 0.86);
  // Zone touchée puis invalidation.
  const down = replayIdea(
    buy,
    bars(
      [
        [96, 99, 97],
        [89, 97, 91],
      ],
      100,
    ),
    TF,
  );
  assert.equal(down.nowR, -1);
  assert.ok(down.invalidatedAt);
  // Jamais touchée.
  assert.equal(replayIdea(buy, bars([[99, 104, 103]]), TF).touchedAt, undefined);
  // Sans prix d'invalidation : le meilleur prix seulement.
  const noInv = replayIdea(
    { side: "sell", low: 104, high: 106, from: T0 },
    bars(
      [
        [100, 105, 101],
        [96, 101, 97],
      ],
      100,
    ),
    TF,
  );
  assert.equal(noInv.entry, 104);
  assert.equal(noInv.bestPrice, 96);
  assert.equal(noInv.bestR, undefined);
});

test("le prix d'une invalidation dite avec des mots, et l'unité d'un rejeu", () => {
  assert.equal(invalidationPrice("clôture 4 h sous 2 585", { low: 2600, high: 2610 }), 2585);
  assert.equal(invalidationPrice("invalidé sous 26 520 en 1 heure", { low: 26600, high: 26650 }), 26520);
  assert.equal(invalidationPrice("le bas du range à 0,7000", { low: 0.705, high: 0.708 }), 0.7);
  assert.equal(invalidationPrice("si les chiffres du chômage déçoivent", { low: 2600, high: 2610 }), undefined);
  assert.equal(invalidationPrice(undefined, { low: 1, high: 2 }), undefined);
  // Une zone dite en mots : ses prix, sans la moyenne mobile 50 ni « la zone des 88 ».
  assert.deepEqual(zoneFromText("La zone des 88, 88,064 – 88,222, avec la moyenne mobile 50 derrière"), { low: 88.064, high: 88.222 });
  assert.deepEqual(zoneFromText("la zone des 2 600 – 2 610"), { low: 2600, high: 2610 });
  assert.equal(zoneFromText("le bas du range"), undefined);
  assert.deepEqual(ideaZone({ idea: { side: "sell", zone: { text: "la zone 88,064 – 88,222" } } }), { low: 88.064, high: 88.222 });
  assert.deepEqual(ideaZone({ idea: { side: "buy", zone: { low: 2610, high: 2600 } } }), { low: 2600, high: 2610 });
  assert.equal(replayTimeframe(3 * 3_600_000), "5m");
  assert.equal(replayTimeframe(5 * 86_400_000), "15m");
  assert.equal(replayTimeframe(30 * 86_400_000), "1h");
});

const TRADE = {
  id: "t_1",
  symbol: "XAUUSD",
  name: "or",
  digits: 2,
  side: "long",
  execution: "limit",
  entry: 4005,
  stop: 4018,
  initialStop: 3985,
  targets: [4055],
  lots: 0.15,
  risk: 300,
  riskPercent: 3,
  currency: "USD",
  state: "closed",
  legs: [{ clientId: "c", lots: 0.15, state: "closed", openPrice: 4005, exits: [{ id: "d", at: T0, price: 4018, lots: 0.15, profit: 285, reason: "stop" }] }],
  protected: true,
  profit: 285,
  r: 0.95,
  demo: true,
  createdAt: T0 - 3_600_000,
  updatedAt: T0,
  openedAt: T0 - 3_000_000,
  closedAt: T0,
} as Trade;

test("les phrases des rejeux : prévu contre géré, après la sortie, l'idée abandonnée, l'idée non prise", () => {
  assert.equal(wasManaged(TRADE, 0), true, "stop déplacé");
  assert.equal(
    wasManaged({ ...TRADE, stop: TRADE.initialStop, legs: [{ ...TRADE.legs[0], exits: [{ ...TRADE.legs[0].exits![0], reason: "target" }] }] }, 0),
    false,
  );
  const now = T0 + 3_600_000;
  const plan = planFact(TRADE, { result: "target", at: T0 + 1_800_000, r: 2, best: 2 }, { target: 4045, now });
  assert.equal(plan.tone, "warn");
  assert.match(
    plain(plan.text),
    /^Prévu au ticket \(stop 3 985,00, objectif 4 045,00, rien de touché\) : objectif touché .+, \+2 R\. Géré : \+0,95 R, −1,05 R par rapport au plan\.$/,
  );
  const after = afterFact(TRADE, { result: "target", at: T0 + 2_400_000, r: 2, best: 2 }, { target: 4045, now })!;
  assert.match(plain(after.text), /^Après ta sortie \(au stop remonté\), l'objectif du ticket \(4 045,00\) a été touché .+ : 1,05 R laissés\.$/);
  const saved = afterFact({ ...TRADE, r: -0.3 }, { result: "stop", at: T0 + 600_000, r: -1, best: 0 }, { target: 4045, now })!;
  assert.match(saved.text, /ta sortie t'a gardé 0,7 R de plus que le stop/);
  const view = { idea: { side: "buy" as const, zone: { low: 26600, high: 26650 } }, invalidation: "sous 26 520" };
  const idea = ideaFact(
    "Ton idée de départ",
    view,
    T0 - 86_400_000,
    { touchedAt: T0, entry: 26650, bestR: 1.6, nowR: 1.3, last: 26815 },
    { digits: 2, now, key: "idea-replay", invalidation: 26520 },
  );
  assert.equal(idea.tone, "warn");
  assert.match(
    plain(idea.text),
    /^Ton idée de départ \(achat sur 26 600,00 – 26 650,00, .+\), rejouée sur les cours : zone touchée .+, invalidation \(26 520,00\) jamais touchée ; \+1,3 R à ce jour, \+1,6 R au mieux\.$/,
  );
  assert.match(ideaFact("L'idée de ta fiche", view, T0, {}, { now, key: "k" }).text, /zone pas touchée depuis/);
  assert.match(untakenLine({ touchedAt: T0, nowR: 0.9, bestR: 1.8 }, { now }), /^Idée non prise : zone touchée .+ ; \+0,9 R à ce jour, \+1,8 R au mieux\.$/);
  assert.equal(untakenLine({}, { now }), "Idée non prise : zone pas encore touchée.");
});

const page = (over: Partial<JournalTrade> & { r: number; id: string }): JournalTrade => ({
  trade: { ...TRADE, id: over.id, r: over.r, profit: over.r * 100 },
  outcome: over.r >= 0.1 ? "win" : over.r <= -0.1 ? "loss" : "neutral",
  fidelity: over.fidelity ?? "with",
  frozen: true,
  facts: over.facts ?? [],
  gestures: [],
  notes: [],
  thread: over.thread ?? [],
});

test("l'analyse : chiffres du serveur, tour donné à l'IA, réponse vérifiée", () => {
  const pages = [
    page({ id: "t_a", r: 2, facts: [{ key: "plan", tone: "warn", text: "Prévu … Géré : +0,95 R, −1,05 R par rapport au plan." }] }),
    page({
      id: "t_b",
      r: -1,
      fidelity: "against",
      facts: [
        { key: "changed-mind", tone: "warn", text: "Changement d'avis : …" },
        { key: "objection", tone: "warn", text: "Objection relevée …" },
      ],
      thread: [{ at: T0, kind: "note", by: "user", text: "je n'aurais pas dû lâcher ma fiche" }],
    }),
    page({ id: "t_c", r: 0.03, fidelity: "none" }),
  ];
  const stats = reviewStats(pages, [{ name: "or", line: "Idée non prise : zone touchée…" }]);
  const byKey = Object.fromEntries(stats.map((s) => [s.key, s]));
  assert.equal(byKey.total.label, "3 trades fermés : 1 gagnant, 1 perdant, 1 neutre");
  assert.equal(byKey.total.value, "+1,03 R");
  assert.equal(byKey["fidelity-with"].value, "+2 R");
  assert.equal(byKey["fidelity-against"].value, "−1 R");
  assert.equal(byKey["changed-mind"].label, "Changement d'avis avant le trade : 1 trade");
  assert.equal(byKey.objection.value, "−1 R");
  assert.equal(byKey.plan.value, "−1,05 R");
  assert.equal(byKey.untaken.label, "Idées de fiche non prises : 1");

  const turn = reviewTurn({ days: 7, stats, pages, untaken: [{ name: "or", line: "Idée non prise : zone touchée…" }], now: T0 });
  assert.match(turn, /^Période : les 7 derniers jours\./);
  assert.ok(turn.includes("## t_b — or, achat, perdant −1 R, contre la fiche"));
  assert.ok(turn.includes("sa note : je n'aurais pas dû lâcher ma fiche"));
  assert.ok(turn.includes("- or : Idée non prise"));
  assert.match(REVIEW_PROMPT, /ton avis franc de trader expérimenté/);
  assert.match(REVIEW_PROMPT, /N'en déduis rien qu'il n'a pas dit/);

  const reply = `Voici :\n${JSON.stringify({
    summary: "Ta seule perte vient d'un changement d'avis contre ta fiche.",
    findings: [
      { title: "Changement d'avis", text: "Sur t_b, tu as lâché ta fiche.", trades: ["t_b", "t_inconnu"] },
      { title: "Sans trade", text: "Un constat en l'air.", trades: [] },
    ],
    carnet: "je ne lâche pas ma fiche pour une divergence",
  })}`;
  const parsed = parseReview(reply, ["t_a", "t_b", "t_c"])!;
  assert.equal(parsed.summary, "Ta seule perte vient d'un changement d'avis contre ta fiche.");
  assert.deepEqual(
    parsed.findings.map((f) => f.trades),
    [["t_b"]],
    "trades inconnus retirés, constat sans trade écarté",
  );
  assert.equal(parsed.carnet, "je ne lâche pas ma fiche pour une divergence");
  assert.equal(parseReview('{"summary":"x","findings":[],"carnet":null}', [])?.carnet, undefined);
  assert.equal(parseReview("pas de JSON", []), undefined);
  assert.equal(parseReview('{"findings":[]}', []), undefined, "sans résumé");

  const review = {
    id: "jr_1",
    createdAt: T0,
    days: 7,
    since: 0,
    stats,
    summary: parsed.summary,
    findings: parsed.findings,
    carnet: parsed.carnet,
    tradeIds: ["t_a", "t_b", "t_c"],
  };
  const r = reviewReport(review, T0);
  assert.match(r.prompt, /^\[Journal\] L'analyse de son trading sur 7 jours est prête/);
  assert.match(r.prompt, /seulement s'il dit oui, remember avec notebook trading/);
  assert.doesNotMatch(reviewReport({ ...review, carnet: undefined }, T0).prompt, /carnet/);
  assert.match(reviewFailedReport("réponse de l'IA illisible", T0).prompt, /n'a pas pu se faire : réponse de l'IA illisible/);
});
