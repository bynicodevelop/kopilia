#!/usr/bin/env node
// Worker NDJSON de test pour WorkerLink, réglé par arguments :
//   --crash          quitte (code 1) juste après s'être annoncé
//   --half           écrit une demi-ligne sans fin, puis quitte (code 1)
//   --split          écrit un événement en deux morceaux, puis une ligne illisible
//   --die-on-input   quitte (code 1) à la première ligne reçue
// Sinon : s'annonce, puis renvoie chaque ligne reçue dans { echo }.
import { createInterface } from "node:readline";

const has = (flag) => process.argv.includes(flag);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const marker = process.env.WORKER_MARK ?? "w";

if (has("--half")) {
  process.stdout.write('{"type":"moit', () => process.exit(1));
} else {
  out({ type: "ready", marker, pid: process.pid });
  if (has("--crash")) process.exit(1);
  if (has("--split")) {
    process.stdout.write('{"type":"spl');
    setTimeout(() => {
      process.stdout.write('it","n":1}\n');
      process.stdout.write("pas du json\n");
    }, 30);
  }
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (has("--die-on-input")) process.exit(1);
    out({ type: "echo", line: JSON.parse(line) });
  });
}
