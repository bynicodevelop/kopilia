import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { applyReplacements, buildSttPrompt, parseVocabulary, readVocabularyFile } from "../src/voice/vocabulary.js";
import { isPromptEcho } from "../src/voice/transcript-filter.js";

test("fichier de vocabulaire : termes, corrections, commentaires", () => {
  const v = parseVocabulary("# titre\nKopilia\n\n  BCE  # sigle\nCopilia => Kopilia\npont à vent => Pont-Aven\n=> rien\n");
  assert.deepEqual(v.terms, ["Kopilia", "BCE"]);
  assert.deepEqual(v.replacements, [
    ["Copilia", "Kopilia"],
    ["pont à vent", "Pont-Aven"],
  ]);
});

test("amorce : liste sans doublon, coupée sur un terme entier", () => {
  assert.equal(buildSttPrompt(["Kopilia", "BCE", "bce", " Fed "]), "Kopilia, BCE, Fed.");
  assert.equal(buildSttPrompt(["Kopilia", "Annecy", "Nasdaq"], 20), "Kopilia, Annecy.");
  assert.equal(buildSttPrompt([]), "");
});

test("corrections : mots entiers, sans tenir compte de la casse, expressions comprises", () => {
  const r: Array<[string, string]> = [
    ["Copilia", "Kopilia"],
    ["pont à vent", "Pont-Aven"],
  ];
  assert.equal(applyReplacements("copilia, le cinéma de Pont  à vent ?", r), "Kopilia, le cinéma de Pont-Aven ?");
  assert.equal(applyReplacements("Copiliaite", r), "Copiliaite", "jamais à l'intérieur d'un mot");
});

test("recopie de l'amorce sur du bruit : écartée ; une vraie phrase courte reste", () => {
  const prompt = "Kopilia, Annecy, BCE, Fed, FOMC, taux directeurs.";
  assert.equal(isPromptEcho("Kopilia, Annecy, BCE.", prompt), true);
  assert.equal(isPromptEcho("FOMC, taux directeurs", prompt), true);
  assert.equal(isPromptEcho("Kopilia ?", prompt), false, "s'adresser à Kopilia par son nom");
  assert.equal(isPromptEcho("Quelle est la décision de la Fed ?", prompt), false);
  assert.equal(isPromptEcho("Kopilia, Annecy, BCE.", undefined), false);
});

test("config/vocabulaire.example.txt : amorce entière, corrections des erreurs relevées sur ses produits", () => {
  const v = readVocabularyFile(fileURLToPath(new URL("../../../config/vocabulaire.example.txt", import.meta.url)));
  assert.equal(buildSttPrompt(v.terms), `${v.terms.join(", ")}.`, "aucun terme coupé de l'amorce");

  // Phrases réellement transcrites (table turns, 2026-11-04 et 05) et sur le banc (pnpm stt:bench).
  const fix = (text: string) => applyReplacements(text, v.replacements);
  assert.equal(fix("Je suis en vente sur le Royenne."), "Je suis en vente sur l'euro-yen.");
  assert.equal(fix("Ok, ferme le royen."), "Ok, ferme l'euro-yen.");
  assert.equal(fix("Est-ce que tu peux envoyer sur mon canal le dollarienne ?"), "Est-ce que tu peux envoyer sur mon canal le dollar-yen ?");
  assert.equal(fix("Affiche le cadienne."), "Affiche le CAD-yen.");
  assert.equal(fix("le dollar néo-zerlandais par rapport à l'USD"), "le dollar néo-zélandais par rapport à l'USD");
  assert.equal(fix("Dollar Néo-Sierlandais sur mon canal Telegram"), "Dollar néo-zélandais sur mon canal Telegram");
  assert.equal(fix("une capture d'écran sur Goulard Neuzerlandais"), "une capture d'écran sur Goulard néo-zélandais");
  assert.equal(fix("Je peux que tu m'affiches une liste de mes produits."), "Je veux que tu m'affiches une liste de mes produits.");
  assert.equal(fix("COPILIA, quel est le prochain chiffre américain ?"), "Kopilia, quel est le prochain chiffre américain ?");

  // Les vrais mots restent.
  for (const ok of ["Je pars à Rouen, puis à Royan.", "Une Acadienne.", "Je peux te dire que tu as raison.", "Le dollar australien."])
    assert.equal(fix(ok), ok);
});
