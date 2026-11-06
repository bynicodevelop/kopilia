#!/usr/bin/env node
/**
 * Les discussions que voit le bot Telegram de Kopilia, avec leur identifiant :
 * de quoi remplir KOPILIA_TELEGRAM_CHAT_ID. Le jeton du bot est lu dans .env
 * (ou l'environnement), jamais affiché ni passé en ligne de commande.
 *
 * Avant : ajoute le bot à ton canal comme administrateur et publies-y un
 * message, ou transfère-lui en privé un message du canal (pour une discussion
 * privée, écris-lui), puis lance `pnpm telegram:chats`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * La valeur d'une variable : l'environnement d'abord, puis .env (comme le serveur).
 * Un .env d'avant le nom Kopilia (JARVIS_…) marche tel quel.
 */
function setting(name) {
  const names = [name, name.replace(/^KOPILIA_/, "JARVIS_")];
  for (const n of names) if (process.env[n]) return process.env[n].trim();
  const file = resolve(ROOT, ".env");
  if (!existsSync(file)) return "";
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0 && names.includes(line.slice(0, eq).trim()))
      return line
        .slice(eq + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

const token = setting("KOPILIA_TELEGRAM_TOKEN");
const api = (setting("KOPILIA_TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/+$/, "");
if (!token) {
  console.log("Il manque le jeton du bot : mets KOPILIA_TELEGRAM_TOKEN=… dans le fichier .env de Kopilia (donné par @BotFather).");
  process.exit(1);
}

let reply;
try {
  const res = await fetch(`${api}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15_000) });
  reply = await res.json();
} catch (e) {
  const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.cause?.message;
  const why = `${e?.message ?? e}${code ? ` (${code})` : ""}`;
  console.log(`Telegram injoignable : ${why.split(token).join("***")}`);
  process.exit(1);
}
if (!reply?.ok) {
  console.log(
    `Telegram refuse : ${String(reply?.description ?? "réponse inattendue")
      .split(token)
      .join("***")} (vérifie le jeton dans .env).`,
  );
  process.exit(1);
}

// Le nom du bot, pour le retrouver dans Telegram (rien de secret).
const me = await fetch(`${api}/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) })
  .then((r) => r.json())
  .catch(() => undefined);
if (me?.ok) console.log(`Bot : ${me.result.first_name} (@${me.result.username})`);

const chats = new Map();
for (const u of reply.result ?? []) {
  const m = u.channel_post ?? u.message ?? u.edited_message ?? u.my_chat_member ?? u.edited_channel_post;
  if (m?.chat) chats.set(m.chat.id, m.chat);
  // Un message transféré d'un canal au bot : le canal d'origine.
  const origin = m?.forward_origin?.chat ?? m?.forward_from_chat;
  if (origin) chats.set(origin.id, origin);
}
if (!chats.size) {
  console.log("Le bot ne voit encore aucune discussion. Ajoute-le à ton canal comme administrateur et publies-y un message,");
  console.log("ou transfère-lui en privé un message du canal, puis relance `pnpm telegram:chats`.");
  process.exit(0);
}
console.log("Discussions vues par le bot (identifiant, genre, nom) :");
for (const c of chats.values()) {
  const name = c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? "";
  console.log(`  ${c.id}  ${c.type}  ${name}${c.username ? ` (@${c.username})` : ""}`);
}
console.log("\nMets l'identifiant voulu dans .env : KOPILIA_TELEGRAM_CHAT_ID=…");
