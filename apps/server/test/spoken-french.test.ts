import { test } from "node:test";
import assert from "node:assert/strict";
import { frenchNumber, frenchOrdinal, spokenFrench, spokenHour } from "../src/voice/spoken-french.js";
import { SentenceGrouper } from "../src/voice/sentence-grouper.js";

/** Écrit -> dit. */
function says(cases: Array<[string, string]>) {
  for (const [written, spoken] of cases) assert.equal(spokenFrench(written), spoken, written);
}

test("heures : « 16 heures » et non « seize ache » ni « seize zéro zéro »", () => {
  says([
    ["L'ISM sort à 16h.", "l'I S M sort à 16 heures."],
    ["À 16 h 30", "À 16 heures 30"],
    ["à 16h30", "à 16 heures 30"],
    ["à 16:00 et à 9:05", "à 16 heures et à 9 heures 5"],
    ["à 1 h et à 21 h", "à une heure et à vingt et une heures"],
    ["à 0 h 15", "à 0 heure 15"],
    ["un film de 2 h 15 min", "un film de 2 heures 15 minutes"],
    ["de 9h-17h30", "de 9 heures à 17 heures 30"],
    ["ouvert 24h/24 et 7j/7", "ouvert 24 heures sur 24 et 7 jours sur 7"],
    ["à 16 h", "à 16 heures"],
  ]);
});

test("heures : rien d'autre n'est touché", () => {
  says([
    ["à 50 km/h", "à 50 kilomètres heure"],
    ["16 heures", "16 heures"],
    ["le ratio 3:1", "le ratio 3:1"],
    ["à 25:99", "à 25:99"],
  ]);
});

test("nombres : virgule dite, signe dit, ordres de grandeur du calendrier", () => {
  says([
    ["Le taux est à 4,85 %.", "Le taux est à 4 virgule 85 %."],
    ["Le taux est à 4.85%.", "Le taux est à 4 virgule 85%."],
    ["Inflation à -0.3% puis +0,2 %.", "Inflation à moins 0 virgule 3% puis plus 0 virgule 2 %."],
    ["Prévision 63K, précédent 29K.", "Prévision 63 mille, précédent 29 mille."],
    [
      "Offres d'emploi 7.11M, solde -56.2B, dette 3.26T.",
      "Offres d'emploi 7 virgule 11 millions, solde moins 56 virgule 2 milliards, dette 3 virgule 26 mille milliards.",
    ],
    ["1M de personnes", "1 million de personnes"],
    ["Le vote 7-0-2, la saison 2025-2026, la liste 1,2,3.", "Le vote 7-0-2, la saison 2025-2026, la liste 1,2,3."],
    ["le 02.11.2026", "le 02.11.2026"],
  ]);
});

test("cours : milliers en espace insécable (Intl fr-FR) lus « vingt et un mille… »", () => {
  says([
    ["Le Nasdaq est à 21 540,25.", "Le Nasdaq est à 21 540 virgule 25."],
    ["L'or à 4 012,3 et l'euro-dollar à 1,0834.", "L'or à 4 012 virgule 3 et l'euro-dollar à 1 virgule 0 8 3 4."],
    ["La livre à 1,34144 à 11:43:04.", "La livre à 1 virgule 3 4 1 4 4 à 11 heures 43 et 4 secondes."],
    ["à 11:43:01, puis à 11:44:00", "à 11 heures 43 et une seconde, puis à 11 heures 44"],
    ["cotation de 11 h 49 min 50 s, heure de Paris", "cotation de 11 heures 49 minutes 50 secondes, heure de Paris"],
    ["en 2 min 1 s", "en 2 minutes une seconde"],
    ["les 3 s de l'alphabet", "les 3 s de l'alphabet"],
    ["Le Nasdaq à 28 093,51 et le ratio 151,234.", "Le Nasdaq à 28 093 virgule 51 et le ratio 151 virgule 234."],
    ["à 25:61:99", "à 25:61:99"],
    ["Spread de 1 234 567 points", "Spread de 1 234 567 points"],
    ["à 16 h et 12 34", "à 16 heures et 12 34"],
  ]);
});

test("montants : euros, dollars, devises", () => {
  says([
    ["Ça coûte 4,50 €.", "Ça coûte 4 euros 50."],
    ["Le baril à $75 et l'once à $2650.", "Le baril à 75 dollars et l'once à 2650 dollars."],
    ["Un budget de 1,2 Md€ et 300 M€.", "Un budget de 1 virgule 2 milliard d'euros et 300 millions d'euros."],
    ["Une levée de 50 k€ et 2 Md$.", "Une levée de 50 mille euros et 2 milliards de dollars."],
    ["100 USD et 1 EUR", "100 dollars et 1 euro"],
    ["L'EUR/USD et le USD/JPY.", "L'euro dollar et le dollar yen."],
  ]);
});

test("indicateurs, unités, dates, fractions", () => {
  says([
    ["Le CPI m/m et le PIB y/y, le GDP q/q.", "Le C P I sur un mois et le P I B sur un an, le G D P sur un trimestre."],
    ["Une baisse de 25 pb, de 50 bps, de 1 pb.", "Une baisse de 25 points de base, de 50 points de base, de 1 point de base."],
    ["Le Nasdaq prend 150 pts.", "Le Nasdaq prend 150 points."],
    ["Il fera 12°C, -3 °C la nuit.", "Il fera 12 degrés, moins 3 degrés la nuit."],
    ["Un T3 de 65 m².", "Un T3 de 65 mètres carrés."],
    ["Le 02/11/2026 et le 2/11.", "Le 2 novembre 2026 et le 2 novembre."],
    ["Le 01/11/26.", "Le premier novembre 2026."],
    ["le 1 novembre", "le premier novembre"],
    ["1/2, 3/4, noté 4/5 et 18/20", "un demi, trois quarts, noté 4 sur 5 et 18 sur 20"],
    ["Dans 30 min, ou 1 min.", "Dans 30 minutes, ou une minute."],
  ]);
});

test("ordinaux, trimestres, siècles", () => {
  says([
    ["Le 2e trimestre et le 3ème.", "Le deuxième trimestre et le troisième."],
    ["Au T3 2026 et au Q4.", "Au troisième trimestre 2026 et au quatrième trimestre."],
    ["Au S1 2027.", "Au premier semestre 2027."],
    ["Le XXe siècle et le XXIe.", "Le vingtième siècle et le vingt et unième."],
    ["La Ve République.", "La cinquième République."],
    ["La 1re fois, le 1er rang, la 2nde.", "La première fois, le premier rang, la seconde."],
    ["Le monde, Ce matin.", "Le monde, Ce matin."],
  ]);
  assert.equal(frenchNumber(71), "soixante et onze");
  assert.equal(frenchNumber(80), "quatre-vingts");
  assert.equal(frenchNumber(200), "deux cents");
  assert.equal(frenchOrdinal(5), "cinquième");
  assert.equal(frenchOrdinal(9), "neuvième");
  assert.equal(frenchOrdinal(80), "quatre-vingtième");
  assert.equal(spokenHour(21, 5), "vingt et une heures 5");
});

test("sigles épelés (espeak lit « PMI » comme un mot), sauf ceux qui se disent", () => {
  says([
    ["Le PMI, l'ISM, le PCE et la BCE.", "Le P M I, l'I S M, le P C E et la B C E."],
    ["La BoE et la BoJ, la Fed.", "La B O E et la B O J, la Fed."],
    ["L'OPEP, l'OTAN, l'INSEE, le NASDAQ, le CAC 40.", "L'OPEP, l'OTAN, l'Insé, le Nasdaq, le CAC 40."],
    ["Les ETFs et les ÉTATS-UNIS.", "Les E T F et les ÉTATS-UNIS."],
  ]);
});

test("abréviations et émojis", () => {
  says([
    ["Apple vs Microsoft.", "Apple contre Microsoft."],
    ["Salle n°3.", "Salle numéro 3."],
    ["M. Powell et MM. Dupont.", "monsieur Powell et messieurs Dupont."],
    ["Des fruits, p. ex. des pommes.", "Des fruits, par exemple des pommes."],
    ["Env. 30 personnes.", "environ 30 personnes."],
    ["Le chiffre x2 en un an.", "Le chiffre multiplié par 2 en un an."],
    ["Il fera beau ☀️ demain 🙂.", "Il fera beau demain ."],
    ["🎉", ""],
  ]);
});

test("découpage en phrases : jamais au milieu d'un nombre ni après une initiale", () => {
  const g = new SentenceGrouper();
  const speech = (segments: Array<{ speech: string }>) => segments.map((s) => s.speech);
  assert.deepEqual(g.push("Le taux est à 4."), [], "« 4. » peut être le début de « 4.85 »");
  assert.deepEqual(speech(g.push("85 %. M. Powell parle à 16 h. Ensuite")), ["Le taux est à 4.85 %.", "M. Powell parle à 16 h."]);
  assert.deepEqual(speech(g.push(" la BCE ! Fin")), ["Ensuite la BCE !"]);
  assert.equal(g.flush()?.speech, "Fin");

  const quotes = new SentenceGrouper();
  assert.deepEqual(speech(quotes.push("Il a dit « oui. » Puis\nUne ligne")), ["Il a dit « oui. »", "Puis"]);
  assert.equal(quotes.flush()?.speech, "Une ligne");
});

test("découpage en phrases : bout à bout, les textes affichés redonnent la réponse exacte", () => {
  const g = new SentenceGrouper();
  const reply = "Voici le code :\n```js\nconst x = 1;\n```\nC'est tout. À 16h, 🙂 bonne soirée !";
  const segments = [...reply.match(/.{1,7}/gsu)!.flatMap((d) => g.push(d)), g.flush()!];
  assert.equal(segments.map((s) => s.text).join(""), reply);
});

test("première phrase longue : son début part seul dès une virgule, pour que la voix commence plus tôt", () => {
  const g = new SentenceGrouper();
  const speech = (segments: Array<{ speech: string }>) => segments.map((s) => s.speech);
  assert.deepEqual(g.push("Un rebond sur support, c'est quand le prix redescend"), [], "pas encore assez long : on attend la fin de phrase");
  assert.deepEqual(speech(g.push(" vers un niveau où les acheteurs")), ["Un rebond sur support,"]);
  // La suite et les phrases suivantes : découpage habituel, sans coupe à la virgule.
  assert.deepEqual(speech(g.push(" sont intervenus, puis repart. Le support est un plancher, souvent touché plusieurs fois par le passé. Fin")), [
    "c'est quand le prix redescend vers un niveau où les acheteurs sont intervenus, puis repart.",
    "Le support est un plancher, souvent touché plusieurs fois par le passé.",
  ]);
  assert.equal(g.flush()?.speech, "Fin");

  // Ni après « Oui, » trop court, ni à la virgule d'un nombre.
  const gold = new SentenceGrouper();
  assert.deepEqual(speech(gold.push("Oui, l'or est à 4 065,31 dollars l'once ce soir, en hausse de trois pour cent")), [
    "Oui, l'or est à 4 065,31 dollars l'once ce soir,",
  ]);
  // Une première phrase courte n'est jamais coupée.
  const brief = new SentenceGrouper();
  assert.deepEqual(speech(brief.push("Salut Paul, ça va très bien, merci. Et")), ["Salut Paul, ça va très bien, merci."]);
});
