// Les réglages de la page rangés sous l'ancien nom (« ecovis.… ») sont repris sous « kopilia.… ».
import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptLegacyStorage } from "../src/app/legacy-storage";

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

test("réglages d'avant le nom Kopilia : repris sous le nouveau nom, l'ancien effacé", () => {
  const s = memoryStorage({
    "ecovis.panelSizes": '{"chart":2}',
    "ecovis.chartMagnet": "strong",
    "kopilia.chartMagnet": "weak",
    autre: "1",
  });
  adoptLegacyStorage(s);
  assert.deepEqual(s.dump(), {
    "kopilia.chartMagnet": "weak",
    autre: "1",
    "kopilia.panelSizes": '{"chart":2}',
  });
  // Une seconde fois : rien ne bouge.
  adoptLegacyStorage(s);
  assert.equal(s.dump()["kopilia.panelSizes"], '{"chart":2}');
});
