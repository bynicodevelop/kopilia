import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TIP_W, chartTips, tipLeft } from "../src/app/dashboard/chart-tips";

test("bulles des outils : chaque outil de la barre a la sienne, avec son groupe, et la touche de l'aimant", () => {
  const tips = chartTips("⌘");
  // Le paquet web est en CommonJS pour tsx : __dirname, pas import.meta.
  const template = readFileSync(resolve(__dirname, "../src/app/dashboard/chart-panel.component.ts"), "utf8");
  const used = [...template.matchAll(/data-tip="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), Object.keys(tips).sort(), "un outil sans bulle, ou une bulle sans outil");
  for (const [key, tip] of Object.entries(tips)) {
    assert.ok(tip.title && tip.text.length > 30, key);
  }
  assert.match(tips.magnet.text, /⌘ maintenu/);
  assert.equal(tips.indicators.group, "Indicateurs");
  assert.equal(tips.ai.group, "IA");
  assert.equal(tips.zone.group, "Objet");
});

test("bulles des outils : centrées sur le bouton, gardées dans l'encart", () => {
  assert.equal(tipLeft(400, 800), 400 - TIP_W / 2);
  assert.equal(tipLeft(20, 800), 4, "contre le bord gauche");
  assert.equal(tipLeft(790, 800), 800 - TIP_W - 4, "contre le bord droit");
});
