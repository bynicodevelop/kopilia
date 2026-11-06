#!/usr/bin/env node
/**
 * Capture les événements stream-json réellement émis par la version installée
 * du CLI, pour valider le parsing (deltas, result, session_id) et documenter la
 * recette. Écrit docs/claude-events-sample.ndjson.
 *
 * Nécessite un CLI authentifié (abonnement). Sans auth, enregistre quand même
 * la trace (utile pour voir la forme des événements d'erreur).
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = createWriteStream(resolve(ROOT, "docs/claude-events-sample.ndjson"));
const bin = process.env.KOPILIA_CLAUDE_BIN ?? "claude";

const proc = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"], {
  stdio: ["pipe", "pipe", "inherit"],
});

proc.stdout.on("data", (c) => out.write(c));
proc.on("exit", (code) => {
  out.end();
  console.log(`Trace écrite dans docs/claude-events-sample.ndjson (exit ${code}).`);
});

proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Réponds en un mot: bonjour." } }) + "\n");
setTimeout(() => proc.stdin.end(), 20000);
