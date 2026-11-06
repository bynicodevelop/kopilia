/**
 * Avant de s'appeler Kopilia, l'application lisait ses réglages sous le préfixe
 * JARVIS_ : un .env d'avant le changement de nom marche tel quel. Chaque
 * JARVIS_X devient KOPILIA_X (sauf si KOPILIA_X est déjà défini, qui l'emporte),
 * puis disparaît de l'environnement : les processus lancés ensuite ne voient
 * que les nouveaux noms.
 *
 * Importé en premier par chaque point d'entrée (serveur, serveurs MCP), et
 * rappelé après la lecture du .env.
 */
const LEGACY = "JARVIS_";
const PREFIX = "KOPILIA_";

export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY)) continue;
    const next = PREFIX + key.slice(LEGACY.length);
    if (env[next] === undefined && value !== undefined) env[next] = value;
    delete env[key];
  }
}

adoptLegacyEnv();
