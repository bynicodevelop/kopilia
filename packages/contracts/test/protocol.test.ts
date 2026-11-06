import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryKind, decodeBinaryFrame, encodeBinaryFrame, parseClientMessage, safeParseClientMessage, serverMessage, PROTOCOL_VERSION } from "../src/index.js";

test("binary frame roundtrip preserves header and payload", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const frame = encodeBinaryFrame({ kind: BinaryKind.Mic, streamId: 42, seq: 7, final: true }, payload);
  const decoded = decodeBinaryFrame(frame);
  assert.equal(decoded.header.kind, BinaryKind.Mic);
  assert.equal(decoded.header.streamId, 42);
  assert.equal(decoded.header.seq, 7);
  assert.equal(decoded.header.final, true);
  assert.deepEqual([...decoded.payload], [...payload]);
});

test("binary frame rejects a bad magic", () => {
  const bad = new Uint8Array(16);
  assert.throws(() => decodeBinaryFrame(bad), /magie binaire invalide/);
});

test("client message parses a valid call.state", () => {
  const msg = parseClientMessage({
    v: PROTOCOL_VERSION,
    type: "call.state",
    eventId: "e1",
    sessionId: "s1",
    ts: Date.now(),
    inCall: true,
  });
  assert.equal(msg.type, "call.state");
});

test("client message: session.start, session.stop, speech.start/end no longer exist (never sent)", () => {
  for (const type of ["session.start", "session.stop", "speech.start", "speech.end"]) {
    const res = safeParseClientMessage({ v: PROTOCOL_VERSION, type, eventId: "e1", sessionId: "s1", ts: 0, token: "t", turnId: "u1" });
    assert.equal(res.success, false, type);
  }
});

test("client message rejects an unknown type", () => {
  const res = safeParseClientMessage({
    v: PROTOCOL_VERSION,
    type: "nope",
    eventId: "e1",
    sessionId: "s1",
    ts: 0,
  });
  assert.equal(res.success, false);
});

test("text.input requires non-empty text", () => {
  const res = safeParseClientMessage({
    v: PROTOCOL_VERSION,
    type: "text.input",
    eventId: "e1",
    sessionId: "s1",
    turnId: "t1",
    ts: 0,
    text: "",
  });
  assert.equal(res.success, false);
});

test("mic.cancel : accepté avec un streamId, refusé sans", () => {
  const base = { v: PROTOCOL_VERSION, eventId: "e1", sessionId: "s1", ts: 0, type: "mic.cancel" };
  assert.equal(safeParseClientMessage({ ...base, streamId: 7 }).success, true);
  assert.equal(safeParseClientMessage(base).success, false);
});

test("server message: panel.display, with or without a panel (restore everything)", () => {
  const base = { v: PROTOCOL_VERSION, type: "panel.display", eventId: "e1", sessionId: "s1", ts: Date.now() };
  assert.equal(serverMessage.safeParse({ ...base, panelId: "p_ab12cd", display: "maximize" }).success, true);
  assert.equal(serverMessage.safeParse({ ...base, display: "restore" }).success, true);
  assert.equal(serverMessage.safeParse({ ...base, panelId: "p_ab12cd", display: "fullscreen" }).success, false);
});
