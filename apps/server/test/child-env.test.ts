import { test } from "node:test";
import assert from "node:assert/strict";
import { OWN_TOOLS_ENV, buildChildEnv } from "../src/session/child-env.js";

test("l'assainisseur retire les variables de provider/billing/host", () => {
  process.env.ANTHROPIC_BASE_URL = "https://staging.example";
  process.env.CLAUDE_CODE_SESSION_ID = "abc";
  process.env.USE_STAGING_OAUTH = "1";
  process.env.PATH = process.env.PATH ?? "/usr/bin";
  process.env.KOPILIA_KEEP = "oui";

  const { env, stripped } = buildChildEnv();
  assert.ok(stripped.includes("ANTHROPIC_BASE_URL"));
  assert.ok(stripped.includes("CLAUDE_CODE_SESSION_ID"));
  assert.ok(stripped.includes("USE_STAGING_OAUTH"));
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  // les variables neutres sont conservées
  assert.equal(env.KOPILIA_KEEP, "oui");
  assert.ok(env.PATH);
});

test("le jeton MetaApi reste au serveur : jamais transmis à Claude ni aux ouvriers", () => {
  process.env.KOPILIA_METAAPI_TOKEN = "secret";
  process.env.KOPILIA_METAAPI_ACCOUNT_ID = "acc-1";
  const { env, stripped } = buildChildEnv();
  assert.equal(env.KOPILIA_METAAPI_TOKEN, undefined);
  assert.equal(env.KOPILIA_METAAPI_ACCOUNT_ID, undefined);
  assert.ok(stripped.includes("KOPILIA_METAAPI_TOKEN"), "signalé par son nom");
});

test("le jeton du bot Telegram reste au serveur : jamais transmis à Claude ni aux ouvriers", () => {
  process.env.KOPILIA_TELEGRAM_TOKEN = "123:secret";
  process.env.KOPILIA_TELEGRAM_CHAT_ID = "-100";
  const { env, stripped } = buildChildEnv();
  assert.equal(env.KOPILIA_TELEGRAM_TOKEN, undefined);
  assert.equal(env.KOPILIA_TELEGRAM_CHAT_ID, undefined);
  assert.ok(stripped.includes("KOPILIA_TELEGRAM_TOKEN"), "signalé par son nom");
  delete process.env.KOPILIA_TELEGRAM_TOKEN;
  delete process.env.KOPILIA_TELEGRAM_CHAT_ID;
});

test("les variables additionnelles sont fusionnées après assainissement", () => {
  const { env } = buildChildEnv({ KOPILIA_EXTRA: "x" });
  assert.equal(env.KOPILIA_EXTRA, "x");
});

test("Kopilia charge ses outils d'emblée : pas de recherche d'outils différés", () => {
  const { env } = buildChildEnv(OWN_TOOLS_ENV);
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
});
