import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { sttEvent, SttEvent } from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { WorkerLink } from "./worker-link.js";
import { applyReplacements, buildSttPrompt, readVocabularyFile } from "./vocabulary.js";
import { isPromptEcho } from "./transcript-filter.js";

/** Le vocabulaire est relu au plus toutes les 30 s (fichier modifié à la main). */
const VOCABULARY_TTL_MS = 30_000;

type SttWorkerEvent<T extends SttEvent["type"]> = Extract<SttEvent, { type: T }>;

/** Événements relayés à la passerelle (la transcription finale déjà corrigée par le vocabulaire). */
export interface SttEvents {
  "stt.vad": [SttWorkerEvent<"stt.vad">];
  "stt.partial": [SttWorkerEvent<"stt.partial">];
  "stt.final": [SttWorkerEvent<"stt.final">];
  "stt.error": [SttWorkerEvent<"stt.error">];
}

/**
 * Pilote le worker STT persistant (whisper.cpp + VAD). Reçoit du PCM 16 kHz
 * mono par flux (streamId), renvoie partiels et transcription finale française.
 * Chaque énoncé part avec une amorce de vocabulaire (config/vocabulaire.txt)
 * pour bien orthographier noms propres et sigles ; les corrections du même
 * fichier sont appliquées au texte transcrit.
 * Fonctionne avec le worker réel ou un double de test (KOPILIA_STT_CMD).
 */
@Injectable()
export class SttService extends EventEmitter<SttEvents> implements OnModuleInit, OnModuleDestroy {
  private link?: WorkerLink;
  /** Amorce envoyée pour chaque flux ouvert (pour écarter sa simple recopie). */
  private prompts = new Map<number, string>();
  /** Flux ouverts chez le worker, en attente de leur transcription finale. */
  private readonly openStreams = new Set<number>();
  /** Flux que le worker n'a jamais reçus (ouverts pendant une panne). */
  private readonly unopenedStreams = new Set<number>();
  private vocabulary?: { prompt: string; replacements: Array<[string, string]>; at: number };

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  /**
   * Démarre le worker avec le serveur : le modèle (plusieurs centaines de Mo)
   * est chargé avant la première phrase, pas pendant (~1 s de gagnée).
   */
  onModuleInit() {
    this.ensure();
  }

  /** Vocabulaire courant (amorce + corrections), mis en cache brièvement. */
  private currentVocabulary(now = Date.now()) {
    if (!this.vocabulary || now - this.vocabulary.at >= VOCABULARY_TTL_MS) {
      const v = readVocabularyFile(this.config.sttVocabularyFile);
      this.vocabulary = { prompt: buildSttPrompt(v.terms), replacements: v.replacements, at: now };
    }
    return this.vocabulary;
  }

  private ensure(): WorkerLink {
    if (this.link) return this.link;
    this.link = new WorkerLink({
      name: "stt",
      command: this.config.sttCommand,
      env: {
        KOPILIA_WHISPER_MODEL: this.config.whisperModel,
        KOPILIA_WHISPER_LANG: this.config.whisperLang,
      },
      logger: this.logger,
    });
    this.link.on("event", (raw) => this.onEvent(raw));
    this.link.on("down", () => this.onDown());
    this.link.start();
    return this.link;
  }

  /**
   * Le worker est mort : les énoncés en cours n'auront pas de transcription.
   * Chacun se termine vide (comme un bruit), sinon l'écran resterait sur « transcrit ».
   */
  private onDown() {
    const lost = [...this.openStreams];
    this.openStreams.clear();
    for (const streamId of lost) this.endEmpty(streamId);
  }

  private endEmpty(streamId: number) {
    this.prompts.delete(streamId);
    this.emit("stt.final", { type: "stt.final", streamId, text: "" });
  }

  private onEvent(raw: unknown) {
    const parsed = sttEvent.safeParse(raw);
    if (!parsed.success) return;
    const e: SttEvent = parsed.data;
    if (e.type === "stt.ready") {
      this.logger.log(`STT prêt (${e.model}, ${e.lang})`, "voice");
      return;
    }
    if (e.type === "stt.final") {
      this.openStreams.delete(e.streamId);
      const prompt = this.prompts.get(e.streamId);
      this.prompts.delete(e.streamId);
      // Recopie de l'amorce sur du bruit : traitée comme un énoncé vide.
      if (isPromptEcho(e.text, prompt)) {
        this.logger.debug(`amorce recopiée écartée (flux ${e.streamId})`, "voice");
        this.emit(e.type, { ...e, text: "" });
        return;
      }
      this.emit(e.type, { ...e, text: applyReplacements(e.text, this.currentVocabulary().replacements) });
      return;
    }
    this.relay(e);
  }

  /** Relaie un événement du worker sous son propre nom (le nom et le contenu vont ensemble). */
  private relay(e: Exclude<SttEvent, { type: "stt.ready" | "stt.final" }>) {
    if (e.type === "stt.vad") this.emit("stt.vad", e);
    else if (e.type === "stt.partial") this.emit("stt.partial", e);
    else this.emit("stt.error", e);
  }

  open(streamId: number, sampleRate: number) {
    const { prompt } = this.currentVocabulary();
    if (this.ensure().send({ type: "stt.open", streamId, sampleRate, prompt: prompt || undefined })) {
      this.openStreams.add(streamId);
      if (prompt) this.prompts.set(streamId, prompt);
    } else {
      this.unopenedStreams.add(streamId);
    }
  }

  /** Transmet une tranche PCM (Uint8Array) encodée base64 au worker. */
  audio(streamId: number, seq: number, pcm: Uint8Array) {
    this.ensure().send({ type: "stt.audio", streamId, seq, pcmBase64: Buffer.from(pcm).toString("base64") });
  }

  /** Fin de l'énoncé. Un flux que le worker n'a jamais reçu (panne) se termine vide, juste après l'appel. */
  close(streamId: number) {
    if (this.openStreams.has(streamId) && this.ensure().send({ type: "stt.close", streamId })) return;
    // Jamais reçu par le worker, ou worker mort entre-temps : fin vide. Un flux
    // déjà terminé par la panne (onDown) n'est plus dans aucun des deux ensembles.
    if (this.unopenedStreams.delete(streamId) || this.openStreams.delete(streamId)) queueMicrotask(() => this.endEmpty(streamId));
  }

  cancel(streamId: number) {
    this.openStreams.delete(streamId);
    this.unopenedStreams.delete(streamId);
    this.prompts.delete(streamId);
    this.ensure().send({ type: "stt.cancel", streamId });
  }

  onModuleDestroy() {
    this.link?.stop();
  }
}
