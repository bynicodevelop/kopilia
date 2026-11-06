import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { TurnOutcome } from "@kopilia/contracts";
import { ClaudeProcess } from "../src/session/claude-process.js";
import { AppLogger } from "../src/common/logger.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..");

function mockProcess(): ClaudeProcess {
  const p = new ClaudeProcess({ bin: resolve(REPO, "workers/_doubles/mock-claude.mjs"), cwd: tmpdir(), logger: new AppLogger() });
  p.start();
  return p;
}

test("tour normal : succès, et la réponse finale est rapportée à part", async () => {
  const p = mockProcess();
  const r = await p.sendTurn("Bonjour", () => {});
  p.stop();
  assert.equal(r.outcome, TurnOutcome.Success);
  assert.equal(r.final, "Bien reçu : Bonjour");
});

test("étapes : chaque outil appelé pendant le tour est signalé, dans l'ordre", async () => {
  const p = mockProcess();
  const tools: string[] = [];
  const r = await p.sendTurn(
    "[étapes 3] cherche",
    () => {},
    (name) => tools.push(name),
  );
  p.stop();
  assert.equal(r.final, "Terminé en 3 étapes.");
  assert.deepEqual(tools, ["WebSearch", "WebFetch", "Read"]);
});

test("tour interrompu : issue « interrupted », pas « error »", async () => {
  const p = mockProcess();
  const turn = p.sendTurn("[lent] Une longue réponse", () => {});
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(p.interrupt(), true);
  const r = await turn;
  p.stop();
  assert.equal(r.outcome, TurnOutcome.Interrupted);
});

test("tour interrompu : les tours en attente derrière lui ne partent pas, ceux d'après si", async () => {
  const p = mockProcess();
  const first = p.sendTurn("[lent] Une longue réponse", () => {});
  const queued = p.sendTurn("Ouvre le Nasdaq", () => {});
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(p.interrupt(), true);
  assert.equal((await first).outcome, TurnOutcome.Interrupted);
  assert.deepEqual(await queued, { text: "", outcome: TurnOutcome.Interrupted }, "le tour en attente est parti quand même");
  const after = await p.sendTurn("Bonjour", () => {});
  p.stop();
  assert.equal(after.final, "Bien reçu : Bonjour");
});
