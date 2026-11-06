// La voix d'un tour, avec une synthèse simulée : ce que l'écran reçoit, dans l'ordre.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { FILLER_DELAY_MS, SpeechPort, SpeechTurn } from "../src/gateway/speech-turn.js";
import type { Conn } from "../src/gateway/conn.js";

function setup(latest = true) {
  const sent: Array<Record<string, unknown>> = [];
  const states: string[] = [];
  const spoken: string[] = [];
  const cancelled: number[] = [];
  const routes = { speaking: 0, silent: 0 };
  const port: SpeechPort = {
    send: (body) => sent.push(body as Record<string, unknown>),
    setState: (state) => states.push(state),
    isLatest: () => latest,
    speaking: () => routes.speaking++,
    silent: () => routes.silent++,
    tts: {
      sampleRate: 24000,
      toSpeech: (text) => (/^[\p{Emoji}\s]+$/u.test(text) ? "" : text),
      speak: (_id, text) => spoken.push(text),
      cancel: (id) => cancelled.push(id),
    },
  };
  const turn = new SpeechTurn({} as Conn, "t1", port);
  const types = () => sent.map((m) => m.type);
  return { turn, sent, states, spoken, cancelled, routes, types };
}

test("voix d'un tour : début de l'audio, repère de chaque phrase à son début, fin quand tout est dit", () => {
  const { turn, sent, states, spoken, routes, types } = setup();
  turn.say({ text: "Bonjour.", speech: "Bonjour." });
  turn.say({ text: "Il est 16 h.", speech: "Il est 16 heures." });
  assert.deepEqual(types(), ["audio.start"]);
  assert.deepEqual(spoken, ["Bonjour.", "Il est 16 heures."]);
  assert.deepEqual(states, ["speaking"]);
  turn.sentenceStarted();
  turn.sentenceEnded();
  turn.sentenceStarted();
  turn.sentenceEnded();
  assert.deepEqual(types(), ["audio.start", "speech.segment", "speech.segment"], "pas de fin tant que la génération continue");
  assert.deepEqual(
    sent.filter((m) => m.type === "speech.segment").map((m) => m.text),
    ["Bonjour.", "Il est 16 h."],
    "le texte écrit, pas le texte dit",
  );
  turn.finish();
  assert.deepEqual(types().slice(-1), ["audio.end"]);
  assert.deepEqual(states, ["speaking", "idle"]);
  assert.deepEqual(routes, { speaking: 1, silent: 1 });
});

test("voix d'un tour : une phrase sans rien à dire est repérée tout de suite, sans audio", () => {
  const { turn, sent, spoken, types } = setup();
  turn.say({ text: "🙂", speech: "🙂" });
  assert.deepEqual(types(), ["speech.segment"]);
  assert.equal(sent[0].silent, true);
  assert.deepEqual(spoken, []);
  turn.finish();
  assert.deepEqual(types(), ["speech.segment"], "aucun audio commencé : rien à terminer");
});

test("voix d'un tour : coupée, la synthèse est annulée et plus rien ne part", () => {
  const { turn, cancelled, types } = setup();
  turn.say({ text: "Une longue phrase.", speech: "Une longue phrase." });
  turn.cancelAudio(true);
  assert.deepEqual(cancelled, [turn.streamId]);
  assert.deepEqual(types(), ["audio.start", "audio.end"]);
  turn.sentenceStarted();
  turn.say({ text: "Encore.", speech: "Encore." });
  turn.sentenceEnded();
  turn.finish();
  assert.deepEqual(types(), ["audio.start", "audio.end"]);
  assert.equal(turn.frame(new Uint8Array(4)), undefined, "plus aucune trame");
});

test("voix d'un tour : un tour qui n'est plus le dernier ne remet pas l'écran au repos", () => {
  const { turn, states } = setup(false);
  turn.say({ text: "Ancienne réponse.", speech: "Ancienne réponse." });
  turn.sentenceEnded();
  turn.finish();
  assert.deepEqual(states, ["speaking"]);
});

test("voix d'un tour : rien de dit à temps, une phrase d'attente part ; une vraie phrase l'annule", async () => {
  const late = setup();
  late.turn.startFiller();
  await sleep(FILLER_DELAY_MS + 100);
  assert.equal(late.spoken.length, 1, "la phrase d'attente est partie");
  late.turn.sentenceStarted();
  assert.deepEqual(late.types(), ["audio.start"], "la phrase d'attente n'a pas de texte affiché");
  late.turn.clearFiller();

  const quick = setup();
  quick.turn.startFiller();
  quick.turn.say({ text: "Tout de suite.", speech: "Tout de suite." });
  await sleep(FILLER_DELAY_MS + 100);
  assert.deepEqual(quick.spoken, ["Tout de suite."]);
});
