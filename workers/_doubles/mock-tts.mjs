#!/usr/bin/env node
/**
 * Double déterministe du worker TTS (Kokoro). Protocole NDJSON de
 * packages/contracts (TtsRequest/TtsEvent). Émet du PCM de silence
 * proportionnel à la longueur du texte, à 24 kHz, puis tts.end.
 */
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const SAMPLE_RATE = 24000;
function emit(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}
emit({ type: "tts.ready", voice: process.env.KOPILIA_KOKORO_VOICE ?? "ff_siwis", sampleRate: SAMPLE_RATE });

const cancelled = new Set();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "tts.cancel") {
    // Flux annulés, pour les tests (KOPILIA_MOCK_TTS_CANCEL_LOG).
    if (process.env.KOPILIA_MOCK_TTS_CANCEL_LOG) appendFileSync(process.env.KOPILIA_MOCK_TTS_CANCEL_LOG, `${m.streamId}\n`);
    cancelled.add(m.streamId);
    return;
  }
  if (m.type !== "tts.speak") return;
  // Texte effectivement dit, pour les tests (KOPILIA_MOCK_TTS_LOG).
  if (process.env.KOPILIA_MOCK_TTS_LOG) appendFileSync(process.env.KOPILIA_MOCK_TTS_LOG, m.text + "\n");
  cancelled.delete(m.streamId);
  emit({ type: "tts.start", streamId: m.streamId, sampleRate: SAMPLE_RATE });
  // ~60 ms d'audio par mot (silence), découpé en tranches de 20 ms.
  const words = Math.max(1, m.text.split(/\s+/).length);
  const totalSamples = words * Math.round(SAMPLE_RATE * 0.06);
  const chunkSamples = Math.round(SAMPLE_RATE * 0.02);
  let seq = 0;
  for (let i = 0; i < totalSamples; i += chunkSamples) {
    if (cancelled.has(m.streamId)) break;
    const n = Math.min(chunkSamples, totalSamples - i);
    const pcm = Buffer.alloc(n * 2); // PCM16 silence
    emit({ type: "tts.chunk", streamId: m.streamId, seq: seq++, pcmBase64: pcm.toString("base64") });
  }
  if (!cancelled.has(m.streamId)) emit({ type: "tts.end", streamId: m.streamId });
});
