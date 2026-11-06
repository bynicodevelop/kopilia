#!/usr/bin/env node
/**
 * Banc de la reconnaissance vocale de Kopilia : ce que Whisper comprend des
 * phrases de scripts/stt-bench/phrases.txt, avec un fichier de vocabulaire.
 *
 * Chaque phrase est lue par deux voix de synthèse, à deux débits : Kokoro
 * (ff_siwis, la voix de Kopilia) et la voix macOS Thomas (jamais Flo ni Eddy,
 * trop robotiques, ratées par tous les modèles). L'audio est gardé dans
 * var/stt-bench/. Puis chaque phrase passe par le vrai worker
 * (workers/whisper/run.mjs) comme une prise de parole au micro : 0,3 s de
 * silence avant, 0,5 s après, avec l'amorce et les corrections du vocabulaire
 * telles que stt.service les applique.
 *
 *   pnpm stt:bench [vocabulaire.txt…] [--details] [--json bilan.json]
 *
 * Sans fichier : config/vocabulaire.txt (sinon le modèle config/vocabulaire.example.txt) ; « - » : aucun vocabulaire. Plusieurs
 * fichiers sont comparés sur le même banc, dans le même passage.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isPromptEcho } from "../../apps/server/src/voice/transcript-filter.ts";
import { applyReplacements, buildSttPrompt, readVocabularyFile } from "../../apps/server/src/voice/vocabulary.ts";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CACHE = resolve(ROOT, "var/stt-bench");
const RATE = 16000;
/** Comme au micro : la pré-écoute avant l'appui, le silence ajouté à la fin. */
const PAD_BEFORE_S = 0.3;
const PAD_AFTER_S = 0.5;

const VOICES = [
  { id: "kokoro", engine: "kokoro", speed: 1.0 },
  { id: "kokoro-vite", engine: "kokoro", speed: 1.2 },
  { id: "thomas", engine: "say", voice: "Thomas", rate: 180 },
  { id: "thomas-vite", engine: "say", voice: "Thomas", rate: 220 },
];

/* -------------------------------- Phrases -------------------------------- */

function readPhrases(path) {
  const phrases = [];
  let family = "";
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) family = line.slice(3).trim();
    if (!line || line.startsWith("#")) continue;
    const [said, expected, terms = ""] = line.split("|").map((s) => s.trim());
    phrases.push({
      family,
      said,
      expected: expected || said,
      terms: terms
        .split(";")
        .map((t) =>
          t
            .split("/")
            .map((a) => a.trim())
            .filter(Boolean),
        )
        .filter((alts) => alts.length),
    });
  }
  return phrases;
}

/** Sans casse, sans accents, sans ponctuation : « l'Euro-Yen ! » -> « l euro yen ». */
const norm = (s) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Le terme est-il dans la transcription ? En mots entiers. Un terme de 4
 * lettres ou plus est aussi reconnu collé ou coupé autrement (« euroyen »,
 * « intra-day », « N-Z-D-J-P-Y ») ; un plus court reste un mot exact (« or »).
 */
function hasTerm(text, alts) {
  const words = norm(text);
  return alts.some((alt) => {
    const letters = norm(alt).replace(/ /g, "");
    const pattern = letters.length >= 4 ? [...letters].join(" ?") : norm(alt);
    return new RegExp(`(?:^| )${pattern}(?: |$)`).test(words);
  });
}

/** Distance d'édition en mots (taux d'erreur par mot). */
function wordEdits(ref, hyp) {
  const a = norm(ref).split(" ").filter(Boolean);
  const b = norm(hyp).split(" ").filter(Boolean);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return { edits: prev[b.length], words: a.length };
}

/* ------------------------------- Synthèse -------------------------------- */

const audioPath = (voice, text) => join(CACHE, `${voice.id}-${createHash("sha1").update(`${voice.id}|${text}`).digest("hex").slice(0, 12)}.wav`);

async function synthesizeSay(voice, jobs) {
  for (const { text, out } of jobs) {
    await run("say", ["-v", voice.voice, "-r", String(voice.rate), "-o", out, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
  }
}

/** Kokoro sort du 24 kHz : converti en 16 kHz mono 16 bits (le format du micro) par afconvert. */
async function synthesizeKokoro(voice, jobs) {
  const python = resolve(ROOT, "workers/kokoro/.venv/bin/python");
  if (!existsSync(python)) throw new Error(`venv Kokoro absent : ${relative(ROOT, python)} (pnpm run setup)`);
  const proc = spawn(python, ["-I", join(HERE, "synth_kokoro.py")], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, HF_HUB_OFFLINE: "1" } });
  let log = "";
  proc.stderr.on("data", (d) => (log = (log + d).slice(-2000)));
  const done = new Promise((res, rej) => {
    proc.once("error", rej);
    proc.once("exit", (code) => (code === 0 ? res() : rej(new Error(`synth_kokoro.py : code ${code}\n${log}`))));
  });
  for (const { text, out } of jobs) proc.stdin.write(JSON.stringify({ text, speed: voice.speed, out: `${out}.24k.wav` }) + "\n");
  proc.stdin.end();
  await done;
  for (const { out } of jobs) {
    await run("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", `${out}.24k.wav`, out]);
    rmSync(`${out}.24k.wav`);
  }
}

async function synthesizeAll(phrases) {
  mkdirSync(CACHE, { recursive: true });
  for (const voice of VOICES) {
    const jobs = [...new Set(phrases.map((p) => p.said))].map((text) => ({ text, out: audioPath(voice, text) })).filter((j) => !existsSync(j.out));
    if (!jobs.length) continue;
    process.stderr.write(`synthèse ${voice.id} : ${jobs.length} phrase(s)…\n`);
    await (voice.engine === "say" ? synthesizeSay(voice, jobs) : synthesizeKokoro(voice, jobs));
  }
}

/** Les échantillons d'un WAV 16 kHz mono 16 bits (en-têtes de longueur variable, comme ceux d'afconvert). */
function readPcm(path) {
  const buf = readFileSync(path);
  let fmt;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt ")
      fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${path} : pas du PCM 16 kHz mono 16 bits`);
      return buf.subarray(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} : pas de données audio`);
}

/* -------------------------------- Whisper -------------------------------- */

/** Le worker de transcription de Kopilia, piloté par son protocole NDJSON. */
function startWorker() {
  const proc = spawn(process.execPath, [resolve(ROOT, "workers/whisper/run.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let streamId = 0;
  const ready = new Promise((res, rej) => {
    proc.once("exit", (code) => rej(new Error(`worker whisper arrêté (code ${code})`)));
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.type === "stt.ready") res(m.model);
      if (m.type === "stt.final" || m.type === "stt.error") {
        pending.get(m.streamId)?.(m);
        pending.delete(m.streamId);
      }
    });
  });
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  return {
    ready,
    stop: () => proc.stdin.end(),
    /** Comme stt.service : l'amorce à l'ouverture, l'audio par tranches de 100 ms, la transcription à la fermeture. */
    transcribe(pcm, prompt) {
      const id = ++streamId;
      const result = new Promise((res) => pending.set(id, res));
      send({ type: "stt.open", streamId: id, sampleRate: RATE, prompt: prompt || undefined });
      const step = (RATE / 10) * 2;
      for (let at = 0, seq = 0; at < pcm.length; at += step, seq++)
        send({ type: "stt.audio", streamId: id, seq, pcmBase64: pcm.subarray(at, at + step).toString("base64") });
      send({ type: "stt.close", streamId: id });
      return result.then((m) => {
        if (m.type === "stt.error") throw new Error(m.message);
        return m.text;
      });
    },
  };
}

/* --------------------------------- Bilan --------------------------------- */

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1).replace(".", ",")} %` : "—");

/** Par famille de phrases, dans l'ordre du fichier, puis le total. */
function summarize(rows) {
  const by = new Map(rows.map((r) => [r.family, undefined]));
  for (const r of rows) {
    for (const key of [r.family, "total"]) {
      const s = by.get(key) ?? { ok: 0, terms: 0, edits: 0, words: 0 };
      s.ok += r.found.filter(Boolean).length;
      s.terms += r.found.length;
      s.edits += r.edits;
      s.words += r.words;
      by.set(key, s);
    }
  }
  return by;
}

async function main() {
  const args = process.argv.slice(2);
  const details = args.includes("--details");
  const jsonAt = args.indexOf("--json");
  const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const files = args.filter((a, i) => !a.startsWith("--") && !(jsonAt >= 0 && i === jsonAt + 1));
  const ownVocabulary = resolve(ROOT, "config/vocabulaire.txt");
  const defaultVocabulary = existsSync(ownVocabulary) ? ownVocabulary : resolve(ROOT, "config/vocabulaire.example.txt");
  const vocabs = (files.length ? files : [defaultVocabulary]).map((f) => {
    const v = f === "-" ? { terms: [], replacements: [] } : readVocabularyFile(resolve(f));
    return { name: f === "-" ? "(aucun)" : relative(ROOT, resolve(f)), prompt: buildSttPrompt(v.terms), replacements: v.replacements };
  });

  const phrases = readPhrases(join(HERE, "phrases.txt"));
  await synthesizeAll(phrases);

  const worker = startWorker();
  process.stderr.write(`whisper : ${await worker.ready}\n`);
  const before = Buffer.alloc(Math.round(PAD_BEFORE_S * RATE) * 2);
  const after = Buffer.alloc(Math.round(PAD_AFTER_S * RATE) * 2);
  const rows = [];
  const total = phrases.length * VOICES.length;
  let n = 0;
  for (const p of phrases) {
    for (const voice of VOICES) {
      const pcm = Buffer.concat([before, readPcm(audioPath(voice, p.said)), after]);
      for (const v of vocabs) {
        const raw = await worker.transcribe(pcm, v.prompt);
        const text = isPromptEcho(raw, v.prompt) ? "" : applyReplacements(raw, v.replacements);
        rows.push({
          vocab: v.name,
          family: p.family,
          voice: voice.id,
          said: p.said,
          expected: p.expected,
          text,
          found: p.terms.map((alts) => hasTerm(text, alts)),
          terms: p.terms,
          ...wordEdits(p.expected, text),
        });
      }
      if (++n % 40 === 0) process.stderr.write(`  ${n}/${total}\n`);
    }
  }
  worker.stop();

  for (const v of vocabs) {
    const mine = rows.filter((r) => r.vocab === v.name);
    console.log(`\n${v.name} — amorce de ${v.prompt.length} caractères, ${v.replacements.length} correction(s)`);
    console.log(`  ${"famille".padEnd(27)}${"termes justes".padEnd(24)}mots faux (WER)`);
    for (const [family, s] of summarize(mine))
      console.log(`  ${family.padEnd(27)}${`${s.ok}/${s.terms} (${pct(s.ok, s.terms)})`.padEnd(24)}${pct(s.edits, s.words)}`);
    if (details) {
      for (const r of mine.filter((r) => r.found.includes(false))) {
        const missing = r.terms.filter((_, i) => !r.found[i]).map((alts) => alts[0]);
        console.log(`  ✗ [${r.voice}] « ${r.expected} » → « ${r.text} » (manque : ${missing.join(", ")})`);
      }
    }
  }
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
