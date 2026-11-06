#!/usr/bin/env node
/**
 * Serveur MCP local « kopilia » exposé aux AGENTS (recherche, veille) : les
 * recettes (skill_view) et, si MetaApi est configuré, les outils de cours
 * (market_price, market_history, market_indicators, market_candles,
 * market_levels, market_scan). Il relaie
 * vers l'API interne de Nest avec un jeton qui n'ouvre que ces lectures :
 * l'agent n'a ni le jeton MetaApi, ni accès aux tâches, à la mémoire ou aux
 * conversations. Les agents de la recherche d'opportunités ont en plus leurs
 * outils (hypothèses, dossiers de scénarios, alertes de l'IA), avec leur
 * propre jeton ; chaque appel porte l'identifiant de leur travail, écrit au
 * fil des dossiers.
 *
 * Les agents d'action (tâches de fond sur Kopilia) ont en plus les tracés, les
 * alertes et les indicateurs de plusieurs graphiques, avec leur propre jeton ;
 * jamais l'écran.
 *
 * Lancé par le CLI comme sous-processus via --mcp-config. Variables attendues :
 *   KOPILIA_INTERNAL_URL, KOPILIA_AGENT_TOKEN, KOPILIA_MARKET_TOOLS (« 1 » : outils de cours),
 *   KOPILIA_SETUP_TOOLS (« 1 » : outils de la recherche d'opportunités), KOPILIA_SETUP_TOKEN, KOPILIA_SETUP_JOB,
 *   KOPILIA_ACTION_TOOLS (« 1 » : outils d'action), KOPILIA_ACTION_TOKEN, KOPILIA_ACTION_JOB,
 *   KOPILIA_ALGO_TOOLS (« 1 » : outils du laboratoire de stratégies), KOPILIA_ALGO_TOKEN, KOPILIA_ALGO_JOB
 */
import "../common/legacy-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMarketTools } from "./market-tools.js";
import { registerSkillView } from "./knowledge-tools.js";
import { registerSetupTools } from "./setup-tools.js";
import { registerActionTools } from "./action-tools.js";
import { registerAlgoTools } from "./algo-tools.js";

const BASE = process.env.KOPILIA_INTERNAL_URL ?? "http://127.0.0.1:4317";
const SETUPS = process.env.KOPILIA_SETUP_TOOLS === "1";
const ACTIONS = !SETUPS && process.env.KOPILIA_ACTION_TOOLS === "1";
const ALGO = !SETUPS && !ACTIONS && process.env.KOPILIA_ALGO_TOOLS === "1";
const TOKEN =
  (SETUPS
    ? process.env.KOPILIA_SETUP_TOKEN
    : ACTIONS
      ? process.env.KOPILIA_ACTION_TOKEN
      : ALGO
        ? process.env.KOPILIA_ALGO_TOKEN
        : process.env.KOPILIA_AGENT_TOKEN) ?? "";
const JOB = process.env.KOPILIA_SETUP_JOB ?? "";
const ALGO_JOB = process.env.KOPILIA_ALGO_JOB ?? "";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}/internal${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(JOB ? { "x-setup-job": JOB } : {}),
      ...(ALGO_JOB ? { "x-algo-job": ALGO_JOB } : {}),
    },
  });
  if (!res.ok) throw new Error(`service Kopilia indisponible (${res.status})`);
  return res.json();
}

const server = new McpServer({ name: "kopilia", version: "0.2.0" });
registerSkillView(
  server,
  api,
  "Ouvre une recette de Kopilia : la façon de faire ce type de tâche pour l'utilisateur (étapes, sources et outils qui marchent, préférences pour le résultat, pièges). À ouvrir avant de commencer quand une recette de la liste correspond à ta tâche, et à suivre.",
);
if (process.env.KOPILIA_MARKET_TOOLS === "1") registerMarketTools(server, api);
if (SETUPS) registerSetupTools(server, api);
if (ACTIONS) registerActionTools(server, api);
if (ALGO) registerAlgoTools(server, api);
await server.connect(new StdioServerTransport());
