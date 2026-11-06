import { test } from "node:test";
import assert from "node:assert/strict";
import type { NewsItem } from "@kopilia/contracts";
import { figureText, mergeNews, pct, reactionText } from "../src/app/news/news";

const item = (id: string, at: number, symbols: string[] = [], extra: Partial<NewsItem> = {}): NewsItem => ({
  id,
  at,
  title: `Titre ${id}`,
  original: `Title ${id}`,
  translated: true,
  symbols,
  level: "medium",
  ...extra,
});

test("news : celles du serveur et celles du direct, sans doublon, les plus récentes d'abord, filtrées par produit", () => {
  const loaded = [item("a", 1000, ["XAUUSD"]), item("b", 3000, ["NAS100"])];
  const live = [item("c", 2000, ["XAUUSD"]), item("a", 1000, ["XAUUSD"], { title: "Titre a traduit" })];
  const all = mergeNews(loaded, live);
  assert.deepEqual(
    all.map((n) => n.id),
    ["b", "c", "a"],
  );
  assert.equal(all[2].title, "Titre a traduit");
  assert.deepEqual(
    mergeNews(loaded, live, "XAUUSD").map((n) => n.id),
    ["c", "a"],
  );
  assert.equal(mergeNews(loaded, live, undefined, 2).length, 2);
  // Une news qui a fait bouger le produit compte pour lui, même s'il n'était pas cité.
  const moved = item("d", 4000, [], { reaction: { symbol: "XAUUSD", name: "or", changePct: 0.4, strength: 5, minutes: 2 } });
  assert.equal(mergeNews([], [moved], "XAUUSD").length, 1);
});

test("news : les textes de la réaction et du chiffre publié", () => {
  assert.equal(pct(-0.4234), "−0,42 %");
  assert.equal(reactionText({ symbol: "XAUUSD", name: "or", changePct: 0.42, strength: 5, minutes: 2 }), "Or +0,42 % en 2 min");
  assert.equal(
    figureText({
      event: "US Initial Jobless Claims",
      actual: "189k",
      forecast: "196k",
      previous: "194k",
      revised: "195K",
      calendar: { title: "Unemployment Claims", country: "USD", impact: "high", forecast: "197K" },
    }),
    "Publié 189k · attendu 196k · précédent 194k (révisé 195K) · calendrier : Unemployment Claims, impact fort, consensus 197K",
  );
});
