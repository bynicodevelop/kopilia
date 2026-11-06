// Montage commun des tests : une base SQLite neuve dans un dossier temporaire,
// l'environnement voulu posé AVANT la lecture de la configuration, et un
// nettoyage unique. Les tests ne dépendent ni du .env du poste ni de data/.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "../src/config/config.service.js";
import { DatabaseService } from "../src/db/database.service.js";
import { AppLogger } from "../src/common/logger.js";

export interface TempData {
  /** Dossier temporaire (canonique : sur macOS, /var est un lien vers /private/var). */
  root: string;
  config: ConfigService;
  logger: AppLogger;
  db: DatabaseService;
  /** Ferme la base et efface le dossier. */
  cleanup(): void;
}

/**
 * Base neuve dans `<tmp>/kopilia-<prefix>-…/data`. `env` est posé avant la
 * configuration ; il peut dépendre du dossier créé (racine des projets…).
 */
export function tempData(prefix: string, env: Record<string, string> | ((root: string) => Record<string, string>) = {}): TempData {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `kopilia-${prefix}-`)));
  process.env.KOPILIA_DATA_DIR = join(root, "data");
  for (const [key, value] of Object.entries(typeof env === "function" ? env(root) : env)) process.env[key] = value;
  const config = new ConfigService();
  const logger = new AppLogger();
  const db = new DatabaseService(config, logger);
  db.onModuleInit();
  return {
    root,
    config,
    logger,
    db,
    cleanup() {
      db.onModuleDestroy();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Une session (les jobs, tours et documents y sont rattachés par clé étrangère). */
export function insertSession(db: DatabaseService, id: string, opts: { state?: string; projectId?: string | null; at?: number } = {}): void {
  const at = opts.at ?? Date.now();
  db.db
    .prepare("INSERT OR IGNORE INTO sessions (id, claude_session_id, project_id, token, state, created_at, updated_at) VALUES (?, NULL, ?, 'tok', ?, ?, ?)")
    .run(id, opts.projectId ?? null, opts.state ?? "active", at, at);
}
