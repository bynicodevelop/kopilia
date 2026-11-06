// WorkerLink : le lien NDJSON vers les workers voix (whisper, Kokoro).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppLogger } from "../src/common/logger.js";
import { WorkerLink } from "../src/voice/worker-link.js";

const WORKER = resolve(import.meta.dirname, "doubles/worker.mjs");

function link(flags: string[], opts: { maxRestarts?: number } = {}) {
  const logs: string[] = [];
  const logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug() {}, log() {} } as unknown as AppLogger;
  const l = new WorkerLink({ name: "test", command: ["node", WORKER, ...flags], logger, restartDelayMs: 20, ...opts });
  const events: Array<Record<string, unknown>> = [];
  l.on("event", (e) => events.push(e as Record<string, unknown>));
  return { l, events, logs };
}

test("lien worker : événements lus ligne à ligne, même coupés en morceaux ; ligne illisible ignorée", async () => {
  const { l, events, logs } = link(["--split"]);
  l.start();
  await sleep(300);
  l.stop();
  assert.deepEqual(
    events.map((e) => e.type),
    ["ready", "split"],
  );
  assert.equal(logs.filter((m) => /non-JSON/.test(m)).length, 1);
});

test("lien worker : un message envoyé revient (aller-retour)", async () => {
  const { l, events } = link([]);
  l.start();
  await sleep(150);
  assert.equal(l.send({ type: "ping" }), true);
  await sleep(100);
  l.stop();
  assert.deepEqual(events.at(-1), { type: "echo", line: { type: "ping" } });
});

test("lien worker : crash, relances bornées puis abandon", async () => {
  const { l, events, logs } = link(["--crash"], { maxRestarts: 2 });
  const downs: unknown[] = [];
  l.on("down", (d) => downs.push(d));
  l.start();
  await sleep(1_200);
  l.stop();
  assert.equal(events.filter((e) => e.type === "ready").length, 3, "lancement + 2 relances");
  assert.equal(downs.length, 3);
  assert.ok(logs.some((m) => /relances épuisées/.test(m)));
});

test("lien worker : pendant la panne, un envoi échoue sans exception", async () => {
  const { l } = link(["--die-on-input"], { maxRestarts: 0 });
  l.start();
  await sleep(150);
  assert.equal(l.send({ type: "x" }), true);
  await sleep(200);
  assert.equal(l.send({ type: "y" }), false, "worker mort : l'envoi est refusé, rien n'est écrit");
  l.stop();
});

test("lien worker : arrêté pendant l'attente d'une relance, il ne repart pas", async () => {
  const { l, events } = link(["--crash"], { maxRestarts: 3 });
  l.start();
  await sleep(120);
  l.stop();
  const ready = events.filter((e) => e.type === "ready").length;
  await sleep(400);
  assert.equal(events.filter((e) => e.type === "ready").length, ready, "aucun lancement après stop()");
});

test("lien worker : une demi-ligne d'avant le crash ne se recolle pas à la suivante", async () => {
  const { l, events, logs } = link(["--half"], { maxRestarts: 1 });
  l.start();
  await sleep(250);
  l.stop();
  assert.deepEqual(events, [], "aucune ligne reconstituée à partir de deux processus");
  assert.equal(logs.filter((m) => /non-JSON/.test(m)).length, 0);
});
