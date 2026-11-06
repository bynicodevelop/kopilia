// Caractérisation de ClaudeProcess sur des traces stream-json rejouées :
// deltas, frontières de blocs, repli sans flux, outils, erreurs, file de tours,
// crash en plein tour. Ces comportements doivent survivre à toute refonte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TurnOutcome } from "@kopilia/contracts";
import { ClaudeProcess } from "../src/session/claude-process.js";
import type { AppLogger } from "../src/common/logger.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const BIN = resolve(REPO, "workers/_doubles/replay-claude.mjs");

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const blockStart = (type: string, name?: string) => ({ type: "stream_event", event: { type: "content_block_start", content_block: { type, name } } });
const blockStop = { type: "stream_event", event: { type: "content_block_stop" } };
const result = (text: string, isError = false) => ({
  type: "result",
  subtype: isError ? "error" : "success",
  is_error: isError,
  result: text,
  session_id: "replay-1",
});

function replay(turns: unknown[], warns: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "kopilia-replay-"));
  const file = join(dir, "trace.json");
  writeFileSync(file, JSON.stringify(turns));
  const logger = { warn: (m: string) => warns.push(m), debug() {}, log() {}, error() {} } as unknown as AppLogger;
  const p = new ClaudeProcess({ bin: BIN, cwd: tmpdir(), extraArgs: ["--replay", file], logger });
  p.start();
  return { p, done: () => (p.stop(), rmSync(dir, { recursive: true, force: true })) };
}

test("trace : deltas assemblés, frontière de bloc = saut de ligne, réponse finale à part", async () => {
  const { p, done } = replay([
    [blockStart("text"), delta("Je regarde"), delta(" ça."), blockStop, blockStart("text"), delta("Voilà."), blockStop, result("Voilà.")],
  ]);
  const deltas: string[] = [];
  const r = await p.sendTurn("question", (t) => deltas.push(t));
  done();
  assert.deepEqual(deltas, ["Je regarde", " ça.", "\n", "Voilà.", "\n"]);
  assert.equal(r.text, "Je regarde ça.\nVoilà.\n");
  assert.equal(r.final, "Voilà.");
  assert.equal(r.outcome, TurnOutcome.Success);
  assert.equal(p.sessionId, "replay-1");
});

test("trace : sans flux partiel, repli sur le message complet de l'assistant", async () => {
  const { p, done } = replay([[{ type: "assistant", message: { content: [{ type: "text", text: "Réponse entière." }] } }, result("Réponse entière.")]]);
  const deltas: string[] = [];
  const r = await p.sendTurn("question", (t) => deltas.push(t));
  done();
  assert.deepEqual(deltas, ["Réponse entière."]);
  assert.equal(r.text, "Réponse entière.");
});

test("trace : outils signalés (étape, appel, résultat en erreur)", async () => {
  const { p, done } = replay([
    [
      blockStart("tool_use", "WebSearch"),
      blockStop,
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "BCE" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "délai dépassé" }] }] } },
      delta("Rien trouvé."),
      result("Rien trouvé."),
    ],
  ]);
  const steps: string[] = [];
  const uses: unknown[] = [];
  const results: unknown[] = [];
  p.on("tool.use", (u) => uses.push(u));
  p.on("tool.result", (r) => results.push(r));
  const r = await p.sendTurn(
    "cherche",
    () => {},
    (name) => steps.push(name),
  );
  done();
  assert.deepEqual(steps, ["WebSearch"]);
  assert.deepEqual(uses, [{ id: "t1", name: "WebSearch", input: { query: "BCE" } }]);
  assert.deepEqual(results, [{ id: "t1", isError: true, text: "délai dépassé" }]);
  assert.equal(r.text, "Rien trouvé.", "pas de saut de ligne ajouté quand rien n'a encore été dit");
});

test("trace : result en erreur, issue « error »", async () => {
  const { p, done } = replay([[delta("Oups"), result("échec", true)]]);
  const r = await p.sendTurn("question", () => {});
  done();
  assert.equal(r.outcome, TurnOutcome.Error);
  assert.equal(r.final, "échec");
});

test("trace : ligne illisible ignorée et signalée, le tour continue", async () => {
  const warns: string[] = [];
  const { p, done } = replay([["pas du json", delta("OK"), result("OK")]], warns);
  const r = await p.sendTurn("question", () => {});
  done();
  assert.equal(r.text, "OK");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /non-JSON/);
});

test("trace : deux tours en file, traités dans l'ordre", async () => {
  const { p, done } = replay([
    [delta("un"), result("un")],
    [delta("deux"), result("deux")],
  ]);
  const [a, b] = await Promise.all([p.sendTurn("1", () => {}), p.sendTurn("2", () => {})]);
  done();
  assert.equal(a.final, "un");
  assert.equal(b.final, "deux");
});

test("trace : le processus quitte en plein tour, le tour et la file sont rejetés", async () => {
  const { p, done } = replay([{ exit: 3 }]);
  const exits: unknown[] = [];
  p.on("exit", (e) => exits.push(e));
  const first = p.sendTurn("1", () => {});
  const queued = p.sendTurn("2", () => {});
  await assert.rejects(first, /claude a quitté \(code=3/);
  await assert.rejects(queued, /claude a quitté/);
  done();
  assert.deepEqual(exits, [{ code: 3, signal: null }]);
});

test("lancement impossible (binaire absent) : le tour est rejeté, l'erreur et la fin signalées", { timeout: 5_000 }, async () => {
  const logger = { warn() {}, debug() {}, log() {}, error() {} } as unknown as AppLogger;
  const p = new ClaudeProcess({ bin: "/chemin/inexistant/claude", cwd: tmpdir(), logger });
  const fatal: Error[] = [];
  const exits: unknown[] = [];
  p.on("fatal", (e) => fatal.push(e));
  p.on("exit", (e) => exits.push(e));
  p.start();
  await assert.rejects(
    p.sendTurn("bonjour", () => {}),
    /ENOENT|introuvable|lancer/,
  );
  assert.equal(fatal.length, 1);
  assert.equal(exits.length, 1, "la fin est signalée une fois : le propriétaire oublie ce processus");
  p.stop();
});

test("tour demandé après l'arrêt : rejeté tout de suite", { timeout: 5_000 }, async () => {
  const { p, done } = replay([[delta("un"), result("un")]]);
  await p.sendTurn("1", () => {});
  p.stop();
  await assert.rejects(
    p.sendTurn("2", () => {}),
    /arrêté|quitté/,
  );
  done();
});
