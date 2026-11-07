import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Catalogue des serveurs MCP de Kopilia et de leurs outils : une seule source
 * pour les listes d'outils autorisés (--allowedTools) et les configurations
 * passées aux processus claude. Les serveurs eux-mêmes (coordination-server,
 * agent-server, learning-server) déclarent ces outils ; un test vérifie que les
 * deux côtés concordent (un outil déclaré mais non autorisé serait bloqué sans
 * bruit par claude).
 */

/** Nom de chaque serveur, tel que claude le voit (préfixe des outils : mcp__<nom>__). */
export const MCP_SERVER = {
  /** Coordination, pour le dialogue de Kopilia. */
  dialogue: "kopilia",
  /** Recettes et cours, pour les agents. */
  agents: "kopilia",
  /** Carnets et recettes, pour le relecteur et le rangement. */
  learning: "apprentissage",
} as const;

export type McpServerName = (typeof MCP_SERVER)[keyof typeof MCP_SERVER];

/** Outils du serveur de coordination, ouverts au dialogue. */
export const DIALOGUE_TOOLS = [
  "list_folders",
  "ask_agent",
  "start_task",
  "task_status",
  "instruct_task",
  "cancel_task",
  "start_brief",
  "get_brief",
  "economic_calendar",
  "news_recent",
  "market_price",
  "market_history",
  "market_indicators",
  "remember",
  "forget",
  "skill_view",
  "search_conversations",
  "learn_from_conversation",
  "learning_status",
  "skill_decide",
  "panel_open",
  "panel_update",
  "panel_display",
  "panel_close",
  "view_catalog",
  "view_open",
  "view_update",
  "chart_draw",
  "chart_drawings",
  "chart_move",
  "chart_erase",
  "alert_create",
  "alert_list",
  "alert_update",
  "alert_delete",
  "chart_indicators",
  "market_candles",
  "market_levels",
  "market_scan",
  "setups_search",
  "setups_list",
  "setup_feedback",
  "setup_example",
  "analysis_note",
  "analysis_get",
  "analysis_close",
  "level_keep",
  "telegram_send",
  "telegram_publish",
  "x_compose",
  "trading_status",
  "trading_settings",
  "order_prepare",
  "trade_manage",
  "ticket_cancel",
  "trading_review",
  "journal_get",
  "journal_note",
  "journal_show",
  "journal_analyze",
  "journal_bilan",
  "journal_settings",
  "broker_status",
  "broker_wake",
  "broker_pause",
  "broker_settings",
  "robot_develop",
  "robots_list",
  "robot_get",
] as const;

/** Recettes de Kopilia, lues par les agents. */
export const AGENT_SKILL_TOOLS = ["skill_view"] as const;

/** Cours du compte MetaTrader, pour les agents (si MetaApi est configuré). */
export const AGENT_MARKET_TOOLS = ["market_price", "market_history", "market_indicators", "market_candles", "market_levels", "market_scan"] as const;

/**
 * Outils des agents de la recherche d'opportunités (passes et réveils), en
 * plus des lectures des agents : hypothèses, dossiers de scénarios, leurs
 * alertes et rendez-vous, correction de la carte automatique.
 */
export const AGENT_SETUP_TOOLS = [
  "hypothesis_set",
  "scenario_open",
  "scenario_view",
  "scenario_update",
  "scenario_note",
  "scenario_watch",
  "scenario_unwatch",
  "scenario_rendezvous",
  "scenario_propose",
  "scenario_abandon",
  "map_adjust",
  "level_draw",
  "level_erase",
  "drawing_suggest",
] as const;

/**
 * Outils des agents d'action (tâches de fond sur Kopilia), en plus des lectures
 * des agents : tracés, alertes, indicateurs de plusieurs graphiques. Jamais
 * l'écran (encarts) : ils travaillent sans y toucher.
 */
export const AGENT_ACTION_TOOLS = [
  "chart_indicators",
  "chart_draw",
  "chart_drawings",
  "chart_move",
  "chart_erase",
  "alert_create",
  "alert_list",
  "alert_update",
  "alert_delete",
] as const;

/**
 * Outils de l'agent quant du laboratoire de stratégies, en plus des lectures
 * des agents : bibliothèque et leçons, réserve de bougies, versions du robot,
 * backtests, trades d'apprentissage, fil de la fiche.
 */
export const AGENT_ALGO_TOOLS = [
  "algo_library",
  "algo_data",
  "algo_robot_save",
  "algo_backtest_run",
  "algo_backtest_trades",
  "algo_note",
  "algo_lesson",
] as const;

/** Outils du relecteur et du rangement, et rien d'autre. */
export const LEARNING_TOOLS = [
  "memory_add",
  "memory_replace",
  "memory_remove",
  "skill_list",
  "skill_view",
  "skill_create",
  "skill_patch",
  "skill_rewrite",
  "skill_write_file",
  "skill_archive",
  "search_conversations",
] as const;

/** « mcp__kopilia__skill_view » : le nom complet d'un outil, pour --allowedTools. */
export function mcpTools(server: McpServerName, tools: readonly string[]): string[] {
  return tools.map((t) => `mcp__${server}__${t}`);
}

/** Configuration --mcp-config d'un serveur : lancé par le même Node, avec son environnement. */
export function mcpConfig(server: McpServerName, path: string, env: Record<string, string>) {
  return { mcpServers: { [server]: { command: process.execPath, args: [path], env } } };
}

/**
 * Écrit une configuration MCP dans un fichier privé (0600) et renvoie son
 * chemin, à passer à --mcp-config : les jetons qu'elle contient n'apparaissent
 * pas dans la ligne de commande du processus claude, lisible de tous (ps).
 */
export function writeMcpConfig(dataDir: string, name: string, config: object): string {
  const dir = join(dataDir, "mcp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

/** Le processus claude est terminé : sa configuration n'a plus de raison d'exister. */
export function removeMcpConfig(file: string): void {
  rmSync(file, { force: true });
}

/** Au démarrage : les configurations laissées par un arrêt brutal ne servent plus. */
export function clearMcpConfigs(dataDir: string): void {
  rmSync(join(dataDir, "mcp"), { recursive: true, force: true });
}
