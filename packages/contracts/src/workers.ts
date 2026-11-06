import { z } from "zod";

/**
 * Protocole stdio (NDJSON) entre Nest et les workers vocaux persistants
 * (whisper.cpp pour le STT, Kokoro pour le TTS). Une ligne JSON par message ;
 * l'audio binaire associé passe par un canal séparé référencé par `streamId`.
 *
 * Ces contrats servent aussi aux doubles de test (workers simulés).
 */

/* ---- STT (whisper.cpp) ---- */

export const sttRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stt.open"),
    streamId: z.number().int(),
    sampleRate: z.number().int(),
    /** Amorce de vocabulaire (noms propres, sigles) pour orienter la transcription. */
    prompt: z.string().optional(),
  }),
  z.object({ type: z.literal("stt.audio"), streamId: z.number().int(), seq: z.number().int(), pcmBase64: z.string() }),
  z.object({ type: z.literal("stt.close"), streamId: z.number().int() }),
  z.object({ type: z.literal("stt.cancel"), streamId: z.number().int() }),
]);
export type SttRequest = z.infer<typeof sttRequest>;

export const sttEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stt.ready"), model: z.string(), lang: z.string() }),
  z.object({ type: z.literal("stt.vad"), streamId: z.number().int(), speaking: z.boolean() }),
  z.object({ type: z.literal("stt.partial"), streamId: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("stt.final"), streamId: z.number().int(), text: z.string(), lang: z.string().optional() }),
  z.object({ type: z.literal("stt.error"), streamId: z.number().int().optional(), message: z.string() }),
]);
export type SttEvent = z.infer<typeof sttEvent>;

/* ---- TTS (Kokoro) ---- */

export const ttsRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tts.speak"),
    streamId: z.number().int(),
    text: z.string(),
    voice: z.string(),
    lang: z.string(),
  }),
  z.object({ type: z.literal("tts.cancel"), streamId: z.number().int() }),
]);
export type TtsRequest = z.infer<typeof ttsRequest>;

export const ttsEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tts.ready"), voice: z.string(), sampleRate: z.number().int() }),
  z.object({ type: z.literal("tts.start"), streamId: z.number().int(), sampleRate: z.number().int() }),
  // La charge PCM est émise sur le canal binaire ; cet événement annonce une tranche.
  z.object({ type: z.literal("tts.chunk"), streamId: z.number().int(), seq: z.number().int(), pcmBase64: z.string() }),
  z.object({ type: z.literal("tts.end"), streamId: z.number().int() }),
  z.object({ type: z.literal("tts.error"), streamId: z.number().int().optional(), message: z.string() }),
]);
export type TtsEvent = z.infer<typeof ttsEvent>;
