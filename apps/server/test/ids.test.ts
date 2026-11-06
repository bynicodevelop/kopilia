import { test } from "node:test";
import assert from "node:assert/strict";

type Ids = typeof import("../src/common/ids.js");
/** Un chargement neuf du module, comme un nouveau démarrage du serveur. */
const boot = (n: number) => import(`../src/common/ids.js?demarrage=${n}`) as Promise<Ids>;

test("les numéros de voix ne repartent pas du même point à chaque démarrage du serveur", async () => {
  // Deux chargements du module : deux démarrages du serveur.
  const first = await boot(1);
  const second = await boot(2);
  assert.notEqual(first, second, "deux modules distincts, comme deux serveurs");
  const a = [first.nextStreamId(), first.nextStreamId()];
  const b = second.nextStreamId();
  assert.equal(a[1], a[0] + 1, "dans un même démarrage, les numéros se suivent");
  assert.notEqual(a[0], b, "un nouveau démarrage ne reprend pas les mêmes numéros");
  for (const id of [...a, b]) assert.ok(Number.isInteger(id) && id >= 1 && id <= 0xffffffff, `${id} tient sur 32 bits`);
});
