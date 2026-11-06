import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseService } from "../src/db/database.service.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { tempData, type TempData } from "./harness.js";

let data: TempData;
let db: DatabaseService;
let mem: MemoryService;

before(() => {
  data = tempData("mem");
  db = data.db;
  mem = new MemoryService(db, data.config);
});

after(() => data?.cleanup());

test("sauvegarde et recherche FTS d'un souvenir personnel", () => {
  mem.save({ scope: "personal", kind: "preference", content: "Je préfère les réponses courtes en français", provenance: "instruction" });
  const hits = mem.search("réponses courtes");
  assert.ok(hits.length >= 1);
  assert.match(hits[0].content, /réponses courtes/);
});

test("isolation entre projets", () => {
  mem.save({ scope: "project", projectId: "proj_a", kind: "decision", content: "Atlas utilise SQLite", provenance: "turn:1" });
  mem.save({ scope: "project", projectId: "proj_b", kind: "decision", content: "Borealis utilise Postgres", provenance: "turn:2" });
  const a = mem.search("utilise", { scope: "project", projectId: "proj_a" });
  assert.ok(a.every((r) => r.project_id === "proj_a"));
  assert.ok(a.some((r) => /SQLite/.test(r.content)));
});

test("remplacement puis oubli", () => {
  const v1 = mem.save({ scope: "personal", kind: "topic", content: "Suivre le Nasdaq", provenance: "turn:3" });
  const v2 = mem.save({ scope: "personal", kind: "topic", content: "Suivre le Nasdaq et le Gold", provenance: "turn:4", supersedesId: v1.id });
  const active = mem.list("personal", null).filter((r) => r.content.includes("Nasdaq"));
  assert.ok(active.some((r) => r.id === v2.id));
  assert.ok(!active.some((r) => r.id === v1.id)); // v1 superseded
  assert.equal(mem.forget(v2.id), true);
  const after = mem.search("Gold");
  assert.ok(!after.some((r) => r.id === v2.id)); // index purgé
});

test("carnet de trader dicté : ajouté, doublon rendu tel quel, règle changée remplacée, oubliée ; le profil n'est pas touché", () => {
  const swing = mem.dictate("trading", "Considère comme swing une entrée en 1 heure ou 4 heures.", { provenance: "session:s1" });
  assert.equal(swing.row.scope, "trading");
  assert.equal(swing.replaced, undefined);
  mem.dictate("trading", "Considère comme intraday une entrée en 15 minutes.", { provenance: "session:s1" });
  assert.equal(
    mem.dictate("trading", "Considère comme swing une entrée en 1 heure ou 4 heures.", { provenance: "session:s1" }).row.id,
    swing.row.id,
    "doublon",
  );

  // Il change sa définition du swing : l'ancienne est remplacée, l'intraday reste.
  const daily = mem.dictate("trading", "Considère comme swing une entrée en 1 heure, 4 heures ou daily.", { provenance: "session:s2", replaces: "swing" });
  assert.equal(daily.replaced, "Considère comme swing une entrée en 1 heure ou 4 heures.");
  assert.deepEqual(mem.snapshot().trading, [
    "Considère comme intraday une entrée en 15 minutes.",
    "Considère comme swing une entrée en 1 heure, 4 heures ou daily.",
  ]);

  // Rien à remplacer : elle s'ajoute.
  assert.equal(
    mem.dictate("trading", "Ne trade pas pendant les annonces fortes.", { provenance: "session:s2", replaces: "bougie de rejet" }).replaced,
    undefined,
  );

  // Un mot du carnet de trader n'efface rien du profil, et inversement.
  mem.dictate("profile", "Attend ses graphiques en 15 minutes.", { provenance: "session:s2" });
  assert.equal(mem.forgetBest("intraday", "profile"), null);
  assert.equal(mem.forgetBest("intraday", "trading"), "Considère comme intraday une entrée en 15 minutes.");
  assert.ok(mem.snapshot().profile.includes("Attend ses graphiques en 15 minutes."));
  assert.equal(mem.snapshot().trading.length, 2);
});
