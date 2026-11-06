/**
 * Les réglages de la page (tailles et places des encarts, aimant, unité suivie…)
 * étaient rangés sous « ecovis.… » avant le nom Kopilia : repris une fois sous
 * « kopilia.… », puis effacés. Un réglage déjà rangé sous le nouveau nom l'emporte.
 */
const LEGACY = "ecovis.";
const PREFIX = "kopilia.";

export function adoptLegacyStorage(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(LEGACY)) keys.push(key);
  }
  for (const key of keys) {
    const value = storage.getItem(key);
    const next = PREFIX + key.slice(LEGACY.length);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}
