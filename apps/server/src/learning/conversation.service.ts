import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../db/database.service.js";
import { sanitizeFts } from "../common/fts.js";

export interface TurnRow {
  id: string;
  session_id: string;
  turn_id: string;
  role: "user" | "assistant";
  text: string;
  outcome: string | null;
  created_at: number;
}

/** Un passage retrouvé : le tour qui correspond, avec la question ou la réponse qui l'entoure. */
export interface ConversationHit {
  at: number;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  before?: string;
  after?: string;
}

const HIT_CHARS = 600;
const CONTEXT_CHARS = 300;

/**
 * Les conversations passées : recherche plein texte (« on en avait parlé le
 * mois dernier ») et lecture des tours dans l'ordre pour la relecture.
 */
@Injectable()
export class ConversationService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Passages correspondant à la requête, du plus pertinent au moins pertinent,
   * un par conversation au plus (les autres tours d'une conversation déjà citée
   * n'apportent rien de plus). `excludeSession` : la conversation en cours.
   */
  search(query: string, opts: { limit?: number; excludeSession?: string } = {}): ConversationHit[] {
    const match = sanitizeFts(query);
    if (!match) return [];
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const rows = this.db.db
      .prepare(
        `SELECT t.* FROM turns_fts f JOIN turns t ON t.rowid = f.rowid
         WHERE turns_fts MATCH ? AND (? IS NULL OR t.session_id <> ?)
         ORDER BY rank LIMIT 60`,
      )
      .all(match, opts.excludeSession ?? null, opts.excludeSession ?? null) as TurnRow[];
    const seen = new Set<string>();
    const hits: ConversationHit[] = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      const before = this.neighbour(row, -1);
      const after = this.neighbour(row, 1);
      hits.push({
        at: row.created_at,
        sessionId: row.session_id,
        role: row.role,
        text: clip(row.text, HIT_CHARS),
        ...(before ? { before: clip(before.text, CONTEXT_CHARS) } : {}),
        ...(after ? { after: clip(after.text, CONTEXT_CHARS) } : {}),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Tours écrits après `from` (exclu) jusqu'à `to` (inclus), dans l'ordre, hors sessions système. */
  between(from: number, to: number): TurnRow[] {
    return this.db.db
      .prepare(
        `SELECT t.* FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.created_at > ? AND t.created_at <= ? AND s.state <> 'system'
         ORDER BY t.created_at, t.rowid`,
      )
      .all(from, to) as TurnRow[];
  }

  /** Dernier tour écrit (hors sessions système). */
  /** Les `n` derniers tours d'une session, dans l'ordre de la conversation. */
  lastTurns(sessionId: string, n: number): TurnRow[] {
    return this.db.db
      .prepare("SELECT * FROM (SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at")
      .all(sessionId, n) as TurnRow[];
  }

  lastTurnAt(): number | undefined {
    const row = this.db.db.prepare("SELECT max(t.created_at) at FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.state <> 'system'").get() as {
      at: number | null;
    };
    return row.at ?? undefined;
  }

  private neighbour(row: TurnRow, dir: -1 | 1): TurnRow | undefined {
    const sql =
      dir < 0
        ? "SELECT * FROM turns WHERE session_id = ? AND created_at <= ? AND id <> ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
        : "SELECT * FROM turns WHERE session_id = ? AND created_at >= ? AND id <> ? ORDER BY created_at, rowid LIMIT 1";
    return this.db.db.prepare(sql).get(row.session_id, row.created_at, row.id) as TurnRow | undefined;
  }
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).replace(/\s+\S*$/, "")}…` : flat;
}
