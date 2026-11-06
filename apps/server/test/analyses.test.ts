// Fiches d'analyse : une fiche par produit qui continue d'un jour à l'autre,
// ce qu'il dit ne remplace que les champs dits, le fil garde tout ; et le
// contradicteur : un changement de sens depuis la veille, une idée contre son
// biais, un setup du système dans l'autre sens, une fiche fermée récemment,
// chacun relevé une seule fois. Le courtier, les setups et le wrap sont simulés.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisView } from "@kopilia/contracts";
import { AnalysisError, AnalysisService, merge } from "../src/analyses/analysis.service.js";
import { confront, type SystemSetup } from "../src/analyses/analysis-check.js";
import { AnalysesController } from "../src/analyses/analyses.controller.js";
import { saidText, viewText } from "../src/analyses/analysis-texts.js";
import { setupPassPrompt } from "../src/setups/setup-prompts.js";
import type { MarketService } from "../src/market/market.service.js";
import type { ScenarioService } from "../src/setups/scenario.service.js";
import type { BriefService } from "../src/veille/brief.service.js";
import type { DrawingService } from "../src/dashboard/drawing.service.js";
import { tempData } from "./harness.js";

const GOLD = { symbol: "XAUUSD", name: "or", digits: 2 };
const plain = (text: string) => text.replace(/\u202f/g, " ");
/** Mercredi 4 novembre 2026, 8 h 40 (heure de Paris), et le lendemain 9 h 12. */
const DAY1 = new Date(2026, 10, 4, 8, 40).getTime();
const DAY2 = new Date(2026, 10, 5, 9, 12).getTime();

/** Son exemple : le matin, un rebond attendu sur la zone des 2 600, une hausse pour une raison macro. */
const DAY1_VIEW: AnalysisView = {
  fundamental: { bias: "up", reason: "les taux réels baissent" },
  idea: { side: "buy", zone: { low: 2600, high: 2610, text: "la zone des 2 600" }, horizon: "swing", timeframe: "4h" },
  invalidation: "clôture 4 h sous 2 585",
};

function service() {
  const data = tempData("analyses");
  const analyses = new AnalysisService(data.db);
  let now = DAY1;
  analyses.now = () => now;
  return { data, analyses, at: (t: number) => (now = t) };
}

test("fusion : ce qu'il dit ne remplace que les champs dits ; un changement de sens repart de ce qu'il dit", () => {
  // Une raison seule garde le sens ; un sens qui change perd l'ancienne raison.
  assert.deepEqual(merge(DAY1_VIEW, { fundamental: { reason: "la Fed ralentit" } }).fundamental, { bias: "up", reason: "la Fed ralentit" });
  assert.deepEqual(merge(DAY1_VIEW, { fundamental: { bias: "down" } }).fundamental, { bias: "down" });
  // Même sens : seule la zone change, le reste de l'idée et l'invalidation restent.
  const moved = merge(DAY1_VIEW, { idea: { zone: { low: 2595, high: 2605 } } });
  assert.deepEqual(moved.idea, { side: "buy", zone: { low: 2595, high: 2605 }, horizon: "swing", timeframe: "4h" });
  assert.equal(moved.invalidation, "clôture 4 h sous 2 585");
  // Une vente : l'ancienne zone et l'ancienne invalidation allaient avec l'achat ; l'horizon reste.
  const sell = merge(DAY1_VIEW, { idea: { side: "sell", trigger: "cassure de 2 640" } });
  assert.deepEqual(sell.idea, { side: "sell", trigger: "cassure de 2 640", horizon: "swing" });
  assert.equal(sell.invalidation, undefined);
  assert.equal(sell.fundamental?.bias, "up");
  // Ce qui manque pour comprendre est demandé, en français.
  assert.throws(() => merge({}, { fundamental: { reason: "les taux" } }), AnalysisError);
  assert.throws(() => merge({}, { idea: { zone: { low: 2600 } } }), /achat \(buy\), vente \(sell\)/);
});

test("fiche : ouverte à la première lecture, mise à jour ensuite, une seule ouverte par produit, rien d'effacé", () => {
  const { data, analyses, at } = service();
  try {
    const first = analyses.note(GOLD, {
      fundamental: { bias: "up", reason: "les taux réels baissent" },
      idea: { side: "buy", zone: { low: 2610, high: 2600, text: "la zone des 2 600" }, horizon: "swing", timeframe: "4h" },
      invalidation: "clôture 4 h sous 2 585",
    });
    assert.equal(first.opened, true);
    assert.equal(first.before, undefined);
    assert.match(first.analysis.id, /^an_[0-9a-f]{8}$/);
    // Les bornes sont rangées.
    assert.deepEqual(first.analysis.view.idea?.zone, { low: 2600, high: 2610, text: "la zone des 2 600" });

    at(DAY2);
    const second = analyses.note(GOLD, { idea: { side: "sell" } });
    assert.equal(second.opened, false);
    assert.equal(second.analysis.id, first.analysis.id);
    assert.equal(second.before?.at, DAY1);
    assert.equal(second.before?.view.idea?.side, "buy");
    assert.equal(second.analysis.view.idea?.side, "sell");
    assert.equal(analyses.list().length, 1);

    // Le fil : ce qu'il a dit à chaque fois, avec l'état complet.
    const fil = analyses.entries(first.analysis.id);
    assert.deepEqual(
      fil.map((e) => [e.kind, e.at]),
      [
        ["view", DAY1],
        ["view", DAY2],
      ],
    );
    assert.equal(
      plain(fil[0].text),
      "fondamental haussier (les taux réels baissent) ; idée : achat sur la zone des 2 600 (2 600,00 – 2 610,00), swing, en 4h ; invalidée si : clôture 4 h sous 2 585",
    );
    assert.equal(fil[1].text, "idée : vente");
    assert.equal(fil[1].view?.fundamental?.bias, "up");

    assert.throws(() => analyses.note(GOLD, {}), /rien à noter/);
    assert.throws(() => analyses.note(GOLD, { idea: { side: "short" } }), /buy, sell, none/);

    // Fermée : la suivante est une nouvelle fiche, qui rappelle la précédente.
    const closed = analyses.close(first.analysis.id, "zone cassée");
    assert.equal(closed.state, "closed");
    assert.equal(closed.closeReason, "zone cassée");
    assert.throws(() => analyses.close(first.analysis.id, "encore"), /déjà fermée/);
    const fresh = analyses.note(GOLD, { fundamental: { bias: "down", reason: "le dollar repart" } });
    assert.equal(fresh.opened, true);
    assert.notEqual(fresh.analysis.id, first.analysis.id);
    assert.equal(fresh.closed?.id, first.analysis.id);
    assert.equal(analyses.get(first.analysis.id)?.state, "closed");
    assert.deepEqual(
      analyses.list({ closedSince: DAY1 }).map((a) => a.state),
      ["open", "closed"],
    );
  } finally {
    data.cleanup();
  }
});

test("contradicteur : son exemple, vente le lendemain alors que le fondamental reste haussier", () => {
  const after = merge(DAY1_VIEW, { idea: { side: "sell", zone: { low: 2640, high: 2645 } } });
  const { points, missing } = confront({ before: { view: DAY1_VIEW, at: DAY1 }, after, said: { idea: { side: "sell" } }, setups: [], digits: 2, now: DAY2 });
  assert.equal(points.length, 1, points.map((p) => p.text).join("\n"));
  assert.equal(
    plain(points[0].text),
    "hier à 8 h 40, il voyait achat sur la zone des 2 600 (2 600,00 – 2 610,00) ; maintenant vente sur 2 640,00 – 2 645,00, alors que son biais fondamental n'a pas changé (haussier : les taux réels baissent). Qu'est-ce qui a changé ?",
  );
  // L'ancienne invalidation allait avec l'achat : il faut la nouvelle.
  assert.deepEqual(missing, ["ce qui invaliderait son idée (il ne l'a pas dit)"]);

  // Le changement de sens dit déjà « contre ton fondamental » : relevé, ni l'un ni l'autre ne revient.
  assert.deepEqual(points[0].covers, ["against_fundamental:sell:up"]);
  const raised = new Set([points[0].key, ...points[0].covers!]);
  assert.deepEqual(confront({ before: { view: DAY1_VIEW, at: DAY1 }, after, said: {}, setups: [], raised, now: DAY2 }).points, []);
  assert.deepEqual(confront({ before: { view: after, at: DAY2 }, after, said: {}, setups: [], raised, now: DAY2 }).points, []);

  // Il change aussi son fondamental, avec une raison : le changement de sens reste relevé, sans « sans raison ».
  const both = merge(DAY1_VIEW, {
    idea: { side: "sell" },
    fundamental: { bias: "down", reason: "CPI au-dessus des attentes" },
    invalidation: "retour au-dessus de 2 660",
  });
  const p2 = confront({
    before: { view: DAY1_VIEW, at: DAY1 },
    after: both,
    said: { fundamental: { bias: "down", reason: "CPI au-dessus des attentes" } },
    setups: [],
    now: DAY2,
  });
  assert.equal(p2.points.length, 1);
  assert.match(p2.points[0].text, /son biais fondamental passe de haussier à baissier\. Qu'est-ce qui a changé \?$/);
  assert.deepEqual(p2.missing, []);
});

test("contradicteur : il se tait quand tout tient ensemble, et relève le reste une fois", () => {
  // Cohérent : même sens, zone ajustée, invalidation dite.
  const moved = merge(DAY1_VIEW, { idea: { zone: { low: 2595, high: 2605 } } });
  assert.deepEqual(confront({ before: { view: DAY1_VIEW, at: DAY1 }, after: moved, said: {}, setups: [], now: DAY2 }), { points: [], missing: [] });

  // Une vente dès la première lecture contre son fondamental haussier, et contre sa lecture technique.
  const against: AnalysisView = {
    fundamental: { bias: "up" },
    technical: { bias: "up", reason: "au-dessus de la 200" },
    idea: { side: "sell" },
    invalidation: "2 660",
  };
  const p = confront({ after: against, said: against, setups: [], now: DAY1 }).points.map((x) => x.text);
  assert.deepEqual(p, [
    "Son idée (vente) va contre son biais fondamental (haussier) : un trade contre le fond, qu'est-ce qui le justifie ?",
    "Son idée (vente) va contre sa propre lecture technique (haussier : au-dessus de la 200).",
  ]);

  // Son biais fondamental change sans raison donnée.
  const flipped = merge(DAY1_VIEW, { fundamental: { bias: "neutral" } });
  const f = confront({ before: { view: DAY1_VIEW, at: DAY1 }, after: flipped, said: { fundamental: { bias: "neutral" } }, setups: [], now: DAY2 }).points;
  assert.equal(f.length, 1);
  assert.equal(f[0].text, "Son biais fondamental passe de haussier à neutre sans raison donnée : une annonce, le wrap ?");
});

test("contradicteur : un setup du système dans l'autre sens, une fiche fermée récemment dans l'autre sens", () => {
  const short: SystemSetup = {
    id: "sc_1",
    direction: "short",
    state: "watching",
    horizon: "intraday",
    timeframe: "15m",
    title: "Or : rejet de 2 640 en 15 minutes",
  };
  const long: SystemSetup = { ...short, id: "sc_2", direction: "long", title: "Or : rebond sur 2 600" };
  const p = confront({ after: DAY1_VIEW, said: DAY1_VIEW, setups: [short, long], now: DAY1 }).points;
  assert.equal(p.length, 1, "le setup dans le même sens n'est pas une objection");
  assert.equal(
    p[0].text,
    "Le système a un setup en attente à la vente (intraday, 15m) : « Or : rejet de 2 640 en 15 minutes » (sc_1), contre son idée (achat). Les deux peuvent tenir (un repli avant sa zone, par exemple) : à confronter.",
  );
  // Sans idée de trade : confronté à son biais fondamental.
  const onlyBias: AnalysisView = { fundamental: { bias: "up" } };
  assert.match(confront({ after: onlyBias, said: onlyBias, setups: [short], now: DAY1 }).points[0].text, /contre son biais fondamental \(haussier\)/);

  // Une fiche neuve à la vente, deux jours après en avoir fermé une à l'achat.
  const sell: AnalysisView = { idea: { side: "sell" }, invalidation: "2 660" };
  const r = confront({
    after: sell,
    said: sell,
    closed: { view: DAY1_VIEW, closedAt: DAY1, reason: "je repars de zéro" },
    setups: [],
    digits: 2,
    now: DAY2 + 86_400_000,
  });
  assert.equal(r.points.length, 1);
  assert.equal(
    plain(r.points[0].text),
    "Sa fiche précédente sur ce produit, fermée mercredi 4 novembre à 8 h 40 (je repars de zéro), voyait achat sur la zone des 2 600 (2 600,00 – 2 610,00) : qu'est-ce qui a changé ?",
  );
});

test("outil du dialogue : la lecture notée revient avec de quoi le contredire ; sa réponse, la relecture, la fermeture", async () => {
  const { data, analyses, at } = service();
  try {
    const market = { resolve: async (q: string) => (/or|xau/i.test(q) ? GOLD : { error: `introuvable : ${q}` }) } as unknown as MarketService;
    let setups: unknown[] = [];
    const scenarios = { list: () => setups } as unknown as ScenarioService;
    const briefs = {
      latest: () => ({ created_at: DAY2 - 2 * 3_600_000, title: "Wrap du 5 novembre : dollar ferme", spoken: "Le dollar reprend avant l'emploi." }),
    } as unknown as BriefService;
    const drawings = {
      get: (id: string) => (id === "d_zone" ? { id, symbol: "XAUUSD", kind: "zone", top: 2610, bottom: 2600, createdBy: "user" } : undefined),
    } as unknown as DrawingService;
    const ctl = new AnalysesController(analyses, market, scenarios, briefs, drawings);

    const day1 = (await ctl.note({
      product: "l'or",
      fundamental_bias: "up",
      fundamental_reason: "les taux réels baissent",
      side: "buy",
      zone_drawing: "d_zone",
      horizon: "swing",
      invalidation: "clôture 4 h sous 2 585",
      summary: "  ",
    })) as Record<string, unknown>;
    assert.match(String(day1.noted), /^Fiche ouverte : or \(an_/);
    // Le texte du tracé porte déjà ses prix : ils ne sont pas répétés.
    assert.match(plain(String(day1.noted)), /idée : achat sur son tracé : zone 2 600,00 – 2 610,00, swing ;/);
    assert.equal(day1.point, undefined);
    assert.match(String(day1.consigne), /confirme en quelques mots/);

    at(DAY2);
    setups = [
      { id: "sc_9", direction: "short", state: "proposed", horizon: "intraday", timeframe: "15m", title: "Or : vente sous 2 640" },
      { id: "sc_8", direction: "long", state: "watching", horizon: "swing", timeframe: "4h", title: "Or : rebond sur 2 600" },
    ];
    const day2 = (await ctl.note({ product: "or", side: "sell", zone_low: 2640, zone_high: 2645 })) as Record<string, unknown>;
    assert.match(String(day2.noted), /^Fiche mise à jour/);
    assert.match(String(day2.before), /^hier à 8 h 40 : fondamental haussier/);
    // Deux objections possibles (son changement de sens, le setup du système à l'achat) : la plus importante, seule.
    assert.match(String(day2.point), /^hier à 8 h 40, il voyait achat/);
    assert.deepEqual(day2.ask, ["ce qui invaliderait son idée (il ne l'a pas dit)"]);
    assert.deepEqual(day2.systemSetups, [
      "sc_9, déclenché, vente (intraday, 15m) : Or : vente sous 2 640",
      "sc_8, en attente, achat (swing, 4h) : Or : rebond sur 2 600",
    ]);
    assert.equal(day2.wrap, "aujourd'hui à 7 h 12 : « Wrap du 5 novembre : dollar ferme ». En bref : Le dollar reprend avant l'emploi.");
    assert.match(String(day2.consigne), /contradicteur/);

    // Sa réponse va au fil ; l'objection n'est pas relevée une deuxième fois, la suivante vient à sa lecture suivante.
    assert.deepEqual(await ctl.note({ product: "or", answer: "un repli vers 2 600 avant la reprise" }), {
      noted: `réponse notée dans la fiche or (${analyses.open("XAUUSD")!.id})`,
    });
    const again = (await ctl.note({ product: "or", invalidation: "retour au-dessus de 2 660" })) as Record<string, unknown>;
    assert.match(String(again.point), /^Le système a un setup en attente à l'achat \(swing, 4h\) : « Or : rebond sur 2 600 » \(sc_8\)/);
    const calm = (await ctl.note({ product: "or", trigger: "une bougie de rejet en 15 minutes" })) as Record<string, unknown>;
    assert.equal(calm.point, undefined);

    const read = (await ctl.list("or")) as { analysis: string; fil: string[] };
    assert.match(read.analysis, /invalidée si : retour au-dessus de 2 660/);
    assert.deepEqual(
      read.fil.map((l) => l.split(" : ")[0]),
      [
        "hier à 8 h 40, sa lecture",
        "aujourd'hui à 9 h 12, sa lecture",
        "aujourd'hui à 9 h 12, objection",
        "aujourd'hui à 9 h 12, sa réponse",
        "aujourd'hui à 9 h 12, sa lecture",
        "aujourd'hui à 9 h 12, objection",
        "aujourd'hui à 9 h 12, sa lecture",
      ],
    );

    // Erreurs que le modèle corrige.
    assert.deepEqual(await ctl.note({ product: "or" }), {
      error: "rien à noter : dis sa lecture, un biais, son idée, ce qui l'invaliderait, ou sa réponse (answer)",
    });
    assert.deepEqual(await ctl.note({ product: "or", zone_drawing: "d_autre" }), { error: "aucun tracé « d_autre » sur or (chart_drawings les donne)" });
    assert.deepEqual(await ctl.note({ product: "blé", side: "buy" }), { error: "introuvable : blé" });

    // Fermée à sa demande ; la liste la montre parmi les fermées.
    const closed = (await ctl.close({ product: "or", reason: "je repars de zéro" })) as { closed: string };
    assert.match(closed.closed, /FERMÉE aujourd'hui à 9 h 12 : je repars de zéro/);
    assert.deepEqual(await ctl.close({ product: "or" }), { error: "pas de fiche ouverte sur or" });
    const all = (await ctl.list()) as { open: string[]; recentlyClosed: string[] };
    assert.equal(all.open.length, 0);
    assert.equal(all.recentlyClosed.length, 1);
  } finally {
    data.cleanup();
  }
});

test("textes : l'état d'une fiche et ce qu'il vient de dire, à lire tels quels", () => {
  assert.equal(viewText({}), "rien de noté");
  assert.equal(
    saidText({ fundamental: { reason: "la Fed ralentit" }, idea: { zone: { text: "la zone des 2 600" } } }),
    "raison fondamentale : la Fed ralentit ; idée : zone : la zone des 2 600",
  );
  assert.equal(saidText({ idea: { side: "none" } }), "idée : pas d'idée de trade");
  assert.equal(plain(saidText({ idea: { side: "sell", zone: { text: "sous 25 400" } } })), "idée : vente sous 25 400");
  // Glissé dans une phrase : sans majuscule ni point final (sauf un sigle), sans « sur » devant une préposition, sans prix répétés.
  assert.equal(
    plain(viewText({ fundamental: { bias: "up", reason: "Les taux réels baissent." }, idea: { side: "sell", zone: { text: "Sous 4 100" } } })),
    "fondamental haussier (les taux réels baissent) ; idée : vente sous 4 100",
  );
  assert.equal(viewText({ fundamental: { bias: "down", reason: "BCE plus ferme" } }), "fondamental baissier (BCE plus ferme)");
  assert.equal(
    plain(viewText({ idea: { side: "buy", zone: { low: 4020, high: 4030, text: "la zone des 4 020 – 4 030" } } }, 2)),
    "idée : achat sur la zone des 4 020 – 4 030",
  );
});

test("recherche de setups : elle reçoit ses fiches d'analyse, son avis sur ces produits", () => {
  const prompt = setupPassPrompt({
    reason: "après le wrap",
    products: ["or"],
    hypotheses: [],
    analyses: ["or (an_1, ouverte hier à 8 h 40) : fondamental haussier"],
    scenarios: [],
  });
  assert.match(prompt, /Fiches d'analyse de l'utilisateur .*:\n- or \(an_1, ouverte hier à 8 h 40\) : fondamental haussier/);
  assert.match(prompt, /Ses fiches d'analyse aussi : c'est son avis sur ces produits/);
  assert.doesNotMatch(setupPassPrompt({ reason: "x", products: ["or"], hypotheses: [], scenarios: [] }), /Fiches d'analyse de l'utilisateur/);
});
