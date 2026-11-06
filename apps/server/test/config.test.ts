// Configuration lue au démarrage : une valeur invalide arrête le serveur avec
// un message clair, au lieu d'un comportement étrange plus tard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigService } from "../src/config/config.service.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("port : 4317 par défaut, un port invalide est refusé avec un message clair", () => {
  withEnv({ KOPILIA_PORT: undefined }, () => assert.equal(new ConfigService().port, 4317));
  withEnv({ KOPILIA_PORT: "4400" }, () => assert.equal(new ConfigService().port, 4400));
  for (const bad of ["abc", "0", "70000", "43.5"]) {
    withEnv({ KOPILIA_PORT: bad }, () => assert.throws(() => new ConfigService(), /KOPILIA_PORT/, bad));
  }
});

test("hôte : la machine locale par défaut, et toute autre adresse est signalée comme exposée", () => {
  withEnv({ KOPILIA_HOST: undefined }, () => assert.equal(new ConfigService().exposed, false));
  withEnv({ KOPILIA_HOST: "localhost" }, () => assert.equal(new ConfigService().exposed, false));
  withEnv({ KOPILIA_HOST: "0.0.0.0" }, () => assert.equal(new ConfigService().exposed, true));
});

test("effort du dialogue : « low » par défaut, vide => celui de Claude Code, une valeur inconnue est refusée", () => {
  withEnv({ KOPILIA_DIALOGUE_EFFORT: undefined }, () => assert.equal(new ConfigService().dialogueEffort, "low"));
  withEnv({ KOPILIA_DIALOGUE_EFFORT: "medium" }, () => assert.equal(new ConfigService().dialogueEffort, "medium"));
  withEnv({ KOPILIA_DIALOGUE_EFFORT: "" }, () => assert.equal(new ConfigService().dialogueEffort, undefined));
  withEnv({ KOPILIA_DIALOGUE_EFFORT: "rapide" }, () => assert.throws(() => new ConfigService(), /KOPILIA_DIALOGUE_EFFORT/));
});
