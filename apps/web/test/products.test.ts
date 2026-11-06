// La liste de tous ses produits, sans écran : familles, ordre, et ce que fait un clic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayName, groupProducts, listClick, productFamily, productLabel } from "../src/app/dashboard/products";

test("liste des produits : chaque symbole du courtier dans sa famille, suffixe de compte ignoré", () => {
  const families = Object.fromEntries(
    [
      "COPPER",
      "XAGUSD",
      "USOIL",
      "PLATINUM",
      "XAUUSD",
      "XAUUSD.i",
      "UKBRENT",
      "GAS",
      "NAS100",
      "SP500",
      "DJ30",
      "VIXIndex",
      "USDIndex",
      "EURUSD",
      "EURUSD.i",
      "NZDJPY",
      "GBPAUD",
      "BTCUSD",
      "CL.NYS",
    ].map((s) => [s, productFamily(s)]),
  );
  assert.deepEqual(families, {
    COPPER: "Matières premières",
    XAGUSD: "Matières premières",
    USOIL: "Matières premières",
    PLATINUM: "Matières premières",
    XAUUSD: "Matières premières",
    "XAUUSD.i": "Matières premières",
    UKBRENT: "Matières premières",
    GAS: "Matières premières",
    NAS100: "Indices",
    SP500: "Indices",
    DJ30: "Indices",
    VIXIndex: "Indices",
    USDIndex: "Indices",
    EURUSD: "Devises",
    "EURUSD.i": "Devises",
    NZDJPY: "Devises",
    GBPAUD: "Devises",
    BTCUSD: "Cryptos",
    "CL.NYS": "Autres",
  });
});

test("liste des produits : familles dans l'ordre où sa liste les fait paraître, produits à leur rang", () => {
  const p = (symbol: string) => ({ symbol, name: symbol.toLowerCase() });
  const groups = groupProducts(["COPPER", "NAS100", "EURUSD", "XAUUSD", "SP500", "GBPUSD"].map(p));
  assert.deepEqual(
    groups.map((g) => [g.family, g.products.map((x) => x.symbol)]),
    [
      ["Matières premières", ["COPPER", "XAUUSD"]],
      ["Indices", ["NAS100", "SP500"]],
      ["Devises", ["EURUSD", "GBPUSD"]],
    ],
  );
  assert.equal(displayName("or"), "Or");
  assert.equal(displayName("euro-dollar"), "Euro-dollar");
  assert.equal(displayName("S&P 500"), "S&P 500");
  assert.equal(productLabel({ symbol: "NZDCAD", name: "dollar néo-zélandais contre dollar canadien" }), "NZD/CAD", "une paire : son code");
  assert.equal(productLabel({ symbol: "EURUSD.i", name: "euro-dollar" }), "EUR/USD", "sans le suffixe du compte");
  assert.equal(productLabel({ symbol: "XAUUSD", name: "or" }), "Or", "l'or n'est pas une paire de devises");
});

test("liste des produits : un clic montre son graphique, sinon change celui de la liste, sinon en ouvre un ; ⌘ en ouvre toujours un", () => {
  const charts = [
    { id: "p_or", symbol: "XAUUSD" },
    { id: "p_liste", symbol: "NAS100" },
  ];
  assert.deepEqual(listClick("XAUUSD", charts, "p_liste", false), { action: "front", id: "p_or" }, "déjà affiché : il passe devant");
  assert.deepEqual(listClick("XAUUSD", charts, "p_liste", true), { action: "front", id: "p_or" }, "même avec ⌘ : un seul graphique par produit");
  assert.deepEqual(
    listClick("EURUSD", charts, "p_liste", false),
    { action: "switch", id: "p_liste" },
    "comme TradingView : le graphique de la liste change de produit",
  );
  assert.deepEqual(listClick("EURUSD", charts, "p_liste", true), { action: "open" }, "⌘ : à part");
  assert.deepEqual(listClick("EURUSD", charts, "p_ferme", false), { action: "open" }, "le graphique de la liste a été fermé");
  assert.deepEqual(listClick("EURUSD", charts, null, false), { action: "open" });
});
