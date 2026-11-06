// La trame binaire est codée deux fois : côté contrats (serveur) et côté web
// (bundle indépendant). Ces tests verrouillent l'aller-retour et la parité.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND_MIC, KIND_TTS, decodeFrame, encodeFrame } from "../src/app/audio/binary";
import { BinaryKind, decodeBinaryFrame, encodeBinaryFrame } from "../../../packages/contracts/src/audio";

const bytes = (...n: number[]) => new Uint8Array(n).buffer;

test("trame binaire : aller-retour", () => {
  const frame = decodeFrame(encodeFrame(KIND_TTS, 7, 42, true, bytes(1, 2, 3)));
  assert.ok(frame);
  assert.equal(frame.kind, KIND_TTS);
  assert.equal(frame.streamId, 7);
  assert.equal(frame.seq, 42);
  assert.equal(frame.final, true);
  assert.deepEqual([...new Uint8Array(frame.payload)], [1, 2, 3]);
});

test("trame binaire : identifiants sur 32 bits non signés", () => {
  const frame = decodeFrame(encodeFrame(KIND_MIC, 0xffff_ffff, -1, false, bytes()));
  assert.equal(frame?.streamId, 0xffff_ffff);
  assert.equal(frame?.seq, 0xffff_ffff, "un négatif est replié sur 32 bits");
  assert.equal(frame?.payload.byteLength, 0);
});

test("trame binaire : en-tête trop court, mauvaise marque ou version, refusée", () => {
  assert.equal(decodeFrame(bytes(1, 2, 3)), null);
  const bad = new Uint8Array(encodeFrame(KIND_MIC, 1, 1, false, bytes(9)));
  bad[0] ^= 0xff;
  assert.equal(decodeFrame(bad.buffer), null, "marque");
  const old = new Uint8Array(encodeFrame(KIND_MIC, 1, 1, false, bytes(9)));
  old[2] = 2;
  assert.equal(decodeFrame(old.buffer), null, "version");
});

test("trame binaire : web et contrats parlent exactement le même format", () => {
  assert.equal(KIND_MIC, BinaryKind.Mic);
  assert.equal(KIND_TTS, BinaryKind.Tts);
  // Web -> contrats (micro vers le serveur).
  const fromWeb = new Uint8Array(encodeFrame(KIND_MIC, 3, 9, true, bytes(5, 6)));
  const read = decodeBinaryFrame(fromWeb);
  assert.deepEqual(
    { kind: read.header.kind, streamId: read.header.streamId, seq: read.header.seq, final: read.header.final, payload: [...read.payload] },
    { kind: BinaryKind.Mic, streamId: 3, seq: 9, final: true, payload: [5, 6] },
  );
  // Contrats -> web (voix de Kopilia vers l'écran).
  const fromServer = encodeBinaryFrame({ kind: BinaryKind.Tts, streamId: 11, seq: 2, final: false }, new Uint8Array([7, 8, 9]));
  const copy = fromServer.buffer.slice(fromServer.byteOffset, fromServer.byteOffset + fromServer.byteLength);
  const frame = decodeFrame(copy);
  assert.deepEqual(frame && { kind: frame.kind, streamId: frame.streamId, seq: frame.seq, final: frame.final, payload: [...new Uint8Array(frame.payload)] }, {
    kind: KIND_TTS,
    streamId: 11,
    seq: 2,
    final: false,
    payload: [7, 8, 9],
  });
});
