#!/usr/bin/env node
// Worker voix qui meurt au mauvais moment : `tts` quitte à la première phrase
// à dire, `stt` quitte au premier morceau d'audio (en pleine prise de parole).
import { createInterface } from "node:readline";

const kind = process.argv[2];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out(kind === "tts" ? { type: "tts.ready", voice: "test", sampleRate: 24000 } : { type: "stt.ready", model: "test", lang: "fr" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if ((kind === "tts" && m.type === "tts.speak") || (kind === "stt" && m.type === "stt.audio")) process.exit(1);
});
