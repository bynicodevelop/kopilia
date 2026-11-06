import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerMessage } from "@kopilia/contracts";
import { ReplyQueue } from "../src/app/call/reply-queue";

const env = { v: 1, eventId: "e", sessionId: "s", ts: 0 };
const delta = (turnId: string, text: string) => ({ ...env, type: "assistant.delta", turnId, seq: 0, text }) as ServerMessage;
const audioStart = (turnId: string, streamId: number) =>
  ({ ...env, type: "audio.start", turnId, streamId, format: { sampleRate: 24000, channels: 1, bitDepth: 16, encoding: "pcm_s16le" } }) as ServerMessage;
const done = (turnId: string) => ({ ...env, type: "assistant.done", turnId, outcome: "success" }) as ServerMessage;
const frame = () => new ArrayBuffer(4);

test("réponse en attente : ses messages et sa voix sont gardés dans l'ordre, ceux de la réponse affichée passent", () => {
  const q = new ReplyQueue();
  q.add({ turnId: "nasdaq", text: "Ouvre le graphique du Nasdaq." });
  assert.equal(q.keep(delta("brief", "Le résumé continue")), false, "la réponse affichée a été retenue");
  assert.equal(q.keep({ ...env, type: "state.changed", state: "thinking" } as ServerMessage), false);
  const voice = frame();
  assert.equal(q.keep(delta("nasdaq", "J'ouvre")), true);
  assert.equal(q.keepFrame(9, frame()), false, "voix d'un flux inconnu retenue");
  assert.equal(q.keep(audioStart("nasdaq", 9)), true);
  assert.equal(q.keepFrame(9, voice), true);
  assert.equal(q.keepFrame(3, frame()), false, "la voix de la réponse affichée a été retenue");
  assert.equal(q.keep(done("nasdaq")), true);

  const next = q.next()!;
  assert.equal(next.text, "Ouvre le graphique du Nasdaq.");
  assert.deepEqual(
    next.backlog.map((m) => (m instanceof ArrayBuffer ? "voix" : m.type)),
    ["assistant.delta", "audio.start", "voix", "assistant.done"],
  );
  assert.equal(next.backlog[2], voice);
  assert.equal(q.size, 0);
  assert.equal(q.keepFrame(9, frame()), false, "à son tour, sa voix doit se jouer, plus être gardée");
});

test("réponses en attente : elles passent dans l'ordre où elles ont été demandées, rapports compris", () => {
  const q = new ReplyQueue();
  q.add({ turnId: "nasdaq", text: "Ouvre le Nasdaq." });
  q.add({ turnId: "agent", report: { title: "Séances du cinéma", briefId: null } });
  q.keep(delta("agent", "L'agent a fini."));
  assert.equal(q.next()!.turnId, "nasdaq");
  const report = q.next()!;
  assert.deepEqual(report.report, { title: "Séances du cinéma", briefId: null });
  assert.equal(report.backlog.length, 1);
  assert.equal(q.next(), undefined);
});

test("« stop » : tout ce qui attendait est oublié, et ses flux de voix sont rendus pour être tus", () => {
  const q = new ReplyQueue();
  q.add({ turnId: "nasdaq", text: "Ouvre le Nasdaq." });
  q.add({ turnId: "or", text: "Et l'or aussi." });
  q.keep(audioStart("nasdaq", 9));
  q.keep(audioStart("or", 10));
  assert.deepEqual(
    q.clear().sort((a, b) => a - b),
    [9, 10],
  );
  assert.equal(q.size, 0);
  assert.equal(q.keep(delta("nasdaq", "J'ouvre")), false);
  assert.equal(q.keepFrame(9, frame()), false);
});
