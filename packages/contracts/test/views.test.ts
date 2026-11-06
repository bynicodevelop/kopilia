// Le catalogue des vues : ce que Kopilia peut envoyer, ce qui est gardé, et ce qui est refusé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_VIEW_BLOCKS, VIEW_CATALOG, viewBlockInputSchema, viewBlockSummary, viewSpecSchema, viewSymbols } from "../src/views.js";

const gold = { symbol: "XAUUSD", name: "or", digits: 2 };

test("vues : une vue gardée, ses produits suivis en direct, son résumé", () => {
  const spec = viewSpecSchema.parse({
    blocks: [
      { type: "heading", text: "Métaux" },
      { type: "quotes", products: [gold, { symbol: "XAGUSD", name: "argent" }] },
      { type: "sparkline", product: gold, timeframe: "1h", bars: 48 },
      {
        type: "table",
        columns: ["Niveau", "Rôle"],
        rows: [
          ["4 021", "support"],
          ["4 050", "résistance"],
        ],
      },
      { type: "setups", product: gold, states: ["waiting"] },
      { type: "brief" },
    ],
  });
  assert.deepEqual(viewSymbols(spec), ["XAUUSD", "XAGUSD", "XAUUSD"]);
  assert.deepEqual(spec.blocks.map(viewBlockSummary), [
    "titre « Métaux »",
    "cours de or, argent",
    "courbe or 1h",
    "tableau 2 × 2",
    "setups de or",
    "dernier brief",
  ]);
});

test("vues : un genre inconnu, un tableau bancal, trop de blocs ou du code ne passent pas", () => {
  assert.equal(viewBlockInputSchema.safeParse({ type: "html", html: "<script>alert(1)</script>" }).success, false, "pas de bloc HTML");
  const bad = viewBlockInputSchema.safeParse({ type: "table", columns: ["a", "b", "c"], rows: [["1", "2"]] });
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0].message, /2 cases pour 3 colonnes/);
  const many = Array.from({ length: MAX_VIEW_BLOCKS + 1 }, () => ({ type: "brief" }));
  assert.equal(viewSpecSchema.safeParse({ blocks: many }).success, false);
  assert.equal(viewSpecSchema.safeParse({ blocks: [] }).success, false, "une vue vide n'a pas de sens");
  // Un texte qui ressemble à du HTML reste un texte : il est gardé tel quel, l'écran l'affiche comme du texte.
  assert.equal(viewBlockInputSchema.safeParse({ type: "text", text: "<b>gras</b>" }).success, true);
});

test("vues : chaque genre du catalogue a sa forme envoyée, et les blocs vivants sont marqués", () => {
  const live = Object.entries(VIEW_CATALOG)
    .filter(([, c]) => c.live)
    .map(([t]) => t);
  assert.deepEqual(live, ["quotes", "sparkline", "calendar", "setups", "hypotheses", "brief"]);
  const minimal: Record<string, unknown> = {
    heading: { text: "x" },
    text: { text: "x" },
    stat: { label: "x", value: "1" },
    table: { columns: ["a"], rows: [["1"]] },
    list: { items: [{ text: "x" }] },
    quotes: { symbols: ["or"] },
    sparkline: { symbol: "or" },
    calendar: {},
    setups: {},
    hypotheses: {},
    brief: {},
  };
  for (const type of Object.keys(VIEW_CATALOG)) {
    const r = viewBlockInputSchema.safeParse({ type, ...(minimal[type] as object) });
    assert.equal(r.success, true, `${type} : ${r.success ? "" : r.error.message}`);
  }
});
