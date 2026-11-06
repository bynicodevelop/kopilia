// Les outils déclarés par chaque serveur MCP et ceux que les processus claude
// ont le droit d'appeler doivent concorder : un outil déclaré mais absent de
// --allowedTools serait bloqué sans bruit ; un outil autorisé mais plus déclaré
// n'existe plus. Les serveurs démarrent à l'import, d'où une lecture des sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_ACTION_TOOLS,
  AGENT_ALGO_TOOLS,
  AGENT_MARKET_TOOLS,
  AGENT_SETUP_TOOLS,
  AGENT_SKILL_TOOLS,
  DIALOGUE_TOOLS,
  LEARNING_TOOLS,
} from "../src/mcp/catalog.js";
import { stepLabel } from "../src/session/steps.js";

const MCP = resolve(import.meta.dirname, "../src/mcp");
const source = (file: string) => readFileSync(resolve(MCP, file), "utf8");
const toolsIn = (code: string) => [...code.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);

/** Outils déclarés par les fonctions partagées (registerMarketTools, registerSkillView…). */
function helpers(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of ["knowledge-tools.ts", "market-tools.ts", "setup-tools.ts", "action-tools.ts", "trading-tools.ts", "algo-tools.ts"]) {
    const parts = source(file).split(/export function (\w+)/);
    for (let i = 1; i < parts.length; i += 2) map.set(parts[i], toolsIn(parts[i + 1]));
  }
  return map;
}

/** Tous les outils d'un serveur : les siens, et ceux des fonctions partagées qu'il appelle. */
function declared(file: string): string[] {
  const code = source(file);
  const shared = [...helpers()].filter(([name]) => new RegExp(`\\b${name}\\(`).test(code)).flatMap(([, tools]) => tools);
  return [...new Set([...toolsIn(code), ...shared])].sort();
}

const sorted = (list: readonly string[]) => [...list].sort();

test("catalogue MCP : le dialogue a droit à tous les outils de coordination, et à eux seuls", () => {
  assert.deepEqual(declared("coordination-server.ts"), sorted(DIALOGUE_TOOLS));
});

test("catalogue MCP : les agents ont droit aux recettes et aux cours ; ceux de la recherche d'opportunités, à leurs dossiers ; ceux d'action, aux tracés, alertes et indicateurs", () => {
  assert.deepEqual(
    declared("agent-server.ts"),
    sorted([...AGENT_SKILL_TOOLS, ...AGENT_MARKET_TOOLS, ...AGENT_SETUP_TOOLS, ...AGENT_ACTION_TOOLS, ...AGENT_ALGO_TOOLS]),
  );
});

test("catalogue MCP : un agent d'action n'a jamais l'écran (encarts, vues), et tous ses outils sont aussi ceux du dialogue", () => {
  for (const tool of AGENT_ACTION_TOOLS) {
    assert.ok(!/^(panel|view)_/.test(tool), tool);
    assert.ok((DIALOGUE_TOOLS as readonly string[]).includes(tool), tool);
  }
});

test("catalogue MCP : la prise de position (tickets d'ordre, money management) est au dialogue seul, jamais aux agents", () => {
  const agents = declared("agent-server.ts");
  for (const tool of ["trading_status", "trading_settings", "order_prepare", "trade_manage", "ticket_cancel", "trading_review"]) {
    assert.ok((DIALOGUE_TOOLS as readonly string[]).includes(tool), tool);
    assert.ok(!agents.includes(tool), `${tool} chez les agents`);
  }
  // Aucun outil ne confirme un ticket : seul l'utilisateur le fait (écran ou « je confirme »).
  assert.ok(
    !/confirm/.test(
      source("trading-tools.ts")
        .match(/server\.tool\(\s*"[a-z_]+"/g)!
        .join(" "),
    ),
  );
});

test("catalogue MCP : le relecteur a droit à ses outils d'apprentissage, et à eux seuls", () => {
  assert.deepEqual(declared("learning-server.ts"), sorted(LEARNING_TOOLS));
});

test("catalogue MCP : chaque outil du dialogue a son étape à l'écran", () => {
  for (const tool of DIALOGUE_TOOLS) {
    assert.notEqual(stepLabel(`mcp__kopilia__${tool}`), tool.replace(/_/g, " "), `${tool} : libellé d'étape manquant`);
  }
});
