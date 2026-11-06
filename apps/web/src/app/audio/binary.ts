/**
 * Cadrage binaire (en-tête 16 octets) — miroir de packages/contracts/audio.ts.
 * Dupliqué ici pour garder le bundle navigateur indépendant du paquet serveur.
 */
const MAGIC = 0x4b50;
const VERSION = 1;
const HEADER = 16;
export const KIND_MIC = 0;
export const KIND_TTS = 1;

export function encodeFrame(kind: number, streamId: number, seq: number, final: boolean, payload: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(HEADER + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, MAGIC, true);
  view.setUint8(2, VERSION);
  view.setUint8(3, kind);
  view.setUint32(4, streamId >>> 0, true);
  view.setUint32(8, seq >>> 0, true);
  view.setUint8(12, final ? 1 : 0);
  out.set(new Uint8Array(payload), HEADER);
  return out.buffer;
}

export interface DecodedFrame {
  kind: number;
  streamId: number;
  seq: number;
  final: boolean;
  payload: ArrayBuffer;
}

export function decodeFrame(buf: ArrayBuffer): DecodedFrame | null {
  if (buf.byteLength < HEADER) return null;
  const view = new DataView(buf);
  if (view.getUint16(0, true) !== MAGIC || view.getUint8(2) !== VERSION) return null;
  return {
    kind: view.getUint8(3),
    streamId: view.getUint32(4, true),
    seq: view.getUint32(8, true),
    final: view.getUint8(12) === 1,
    payload: buf.slice(HEADER),
  };
}
