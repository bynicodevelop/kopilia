import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { newId } from "../common/ids.js";
import { unsafeContent } from "../common/guard.js";
import { sanitizeFts } from "../common/fts.js";

export type MemoryScope = "personal" | "environment" | "trading" | "project";
export type MemoryKind = "fact" | "preference" | "decision" | "correction" | "topic" | "commitment" | "hypothesis";

/**
 * Les carnets : le profil (qui est l'utilisateur, ses préférences, ses
 * corrections) et les notes d'environnement (outils, sources, pièges du
 * système), toujours chargés dans le prompt ; et sa façon de trader (style,
 * horizons et leurs unités de temps, niveaux qu'il trace, conditions d'entrée),
 * le carnet de trader, que suivent les agents de la recherche d'opportunités
 * (et que le dialogue connaît, pour le tenir à jour). Un fait va dans un seul carnet.
 */
export type MemoryStore = "profile" | "environment" | "trading";

const STORE_SCOPE: Record<MemoryStore, MemoryScope> = { profile: "personal", environment: "environment", trading: "trading" };

/** Nom d'un carnet, dans les refus. */
const STORE_NAMES: Record<MemoryStore, string> = { profile: "profil", environment: "environnement", trading: "façon de trader" };

/**
 * Budget de chaque carnet, en caractères. Volontairement petit : un carnet
 * plein oblige à fusionner ou remplacer plutôt qu'à empiler.
 */
export const MEMORY_BUDGET: Record<MemoryStore, number> = { profile: 1500, environment: 2000, trading: 2500 };

export interface MemoryRow {
  id: string;
  scope: MemoryScope;
  project_id: string | null;
  kind: MemoryKind;
  content: string;
  provenance: string;
  status: "active" | "superseded" | "forgotten";
  created_at: number;
  confirmed_at: number;
  expires_at: number | null;
  supersedes_id: string | null;
}

export interface SaveMemoryInput {
  scope: MemoryScope;
  projectId?: string | null;
  kind: MemoryKind;
  content: string;
  provenance: string;
  expiresAt?: number | null;
  supersedesId?: string | null;
}

/** Ce que les prompts reçoivent : les carnets, figés au lancement d'une session. */
export interface MemorySnapshot {
  profile: string[];
  environment: string[];
  trading: string[];
}

/** Refus lisible par le modèle qui écrit (doublon, budget, contenu dangereux). */
export class MemoryError extends Error {}

/**
 * Mémoire locale indépendante du contexte du CLI. Recherche par portée,
 * mots-clés (FTS5) et statut, avec un budget de contexte configurable.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  save(input: SaveMemoryInput): MemoryRow {
    const now = Date.now();
    const row: MemoryRow = {
      id: newId("mem"),
      scope: input.scope,
      project_id: input.scope === "project" ? (input.projectId ?? null) : null,
      kind: input.kind,
      content: input.content.trim(),
      provenance: input.provenance,
      status: "active",
      created_at: now,
      confirmed_at: now,
      expires_at: input.expiresAt ?? null,
      supersedes_id: input.supersedesId ?? null,
    };
    this.db.tx(() => {
      if (row.supersedes_id) {
        this.db.db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(row.supersedes_id);
      }
      this.db.db
        .prepare(
          "INSERT INTO memories (id,scope,project_id,kind,content,provenance,status,created_at,confirmed_at,expires_at,supersedes_id) VALUES (@id,@scope,@project_id,@kind,@content,@provenance,@status,@created_at,@confirmed_at,@expires_at,@supersedes_id)",
        )
        .run(row);
    });
    return row;
  }

  /** Dédupliquer : un contenu actif identique dans la même portée. */
  findDuplicate(scope: MemoryScope, projectId: string | null, content: string): MemoryRow | undefined {
    return this.db.db
      .prepare("SELECT * FROM memories WHERE status='active' AND scope=? AND ifnull(project_id,'')=ifnull(?,'') AND content=? LIMIT 1")
      .get(scope, projectId, content.trim()) as MemoryRow | undefined;
  }

  /** Recherche FTS5 bornée par portée/projet et budget de contexte. */
  search(query: string, opts: { scope?: MemoryScope; projectId?: string | null; limit?: number } = {}): MemoryRow[] {
    const limit = opts.limit ?? this.config.memoryContextBudget;
    const match = sanitizeFts(query);
    if (!match) return this.recent(opts.scope, opts.projectId ?? null, limit);
    const rows = this.db.db
      .prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status='active'
           AND (? IS NULL OR m.scope = ?)
           AND (? IS NULL OR ifnull(m.project_id,'') = ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(match, opts.scope ?? null, opts.scope ?? null, opts.projectId ?? null, opts.projectId ?? "", limit) as MemoryRow[];
    return rows;
  }

  recent(scope: MemoryScope | undefined, projectId: string | null, limit: number): MemoryRow[] {
    return this.db.db
      .prepare(
        `SELECT * FROM memories WHERE status='active'
           AND (? IS NULL OR scope = ?)
           AND (? IS NULL OR ifnull(project_id,'') = ?)
         ORDER BY confirmed_at DESC LIMIT ?`,
      )
      .all(scope ?? null, scope ?? null, projectId ?? null, projectId ?? "", limit) as MemoryRow[];
  }

  /** Oubli : purge la ligne (triggers => FTS nettoyé) et empêche la relecture. */
  forget(id: string): boolean {
    const info = this.db.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return info.changes > 0;
  }

  list(scope?: MemoryScope, projectId?: string | null): MemoryRow[] {
    return this.recent(scope, projectId ?? null, 500);
  }

  /* ------------------------- Carnets (apprentissage) ------------------------- */

  /** Entrées actives d'un carnet, de la plus ancienne à la plus récente. */
  entries(store: MemoryStore): MemoryRow[] {
    return this.db.db
      .prepare("SELECT * FROM memories WHERE status='active' AND scope=? AND project_id IS NULL ORDER BY created_at, rowid")
      .all(STORE_SCOPE[store]) as MemoryRow[];
  }

  /** Caractères occupés dans un carnet, et son budget. */
  usage(store: MemoryStore): { used: number; budget: number } {
    return { used: this.entries(store).reduce((n, r) => n + r.content.length, 0), budget: MEMORY_BUDGET[store] };
  }

  /**
   * Les deux carnets pour un prompt. Un carnet qui déborde (souvenirs dictés
   * entre deux rangements) garde ses entrées les plus récentes dans le budget ;
   * le rangement fusionnera le reste.
   */
  snapshot(): MemorySnapshot {
    const fit = (store: MemoryStore) => {
      let left = MEMORY_BUDGET[store];
      const kept: MemoryRow[] = [];
      for (const row of this.entries(store).reverse()) {
        if (row.content.length > left) continue;
        left -= row.content.length;
        kept.push(row);
      }
      return kept.reverse().map((r) => r.content);
    };
    return { profile: fit("profile"), environment: fit("environment"), trading: fit("trading") };
  }

  /**
   * Ajoute une entrée à un carnet. Refusée si elle est vide, en double, jugée
   * dangereuse, ou si le carnet n'a plus la place (`strict`) : il faut alors
   * remplacer ou fusionner une entrée existante.
   */
  add(store: MemoryStore, content: string, opts: { kind?: MemoryKind; provenance: string; strict?: boolean }): MemoryRow {
    const text = this.check(content);
    const scope = STORE_SCOPE[store];
    const twin = this.findDuplicate(scope, null, text);
    if (twin) throw new MemoryError(`déjà retenu (${twin.id}) : rien à ajouter`);
    if (opts.strict) this.checkBudget(store, text.length);
    return this.save({ scope, kind: opts.kind ?? "fact", content: text, provenance: opts.provenance });
  }

  /** Remplace une entrée (reformulation, fusion de deux faits) : l'ancienne passe en « superseded ». */
  replace(id: string, content: string, opts: { provenance: string; strict?: boolean }): MemoryRow {
    const old = this.active(id);
    const text = this.check(content);
    const store = storeOf(old);
    if (opts.strict) this.checkBudget(store, text.length - old.content.length);
    return this.save({ scope: old.scope, kind: old.kind, content: text, provenance: opts.provenance, supersedesId: old.id });
  }

  /** Retire une entrée devenue fausse ou inutile (gardée en historique, hors des prompts). */
  retire(id: string): MemoryRow {
    const old = this.active(id);
    this.db.db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(id);
    return old;
  }

  /**
   * Rétablit une entrée remplacée ou retirée (l'utilisateur défait un
   * changement de la relecture) ; la version qui l'avait remplacée sort du carnet.
   */
  restore(id: string): MemoryRow {
    const row = this.db.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!row || row.status !== "superseded") throw new MemoryError(`rien à rétablir pour ${id}`);
    this.db.tx(() => {
      this.db.db.prepare("UPDATE memories SET status = 'superseded' WHERE supersedes_id = ? AND status = 'active'").run(id);
      this.db.db.prepare("UPDATE memories SET status = 'active', confirmed_at = ? WHERE id = ?").run(Date.now(), id);
    });
    return { ...row, status: "active" };
  }

  /** Souvenirs arrivés à échéance : sortis des carnets. */
  expire(now = Date.now()): number {
    return this.db.db.prepare("UPDATE memories SET status = 'superseded' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").run(now)
      .changes;
  }

  private active(id: string): MemoryRow {
    const row = this.db.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!row || row.status !== "active" || row.project_id) throw new MemoryError(`aucune entrée active ${id}`);
    if (row.scope !== "personal" && row.scope !== "environment" && row.scope !== "trading") throw new MemoryError(`aucune entrée active ${id}`);
    return row;
  }

  private check(content: string): string {
    const text = content.replace(/\s+/g, " ").trim();
    if (!text) throw new MemoryError("entrée vide");
    if (text.length > 400) throw new MemoryError("entrée trop longue (400 caractères au plus) : un fait par entrée");
    const unsafe = unsafeContent(text);
    if (unsafe) throw new MemoryError(`refusé : ${unsafe}`);
    return text;
  }

  private checkBudget(store: MemoryStore, extra: number) {
    const { used, budget } = this.usage(store);
    if (used + extra > budget) {
      throw new MemoryError(
        `carnet ${STORE_NAMES[store]} plein (${used + extra}/${budget} caractères) : remplace ou fusionne une entrée existante (memory_replace), ou retire-en une devenue inutile, plutôt que d'ajouter`,
      );
    }
  }

  /**
   * Ce que l'utilisateur dicte (remember) : retenu même si le carnet déborde
   * (le rangement fusionnera). Un doublon renvoie l'entrée existante.
   * `replaces` : quelques mots de l'entrée qu'elle remplace dans ce carnet (il
   * change une règle déjà notée) ; sans entrée correspondante, elle s'ajoute.
   */
  dictate(store: MemoryStore, content: string, opts: { provenance: string; replaces?: string }): { row: MemoryRow; replaced?: string } {
    const twin = this.findDuplicate(STORE_SCOPE[store], null, this.check(content));
    if (twin) return { row: twin };
    const old = opts.replaces ? this.best(store, opts.replaces) : undefined;
    if (old) return { row: this.replace(old.id, content, { provenance: opts.provenance }), replaced: old.content };
    return { row: this.add(store, content, { provenance: opts.provenance }) };
  }

  /** Oublie l'entrée d'un carnet (le profil par défaut) la plus proche de `query` ; renvoie son contenu. */
  forgetBest(query: string, store: MemoryStore = "profile"): string | null {
    const best = this.best(store, query);
    if (!best) return null;
    this.forget(best.id);
    return best.content;
  }

  /** L'entrée active d'un carnet la plus proche de `query`. */
  private best(store: MemoryStore, query: string): MemoryRow | undefined {
    // Sans mot-clé exploitable, search() renverrait la plus récente : aucune.
    if (!sanitizeFts(query)) return undefined;
    return this.search(query, { scope: STORE_SCOPE[store], projectId: null, limit: 1 })[0];
  }
}

export function storeOf(row: Pick<MemoryRow, "scope">): MemoryStore {
  return row.scope === "environment" ? "environment" : row.scope === "trading" ? "trading" : "profile";
}
