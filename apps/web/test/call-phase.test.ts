import { test } from "node:test";
import assert from "node:assert/strict";
import { CallState, canInterruptOf, hintFor, phaseOf, reconnectDelay } from "../src/app/call/phase";

const base: CallState = { connected: true, armed: true, userSpeaking: false, holding: false, speaking: false, state: "idle" };

test("phase : hors ligne, avant le premier geste, puis selon la touche et Kopilia", () => {
  assert.equal(phaseOf({ ...base, connected: false }), "offline");
  assert.equal(phaseOf({ ...base, armed: false, state: "speaking" }), "ready", "pas encore de son : prêt, quoi que dise le serveur");
  assert.equal(phaseOf(base), "listening");
  assert.equal(phaseOf({ ...base, userSpeaking: true, state: "speaking" }), "hearing", "touche tenue : priorité à ta phrase");
  assert.equal(phaseOf({ ...base, holding: true }), "thinking", "Kopilia attend la fin de ta phrase");
  assert.equal(phaseOf({ ...base, state: "transcribing" }), "thinking");
  assert.equal(phaseOf({ ...base, state: "idle", speaking: true }), "speaking", "la réponse s'entend encore après la fin de l'envoi");
});

test("couper la parole : seulement pendant que Kopilia réfléchit ou parle, son autorisé", () => {
  assert.equal(canInterruptOf({ armed: true, speaking: false, state: "thinking" }), true);
  assert.equal(canInterruptOf({ armed: true, speaking: true, state: "idle" }), true);
  assert.equal(canInterruptOf({ armed: true, speaking: false, state: "transcribing" }), false, "sa propre phrase est en cours de transcription");
  assert.equal(canInterruptOf({ armed: false, speaking: true, state: "speaking" }), false);
});

test("ligne d'aide : la touche, documents en attente, micro absent", () => {
  const o = { readyDocs: 0, micSupported: true };
  assert.equal(hintFor("ready", o), "Maintiens ⌥ droite pour parler");
  assert.equal(hintFor("listening", o), "Maintiens ⌥ droite pour parler");
  assert.equal(hintFor("listening", { ...o, readyDocs: 2 }), "Maintiens ⌥ droite et dis-moi quoi faire des documents");
  assert.equal(hintFor("ready", { ...o, readyDocs: 1 }), "Maintiens ⌥ droite et dis-moi quoi faire du document");
  assert.equal(hintFor("ready", { ...o, micSupported: false }), "Micro indisponible dans ce navigateur");
  assert.equal(hintFor("hearing", o), "Je t'écoute… lâche pour envoyer");
  assert.equal(hintFor("speaking", o), "Appuie sur ⌥ droite pour m'arrêter");
});

test("reconnexion : 1, 2, 4, 8 s, puis 10 s au plus", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelay), [1000, 2000, 4000, 8000, 10_000, 10_000]);
});
