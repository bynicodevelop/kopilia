import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-web";
import { SILERO_FRAME, SileroModel, VoiceDetector } from "../src/app/audio/silero";
import { PttRecorder } from "../src/app/call/push-to-talk";

/*
 * Le vrai modèle Silero (celui que sert l'application), sur une vraie voix
 * française (une phrase dite par Kokoro, ff_siwis) et une musique synthétique
 * (accords, basse, batterie). Le moteur est celui de Node (onnxruntime-web).
 */

const SR = 16000;
const MODEL = join(__dirname, "../node_modules/@ricky0123/vad-web/dist/silero_vad_v6.onnx");
const loadModel = () => SileroModel.load(ort, new Uint8Array(readFileSync(MODEL)));

/** La phrase de test, en -1..1 : « Kopilia, donne-moi le prix de l'or et ouvre le graphique du Nasdaq en une heure. » */
function voice(gain = 1): Float32Array {
  const wav = readFileSync(join(__dirname, "fixtures/voix-ff_siwis-16k.wav"));
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
  return Float32Array.from(pcm, (s) => (s / 32768) * gain);
}

/** Une musique instrumentale de `sec` secondes, au niveau `db` (dBFS). */
function music(sec: number, db: number): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  const chords = [
    [261.6, 329.6, 392],
    [220, 261.6, 329.6],
    [174.6, 220, 261.6],
    [196, 246.9, 293.7],
  ];
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const beat = t % 0.5;
    const chord = chords[Math.floor(t) % 4];
    let v = 0;
    for (const f of chord) for (let h = 1; h <= 4; h++) v += (Math.sin(2 * Math.PI * f * h * t) / (h * h)) * Math.exp(-(t % 1) * 1.5);
    v += 0.8 * Math.sin(Math.PI * chord[0] * t); // basse, une octave sous la fondamentale
    v += 1.5 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 12); // grosse caisse
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (t % 0.25 < 0.03) v += ((seed / 0x7fffffff) * 2 - 1) * 0.6; // charleston
    out[i] = v;
  }
  const rms = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / out.length);
  const gain = 10 ** (db / 20) / rms;
  return out.map((x) => x * gain);
}

/** `under` mélangé à `over` à partir de l'échantillon `at`. */
function mix(under: Float32Array, over: Float32Array, at: number): Float32Array {
  const out = under.slice();
  for (let i = 0; i < over.length && at + i < out.length; i++) out[at + i] += over[i];
  return out;
}

async function probabilities(model: SileroModel, x: Float32Array): Promise<number[]> {
  model.reset();
  const out: number[] = [];
  for (let i = 0; i + SILERO_FRAME <= x.length; i += SILERO_FRAME) out.push((await model.probability(x.slice(i, i + SILERO_FRAME)))!);
  return out;
}

const share = (p: number[], min: number) => p.filter((q) => q >= min).length / p.length;

/**
 * Comme à la touche : trames de 8 ms du micro, détecteur de voix et
 * enregistrement ensemble, la touche tenue pendant tout `x`. Renvoie la voix
 * comptée (ms), qui décide si quelque chose a été dit.
 */
async function held(x: Float32Array, detector: VoiceDetector): Promise<number | undefined> {
  let voiced: number | undefined = -1;
  const rec = new PttRecorder(
    () => {},
    (end) => (voiced = end.voicedMs),
  );
  const frame = (i: number) => Int16Array.from(x.subarray(i, i + 128), (s) => Math.max(-32768, Math.min(32767, Math.round(s * 32767))));
  rec.start();
  for (let i = 0; i + 128 <= x.length; i += 128) {
    const pcm = frame(i);
    detector.push(pcm);
    await detector.settled();
    rec.push(pcm, detector.probability);
  }
  rec.stop();
  for (let i = 0; i < 40 && rec.recording; i++) rec.push(new Int16Array(128), detector.probability);
  return voiced;
}

test("modèle réel : la voix est reconnue, la musique non, même forte", async () => {
  const model = await loadModel();
  const speech = await probabilities(model, voice());
  assert.ok(share(speech, 0.5) > 0.6, `voix reconnue sur ${Math.round(share(speech, 0.5) * 100)} % des trames`);
  for (const db of [-35, -20]) {
    const p = await probabilities(model, music(6, db));
    assert.ok(Math.max(...p) < 0.3, `musique à ${db} dB prise pour une voix (max ${Math.max(...p).toFixed(2)})`);
  }
  const over = await probabilities(model, mix(music(voice().length / SR, -33), voice(), 0));
  assert.ok(share(over, 0.5) > 0.6, `voix sur musique reconnue sur ${Math.round(share(over, 0.5) * 100)} % des trames`);
});

test("touche tenue, ta phrase sur une musique de fond : ta voix est comptée, la phrase part", async () => {
  for (const db of [-40, -33]) {
    const detector = new VoiceDetector(await loadModel());
    const speech = voice(1.6); // micro près de la bouche
    const audio = mix(music(1 + speech.length / SR + 0.5, db), speech, SR);
    const ms = await held(audio, detector);
    assert.ok(ms !== undefined && ms > 1500, `musique à ${db} dB : ${ms} ms de voix comptés`);
  }
});

test("touche tenue sans rien dire, même sur une musique forte : aucune voix, rien ne part (Kopilia se tait)", async () => {
  for (const db of [-40, -27, -20]) {
    const detector = new VoiceDetector(await loadModel());
    const ms = await held(music(3, db), detector);
    assert.ok(ms !== undefined && ms < 150, `musique à ${db} dB prise pour une phrase (${ms} ms de voix)`);
  }
  const detector = new VoiceDetector(await loadModel());
  assert.equal(await held(new Float32Array(2 * SR), detector), 0, "silence : aucune voix");
});

test("détecteur : remis à zéro, il oublie l'audio d'avant", async () => {
  const detector = new VoiceDetector(await loadModel());
  const speech = voice();
  detector.push(Int16Array.from(speech.subarray(0, SR), (s) => Math.round(s * 32767)));
  detector.reset();
  await detector.settled();
  assert.equal(detector.probability, undefined, "un résultat d'avant la remise à zéro a été gardé");
});

test("détecteur en panne : Whisper décidera seul, l'erreur est signalée une fois", async () => {
  const failing = { probability: () => Promise.reject(new Error("wasm")), reset: () => {} } as unknown as SileroModel;
  const errors: unknown[] = [];
  const detector = new VoiceDetector(failing, (e) => errors.push(e));
  for (let i = 0; i < 20; i++) detector.push(new Int16Array(512));
  await detector.settled();
  for (let i = 0; i < 20; i++) detector.push(new Int16Array(512));
  await detector.settled();
  assert.equal(detector.probability, undefined);
  assert.equal(errors.length, 1);
});
