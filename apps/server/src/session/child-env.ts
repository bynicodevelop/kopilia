/**
 * Environnement explicite pour les sous-processus `claude`.
 *
 * Le CLI doit s'authentifier via le login d'ABONNEMENT (Claude Max) stocké par
 * l'utilisateur, et non via des variables héritées qui changent le fournisseur,
 * la facturation ou l'endpoint. On retire donc les variables qui :
 *   - forcent un autre fournisseur / endpoint (ANTHROPIC_*, *_USE_BEDROCK/VERTEX)
 *   - imposent un flux OAuth local/staging (USE_LOCAL_OAUTH, USE_STAGING_OAUTH)
 *   - rattachent le processus à une session hôte Claude Code (CLAUDE_CODE_*, SDK)
 * Les secrets de Kopilia (jetons MetaApi et Telegram) restent aussi au serveur : un ouvrier
 * qui lance des commandes dans un projet ne doit pas pouvoir les lire.
 *
 * Conforme au cahier des charges : on signale les variables retirées PAR LEUR
 * NOM, jamais leur valeur.
 */

const DROP_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_AGENT_SDK_", "CLAUDE_PREVIEW_", "AWS_", "KOPILIA_METAAPI_", "KOPILIA_TELEGRAM_"];
const DROP_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
  "AI_AGENT",
  "BAGGAGE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Jetons de l'API interne : chaque serveur MCP reçoit le sien explicitement.
  "KOPILIA_INTERNAL_TOKEN",
  "KOPILIA_AGENT_TOKEN",
  "KOPILIA_LEARNING_TOKEN",
]);

export interface ChildEnvResult {
  env: NodeJS.ProcessEnv;
  stripped: string[];
}

/**
 * Pour Kopilia (dialogue, agents, relecteur) : tous ses outils chargés d'emblée.
 * Sinon, au-delà d'un certain nombre d'outils, le CLI ne donne que leurs noms
 * et le modèle doit d'abord demander leurs paramètres (ToolSearch) : un
 * aller-retour de plus à la voix, et des agents qui devinent les champs (vu
 * le 2026-11-04 : six appels ratés à hypothesis_set). Avec --strict-mcp-config,
 * il ne reste que ses propres outils : rien de trop.
 */
export const OWN_TOOLS_ENV: NodeJS.ProcessEnv = { ENABLE_TOOL_SEARCH: "false" };

export function buildChildEnv(extra?: NodeJS.ProcessEnv): ChildEnvResult {
  const env: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const drop = DROP_EXACT.has(key) || DROP_PREFIXES.some((p) => key.startsWith(p));
    if (drop) {
      stripped.push(key);
      continue;
    }
    env[key] = value;
  }
  // CLAUDE_CONFIG_DIR, s'il existe, est conservé : il localise le login stocké.
  if (extra) Object.assign(env, extra);
  return { env, stripped: stripped.sort() };
}
