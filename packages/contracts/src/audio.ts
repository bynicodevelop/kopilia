/**
 * Format et cadrage binaire de l'audio transporté sur le WebSocket.
 *
 * Deux flux binaires circulent :
 *   - micro  (navigateur -> serveur) : PCM mono 16 bits, 16 kHz (requis par whisper.cpp)
 *   - parole (serveur -> navigateur) : PCM mono 16 bits à la fréquence déclarée par Kokoro
 *
 * Chaque trame binaire porte un en-tête compact de 16 octets afin que le
 * récepteur route et ordonne sans message de contrôle par trame. Le format
 * (fréquence, canaux, encodage) est déclaré une fois dans l'événement de
 * contrôle `audio.start` / `mic.format` qui ouvre le flux.
 */

export const PCM_ENCODING = "pcm_s16le" as const;

export interface AudioFormat {
  /** Hz. Micro = 16000. Parole = fréquence déclarée par Kokoro (p.ex. 24000). */
  sampleRate: number;
  channels: number;
  bitDepth: number;
  encoding: typeof PCM_ENCODING;
}

export const MIC_FORMAT: AudioFormat = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  encoding: PCM_ENCODING,
};

export enum BinaryKind {
  Mic = 0,
  Tts = 1,
}

export const BINARY_MAGIC = 0x4b50; // 'KP'
export const BINARY_VERSION = 1;
export const BINARY_HEADER_BYTES = 16;

export interface BinaryFrameHeader {
  kind: BinaryKind;
  /** Identifie le flux (= turnId pour le micro, = audio stream id pour la parole). */
  streamId: number;
  /** Numéro de séquence croissant à l'intérieur du flux. */
  seq: number;
  /** Vrai sur la dernière trame du flux. */
  final: boolean;
}

/** Encode un en-tête + charge utile PCM dans un seul buffer binaire. */
export function encodeBinaryFrame(header: BinaryFrameHeader, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(BINARY_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, BINARY_MAGIC, true);
  view.setUint8(2, BINARY_VERSION);
  view.setUint8(3, header.kind);
  view.setUint32(4, header.streamId >>> 0, true);
  view.setUint32(8, header.seq >>> 0, true);
  view.setUint8(12, header.final ? 1 : 0);
  // octets 13..15 réservés (0)
  out.set(payload, BINARY_HEADER_BYTES);
  return out;
}

export interface DecodedBinaryFrame {
  header: BinaryFrameHeader;
  payload: Uint8Array;
}

/** Décode une trame binaire. Rejette magie / version invalides. */
export function decodeBinaryFrame(buf: Uint8Array): DecodedBinaryFrame {
  if (buf.byteLength < BINARY_HEADER_BYTES) {
    throw new Error(`trame binaire trop courte (${buf.byteLength} octets)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint16(0, true);
  if (magic !== BINARY_MAGIC) throw new Error(`magie binaire invalide: 0x${magic.toString(16)}`);
  const version = view.getUint8(2);
  if (version !== BINARY_VERSION) throw new Error(`version binaire non supportée: ${version}`);
  const kind = view.getUint8(3) as BinaryKind;
  const streamId = view.getUint32(4, true);
  const seq = view.getUint32(8, true);
  const final = view.getUint8(12) === 1;
  const payload = buf.subarray(BINARY_HEADER_BYTES);
  return { header: { kind, streamId, seq, final }, payload };
}
