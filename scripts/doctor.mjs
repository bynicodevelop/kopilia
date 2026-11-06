#!/usr/bin/env node
/**
 * Diagnostic Kopilia : vérifie l'outillage, les modèles, la voix française, les
 * workers, le stockage, le port, le CLI et l'authentification. Codes couleur
 * sur un terminal ; sortie compacte avec --quiet (utilisé par `pnpm test`).
 *
 * N'affiche jamais de valeur de secret : seulement des noms et des états.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
}
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}
function env(key, fallback) {
  return process.env[key] ?? fallback;
}
// .env, comme le serveur : l'environnement déjà défini l'emporte.
const dotEnv = resolve(ROOT, ".env");
if (existsSync(dotEnv)) {
  for (const raw of readFileSync(dotEnv, "utf8").split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env))
      process.env[key] = line
        .slice(eq + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
  }
}
// Un .env d'avant le nom Kopilia (JARVIS_…) marche tel quel, comme pour le serveur.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("JARVIS_")) process.env[`KOPILIA_${key.slice(7)}`] ??= process.env[key];
}

// --- Outillage ---
const node = process.version;
check("Node >= 22", Number(node.slice(1).split(".")[0]) >= 22, node);
check("pnpm", !!sh("pnpm -v"), sh("pnpm -v") ?? "absent");
check("python3", !!sh("python3 --version"), sh("python3 --version") ?? "absent");
const arch = sh("uname -m");
check("Apple Silicon", arch === "arm64", arch ?? "?");
check("clang", !!sh("clang --version"), (sh("clang --version") ?? "").split("\n")[0]);
check("cmake", !!sh("cmake --version"), (sh("cmake --version") ?? "").split("\n")[0]);

// --- CLI Claude + auth ---
const claudeBin = env("KOPILIA_CLAUDE_BIN", "claude");
const claudeVer = sh(`${claudeBin} --version`);
check("CLI Claude", !!claudeVer, claudeVer ?? "absent");
// Auth : on tente un -p minimal ; 401 => login requis (jamais de valeur affichée).
if (!quiet && claudeVer) {
  const probe = sh(`${claudeBin} -p "ok" 2>&1 | head -1`);
  const authed = probe != null && !/authenticate|401|invalid/i.test(probe);
  check("Auth abonnement Claude", authed, authed ? "ok" : "login requis (`claude login`)");
}

// --- Modèles & voix ---
// Même choix que le serveur : large-v3-turbo s'il est là, sinon repli sur Base.
const turbo = resolve(ROOT, "models/ggml-large-v3-turbo-q5_0.bin");
const whisperModel = resolve(ROOT, env("KOPILIA_WHISPER_MODEL", "") || (existsSync(turbo) ? turbo : "models/ggml-base.bin"));
const onTurbo = whisperModel === turbo;
check(
  "Modèle Whisper large-v3-turbo",
  existsSync(whisperModel) && (onTurbo || !!process.env.KOPILIA_WHISPER_MODEL),
  onTurbo
    ? `${(statSync(turbo).size / 1e6) | 0} Mo`
    : process.env.KOPILIA_WHISPER_MODEL
      ? `remplacé par ${whisperModel}`
      : "absent : repli sur Base, bien moins précis en français (`pnpm models:fetch`)",
);
const whisperBin = resolve(ROOT, "workers/whisper/bin/whisper-cli");
check("Binaire whisper.cpp", existsSync(whisperBin), existsSync(whisperBin) ? "compilé" : "à compiler (scripts/build-whisper.sh)");
const whisperServer = resolve(ROOT, "workers/whisper/bin/whisper-server");
check(
  "Serveur whisper.cpp (modèle en mémoire)",
  existsSync(whisperServer),
  existsSync(whisperServer) ? "ok" : "absent : repli plus lent sur whisper-cli (bash scripts/build-whisper.sh)",
);
// Le vocabulaire de l'utilisateur (hors git), sinon le modèle du dépôt.
const ownVocabulary = existsSync(resolve(ROOT, "config/vocabulaire.txt")) ? "config/vocabulaire.txt" : "config/vocabulaire.example.txt";
const vocabulary = resolve(ROOT, env("KOPILIA_STT_VOCABULARY", ownVocabulary));
check(
  "Vocabulaire de transcription",
  existsSync(vocabulary),
  existsSync(vocabulary)
    ? vocabulary.endsWith("example.txt")
      ? `${ownVocabulary} (modèle : relancez pnpm run setup pour avoir le vôtre)`
      : ownVocabulary
    : `absent : ${vocabulary}`,
);
const venvPy = resolve(ROOT, "workers/kokoro/.venv/bin/python");
check("Env Python Kokoro", existsSync(venvPy), existsSync(venvPy) ? "ok" : "à créer (bootstrap)");

// --- Build ---
check("Build serveur", existsSync(resolve(ROOT, "apps/server/dist/main.js")), "apps/server/dist");
check("Build web", existsSync(resolve(ROOT, "apps/web/dist/kopilia-web/browser/index.html")), "apps/web/dist");
check("Serveur MCP coordination", existsSync(resolve(ROOT, "apps/server/dist/mcp/coordination-server.js")), "compilé");

// --- Cours en direct (MetaApi, facultatif) : le compte est-il prêt ? ---
const metaToken = env("KOPILIA_METAAPI_TOKEN", "");
if (!quiet && metaToken) {
  const prov = env("KOPILIA_METAAPI_PROVISIONING_URL", "") || "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
  const accountId = env("KOPILIA_METAAPI_ACCOUNT_ID", "");
  try {
    const res = await fetch(`${prov}/users/current/accounts${accountId ? `/${encodeURIComponent(accountId)}` : ""}`, {
      headers: { "auth-token": metaToken },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error("jeton refusé (KOPILIA_METAAPI_TOKEN)");
    if (res.status === 404) throw new Error("compte introuvable (KOPILIA_METAAPI_ACCOUNT_ID)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const accounts = accountId ? [body] : Array.isArray(body) ? body : (body.items ?? []);
    // Même choix que le serveur : le compte indiqué, sinon le seul compte, sinon le seul déployé.
    const deployed = accounts.filter((a) => a.state === "DEPLOYED");
    const chosen = accounts.length === 1 ? accounts[0] : deployed.length === 1 ? deployed[0] : undefined;
    const ok = chosen?.state === "DEPLOYED" && chosen?.connectionStatus === "CONNECTED";
    const describe = (a) => `« ${a.name} » ${a.state}/${a.connectionStatus} (${a.region}, id ${a._id})`;
    const detail = chosen
      ? describe(chosen)
      : accounts.length
        ? `plusieurs comptes, indique KOPILIA_METAAPI_ACCOUNT_ID : ${accounts.map(describe).join(" ; ")}`
        : "aucun compte : à ajouter dans l'interface MetaApi";
    check("MetaApi (cours en direct)", ok, detail);
  } catch (e) {
    check("MetaApi (cours en direct)", false, e.message);
  }
} else if (!quiet) {
  check("MetaApi (cours en direct)", true, "non configuré (facultatif) : KOPILIA_METAAPI_TOKEN dans .env");
}

// --- Port ---
const host = env("KOPILIA_HOST", "127.0.0.1");
const port = Number(env("KOPILIA_PORT", "4317"));
await new Promise((res) => {
  const srv = net.createServer();
  srv.once("error", () => {
    check(`Port ${port} libre`, false, "déjà utilisé (serveur en cours ?)");
    res();
  });
  srv.once("listening", () => srv.close(() => (check(`Port ${port} libre`, true, `${host}:${port}`), res())));
  srv.listen(port, host);
});

// --- Rapport ---
const failed = results.filter((r) => !r.ok);
if (quiet) {
  console.log(`doctor: ${results.length - failed.length}/${results.length} OK`);
} else {
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"}  ${r.name.padEnd(28)} ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} vérifications OK`);
  if (failed.length) console.log("À corriger : " + failed.map((f) => f.name).join(", "));
}
process.exit(failed.some((f) => ["Node >= 22", "pnpm", "CLI Claude"].includes(f.name)) ? 1 : 0);
