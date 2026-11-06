/**
 * Parler en maintenant une touche, comme avec un talkie-walkie. Tant qu'elle
 * est tenue, ta phrase s'enregistre ; relâchée, elle part aussitôt, sans
 * attendre de silence. Deux gestes :
 *
 * - ⌥ droite seule : la prise de parole ne commence qu'après 0,2 s sans autre
 *   touche. Sinon c'était un raccourci (⌥ A, un caractère ⌥ (…) et rien ne se
 *   passe. Le pré-enregistrement couvre ce délai : le premier mot n'est pas perdu.
 * - ⌥ Espace (l'un ou l'autre ⌥) : tout de suite.
 *
 * Une page ne voit le clavier que si elle l'a : TradingView devant, ⌥ va à
 * TradingView. L'application Kopilia (apps/desktop) écoute le clavier de tout
 * le Mac et transmet les gestes de ⌥ à la page (évènement `kopilia-key`, mêmes
 * champs) : la même machine à états en décide.
 *
 * Fonctions et classes pures, sans API du navigateur : testées en Node.
 */

/** Ce que l'application Kopilia dit d'elle à la page, avant ses scripts. Absent : une page dans un navigateur. */
export interface KopiliaApp {
  /** Elle écoute le clavier de tout le Mac (autorisation « Surveillance de l'entrée » donnée). */
  tap: boolean;
  /** Tu es absent : Mac verrouillé, ou sans clavier ni souris depuis 3 minutes. */
  away?: boolean;
}

export function kopiliaApp(scope: object = globalThis): KopiliaApp | undefined {
  return (scope as { __KOPILIA_APP__?: KopiliaApp }).__KOPILIA_APP__;
}

/**
 * Ce que la page dit au serveur (`page.visibility`) : personne ne la regarde,
 * ce que Kopilia dit part aussi sur Telegram. Dans un navigateur, c'est l'onglet
 * caché. Dans l'application, sa fenêtre est souvent cachée ou derrière
 * TradingView alors que tu es là : c'est ton absence qui compte.
 */
export function unwatched(app: KopiliaApp | undefined, documentHidden: boolean): boolean {
  return app ? !!app.away : documentHidden;
}

/** Le nom de la touche, pour l'écran. */
export const PTT_KEY = "⌥ droite";

export const PTT = {
  /** ⌥ droite seule : temps sans autre touche avant que ce soit une prise de parole (ms). */
  aloneMs: 200,
  /** Au-delà, la phrase part d'elle-même (ms) : rien ne reste bloqué si un relâchement se perd. */
  maxMs: 60_000,
  /** Plus court, l'appui ne transcrit rien : c'est un « tais-toi » (ms). */
  tapMs: 300,
};

/** Ce qu'il faut d'un évènement clavier (KeyboardEvent en a toutes les propriétés). */
export interface KeyLike {
  type: string;
  code: string;
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export interface PttHandlers {
  /** La prise de parole commence : Kopilia se tait, l'enregistrement part. */
  press(): void;
  /** Relâchée (ou page quittée, ou durée maximale) au bout de `heldMs` depuis l'appui. */
  release(heldMs: number): void;
  /** Une autre touche pendant la prise de parole : c'était un raccourci, rien ne part. */
  cancel(): void;
  /** ⌥ droite tapée seule, trop vite pour une prise de parole : Kopilia se tait. */
  tap(): void;
}

export interface PttClock {
  now(): number;
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: PttClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type State =
  | { kind: "idle" }
  /** ⌥ droite enfoncée, pas encore 0,2 s sans autre touche. */
  | { kind: "pending"; since: number; timer: unknown }
  | { kind: "held"; via: "alone" | "space"; since: number; timer: unknown };

/** ⌥ Espace : Espace avec l'un des ⌥, sans ⌘ ni ⌃. */
function isOptionSpace(e: KeyLike): boolean {
  return e.code === "Space" && e.altKey && !e.metaKey && !e.ctrlKey;
}

const isOption = (e: KeyLike) => e.code === "AltRight" || e.code === "AltLeft" || e.key === "Alt";

/** Le geste « maintenir pour parler », à partir des évènements clavier de la page. */
export class PushToTalk {
  private state: State = { kind: "idle" };
  /** L'Espace d'un ⌥ Espace est encore enfoncé. */
  private spaceDown = false;

  constructor(
    private readonly on: PttHandlers,
    private readonly clock: PttClock = realClock,
    private readonly o = PTT,
  ) {}

  /** Une prise de parole est en cours (Kopilia enregistre). */
  get held(): boolean {
    return this.state.kind === "held";
  }

  /**
   * Un évènement clavier de la page. Renvoie vrai quand le navigateur doit
   * l'ignorer (preventDefault) : ⌥ Espace ne doit pas écrire d'espace insécable.
   */
  key(e: KeyLike): boolean {
    return e.type === "keydown" ? this.down(e) : e.type === "keyup" ? this.up(e) : false;
  }

  /** La page perd le clavier (autre fenêtre, onglet caché) : un relâchement ailleurs n'arriverait jamais. */
  blur(): void {
    if (this.state.kind === "pending") this.reset();
    else if (this.state.kind === "held") this.finish();
  }

  private down(e: KeyLike): boolean {
    if (isOptionSpace(e)) this.spaceDown = true;
    const s = this.state;
    if (s.kind === "held") {
      if (isOptionSpace(e)) return true; // ⌥ droite tenue, puis Espace, ou répétition : le même geste
      if (isOption(e)) return false;
      this.reset();
      this.on.cancel();
      return false;
    }
    if (e.repeat) return false;
    if (s.kind === "pending") {
      if (e.code === "AltRight") return false;
      this.reset(); // une autre touche : c'était un raccourci (⌥ A, ⌥ (…)
    }
    if (isOptionSpace(e)) {
      this.hold("space", this.clock.now());
      return true;
    }
    if (e.code === "AltRight" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const since = this.clock.now();
      const timer = this.clock.setTimeout(() => {
        if (this.state.kind === "pending") this.hold("alone", since);
      }, this.o.aloneMs);
      this.state = { kind: "pending", since, timer };
    }
    return false;
  }

  private up(e: KeyLike): boolean {
    // L'Espace d'un ⌥ Espace, relâché même après la fin du geste, ne doit rien faire (ni cliquer un bouton).
    const swallow = e.code === "Space" && this.spaceDown;
    if (e.code === "Space") this.spaceDown = false;
    const s = this.state;
    if (s.kind === "pending") {
      if (e.code === "AltRight") {
        this.reset();
        this.on.tap();
      }
      return swallow;
    }
    if (s.kind === "held" && (s.via === "alone" ? e.code === "AltRight" : e.code === "Space" || isOption(e))) this.finish();
    return swallow;
  }

  private hold(via: "alone" | "space", since: number): void {
    this.clearTimer();
    // Un relâchement perdu ne laisse jamais Kopilia à l'écoute.
    const timer = this.clock.setTimeout(() => this.finish(), this.o.maxMs);
    this.state = { kind: "held", via, since, timer };
    this.on.press();
  }

  private finish(): void {
    const s = this.state;
    if (s.kind !== "held") return;
    this.reset();
    this.on.release(this.clock.now() - s.since);
  }

  private reset(): void {
    this.clearTimer();
    this.state = { kind: "idle" };
  }

  private clearTimer(): void {
    if (this.state.kind !== "idle") this.clock.clearTimeout(this.state.timer);
  }
}

/* ------------------------------ L'audio ------------------------------ */

export const RECORDER = {
  sampleRate: 16000,
  /** Audio gardé avant l'appui (ms) : les premiers mots, et le délai de ⌥ droite seule. */
  prerollMs: 300,
  /** Audio gardé après le relâchement (ms) : on lâche souvent la touche sur la dernière syllabe. */
  tailMs: 250,
  /** Silence ajouté à la fin (ms) : Whisper rend vide un morceau court qui s'arrête net. */
  padMs: 500,
  /** Probabilité de voix humaine (Silero) qui fait compter une trame comme parlée. */
  voiceProb: 0.5,
  /** Moins de voix que cela (ms) : rien n'a été dit, la touche a été relâchée sans parler. */
  minVoicedMs: 150,
  /** En dessous (dBFS), jamais de voix. */
  minDb: -50,
};

/** Fin d'un enregistrement : sa durée de voix, absente si le détecteur n'était pas là. */
export interface RecordingEnd {
  voicedMs?: number;
}

/**
 * L'audio d'une prise de parole à la touche. Le micro reste ouvert : hors
 * appui, ses trames ne vont nulle part, sauf les 0,3 dernières secondes
 * gardées en mémoire. À l'appui, elles partent d'abord, puis le direct ; au
 * relâchement, encore 0,25 s, puis un peu de silence. Le temps est compté en
 * trames et non par une minuterie : un onglet caché ralentit les minuteries.
 */
export class PttRecorder {
  private ring: Int16Array[] = [];
  private ringMs = 0;
  private phase: "idle" | "recording" | "tail" = "idle";
  private tailLeft = 0;
  private voicedMs = 0;
  /** Au moins une trame a eu une probabilité de voix. */
  private voiceKnown = false;
  private lastDb = -120;

  constructor(
    private readonly send: (pcm: Int16Array) => void,
    private readonly done: (end: RecordingEnd) => void,
    private readonly o = RECORDER,
  ) {}

  get recording(): boolean {
    return this.phase !== "idle";
  }

  /** Niveau 0..1 de la dernière trame, pour l'orbe. */
  get level(): number {
    return Math.min(1, Math.max(0, (this.lastDb + 55) / 35));
  }

  /** Une trame du micro ; `voiceProb` : la dernière probabilité de voix (Silero), absente s'il n'est pas chargé. */
  push(pcm: Int16Array, voiceProb?: number): void {
    const ms = (pcm.length / this.o.sampleRate) * 1000;
    const db = rmsDb(pcm);
    this.lastDb = db;
    if (this.phase === "idle") {
      this.ring.push(pcm);
      this.ringMs += ms;
      while (this.ring.length > 1 && this.ringMs - this.durationMs(this.ring[0]) >= this.o.prerollMs) {
        this.ringMs -= this.durationMs(this.ring.shift()!);
      }
      return;
    }
    this.count(ms, db, voiceProb);
    this.send(pcm);
    if (this.phase === "tail") {
      this.tailLeft -= ms;
      if (this.tailLeft <= 0) this.end();
    }
  }

  /** La touche est enfoncée : le pré-enregistrement part, puis le direct. */
  start(): void {
    if (this.phase !== "idle") return;
    this.phase = "recording";
    this.voicedMs = 0;
    this.voiceKnown = false;
    const preroll = this.ring;
    this.ring = [];
    this.ringMs = 0;
    // Le pré-enregistrement n'a pas de probabilité à lui : il part sans compter.
    for (const pcm of preroll) this.send(pcm);
  }

  /** La touche est relâchée : encore un peu d'audio, du silence, puis `done`. */
  stop(): void {
    if (this.phase !== "recording") return;
    this.phase = "tail";
    this.tailLeft = this.o.tailMs;
  }

  /** Abandon : rien de plus ne part, `done` n'est pas appelé. */
  cancel(): void {
    this.phase = "idle";
  }

  private end(): void {
    this.phase = "idle";
    this.send(new Int16Array(Math.round((this.o.padMs / 1000) * this.o.sampleRate)));
    this.done(this.voiceKnown ? { voicedMs: Math.round(this.voicedMs) } : {});
  }

  /**
   * Une trame sans probabilité (le détecteur démarre, ou n'est pas là) ne compte
   * pas ; la mesure n'est inconnue que si aucune trame n'en a eu.
   */
  private count(ms: number, db: number, voiceProb: number | undefined): void {
    if (voiceProb === undefined) return;
    this.voiceKnown = true;
    if (voiceProb >= this.o.voiceProb && db > this.o.minDb) this.voicedMs += ms;
  }

  private durationMs(pcm: Int16Array): number {
    return (pcm.length / this.o.sampleRate) * 1000;
  }
}

/** Niveau RMS d'une trame PCM16, en dBFS. */
export function rmsDb(pcm: Int16Array): number {
  if (!pcm.length) return -120;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return 20 * Math.log10(Math.max(Math.sqrt(sum / pcm.length), 1e-6));
}
