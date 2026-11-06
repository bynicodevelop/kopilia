import { test } from "node:test";
import assert from "node:assert/strict";
import { contactVerdict } from "../src/alerts.js";

test("bougie du contact : rejet si elle clôture du côté d'où venait le prix ; dans la zone ; cassure de l'autre côté", () => {
  // Support 3 940 – 3 950, prix venu d'en haut.
  assert.equal(contactVerdict(3955, 3940, 3950, "down"), "rejection");
  assert.equal(contactVerdict(3945, 3940, 3950, "down"), "inside");
  assert.equal(contactVerdict(3950, 3940, 3950, "down"), "inside", "clôture sur le bord : pas encore revenue");
  assert.equal(contactVerdict(3935, 3940, 3950, "down"), "break");
  // Résistance (une ligne à 3 950), prix venu d'en bas.
  assert.equal(contactVerdict(3946, 3950, 3950, "up"), "rejection");
  assert.equal(contactVerdict(3950, 3950, 3950, "up"), "inside");
  assert.equal(contactVerdict(3952, 3950, 3950, "up"), "break");
});
