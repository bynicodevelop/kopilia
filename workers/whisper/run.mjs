#!/usr/bin/env node
/**
 * Worker STT whisper.cpp (protocole NDJSON de packages/contracts).
 *
 * Reçoit du PCM 16 kHz mono 16 bits par flux (streamId), accumule chaque prise
 * de parole, puis la transcrit en français à la fermeture du flux, avec
 * l'amorce de vocabulaire reçue à l'ouverture (noms propres, sigles).
 *
 * Moteur : whisper-server lancé une seule fois, modèle gardé en mémoire
 * (large-v3-turbo par défaut, Metal + flash attention) ; on lui envoie chaque
 * énoncé en WAV sur le loopback. Repli : whisper-cli à chaque énoncé (modèle
 * rechargé à chaque fois, ~0,2 à 0,7 s de plus), si le serveur manque ou tombe.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(HERE, "bin/whisper-cli");
const SERVER_BIN = resolve(HERE, "bin/whisper-server");
const MODEL = process.env.KOPILIA_WHISPER_MODEL ?? resolve(HERE, "../../models/ggml-large-v3-turbo-q5_0.bin");
const LANG = process.env.KOPILIA_WHISPER_LANG ?? "fr";
/** « cli » force le repli (diagnostic). */
const MODE = process.env.KOPILIA_WHISPER_MODE ?? "server";
/**
 * Options communes : français forcé, sans horodatage, -sns supprime les jetons
 * non verbaux (« [Musique] »…, fréquents sur le bruit), -fa = flash attention
 * (encodeur ~25 % plus rapide sur Metal).
 */
const COMMON = ["-m", MODEL, "-l", LANG, "-nt", "-sns", "-fa"];

function emit(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

/** En-tête WAV PCM16 mono. */
function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

const clean = (s) => s.replace(/\s+/g, " ").trim();

/* ------------------------- Moteur : whisper-server ------------------------ */

let server = null; // { proc, url }

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** Lance whisper-server et attend qu'il réponde (modèle chargé). null si indisponible. */
async function startServer() {
  if (MODE === "cli" || !existsSync(SERVER_BIN)) return null;
  const port = await freePort();
  const proc = spawn(SERVER_BIN, [...COMMON, "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr.resume(); // journal verbeux de whisper : drainé, jamais bloquant
  let exited = false;
  proc.once("exit", () => {
    exited = true;
    if (server?.proc === proc) server = null;
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !exited) {
    try {
      if ((await fetch(url)).ok) {
        server = { proc, url };
        // Chauffe : la première inférence compile les noyaux Metal (~1 s).
        await viaServer(Buffer.alloc(16000 * 2), "").catch(() => {});
        return server;
      }
    } catch {
      /* pas encore à l'écoute */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  return null;
}

async function viaServer(pcm, prompt) {
  const form = new FormData();
  form.append("file", new Blob([wav(pcm, 16000)], { type: "audio/wav" }), "utt.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  // Toujours envoyé (même vide) : le serveur garde sinon l'amorce précédente.
  form.append("prompt", prompt ?? "");
  const res = await fetch(`${server.url}/inference`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`whisper-server ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`whisper-server: ${body.error}`);
  return clean(body.text ?? "");
}

/* --------------------------- Repli : whisper-cli -------------------------- */

function viaCli(pcm, rate, prompt) {
  return new Promise((res, rej) => {
    const dir = mkdtempSync(join(tmpdir(), "kopilia-stt-"));
    const wavPath = join(dir, "utt.wav");
    writeFileSync(wavPath, wav(pcm, rate));
    const args = [...COMMON, "-f", wavPath];
    if (prompt) args.push("--prompt", prompt);
    execFile(CLI_BIN, args, { maxBuffer: 1 << 24 }, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) rej(new Error(`whisper-cli: ${err.message}`));
      else res(clean(stdout));
    });
  });
}

/* ------------------------------ Transcription ----------------------------- */

const engine = startServer();
let restarting = false;
const streams = new Map(); // streamId -> { rate, prompt, chunks: Buffer[] }

async function transcribe(streamId) {
  const s = streams.get(streamId);
  if (!s) return;
  streams.delete(streamId);
  const pcm = Buffer.concat(s.chunks);
  if (pcm.length < s.rate) {
    // < 0.5 s : trop court pour une transcription fiable
    emit({ type: "stt.final", streamId, text: "", lang: LANG });
    return;
  }
  await engine;
  try {
    // Le serveur attend du 16 kHz (format du micro) ; tout autre taux passe par la CLI.
    const text = server && s.rate === 16000 ? await viaServer(pcm, s.prompt) : await viaCli(pcm, s.rate, s.prompt);
    emit({ type: "stt.final", streamId, text, lang: LANG });
  } catch (err) {
    // Serveur tombé en route : on transcrit quand même par la CLI, et on le
    // relance en arrière-plan pour les phrases suivantes.
    if (!server && !restarting) {
      restarting = true;
      void startServer().finally(() => (restarting = false));
    }
    try {
      emit({ type: "stt.final", streamId, text: await viaCli(pcm, s.rate, s.prompt), lang: LANG });
    } catch (e) {
      emit({ type: "stt.error", streamId, message: `${err.message} ; ${e.message}` });
    }
  }
}

function shutdown() {
  server?.proc.kill();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

engine.then((s) => emit({ type: "stt.ready", model: `${basename(MODEL)} (${s ? "serveur" : "cli"})`, lang: LANG }));

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case "stt.open":
        streams.set(m.streamId, { rate: m.sampleRate || 16000, prompt: m.prompt ?? "", chunks: [] });
        emit({ type: "stt.vad", streamId: m.streamId, speaking: true });
        break;
      case "stt.audio": {
        const s = streams.get(m.streamId);
        if (s) s.chunks.push(Buffer.from(m.pcmBase64, "base64"));
        break;
      }
      case "stt.close":
        emit({ type: "stt.vad", streamId: m.streamId, speaking: false });
        void transcribe(m.streamId);
        break;
      case "stt.cancel":
        streams.delete(m.streamId);
        break;
    }
  })
  .on("close", shutdown); // Nest arrêté : on n'abandonne pas un serveur orphelin
