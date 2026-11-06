import { test } from "node:test";
import assert from "node:assert/strict";
import { chartFor, findPrices, matchLevel, PriceTracker, productOf, type ChartRef } from "../src/app/dashboard/price-spots";

/** Les prix cités, tels que le texte les écrit, avec leurs bornes. */
function cited(text: string, final = true) {
  return findPrices(text, final).map((m) => ({ raw: text.slice(m.start, m.end), low: m.low, high: m.high, product: m.product }));
}

test("prix à la française : milliers séparés, décimales après la virgule", () => {
  const text = "Oui, je la vois : une boîte d'achat sur l'or, entrée à 4 072,42, stop à 4 028,08, objectif à 4 160,97.";
  assert.deepEqual(
    cited(text).map((c) => [c.raw, c.low]),
    [
      ["4 072,42", 4072.42],
      ["4 028,08", 4028.08],
      ["4 160,97", 4160.97],
    ],
  );
  assert.deepEqual(cited("l'euro-dollar est à 1,16523 et la livre-dollar à 1,31012")[0], { raw: "1,16523", low: 1.16523, high: 1.16523, product: "eurusd" });
  // Espace insécable fine (format Intl) et point décimal.
  assert.equal(cited("le Nasdaq à 25\u202F104,5")[0].low, 25104.5);
  assert.equal(cited("à 4072.42 ce matin")[0].low, 4072.42);
});

test("zones : tiret, « entre … et … », « la zone de … à … », borne abrégée", () => {
  assert.deepEqual(
    cited("la zone 4 141–4 150 reste au-dessus").map((c) => [c.raw, c.low, c.high]),
    [["4 141–4 150", 4141, 4150]],
  );
  assert.deepEqual(
    cited("le support 4 056 - 4 088 tient").map((c) => [c.low, c.high]),
    [[4056, 4088]],
  );
  assert.deepEqual(
    cited("entre 4 056,71 et 4 088,03").map((c) => [c.low, c.high]),
    [[4056.71, 4088.03]],
  );
  assert.deepEqual(
    cited("la zone de 4 040 à 4 050").map((c) => [c.low, c.high]),
    [[4040, 4050]],
  );
  assert.deepEqual(
    cited("vers 4 141–50").map((c) => [c.low, c.high]),
    [[4141, 4150]],
  );
  // Un trajet n'est pas une zone : deux prix.
  assert.deepEqual(
    cited("l'or a monté de 4 000 à 4 120").map((c) => c.low),
    [4000, 4120],
  );
});

test("ce qui n'est pas un prix : heures, pourcentages, dates, longueurs, oscillateurs, ratios", () => {
  const text =
    "Elle est datée de ce soir 18 h 15 à demain 7 h 15, à 11:43:04 ; la variation est de 1,2 %. " +
    "Le 3 novembre, la moyenne simple 200 est à 4 130, l'exponentielle 50 plus bas, et la 200 tient. " +
    "Le RSI 14 est à 68,4 sur 4 heures. Le 0,618 de ton Fibonacci, et 2 pour 1 de gain sur 3 contrats.";
  assert.deepEqual(
    cited(text).map((c) => c.raw),
    ["4 130"],
  );
});

test("le produit nommé en dernier avant le prix", () => {
  const text = "Le Nasdaq recule vers 25 100, mais l'or tient à 4 120. Sur l'argent, 48,20.";
  assert.deepEqual(
    cited(text).map((c) => [c.raw, c.product]),
    [
      ["25 100", "nasdaq"],
      ["4 120", "or"],
      ["48,20", "argent"],
    ],
  );
  assert.equal(productOf("XAUUSD"), "or");
  assert.equal(productOf("NAS100"), "nasdaq");
  assert.equal(productOf("DJ30"), "dow");
  assert.equal(productOf("EURUSD"), "eurusd");
  assert.equal(productOf("ABC"), undefined);
});

test("une citation au bout du texte attend sa suite", () => {
  assert.deepEqual(cited("la zone 4 1", false), []);
  assert.deepEqual(cited("la zone 4 141–", false), []);
  assert.deepEqual(cited("la zone 4 141–4 1", false), []);
  assert.deepEqual(cited("entre 4 056 et", false), []);
  assert.deepEqual(cited("à 4 120,", false), [], "des décimales peuvent suivre");
  assert.deepEqual(
    cited("le plus bas d'hier à 3 919,92, ", false).map((c) => c.raw),
    ["3 919,92"],
    "une virgule suivie d'une espace : complet",
  );
  assert.deepEqual(
    cited("la zone 4 141–4 150 puis", false).map((c) => c.raw),
    ["4 141–4 150"],
  );
  assert.deepEqual(
    cited("la zone 4 141–4 150", true).map((c) => c.raw),
    ["4 141–4 150"],
  );
});

const GOLD: ChartRef = { symbol: "XAUUSD", product: "or", last: 4120.86, digits: 2 };
const NAS: ChartRef = { symbol: "NAS100", product: "nasdaq", last: 25080, digits: 1 };
const EUR: ChartRef = { symbol: "EURUSD", product: "eurusd", last: 1.16523, digits: 5 };
const GBP: ChartRef = { symbol: "GBPUSD", product: "gbpusd", last: 1.31012, digits: 5 };

test("le graphique dont parle le prix : le plus proche, celui du produit nommé, ou aucun", () => {
  const one = (text: string, charts: ChartRef[]) => findPrices(text).map((m) => chartFor(m, charts) ?? null);
  assert.deepEqual(one("4 130, puis 25 100", [GOLD, NAS]), ["XAUUSD", "NAS100"]);
  assert.deepEqual(one("environ 44 dollars de risque pour 88 de gain", [GOLD]), [null, null], "trop loin du prix de l'or");
  assert.deepEqual(one("1,1650 puis 1,3050", [EUR, GBP]), ["EURUSD", "GBPUSD"]);
  // La phrase parle du DAX, qui n'est pas affiché : le Nasdaq ne s'allume pas, même si le prix est proche.
  assert.deepEqual(one("le DAX bute sur 24 100", [NAS]), [null]);
  assert.deepEqual(one("le Nasdaq bute sur 24 100", [NAS]), ["NAS100"]);
  // Plus de décimales que le graphique n'en a : pas ce produit.
  assert.deepEqual(one("à 4,12086", [GOLD]), [null]);
});

test("ce qui est au prix cité sur le graphique : ligne, bord de zone, zone, ou rien", () => {
  const levels = [
    { key: "zone-haute", top: 4150.6, bottom: 4141.2 },
    { key: "mm200", price: 4130.19 },
    { key: "mme200", price: 4119.91 },
    { key: "support", top: 4088.03, bottom: 4056.71 },
    { key: "entrée", price: 4072.42 },
    { key: "oblique", price: 4012.3 },
  ];
  const at = (low: number, high = low, decimals = 0) => matchLevel({ low, high, decimals }, levels)?.key ?? null;
  assert.equal(at(4130), "mm200");
  assert.equal(at(4120), "mme200");
  assert.equal(at(4141, 4150), "zone-haute", "la zone citée a les bornes de la zone tracée");
  assert.equal(at(4150), "zone-haute", "un bord de la zone");
  assert.equal(at(4072.42, 4072.42, 2), "entrée", "une ligne exacte l'emporte sur la zone qui la contient");
  assert.equal(at(4080), "support", "à l'intérieur de la zone, faute de ligne");
  assert.equal(at(4010), "oblique", "un prix rond est approché");
  assert.equal(at(4158), null, "rien à ce prix : ligne temporaire");
  assert.equal(at(4040, 4050), null, "aucune zone tracée à ces bornes");
});

test("le suivi : chaque prix une fois, dès son premier chiffre affiché ; rien après une coupure", () => {
  const full = "Le rebond doit passer 4 130, puis la zone 4 141–4 150. En dessous, 4 056.";
  const t = new PriceTracker();
  assert.deepEqual(t.feed("Le rebond doit passer", full, false), []);
  assert.deepEqual(
    t.feed("Le rebond doit passer 4", full, false).map((m) => m.low),
    [4130],
  );
  assert.deepEqual(t.feed("Le rebond doit passer 4 130, puis", full, false), [], "déjà allumé");
  assert.deepEqual(
    t.feed(full.slice(0, 50), full, false).map((m) => [m.low, m.high]),
    [[4141, 4150]],
  );
  t.skip(full);
  assert.deepEqual(t.feed(full, full, true), [], "coupé : le reste s'affiche sans s'allumer");
  t.reset();
  assert.equal(t.feed(full, full, true).length, 3);
});
