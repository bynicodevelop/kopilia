import { AudioFormat, BinaryKind, encodeBinaryFrame, PipelineState } from "@kopilia/contracts";
import { nextStreamId } from "../common/ids.js";
import type { Segment } from "../voice/sentence-grouper.js";
import type { Conn } from "./conn.js";
import type { ServerBody } from "./messages.js";

/** Délai avant de jouer un filler si aucune parole n'est encore produite (ms). */
export const FILLER_DELAY_MS = 700;
/** Phrases d'attente courtes et variées (couche 1). */
const FILLERS = ["Je regarde ça.", "Un instant.", "Laisse-moi vérifier.", "Je vérifie."];

/** Ce dont un tour a besoin de la passerelle et de la synthèse. */
export interface SpeechPort {
  send(body: ServerBody): void;
  setState(state: PipelineState): void;
  /** Ce tour est le dernier lancé sur sa connexion (un tour plus ancien ne pilote plus l'état). */
  isLatest(turnId: string): boolean;
  /** Le tour commence à parler : ses trames de synthèse doivent lui revenir. */
  speaking(turn: SpeechTurn): void;
  /** Le tour a fini de parler (toutes ses phrases dites). */
  silent(turn: SpeechTurn): void;
  tts: {
    readonly sampleRate: number;
    toSpeech(text: string): string;
    speak(streamId: number, text: string): void;
    cancel(streamId: number): void;
  };
}

/**
 * La voix d'un tour de Kopilia : la phrase d'attente si rien n'est dit à temps
 * (couche 1), chaque phrase envoyée à la synthèse avec son repère texte (le
 * navigateur affiche le texte au rythme de la voix), la fin de l'audio quand
 * tout est dit, l'interruption. La génération elle-même reste à la passerelle.
 */
export class SpeechTurn {
  readonly streamId = nextStreamId();
  /** Une phrase au moins est partie à la synthèse (audio.start envoyé). */
  started = false;
  /** La génération est terminée (plus aucune phrase ne viendra). */
  done = false;
  /** Coupé : plus rien n'est dit ni envoyé. */
  interrupted = false;
  private pendingSpeaks = 0;
  private seq = 0;
  private segments = 0;
  /** Repères des phrases envoyées à la synthèse, dans l'ordre (`null` : filler, sans texte affiché). */
  private readonly marks: Array<{ index: number; text: string } | null> = [];
  private fillerTimer?: NodeJS.Timeout;

  constructor(
    readonly conn: Conn,
    readonly turnId: string,
    private readonly port: SpeechPort,
  ) {}

  /** Couche 1 (« masking latency ») : rien de dit sous FILLER_DELAY_MS, une courte phrase d'attente part. */
  startFiller(): void {
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = undefined;
      if (!this.started && !this.interrupted && !this.done) this.speak(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
    }, FILLER_DELAY_MS);
    this.fillerTimer.unref();
  }

  clearFiller(): void {
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = undefined;
    }
  }

  /**
   * Une phrase de la réponse : dite si elle a quelque chose à dire, et
   * toujours repérée. Une phrase muette (bloc de code, émoji seul) est repérée tout de suite.
   */
  say(segment: Segment): void {
    if (this.interrupted) return;
    const mark = { index: this.segments++, text: segment.text };
    if (this.speak(segment.speech, mark)) return;
    this.port.send({ type: "speech.segment", turnId: this.turnId, streamId: this.streamId, ...mark, silent: true });
  }

  /** Envoie une phrase à la synthèse ; faux s'il n'y a rien à dire. */
  private speak(sentence: string, mark: { index: number; text: string } | null = null): boolean {
    if (this.interrupted) return false;
    const spoken = this.port.tts.toSpeech(sentence);
    if (!spoken) return false; // rien à dire (un émoji seul) : pas de synthèse qui n'arriverait jamais à sa fin
    this.clearFiller(); // une vraie phrase rend le filler inutile
    if (!this.started) {
      this.started = true;
      this.port.speaking(this);
      const format: AudioFormat = { sampleRate: this.port.tts.sampleRate, channels: 1, bitDepth: 16, encoding: "pcm_s16le" };
      this.port.send({ type: "audio.start", turnId: this.turnId, streamId: this.streamId, format });
      this.port.setState(PipelineState.Speaking);
    }
    this.pendingSpeaks++;
    this.marks.push(mark);
    this.port.tts.speak(this.streamId, spoken);
    return true;
  }

  /** Début de l'audio d'une phrase : son texte part juste avant ses trames. */
  sentenceStarted(): void {
    if (this.interrupted) return;
    const mark = this.marks.shift();
    if (mark) this.port.send({ type: "speech.segment", turnId: this.turnId, streamId: this.streamId, ...mark });
  }

  /** Trame binaire d'une tranche de PCM ; rien si le tour a été coupé. */
  frame(pcm: Uint8Array): Uint8Array | undefined {
    if (this.interrupted) return undefined;
    return encodeBinaryFrame({ kind: BinaryKind.Tts, streamId: this.streamId, seq: this.seq++, final: false }, pcm);
  }

  /** Une phrase est dite (ou perdue) : quand tout est dit et la génération finie, l'audio se termine. */
  sentenceEnded(): void {
    this.pendingSpeaks = Math.max(0, this.pendingSpeaks - 1);
    this.maybeEnd();
  }

  /** La génération est terminée normalement : l'audio se termine dès que tout est dit. */
  finish(): void {
    this.done = true;
    this.maybeEnd();
  }

  /** La génération a échoué : rien de plus ne viendra (l'audio en cours se termine avec sa dernière phrase). */
  fail(): void {
    this.done = true;
  }

  /** Arrête ce tour : plus de filler, plus de phrase. */
  stop(): void {
    this.clearFiller();
    this.interrupted = true;
  }

  /** Coupe l'audio en cours : la synthèse est annulée ; `notify` : l'écran est prévenu (audio.end). */
  cancelAudio(notify: boolean): void {
    this.interrupted = true;
    this.port.tts.cancel(this.streamId);
    if (notify) this.port.send({ type: "audio.end", turnId: this.turnId, streamId: this.streamId });
  }

  private maybeEnd(): void {
    if (this.started && this.done && this.pendingSpeaks <= 0 && !this.interrupted) {
      this.port.send({ type: "audio.end", turnId: this.turnId, streamId: this.streamId });
      if (this.port.isLatest(this.turnId)) this.port.setState(PipelineState.Idle);
      this.port.silent(this);
    }
  }
}
