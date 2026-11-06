#!/usr/bin/env node
/**
 * Télécharge les modèles du manifeste de façon reproductible :
 *   - télécharge vers un fichier temporaire (.part), valide, puis renomme
 *   - réutilise les fichiers déjà valides (second passage sans re-téléchargement)
 *   - vérifie l'empreinte publiée si présente ; sinon consigne l'empreinte
 *     obtenue dans models/manifest.lock.json et la revérifie ensuite
 *
 * Usage : node scripts/fetch-models.mjs [--verify-only]
 */
import { createWriteStream, existsSync, readFileSync, writeFileSync, renameSync, statSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "models/manifest.json"), "utf8"));
const lockPath = resolve(ROOT, "models/manifest.lock.json");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : {};
const verifyOnly = process.argv.includes("--verify-only");

async function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}

async function download(url, dest) {
  const part = dest + ".part";
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} pour ${url}`);
  const out = createWriteStream(part);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out.write(Buffer.from(value));
    process.stdout.write(`\r  ${(received / 1e6) | 0} Mo…   `);
  }
  await new Promise((r) => out.end(r));
  process.stdout.write("\n");
  renameSync(part, dest);
}

async function ensureFile(f) {
  const dest = resolve(ROOT, f.dest);
  const expected = f.sha256 ?? lock[f.id]?.sha256 ?? null;

  if (existsSync(dest)) {
    const got = await sha256(dest);
    if (expected && got !== expected) {
      console.log(`✗ ${f.id} : empreinte invalide, re-téléchargement`);
    } else {
      if (!expected) {
        lock[f.id] = { sha256: got, bytes: statSync(dest).size };
      }
      console.log(`✓ ${f.id} présent (${(statSync(dest).size / 1e6) | 0} Mo)`);
      return true;
    }
  }
  // Un modèle optionnel absent n'est jamais une erreur, vérification comprise.
  if (f.optional) {
    console.log(`· ${f.id} optionnel, ignoré`);
    return true;
  }
  if (verifyOnly) {
    console.log(`✗ ${f.id} absent (verify-only)`);
    return false;
  }
  console.log(`↓ ${f.id} ${f.url}`);
  await download(f.url, dest);
  const got = await sha256(dest);
  if (expected && got !== expected) throw new Error(`${f.id} : empreinte attendue ${expected}, obtenue ${got}`);
  lock[f.id] = { sha256: got, bytes: statSync(dest).size };
  console.log(`✓ ${f.id} téléchargé`);
  return true;
}

let ok = true;
for (const f of manifest.files) {
  try {
    ok = (await ensureFile(f)) && ok;
  } catch (e) {
    console.error(`✗ ${f.id} : ${e.message}`);
    ok = false;
  }
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2));
console.log(ok ? "Modèles prêts." : "Certains modèles manquent.");
process.exit(ok ? 0 : 1);
