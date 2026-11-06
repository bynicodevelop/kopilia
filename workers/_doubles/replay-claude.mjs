#!/usr/bin/env node
/**
 * Double du CLI `claude` qui rejoue une trace stream-json écrite à la main :
 * `--replay <fichier.json>`, un tableau de tours ; chaque tour est la liste des
 * lignes à écrire sur stdout (objets JSON, ou chaînes brutes pour simuler une
 * ligne illisible) quand une invite arrive sur stdin. Un tour `{ "exit": n }`
 * fait quitter le processus sans `result` (crash en plein tour).
 * Sert à caractériser ClaudeProcess sans dépendre des réponses de mock-claude.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const at = process.argv.indexOf("--replay");
const turns = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
const out = (line) => process.stdout.write((typeof line === "string" ? line : JSON.stringify(line)) + "\n");

out({ type: "system", subtype: "init", session_id: "replay-1", tools: [], model: "replay" });

let next = 0;
createInterface({ input: process.stdin }).on("line", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type !== "user") return; // requêtes de contrôle : ignorées
  const turn = turns[next++];
  if (!turn) return;
  if (!Array.isArray(turn)) process.exit(turn.exit ?? 1);
  for (const line of turn) out(line);
});
