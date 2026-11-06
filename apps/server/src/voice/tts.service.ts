import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { ttsEvent, TtsEvent } from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { WorkerLink } from "./worker-link.js";
import { spokenFrench } from "./spoken-french.js";

type TtsWorkerEvent<T extends TtsEvent["type"]> = Extract<TtsEvent, { type: T }>;

/** Événements relayés à la passerelle : le PCM de chaque tranche (décodé), le début, la fin, l'erreur d'une phrase. */
export interface TtsEvents {
  chunk: [{ streamId: number; seq: number; pcm: Buffer }];
  "tts.start": [TtsWorkerEvent<"tts.start">];
  "tts.end": [TtsWorkerEvent<"tts.end">];
  "tts.error": [TtsWorkerEvent<"tts.error">];
}

/**
 * Pilote le worker TTS persistant (Kokoro-82M, voix ff_siwis). Reçoit du texte
 * français (groupé par phrases en amont) et émet du PCM à la fréquence déclarée.
 * Fonctionne avec le worker réel ou un double de test (KOPILIA_TTS_CMD).
 */
@Injectable()
export class TtsService extends EventEmitter<TtsEvents> implements OnModuleInit, OnModuleDestroy {
  private link?: WorkerLink;
  sampleRate = 24000;
  /** Phrases envoyées au worker et pas encore terminées, par flux. */
  private readonly inFlight = new Map<number, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  /**
   * Démarre le worker avec le serveur, comme la transcription : chargé à la
   * première phrase, il la retardait de plusieurs secondes (torch, le modèle et
   * la voix ; environ 5 s mesurées le 2026-11-04).
   */
  onModuleInit() {
    this.ensure();
  }

  private ensure(): WorkerLink {
    if (this.link) return this.link;
    this.link = new WorkerLink({
      name: "tts",
      command: this.config.ttsCommand,
      env: { KOPILIA_KOKORO_VOICE: this.config.kokoroVoice, KOPILIA_KOKORO_LANG: this.config.kokoroLang },
      logger: this.logger,
    });
    this.link.on("event", (raw) => this.onEvent(raw));
    this.link.on("down", () => this.onDown());
    this.link.start();
    return this.link;
  }

  /**
   * Le worker est mort : ses phrases en cours ne finiront jamais. Chacune se
   * termine en erreur, sinon l'écran resterait sur « parle » indéfiniment.
   */
  private onDown() {
    const lost = [...this.inFlight];
    this.inFlight.clear();
    for (const [streamId, count] of lost) {
      for (let i = 0; i < count; i++) this.emit("tts.error", { type: "tts.error", streamId, message: "synthèse vocale interrompue" });
    }
  }

  private settle(streamId: number) {
    const left = (this.inFlight.get(streamId) ?? 0) - 1;
    if (left > 0) this.inFlight.set(streamId, left);
    else this.inFlight.delete(streamId);
  }

  private onEvent(raw: unknown) {
    const parsed = ttsEvent.safeParse(raw);
    if (!parsed.success) return;
    const e: TtsEvent = parsed.data;
    if (e.type === "tts.ready") {
      this.sampleRate = e.sampleRate;
      this.logger.log(`TTS prêt (${e.voice}, ${e.sampleRate} Hz)`, "voice");
      return;
    }
    if (e.type === "tts.start") this.sampleRate = e.sampleRate;
    if ((e.type === "tts.end" || e.type === "tts.error") && e.streamId !== undefined) this.settle(e.streamId);
    if (e.type === "tts.chunk") {
      // Émet le PCM décodé pour cadrage binaire par la gateway.
      this.emit("chunk", { streamId: e.streamId, seq: e.seq, pcm: Buffer.from(e.pcmBase64, "base64") });
      return;
    }
    this.relay(e);
  }

  /** Relaie un événement du worker sous son propre nom (le nom et le contenu vont ensemble). */
  private relay(e: Exclude<TtsEvent, { type: "tts.ready" | "tts.chunk" }>) {
    if (e.type === "tts.start") this.emit("tts.start", e);
    else if (e.type === "tts.end") this.emit("tts.end", e);
    else this.emit("tts.error", e);
  }

  /**
   * Texte réellement dit : la transcription pour l'oral (« 16 h » -> « 16 heures »).
   * L'écran garde le texte écrit. Peut être vide (un émoji seul, p.ex.).
   */
  toSpeech(text: string): string {
    return this.config.kokoroLang === "f" ? spokenFrench(text) : text;
  }

  speak(streamId: number, text: string) {
    const sent = this.ensure().send({ type: "tts.speak", streamId, text, voice: this.config.kokoroVoice, lang: this.config.kokoroLang });
    if (sent) {
      this.inFlight.set(streamId, (this.inFlight.get(streamId) ?? 0) + 1);
      return;
    }
    // Worker en panne (relance en cours) : la phrase est perdue, elle se termine en
    // erreur, après l'appel (l'appelant compte encore la phrase à ce moment-là).
    queueMicrotask(() => this.emit("tts.error", { type: "tts.error", streamId, message: "synthèse vocale indisponible" }));
  }

  cancel(streamId: number) {
    this.inFlight.delete(streamId);
    this.ensure().send({ type: "tts.cancel", streamId });
  }

  onModuleDestroy() {
    this.link?.stop();
  }
}
