#!/usr/bin/env node
/**
 * Double déterministe du worker STT (whisper.cpp). Protocole NDJSON de
 * packages/contracts (SttRequest/SttEvent). Transcrit un texte fixe ou
 * déduit de KOPILIA_MOCK_TRANSCRIPT, après réception de stt.close. Un flux dont
 * une trame commence par « say: » (en UTF-8) est transcrit par la suite de
 * cette trame : un test peut ainsi dire « Stop. ».
 */
import readline from "node:readline";
import { appendFileSync } from "node:fs";

function emit(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}
emit({ type: "stt.ready", model: "mock-base", lang: process.env.KOPILIA_WHISPER_LANG ?? "fr" });

const transcript = process.env.KOPILIA_MOCK_TRANSCRIPT ?? "Bonjour Kopilia, quel temps fait-il ?";
const frames = new Map();
/** Texte imposé par flux (trame « say:… »). */
const said = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  // Ouvertures, fermetures et annulations de flux, pour les tests (KOPILIA_MOCK_STT_LOG).
  if (process.env.KOPILIA_MOCK_STT_LOG && m.type !== "stt.audio") appendFileSync(process.env.KOPILIA_MOCK_STT_LOG, `${m.type} ${m.streamId}\n`);
  switch (m.type) {
    case "stt.open":
      frames.set(m.streamId, 0);
      emit({ type: "stt.vad", streamId: m.streamId, speaking: true });
      break;
    case "stt.audio":
      // Seules les trames non vides comptent (la trame finale est vide).
      if (!m.pcmBase64) break;
      frames.set(m.streamId, (frames.get(m.streamId) ?? 0) + 1);
      {
        const head = Buffer.from(m.pcmBase64, "base64").toString("utf8");
        if (head.startsWith("say:")) said.set(m.streamId, head.slice(4).trim());
      }
      // Partiel après quelques trames.
      if (frames.get(m.streamId) === 2) emit({ type: "stt.partial", streamId: m.streamId, text: transcript.split(" ").slice(0, 2).join(" ") });
      break;
    case "stt.close":
      emit({ type: "stt.vad", streamId: m.streamId, speaking: false });
      // Aucun audio : transcription vide, comme le vrai worker sous 0,5 s.
      emit({ type: "stt.final", streamId: m.streamId, text: frames.get(m.streamId) ? (said.get(m.streamId) ?? transcript) : "", lang: "fr" });
      frames.delete(m.streamId);
      said.delete(m.streamId);
      break;
    case "stt.cancel":
      frames.delete(m.streamId);
      said.delete(m.streamId);
      break;
  }
});
