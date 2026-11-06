import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptLegacyEnv } from "../src/common/legacy-env.js";

test("un .env d'avant le nom Kopilia : JARVIS_X devient KOPILIA_X, sans écraser un KOPILIA_X déjà là", () => {
  const env: NodeJS.ProcessEnv = { JARVIS_PORT: "4400", JARVIS_HOST: "0.0.0.0", KOPILIA_HOST: "127.0.0.1", PATH: "/bin" };
  adoptLegacyEnv(env);
  assert.deepEqual(env, { KOPILIA_PORT: "4400", KOPILIA_HOST: "127.0.0.1", PATH: "/bin" });
});
