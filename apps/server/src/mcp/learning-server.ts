#!/usr/bin/env node
/**
 * Serveur MCP local « apprentissage » exposé au RELECTEUR et au RANGEMENT : les
 * carnets (profil, environnement), les recettes et la recherche dans les
 * conversations. Rien d'autre : ni web, ni fichiers, ni tâches. Il relaie vers
 * l'API interne de Nest avec un jeton qui n'ouvre que ces outils, et seulement
 * pendant la relecture en cours (identifiant de passe).
 *
 * Lancé par le CLI comme sous-processus via --mcp-config. Variables attendues :
 *   KOPILIA_INTERNAL_URL, KOPILIA_LEARNING_TOKEN, KOPILIA_LEARNING_RUN, KOPILIA_LEARNING_KIND (review | curator)
 */
import "../common/legacy-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerConversationSearch } from "./knowledge-tools.js";

const BASE = process.env.KOPILIA_INTERNAL_URL ?? "http://127.0.0.1:4317";
const TOKEN = process.env.KOPILIA_LEARNING_TOKEN ?? "";
const RUN = process.env.KOPILIA_LEARNING_RUN ?? "";
const CURATOR = process.env.KOPILIA_LEARNING_KIND === "curator";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}/internal/learning${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-learning-run": RUN, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`apprentissage indisponible (${res.status})`);
  return res.json();
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const STORE = z
  .enum(["profile", "environment", "trading"])
  .describe(
    "profile : qui est l'utilisateur, ses préférences et corrections ; environment : outils, sources, conventions et pièges du système ; trading : sa façon de trader (style, unités de temps, niveaux, conditions d'un bon setup, ce qu'il refuse)",
  );
const REASON = z.string().describe("Pourquoi, en une phrase simple pour l'utilisateur (ce qu'il a dit ou ce qui s'est passé)");

const server = new McpServer({ name: "apprentissage", version: "0.1.0" });

server.tool(
  "memory_add",
  "Ajoute un fait à un carnet (une phrase, un constat et non un ordre). Refusé si le carnet est plein : remplace ou fusionne alors une entrée existante.",
  {
    store: STORE,
    content: z.string().describe("Le fait, en une phrase autonome (ex. « Préfère les prix avec toutes leurs décimales, comme sur MetaTrader. »)"),
    kind: z.enum(["fact", "preference", "correction"]).optional().describe("preference ou correction pour une façon de répondre ou de travailler ; fact sinon"),
  },
  async (args) => text(await post("/memory", { action: "add", ...args })),
);

server.tool(
  "memory_replace",
  "Remplace une entrée d'un carnet (identifiant mem_…) : reformuler, corriger, ou fusionner deux faits en un (remplace l'un, retire l'autre).",
  { id: z.string(), content: z.string().describe("Le nouveau texte de l'entrée") },
  async (args) => text(await post("/memory", { action: "replace", ...args })),
);

server.tool(
  "memory_remove",
  "Retire une entrée devenue fausse, périmée ou en double (gardée dans l'historique, l'utilisateur peut la rétablir).",
  { id: z.string() },
  async (args) => text(await post("/memory", { action: "remove", ...args })),
);

server.tool("skill_list", "Liste les recettes : nom, public, état (active, brouillon en attente de l'utilisateur, archivée), description.", async () =>
  text(await api("/skills")),
);

server.tool(
  "skill_view",
  "Lit une recette en entier (ou un de ses fichiers d'appoint). Obligatoire avant de la modifier.",
  { name: z.string(), file: z.string().optional().describe("references/<sujet>.md") },
  async ({ name, file }) => text(await api(`/skills/${encodeURIComponent(name)}${file ? `?${new URLSearchParams({ file })}` : ""}`)),
);

server.tool(
  "skill_create",
  "Crée une recette pour une CLASSE de tâches qu'aucune recette ne couvre encore.",
  {
    name: z.string().describe("kebab-case, au niveau de la classe de tâches (ex. « donner-un-cours », « horaires-de-cinema »)"),
    audience: z
      .enum(["dialogue", "agents", "all"])
      .describe(
        "dialogue : façon de répondre à l'oral, toujours dans le prompt du dialogue ; agents : ouverte par les agents de recherche et de veille quand la tâche correspond",
      ),
    description: z.string().describe("Quand l'ouvrir, en une phrase courte qui commence par le déclencheur (100 caractères au plus)"),
    body: z.string().describe("La recette en Markdown : « ## Quand l'utiliser », « ## Étapes », « ## Pièges »"),
    reason: REASON,
  },
  async (args) => text(await post("/skills", { action: "create", ...args })),
);

server.tool(
  "skill_patch",
  "Modifie un passage précis d'une recette : old_text doit y figurer exactement une fois (recopié depuis skill_view).",
  { name: z.string(), old_text: z.string(), new_text: z.string(), reason: REASON },
  async (args) => text(await post("/skills", { action: "patch", ...args })),
);

server.tool(
  "skill_rewrite",
  "Réécrit une recette entière (corps, description ou public), pour une refonte ; un changement local passe par skill_patch.",
  {
    name: z.string(),
    body: z.string().optional(),
    description: z.string().optional(),
    audience: z.enum(["dialogue", "agents", "all"]).optional(),
    reason: REASON,
  },
  async (args) => text(await post("/skills", { action: "rewrite", ...args })),
);

server.tool(
  "skill_write_file",
  "Ajoute ou remplace un fichier d'appoint d'une recette (references/<sujet>.md) : un détail utile seulement parfois (tableau de décision, sources, cas particuliers). Ajoute une ligne qui le signale dans la recette.",
  { name: z.string(), path: z.string().describe("references/<sujet>.md"), content: z.string(), reason: REASON },
  async (args) => text(await post("/skills", { action: "write_file", ...args })),
);

if (CURATOR) {
  server.tool(
    "skill_archive",
    "Met de côté une recette absorbée dans une autre (récupérable). Jamais une recette épinglée.",
    { name: z.string(), absorbed_into: z.string().describe("La recette qui reprend désormais son contenu"), reason: REASON },
    async (args) => text(await post("/skills", { action: "archive", ...args })),
  );
}

registerConversationSearch(server, (path) => api(path));

await server.connect(new StdioServerTransport());
