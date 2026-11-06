// L'encart Activité, sans écran : les travaux lus sur le serveur, complétés par ceux de cet écran, et leurs résultats lisibles.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityItem } from "@kopilia/contracts";
import { activityRows, readable } from "../src/app/jobs/activity";

const done: ActivityItem = {
  jobId: "j_1",
  state: "succeeded" as ActivityItem["state"],
  kind: "agent",
  title: "Euro-yen",
  summary: "Structure acheteuse.",
  createdAt: 1,
  updatedAt: 10,
};
const old: ActivityItem = { ...done, jobId: "j_0", title: "Cinéma", updatedAt: 5 };

test("activité : les travaux en cours d'abord, l'état de cet écran l'emporte, un travail qui démarre apparaît aussitôt", () => {
  const rows = activityRows(
    [done, old],
    [
      { jobId: "j_0", state: "running", lastStep: "Recherche sur le web" },
      { jobId: "j_2", state: "queued", kind: "task", title: "Corriger le test", folder: "Kopilia" },
      { jobId: "j_9", state: "succeeded", title: "Ancien, absent du serveur" },
    ],
    100,
  );
  assert.deepEqual(
    rows.map((r) => [r.jobId, r.state]),
    [
      ["j_2", "queued"],
      ["j_0", "running"],
      ["j_1", "succeeded"],
    ],
  );
  assert.equal(rows[1].lastStep, "Recherche sur le web");
  assert.equal(rows[0].kind, "task");
  assert.equal(rows[0].folder, "Kopilia");
});

test("activité : le résultat complet du serveur n'est pas remplacé par un résumé plus court", () => {
  const rows = activityRows([{ ...done, summary: "Résultat complet, bien plus long." }], [{ jobId: "j_1", state: "succeeded", summary: "Court" }]);
  assert.equal(rows[0].summary, "Résultat complet, bien plus long.");
});

test("activité : un résultat se lit sans marques Markdown, ses lignes gardées", () => {
  assert.equal(readable("# Euro-yen\n\n**Biais** : acheteur\n- 177,71\n- `178`\n\n\n> fin"), "Euro-yen\n\nBiais : acheteur\n• 177,71\n• 178\n\nfin");
});
