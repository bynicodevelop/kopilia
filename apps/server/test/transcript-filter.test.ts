import { test } from "node:test";
import assert from "node:assert/strict";
import { cutsReply, isLikelyHallucination, joinPhrases, looksUnfinished } from "../src/voice/transcript-filter.js";

test("hallucinations Whisper connues : rejetées", () => {
  for (const t of [
    "Sous-titres réalisés par la communauté d'Amara.org",
    "Sous-titrage ST' 501",
    "Merci d'avoir regardé cette vidéo !",
    "N'oubliez pas de vous abonner à la chaîne.",
    "[Musique]",
    "(silence)",
    "Musique.",
    "...",
    "",
  ]) {
    assert.equal(isLikelyHallucination(t), true, `aurait dû être rejeté : « ${t} »`);
  }
});

test("vraies demandes proches : conservées", () => {
  for (const t of [
    "Ajoute des sous-titres à ma vidéo",
    "Quelle musique me conseilles-tu ?",
    "Merci, c'est parfait.",
    "Merci",
    "Oui",
    "Lance les tests dans Kopilia",
  ]) {
    assert.equal(isLikelyHallucination(t), false, `aurait dû être conservé : « ${t} »`);
  }
});

test("pendant une réponse : ce qui demande à Kopilia de se taire la coupe", () => {
  for (const t of [
    "Stop.",
    "Stop, stop !",
    "Stomp, stomp.", // « Stop, stop » mal transcrit pendant que Kopilia parle
    "Stump.",
    "Attends.",
    "Attend, ouvre plutôt le graphique de l'or.",
    "Arrête.",
    "Arrête-toi.",
    "Tais-toi.",
    "Chut !",
    "Ça suffit.",
    "Laisse tomber.",
    "Non, plutôt le wrap d'hier.",
    "Euh, stop.",
    "Kopilia, attends.",
    "OK, stop.",
  ]) {
    assert.equal(cutsReply(t), true, `aurait dû couper : « ${t} »`);
  }
});

test("pendant une réponse : une autre demande ne la coupe pas, elle passe après", () => {
  for (const t of [
    "Ouvre le graphique du Nasdaq.",
    "Affiche l'or en une heure.",
    "Oui, vas-y.",
    "Qu'est-ce qui a fait bouger le dollar ?",
    "Stop loss à 28 000 sur le Nasdaq, c'est raisonnable ?",
    "Non farm payrolls, c'est à quelle heure ?",
    "Kopilia, ouvre le Nasdaq.",
    "Il ne faut pas que ça s'arrête.",
    "Nonobstant la BCE, que fait l'euro ?",
    "",
  ]) {
    assert.equal(cutsReply(t), false, `n'aurait pas dû couper : « ${t} »`);
  }
});

test("phrase inachevée : points de suspension, ou un dernier mot qui ne finit pas une phrase ; jointe à sa suite", () => {
  // Les cas vus dans ses conversations (2026-11-03 au 05).
  for (const t of [
    "Envoie le",
    "Fais-moi un...",
    "Donne me...",
    "Lorsque la...",
    "J'imagine une prise de position au niveau des...",
    "Mets une alerte à",
    "Ouvre le graphique de l’",
  ]) {
    assert.ok(looksUnfinished(t), t);
  }
  for (const t of [
    "Envoie-le.",
    "Ouvre l'or.",
    "Quel est le prix du Nasdaq ?",
    "C'est pour vous.",
    "Stop.",
    "Je veux que tu le fasses.",
    "Rouvre l'argent.",
    "Ok.",
    "Et toi ?",
    "",
  ]) {
    assert.ok(!looksUnfinished(t), t);
  }
  assert.equal(joinPhrases("Envoie le", "Dollar néo-zélandais sur mon canal."), "Envoie le dollar néo-zélandais sur mon canal.");
  assert.equal(joinPhrases("Fais-moi un...", "Pour suivre les métaux."), "Fais-moi un pour suivre les métaux.");
  assert.equal(joinPhrases("Donne-moi le prix de", "EURUSD."), "Donne-moi le prix de EURUSD.", "un sigle garde ses majuscules");
  assert.equal(joinPhrases("Donne-moi le prix de...", "L'or."), "Donne-moi le prix de l'or.");
});
