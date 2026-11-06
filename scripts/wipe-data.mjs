#!/usr/bin/env node
/**
 * Efface les données Kopilia (base SQLite : sessions, tours, tâches, mémoire,
 * observations, règles) et les journaux locaux. N'efface PAS les modèles.
 *
 * Portée : ceci supprime la mémoire et l'historique gérés par Kopilia. La
 * rétention des sessions par Claude Code (ses propres fichiers ~/.claude) est
 * INDÉPENDANTE et n'est pas touchée ici — voir le README pour l'expliquer.
 */
import { rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.KOPILIA_DATA_DIR ? resolve(process.env.KOPILIA_DATA_DIR) : resolve(ROOT, "data");
const targets = [dataDir, resolve(ROOT, "logs"), resolve(ROOT, "run")];

if (!process.argv.includes("--yes")) {
  console.log("Cela supprimera les données de Kopilia (mémoire, historique, tâches) dans :");
  for (const t of targets) console.log("  " + t);
  console.log("\nRelancez avec --yes pour confirmer : node scripts/wipe-data.mjs --yes");
  console.log("Note : les sessions conservées par Claude Code (~/.claude) ne sont PAS concernées.");
  process.exit(0);
}

for (const t of targets) {
  if (existsSync(t)) {
    rmSync(t, { recursive: true, force: true });
    console.log("supprimé : " + t);
  }
}
console.log("Données de Kopilia effacées. Les modèles et la config (.env) sont conservés.");
