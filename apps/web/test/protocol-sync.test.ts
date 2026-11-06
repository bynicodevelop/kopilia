// Le web lit les messages du serveur sans les valider (pas de zod dans le
// bundle). Ce test relie les deux bouts : chaque message que le serveur peut
// envoyer est traité par le web (ou volontairement ignoré), et chaque message
// envoyé par le web existe dans le protocole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { clientMessage, serverMessage } from "../../../packages/contracts/src/events";

/** Messages du serveur dont le web n'a pas besoin. */
const IGNORED = new Set(["session.ready"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

// Le paquet web est en CommonJS pour tsx : __dirname, pas import.meta.
const code = sources(resolve(__dirname, "../src/app")).join("\n");
const typesOf = (union: typeof clientMessage | typeof serverMessage) => new Set(union.options.map((o) => o.shape.type.value as string));
const server = typesOf(serverMessage);
const client = typesOf(clientMessage);

test("protocole : le web traite chaque message du serveur", () => {
  const handled = new Set([...code.matchAll(/case "([a-z.]+)":/g)].map((m) => m[1]));
  const missing = [...server].filter((t) => !handled.has(t) && !IGNORED.has(t));
  assert.deepEqual(missing, [], "messages du serveur sans traitement côté web");
  // Un cas qui ressemble à un message mais n'existe plus dans le protocole est du code mort.
  const dead = [...handled].filter((t) => (t.includes(".") || t === "error") && !server.has(t));
  assert.deepEqual(dead, [], "cas du web pour des messages que le serveur n'envoie pas");
});

test("protocole : le web n'envoie que des messages connus du serveur", () => {
  const sent = new Set([...code.matchAll(/send\(\{\s*type:\s*"([a-z.]+)"/g)].map((m) => m[1]));
  assert.ok(sent.size >= 5, `envois trouvés : ${[...sent].join(", ")}`);
  assert.deepEqual(
    [...sent].filter((t) => !client.has(t)),
    [],
  );
});
