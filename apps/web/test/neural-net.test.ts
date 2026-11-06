import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANCHOR_LEAVE_MS,
  Anchor,
  LEAVE_MS,
  MAX_BLOCKS,
  MAX_STEPS,
  blockSpot,
  metaOf,
  NetModel,
  NetNode,
  rgba,
  syncAnchors,
  syncNodes,
  targetOf,
  treeParent,
  treeSpot,
} from "../src/app/neural/neural-net";

const job = (id: string, state: string, steps = 0, extra: Partial<NetModel["jobs"][number]> = {}) => ({
  id,
  name: id,
  kind: "task" as const,
  state,
  steps,
  ...extra,
});

test("trois projets en même temps : trois neurones, chacun à sa place", () => {
  const nodes = new Map<string, NetNode>();
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("Kopilia", "running"), job("Clients", "running"), job("Site", "awaiting_approval")] }, 0);
  assert.deepEqual([...nodes.keys()], ["Kopilia", "Clients", "Site"]);
  const places = [...nodes.values()].map((n) => targetOf(n, 600, 400, 1200, 800));
  assert.equal(new Set(places.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size, 3, "pas deux nœuds au même endroit");
  for (const p of places) assert.ok(Math.hypot(p.x - 600, p.y - 400) > 140, "hors de l'orbe");
});

test("chaque étape d'un agent ajoute un bloc ; fini, il clignote puis s'efface", () => {
  const nodes = new Map<string, NetNode>();
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("a", "running", 0, { kind: "agent" })] }, 0);
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("a", "running", 3, { kind: "agent", lastStep: "Recherche web" })] }, 500);
  const n = nodes.get("a")!;
  assert.deepEqual(n.blocks, [500, 500, 500]);
  assert.equal(metaOf(n), "3 étapes · Recherche web");
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("a", "succeeded", 3)] }, 1000);
  assert.equal(n.outcome, "ok");
  assert.equal(metaOf(n), "Terminé");
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("a", "succeeded", 3)] }, 1000 + LEAVE_MS + 1);
  assert.equal(nodes.size, 0);
});

test("étapes de la réponse : un arbre au-dessus de l'orbe, chacune en déclenche deux", () => {
  const places = Array.from({ length: MAX_STEPS }, (_, slot) => targetOf({ kind: "step", slot }, 600, 400, 1200, 800));
  assert.equal(new Set(places.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size, MAX_STEPS, "pas deux étapes au même endroit");
  for (const p of places) assert.ok(p.y < 400 && Math.hypot(p.x - 600, p.y - 400) > 115, "au-dessus de l'orbe, hors d'elle");
  assert.deepEqual([0, 1, 2, 3, 6].map(treeParent), [-1, 0, 0, 1, 2]);
  for (let k = 1; k < MAX_STEPS; k++) {
    const mother = places[treeParent(k)];
    assert.ok(places[k].y < mother.y - 30, `l'étape ${k} un étage au-dessus de sa mère`);
  }
  // Les deux filles encadrent leur mère.
  assert.ok(places[1].x < places[0].x && places[2].x > places[0].x);
  assert.ok(places[3].x < places[1].x && places[4].x > places[1].x);
});

test("étapes d'un agent : la même arborescence, ouverte vers l'extérieur", () => {
  // Un agent à droite de l'orbe : son arbre s'ouvre vers la droite, chaque étage plus loin.
  const spots = Array.from({ length: MAX_BLOCKS }, (_, k) => blockSpot(k, 1000, 400, 0));
  assert.ok(
    spots.every((p) => p.x > 1000),
    "du côté opposé à l'orbe",
  );
  assert.deepEqual(
    [0, 1, 3, 7].map((k) => treeSpot(k).depth),
    [0, 1, 2, 3],
  );
  assert.ok(Math.hypot(spots[7].x - 1000, spots[7].y - 400) < 80, "assez serré pour rester près de l'astre");
  assert.equal(new Set(spots.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size, MAX_BLOCKS);
});

test("un travail jamais vu en cours n'apparaît pas ; un échec est rouge", () => {
  const nodes = new Map<string, NetNode>();
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("vieux", "succeeded", 4)] }, 0);
  assert.equal(nodes.size, 0);
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("b", "running")] }, 0);
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("b", "failed")] }, 10);
  assert.equal(nodes.get("b")!.outcome, "fail");
  assert.equal(metaOf(nodes.get("b")!), "Échec");
});

test("étapes de la réponse : visibles pendant que Kopilia réfléchit, les plus récentes seulement", () => {
  const nodes = new Map<string, NetNode>();
  const steps = Array.from({ length: MAX_STEPS + 2 }, (_, i) => ({ id: `t:${i}`, label: `Étape ${i}` }));
  syncNodes(nodes, { busy: true, steps, jobs: [] }, 0);
  const shown = [...nodes.values()].filter((n) => n.kind === "step");
  assert.equal(shown.length, MAX_STEPS);
  assert.equal(shown[0].name, "Étape 2");
  syncNodes(nodes, { busy: false, steps, jobs: [] }, 100);
  assert.ok(
    shown.every((n) => n.leaving === 100),
    "la réponse finie, elles s'effacent",
  );
});

test("un nœud qui part libère sa place pour le suivant, sans déplacer les autres", () => {
  const nodes = new Map<string, NetNode>();
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("x", "running"), job("y", "running")] }, 0);
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("x", "succeeded"), job("y", "running")] }, 10);
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("x", "succeeded"), job("y", "running")] }, 10 + LEAVE_MS + 1);
  syncNodes(nodes, { busy: false, steps: [], jobs: [job("y", "running"), job("z", "running")] }, 5000);
  assert.equal(nodes.get("y")!.slot, 1);
  assert.equal(nodes.get("z")!.slot, 0);
});

test("en attente d'accord : il le dit", () => {
  assert.equal(metaOf({ kind: "task", state: "awaiting_approval", blocks: [], outcome: undefined }), "En attente d'accord");
  assert.equal(metaOf({ kind: "agent", state: "running", blocks: [], outcome: undefined }), "Agent · démarrage");
});

test("encarts du tableau de bord : un fil chacun, qui suit l'encart et s'efface quand il se ferme", () => {
  const anchors = new Map<string, Anchor>();
  syncAnchors(anchors, [{ id: "p_1", x: 300, y: 200 }], 0);
  syncAnchors(
    anchors,
    [
      { id: "p_1", x: 320, y: 210 },
      { id: "p_2", x: 900, y: 200 },
    ],
    100,
  );
  assert.deepEqual(
    [...anchors.values()].map((a) => [a.id, a.x, a.born]),
    [
      ["p_1", 320, 0],
      ["p_2", 900, 100],
    ],
  );
  syncAnchors(anchors, [{ id: "p_2", x: 900, y: 200 }], 200);
  assert.equal(anchors.get("p_1")?.leaving, 200, "fermé : il s'efface");
  syncAnchors(anchors, [{ id: "p_2", x: 900, y: 200 }], 200 + ANCHOR_LEAVE_MS + 1);
  assert.deepEqual([...anchors.keys()], ["p_2"]);
});

test("couleur du thème avec opacité", () => {
  assert.equal(rgba("#5b8cff", 0.4), "rgba(91,140,255,0.400)");
  assert.equal(rgba("#fff", 2), "rgba(255,255,255,1.000)");
});
