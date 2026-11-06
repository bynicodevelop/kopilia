import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechSync, revealWords } from "../src/app/audio/speech-sync";

const REPLY = "Le NFP sort à 14 h 30. Puis la BCE.";
const [ONE, TWO] = ["Le NFP sort à 14 h 30.", " Puis la BCE."];

/** Réponse reçue en entier, phrase 1 repérée et calée à t = 10 s pour 2 s de voix. */
function started(): SpeechSync {
  const s = new SpeechSync();
  s.addText(REPLY);
  s.mark(0, ONE);
  s.audio(10, 1.2);
  s.audio(11.2, 0.8);
  return s;
}

test("rien ne s'affiche avant la voix, même si tout le texte est arrivé", () => {
  const s = new SpeechSync();
  s.addText(REPLY);
  assert.equal(s.visible(5), "");
  s.mark(0, ONE);
  assert.equal(s.visible(5), "", "repérée mais sans audio programmé : on attend sa première tranche");
  s.audio(10, 2);
  assert.equal(s.visible(9.5), "", "la voix n'a pas commencé");
});

test("la phrase se révèle mot à mot pendant qu'elle est dite, puis en entier", () => {
  const s = started();
  const early = s.visible(10);
  assert.equal(early, "Le", "le premier mot apparaît quand il commence à être dit");
  const middle = s.visible(11);
  assert.ok(middle.length > early.length && middle.length < ONE.length, `à mi-phrase : « ${middle} »`);
  assert.ok(ONE.startsWith(middle) && ONE[middle.length] === " ", "coupé sur une fin de mot");
  assert.equal(s.visible(12), ONE);
});

test("la phrase suivante attend sa propre voix (même si son texte est déjà là)", () => {
  const s = started();
  s.mark(1, TWO);
  assert.equal(s.visible(12.5), ONE, "repérée, mais son audio n'est pas encore programmé");
  s.audio(12.6, 1);
  assert.equal(s.visible(12.4), ONE);
  assert.equal(s.visible(13.7), REPLY);
});

test("pause de lecture : horloge gelée, texte figé ; l'affichage ne recule jamais", () => {
  const s = started();
  const paused = s.visible(10.8);
  assert.equal(s.visible(10.8), paused);
  s.audio(12, 3); // une tranche de plus allonge la phrase : la proportion baisse, pas l'affichage
  assert.equal(s.visible(10.8), paused);
});

test("phrase muette (bloc de code, émoji) : affichée à la suite de la précédente", () => {
  const s = started();
  s.mark(1, " 🙂", true);
  assert.equal(s.visible(10.5).includes("🙂"), false);
  assert.equal(s.visible(12), `${ONE} 🙂`);
});

test("la phrase d'attente (« Je regarde ça. ») ne décale rien", () => {
  const s = new SpeechSync();
  s.addText(ONE);
  s.audio(9, 1); // filler, sans repère
  s.mark(0, ONE);
  s.audio(10, 2);
  assert.equal(s.visible(9.5), "");
  assert.equal(s.visible(12), ONE);
});

test("tout afficher : fin, coupure ou voix absente (texte non repéré compris)", () => {
  const s = started();
  s.revealAll();
  assert.equal(s.visible(10), REPLY);
  assert.equal(s.revealedAll, true);
});

test("révélation par mots entiers", () => {
  assert.equal(revealWords("Bonjour à tous.", 0), "Bonjour");
  assert.equal(revealWords("Bonjour à tous.", 0.6), "Bonjour à", "juste avant « tous »");
  assert.equal(revealWords("Bonjour à tous.", 0.7), "Bonjour à tous.");
  assert.equal(revealWords(" Puis la BCE.", 0), "");
  assert.equal(revealWords("Bonjour à tous.", 1), "Bonjour à tous.");
});
