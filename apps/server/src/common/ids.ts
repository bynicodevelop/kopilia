import { randomUUID, randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Jeton de session court pour protéger l'ouverture du WebSocket. */
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Petit identifiant numérique de flux (uint32) pour le cadrage binaire. */
let streamCounter = 1;
export function nextStreamId(): number {
  streamCounter = (streamCounter + 1) >>> 0 || 1;
  return streamCounter;
}
