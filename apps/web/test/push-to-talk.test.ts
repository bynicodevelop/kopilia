import { test } from "node:test";
import assert from "node:assert/strict";
import { kopiliaApp, KeyLike, PttClock, PttRecorder, PushToTalk, RECORDER, unwatched } from "../src/app/call/push-to-talk";

/** Une horloge qu'on avance à la main, avec ses minuteries. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; f: () => void }>();
  const clock: PttClock = {
    now: () => now,
    setTimeout: (f, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, f });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].f();
    }
    now = end;
  };
  return { clock, advance };
}

function setup() {
  const { clock, advance } = fakeClock();
  const log: string[] = [];
  const ptt = new PushToTalk(
    {
      press: () => log.push("press"),
      release: (ms) => log.push(`release ${ms}`),
      cancel: () => log.push("cancel"),
      tap: () => log.push("tap"),
    },
    clock,
  );
  return { ptt, advance, log };
}

const key = (type: "keydown" | "keyup", code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  type,
  code,
  key: code.startsWith("Alt") ? "Alt" : code === "Space" ? " " : code.replace("Key", "").toLowerCase(),
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
});
const optRight = (type: "keydown" | "keyup") => key(type, "AltRight", { altKey: type === "keydown" });

test("⌥ droite seule : la prise de parole commence après 0,2 s sans autre touche, et finit au relâchement", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(150);
  assert.deepEqual(log, [], "pas encore : ce pourrait être un raccourci");
  advance(60);
  assert.deepEqual(log, ["press"]);
  assert.equal(ptt.held, true);
  advance(1300);
  ptt.key(optRight("keyup"));
  assert.deepEqual(log, ["press", "release 1510"], "durée comptée depuis l'appui");
  assert.equal(ptt.held, false);
});

test("⌥ droite puis une autre touche : un raccourci (⌥ A, un caractère ⌥ (), rien ne se passe", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(80);
  assert.equal(ptt.key(key("keydown", "KeyQ", { altKey: true })), false, "la touche suit son chemin (Alt+A du graphique)");
  advance(500);
  ptt.key(optRight("keyup"));
  assert.deepEqual(log, [], "ni prise de parole, ni « tais-toi »");
});

test("⌥ droite tenue, puis une autre touche après le début : annulé, rien ne part", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(400);
  ptt.key(key("keydown", "Digit5", { altKey: true }));
  ptt.key(optRight("keyup"));
  assert.deepEqual(log, ["press", "cancel"]);
});

test("⌥ droite tapée seule, vite : Kopilia se tait", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(120);
  ptt.key(optRight("keyup"));
  advance(500);
  assert.deepEqual(log, ["tap"]);
});

test("⌥ droite avec ⇧, ⌘ ou ⌃ déjà tenue : un raccourci, pas une prise de parole", () => {
  const { ptt, advance, log } = setup();
  for (const mods of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }]) {
    ptt.key(key("keydown", "AltRight", { altKey: true, ...mods }));
    advance(500);
    ptt.key(optRight("keyup"));
  }
  assert.deepEqual(log, []);
});

test("⌥ Espace : tout de suite, sans espace insécable ; répétitions ignorées ; fin au relâchement de l'une des deux", () => {
  const { ptt, advance, log } = setup();
  ptt.key(key("keydown", "AltLeft", { altKey: true }));
  assert.equal(ptt.key(key("keydown", "Space", { altKey: true })), true, "l'espace insécable ne s'écrit pas");
  assert.deepEqual(log, ["press"]);
  advance(700);
  assert.equal(ptt.key(key("keydown", "Space", { altKey: true, repeat: true })), true, "répétition : ignorée, sans écrire");
  advance(300);
  assert.equal(ptt.key(key("keyup", "Space", { altKey: true })), true);
  assert.deepEqual(log, ["press", "release 1000"]);

  ptt.key(key("keydown", "Space", { altKey: true }));
  advance(600);
  ptt.key(key("keyup", "AltLeft"));
  assert.deepEqual(log.slice(2), ["press", "release 600"], "⌥ relâché avant Espace : fini aussi");
  assert.equal(ptt.key(key("keyup", "Space")), true, "l'Espace relâché ensuite ne fait rien");
  assert.deepEqual(log.length, 4);
});

test("⌥ droite puis Espace : c'est ⌥ Espace, tout de suite", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(50);
  ptt.key(key("keydown", "Space", { altKey: true }));
  assert.deepEqual(log, ["press"]);
  advance(400);
  ptt.key(key("keyup", "Space", { altKey: true }));
  ptt.key(optRight("keyup"));
  assert.deepEqual(log, ["press", "release 400"], "une seule prise de parole");
});

test("Espace seule, ⌘ Espace, ⌃ ⌥ Espace : rien (Espace s'écrit, Spotlight reste à macOS)", () => {
  const { ptt, log } = setup();
  assert.equal(ptt.key(key("keydown", "Space")), false);
  assert.equal(ptt.key(key("keydown", "Space", { metaKey: true })), false);
  assert.equal(ptt.key(key("keydown", "Space", { altKey: true, ctrlKey: true })), false);
  assert.deepEqual(log, []);
});

test("page quittée pendant l'appui : la phrase part ; avant le début : rien", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(900);
  ptt.blur();
  assert.deepEqual(log, ["press", "release 900"]);
  ptt.key(optRight("keyup"));
  assert.equal(log.length, 2, "le relâchement arrivé après ne compte plus");

  ptt.key(optRight("keydown"));
  advance(100);
  ptt.blur();
  advance(500);
  assert.equal(log.length, 2, "pas encore une prise de parole : oubliée");
});

test("relâchement jamais reçu : la phrase part d'elle-même au bout de 60 s", () => {
  const { ptt, advance, log } = setup();
  ptt.key(key("keydown", "Space", { altKey: true }));
  advance(60_000);
  assert.deepEqual(log, ["press", "release 60000"]);
  assert.equal(ptt.held, false);
});

/* ------------------------------ L'audio ------------------------------ */

const FRAME = 128; // un bloc AudioWorklet à 16 kHz (8 ms)
const frame = (amp: number) => Int16Array.from({ length: FRAME }, (_, i) => Math.round(Math.sin(i / 3) * amp * 32767));
const ms = (frames: Int16Array[]) => (frames.reduce((n, f) => n + f.length, 0) / RECORDER.sampleRate) * 1000;

test("audio : les 0,3 s d'avant l'appui partent d'abord, puis le direct ; rien ne part hors appui", () => {
  const sent: Int16Array[] = [];
  const rec = new PttRecorder(
    (f) => sent.push(f),
    () => {},
  );
  for (let i = 0; i < 100; i++) rec.push(frame(0.1)); // 0,8 s avant l'appui
  assert.equal(sent.length, 0, "hors appui, rien ne part");
  rec.start();
  assert.ok(ms(sent) >= 300 && ms(sent) < 310, `pré-enregistrement : ${ms(sent)} ms`);
  rec.push(frame(0.1));
  assert.ok(ms(sent) > 305);
});

test("audio : au relâchement, encore 0,25 s, puis 0,5 s de silence, puis la fin avec la voix comptée", () => {
  const sent: Int16Array[] = [];
  const ends: Array<{ voicedMs?: number }> = [];
  const rec = new PttRecorder(
    (f) => sent.push(f),
    (e) => ends.push(e),
  );
  rec.start();
  for (let i = 0; i < 125; i++) rec.push(frame(0.2), 0.9); // 1 s de voix
  rec.stop();
  const before = sent.length;
  for (let i = 0; i < 40; i++) rec.push(frame(0.01), 0.1); // la suite du micro : 0,25 s gardées
  assert.equal(ends.length, 1);
  const tail = sent.slice(before, -1);
  assert.ok(ms(tail) >= 250 && ms(tail) < 260, `après le relâchement : ${ms(tail)} ms`);
  const pad = sent.at(-1)!;
  assert.equal(ms([pad]), 500);
  assert.ok(
    pad.every((s) => s === 0),
    "du silence",
  );
  assert.equal(ends[0].voicedMs, 1000);
  const after = sent.length;
  rec.push(frame(0.2), 0.9);
  assert.equal(sent.length, after, "fini : plus rien ne part");
});

test("audio : sans voix (musique, souffle), la voix comptée est nulle ; sans détecteur, elle est inconnue", () => {
  const ends: Array<{ voicedMs?: number }> = [];
  const rec = new PttRecorder(
    () => {},
    (e) => ends.push(e),
  );
  rec.start();
  for (let i = 0; i < 100; i++) rec.push(frame(0.3), 0.05); // fort, mais pas une voix
  for (let i = 0; i < 100; i++) rec.push(frame(0.0001), 0.9); // une « voix » trop faible pour en être une
  rec.stop();
  for (let i = 0; i < 40; i++) rec.push(frame(0.01), 0.1);
  assert.equal(ends[0].voicedMs, 0);

  rec.start();
  for (let i = 0; i < 50; i++) rec.push(frame(0.2));
  rec.stop();
  for (let i = 0; i < 40; i++) rec.push(frame(0.2));
  assert.deepEqual(ends[1], {}, "détecteur absent : Whisper décidera");
});

test("audio : abandon pendant la fin, rien de plus ne part et la fin n'est pas annoncée", () => {
  const sent: Int16Array[] = [];
  const ends: unknown[] = [];
  const rec = new PttRecorder(
    (f) => sent.push(f),
    (e) => ends.push(e),
  );
  rec.start();
  rec.push(frame(0.2), 0.9);
  rec.stop();
  rec.cancel();
  const n = sent.length;
  for (let i = 0; i < 40; i++) rec.push(frame(0.2), 0.9);
  assert.equal(sent.length, n);
  assert.equal(ends.length, 0);
  assert.equal(rec.recording, false);
});

/* --------- Gestes transmis par l'application Kopilia (écoute du clavier de tout le Mac) --------- */

test("application : une autre touche pendant ⌥ arrive sans dire laquelle (« Other ») et annule de la même façon", () => {
  const { ptt, advance, log } = setup();
  ptt.key(optRight("keydown"));
  advance(80);
  ptt.key(key("keydown", "Other", { altKey: true }));
  advance(400);
  ptt.key(optRight("keyup"));
  assert.deepEqual(log, [], "⌥ + une lettre dans TradingView, vite : rien");

  ptt.key(optRight("keydown"));
  advance(400);
  ptt.key(key("keydown", "Other", { altKey: true, metaKey: true }));
  ptt.key(optRight("keyup"));
  assert.deepEqual(log, ["press", "cancel"], "⌘ enfoncée pendant la prise de parole : annulée");
});

test("application : ⌥ Espace signalé deux fois (écoute du clavier et raccourci global), un seul geste", () => {
  const { ptt, advance, log } = setup();
  ptt.key(key("keydown", "AltLeft", { altKey: true }));
  ptt.key(key("keydown", "Space", { altKey: true }));
  ptt.key(key("keydown", "Space", { altKey: true }));
  advance(900);
  ptt.key(key("keyup", "Space"));
  ptt.key(key("keyup", "Space"));
  ptt.key(key("keyup", "AltLeft"));
  assert.deepEqual(log, ["press", "release 900"]);
});

test("application : présente seulement si elle s'est annoncée avant les scripts de la page", () => {
  assert.equal(kopiliaApp({}), undefined, "un navigateur");
  assert.deepEqual(kopiliaApp({ __KOPILIA_APP__: { tap: false } }), { tap: false }, "sans « Surveillance de l'entrée »");
  assert.equal(kopiliaApp({ __KOPILIA_APP__: { tap: true } })?.tap, true);
});

test("personne ne regarde : l'onglet caché dans un navigateur ; dans l'application, ton absence, fenêtre cachée ou non", () => {
  assert.equal(unwatched(undefined, true), true, "navigateur, onglet caché");
  assert.equal(unwatched(undefined, false), false);
  assert.equal(unwatched({ tap: true }, true), false, "application, fenêtre cachée ou derrière TradingView, toi là");
  assert.equal(unwatched({ tap: true, away: false }, true), false);
  assert.equal(unwatched({ tap: false, away: true }, false), true, "Mac verrouillé ou inactif, même fenêtre devant");
});
