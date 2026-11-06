// La file des rapports : Kopilia ne coupe jamais la conversation pour rapporter un résultat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { ReportQueue } from "../src/gateway/report-queue.js";
import type { Conn } from "../src/gateway/conn.js";
import type { Report } from "../src/gateway/messages.js";

const conn = (sessionId = "s1") => ({ sessionId }) as Conn;
const report = (turnId: string): Report => ({ turnId, jobId: turnId, title: turnId, prompt: "" });

function queue(state: { busy?: boolean; alive?: boolean } = {}) {
  const said: string[] = [];
  const q = new ReportQueue({ busy: () => !!state.busy, alive: () => state.alive ?? true, run: (_c, r) => said.push(r.turnId) }, 10);
  return { q, said };
}

test("rapports : dits après un court repos, un par un, sans doublon", async () => {
  const { q, said } = queue();
  const c = conn();
  q.add(c, report("a"));
  q.add(c, report("a"));
  q.add(c, report("b"));
  assert.deepEqual(said, [], "jamais tout de suite");
  await sleep(30);
  assert.deepEqual(said, ["a"], "un seul à la fois");
  q.schedule(c); // la passerelle relance à la fin du tour du rapport
  await sleep(30);
  assert.deepEqual(said, ["a", "b"]);
});

test("rapports : conversation occupée, le rapport attend la relance suivante", async () => {
  const state = { busy: true };
  const { q, said } = queue(state);
  const c = conn();
  q.add(c, report("a"));
  await sleep(30);
  assert.deepEqual(said, []);
  state.busy = false;
  q.schedule(c);
  await sleep(30);
  assert.deepEqual(said, ["a"]);
});

test("rapports : écran fermé ou serveur arrêté, rien ne part", async () => {
  const gone = queue({ alive: false });
  gone.q.add(conn(), report("a"));
  await sleep(30);
  assert.deepEqual(gone.said, []);

  const stopped = queue();
  const c = conn();
  stopped.q.add(c, report("a"));
  stopped.q.stop();
  await sleep(30);
  stopped.q.add(c, report("b"));
  await sleep(30);
  assert.deepEqual(stopped.said, []);
});

test("rapports : la file appartient à la conversation, pas à l'écran ; abandonnée avec la session", async () => {
  const { q, said } = queue();
  const first = conn("s1");
  q.add(first, report("a"));
  q.forget(first); // la page se recharge
  const second = conn("s1");
  q.schedule(second);
  await sleep(30);
  assert.deepEqual(said, ["a"], "le nouvel écran de la même session le reçoit");
  q.add(second, report("b"));
  q.forget(second);
  q.dropSession("s1");
  q.schedule(conn("s1"));
  await sleep(30);
  assert.deepEqual(said, ["a"]);
});

test("rapports : une alerte passe devant les autres, après les alertes déjà là", async () => {
  const { q, said } = queue();
  const c = conn();
  q.add(c, report("agent"));
  q.add(c, { ...report("alerte1"), urgent: true });
  q.add(c, { ...report("alerte2"), urgent: true });
  assert.deepEqual(
    q.pending("s1").map((r) => r.turnId),
    ["alerte1", "alerte2", "agent"],
  );
  await sleep(30);
  assert.deepEqual(said, ["alerte1"]);
});
