import { newToken } from "../common/ids.js";
import { DatabaseService } from "../db/database.service.js";

/**
 * Session « système » d'un service qui lance ses propres travaux (veille,
 * apprentissage) : les travaux y sont rattachés, et la recherche dans les
 * conversations l'ignore. Créée au premier besoin, jamais fermée.
 */
export function ensureSystemSession(db: DatabaseService, id: string): void {
  const now = Date.now();
  db.db
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, claude_session_id, project_id, token, state, created_at, updated_at) VALUES (?, NULL, NULL, ?, 'system', ?, ?)",
    )
    .run(id, newToken(), now, now);
}
