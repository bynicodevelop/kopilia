// Services voix face à un worker en panne : jamais d'écran bloqué sur
// « parle » (une phrase sans fin) ni sur « transcrit » (un énoncé sans final).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigService } from "../src/config/config.service.js";
import type { AppLogger } from "../src/common/logger.js";
import { SttService } from "../src/voice/stt.service.js";
import { TtsService } from "../src/voice/tts.service.js";

const CRASH = resolve(import.meta.dirname, "doubles/voice-crash.mjs");
const logger = { warn() {}, error() {}, debug() {}, log() {} } as unknown as AppLogger;

test("synthèse : le worker meurt en pleine phrase, la phrase se termine en erreur", async () => {
  process.env.KOPILIA_TTS_CMD = `node ${CRASH} tts`;
  const tts = new TtsService(new ConfigService(), logger);
  const errors: Array<{ streamId?: number }> = [];
  tts.on("tts.error", (e) => errors.push(e));
  tts.speak(1, "Première phrase.");
  await sleep(150); // le worker démarre…
  tts.speak(2, "Deuxième phrase.");
  await sleep(300);
  tts.onModuleDestroy();
  assert.ok(
    errors.some((e) => e.streamId === 2),
    "la phrase en cours au moment du crash est close",
  );
});

test("synthèse : phrase demandée pendant la panne, close en erreur juste après l'appel", async () => {
  process.env.KOPILIA_TTS_CMD = `node ${CRASH} tts`;
  const tts = new TtsService(new ConfigService(), logger);
  await sleep(150);
  tts.speak(1, "Elle fait tomber le worker.");
  await sleep(150);
  const errors: Array<{ streamId?: number }> = [];
  tts.on("tts.error", (e) => errors.push(e));
  tts.speak(7, "Perdue ?");
  assert.equal(errors.length, 0, "pas de réentrance : l'erreur arrive après l'appel");
  await sleep(10);
  tts.onModuleDestroy();
  assert.equal(errors.filter((e) => e.streamId === 7).length, 1);
});

test("transcription : le worker meurt en pleine prise de parole, l'énoncé se termine vide", async () => {
  process.env.KOPILIA_STT_CMD = `node ${CRASH} stt`;
  const stt = new SttService(new ConfigService(), logger);
  const finals: Array<{ streamId: number; text: string }> = [];
  stt.on("stt.final", (e) => finals.push(e));
  try {
    stt.onModuleInit();
    await sleep(150);
    stt.open(4, 16000);
    stt.audio(4, 0, new Uint8Array(320));
    await sleep(200);
    assert.deepEqual(finals, [{ type: "stt.final", streamId: 4, text: "" }]);
    // Fin de l'énoncé envoyée par l'écran pendant la panne : rien de plus.
    stt.close(4);
    await sleep(10);
    assert.equal(finals.length, 1);
    // Un flux ouvert pendant la panne n'atteint jamais le worker : fermé, il se termine vide.
    stt.open(5, 16000);
    stt.close(5);
    await sleep(10);
    assert.deepEqual(finals.at(-1), { type: "stt.final", streamId: 5, text: "" });
  } finally {
    stt.onModuleDestroy();
  }
});
