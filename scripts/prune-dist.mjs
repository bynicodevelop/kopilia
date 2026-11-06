#!/usr/bin/env node
// Retire de dist/ ce que tsc a compilé autrefois et dont la source n'existe plus
// (un fichier renommé laisserait sinon son ancienne version exécutable).
// Pas de « rm -rf dist » avant la compilation : un serveur lancé lit dist/ pour
// démarrer ses serveurs MCP, il ne doit jamais le trouver vide.
// Usage : node prune-dist.mjs <dossier source> <dossier compilé>
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [src, dist] = process.argv.slice(2);
if (!src || !dist) {
  console.error("usage : prune-dist.mjs <src> <dist>");
  process.exit(2);
}
const OUTPUT = /\.(?:js|js\.map|d\.ts|d\.ts\.map)$/;

let removed = 0;
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!OUTPUT.test(name)) continue;
    const base = relative(dist, path).replace(OUTPUT, "");
    if (!existsSync(join(src, `${base}.ts`))) {
      rmSync(path);
      removed++;
    }
  }
}
walk(dist);
if (removed) console.log(`prune-dist : ${removed} fichier(s) compilé(s) sans source retiré(s) de ${dist}`);
