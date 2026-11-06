// Les vues vues de l'écran, sans Angular : hauteur prévue, heure d'une annonce, courbe, variation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventTime, periodChange, sparkPoints, viewHeight } from "../src/app/views/views";

test("vues : la hauteur prévue suit les blocs, sans dépasser la fenêtre", () => {
  assert.equal(viewHeight(undefined), 58);
  const small = viewHeight({ blocks: [{ type: "heading", text: "x" }, { type: "brief" }] });
  assert.equal(small, 58 + 28 + 8 + 120 + 8);
  const rows = Array.from({ length: 15 }, () => ["a"]);
  const big = { blocks: Array.from({ length: 6 }, () => ({ type: "table" as const, columns: ["a"], rows })) };
  assert.equal(viewHeight(big, 600), 600);
});

test("vues : l'heure d'une annonce, seule aujourd'hui, avec le jour sinon", () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  assert.equal(eventTime(new Date(2026, 10, 4, 16, 0).getTime(), now), "16:00");
  assert.equal(eventTime(new Date(2026, 10, 5, 14, 30).getTime(), now), "jeu. 14:30");
});

test("vues : la courbe tient dans son cadre, la variation a son signe", () => {
  assert.equal(sparkPoints([1], 100, 20), "");
  assert.equal(sparkPoints([1, 2, 3], 102, 22), "1.0,21.0 51.0,11.0 101.0,1.0");
  assert.equal(sparkPoints([5, 5], 12, 12), "1.0,11.0 11.0,11.0", "plate : en bas, sans division par zéro");
  assert.deepEqual(periodChange(100, 101.5), { text: "+1,50 %", sign: 1 });
  assert.deepEqual(periodChange(100, 99), { text: "-1,00 %", sign: -1 });
  assert.equal(periodChange(0, 1), undefined);
});
