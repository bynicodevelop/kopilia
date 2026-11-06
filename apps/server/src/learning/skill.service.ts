import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { newId } from "../common/ids.js";
import { invalidSkillFile, invalidSkillName, unsafeContent } from "../common/guard.js";

/** Qui suit la recette : le dialogue vocal, les agents (recherche, veille), ou les deux. */
export type SkillAudience = "dialogue" | "agents" | "all";
export type SkillState = "draft" | "active" | "superseded" | "rejected" | "archived";
export type SkillOrigin = "review" | "curator" | "user";

export interface SkillRow {
  id: string;
  name: string;
  version: number;
  state: SkillState;
  audience: SkillAudience;
  description: string;
  body: string;
  /** JSON { "references/<sujet>.md": "…" } */
  files: string;
  origin: SkillOrigin;
  reason: string | null;
  run_id: string | null;
  created_at: number;
  decided_at: number | null;
  announced_at: number | null;
}

export interface SkillMeta {
  name: string;
  pinned: number;
  uses: number;
  last_used_at: number | null;
  created_at: number;
}

/** Recette vue de l'extérieur (prompts, outils, interface). */
export interface SkillView {
  name: string;
  version: number;
  state: SkillState;
  audience: SkillAudience;
  description: string;
  body: string;
  files: string[];
}

export interface SkillProvenance {
  origin: SkillOrigin;
  reason?: string;
  runId?: string;
}

/** Refus lisible par le modèle qui écrit (nom, taille, contenu, lecture préalable). */
export class SkillError extends Error {}

export const SKILL_AUDIENCES: SkillAudience[] = ["dialogue", "agents", "all"];
const DESCRIPTION_MAX = 160;
const BODY_MAX = 6000;
const FILE_MAX = 8000;
const FILES_MAX = 6;
/** Recettes du dialogue placées en entier dans son prompt (au-delà : index + skill_view). */
export const DIALOGUE_INLINE_BUDGET = 4000;
/** Une recette d'agent jamais ouverte depuis si longtemps est archivée (récupérable). */
export const ARCHIVE_UNUSED_MS = 90 * 86_400_000;
/** Une proposition laissée sans réponse expire. */
export const DRAFT_EXPIRY_MS = 14 * 86_400_000;

/**
 * Les recettes (skills) de Kopilia : pour une classe de tâches, la procédure,
 * les outils qui marchent, les préférences de l'utilisateur et les pièges.
 * Chaque changement crée une version ; un changement proposé par la relecture
 * attend la validation de l'utilisateur (brouillon), sauf si l'adoption
 * automatique est activée. Rien n'est jamais supprimé : archivé au plus.
 */
@Injectable()
export class SkillService {
  /** Recettes lues pendant une relecture : on ne modifie que ce qu'on vient de relire. */
  private reads = new Map<string, Set<string>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  /* ------------------------------- Lecture -------------------------------- */

  private one(sql: string, ...args: unknown[]): SkillRow | undefined {
    return this.db.db.prepare(sql).get(...args) as SkillRow | undefined;
  }

  active(name: string): SkillRow | undefined {
    return this.one("SELECT * FROM skills WHERE name = ? AND state = 'active'", name);
  }

  draft(name: string): SkillRow | undefined {
    return this.one("SELECT * FROM skills WHERE name = ? AND state = 'draft' ORDER BY version DESC LIMIT 1", name);
  }

  /** Version de travail : le brouillon en attente s'il y en a un, sinon la version active, sinon la dernière archivée. */
  current(name: string): SkillRow | undefined {
    return this.draft(name) ?? this.active(name) ?? this.one("SELECT * FROM skills WHERE name = ? AND state = 'archived' ORDER BY version DESC LIMIT 1", name);
  }

  /** Une ligne par recette (version de travail), actives d'abord. */
  catalog(): SkillRow[] {
    const names = this.db.db.prepare("SELECT DISTINCT name FROM skills ORDER BY name").all() as Array<{ name: string }>;
    return names.map((n) => this.current(n.name)).filter((r): r is SkillRow => !!r && r.state !== "rejected");
  }

  meta(name: string): SkillMeta | undefined {
    return this.db.db.prepare("SELECT * FROM skill_meta WHERE name = ?").get(name) as SkillMeta | undefined;
  }

  history(name: string): SkillRow[] {
    return this.db.db.prepare("SELECT * FROM skills WHERE name = ? ORDER BY version DESC").all(name) as SkillRow[];
  }

  /** Recettes actives suivies par ce public (une recette « all » vaut pour les deux). */
  activeFor(audience: "dialogue" | "agents"): SkillRow[] {
    return this.db.db.prepare("SELECT * FROM skills WHERE state = 'active' AND audience IN (?, 'all') ORDER BY name").all(audience) as SkillRow[];
  }

  /** Propositions en attente de l'utilisateur. */
  pending(): SkillRow[] {
    return this.db.db.prepare("SELECT * FROM skills WHERE state = 'draft' ORDER BY created_at").all() as SkillRow[];
  }

  /**
   * Recette vue par un modèle. `use` : le dialogue ou un agent la suit (compte
   * l'usage) ; `runId` : la relecture la relit avant de la modifier.
   */
  view(name: string, opts: { file?: string; use?: boolean; runId?: string } = {}): SkillView | { name: string; file: string; content: string } {
    const row = opts.use ? this.active(name) : this.current(name);
    if (!row) throw new SkillError(`aucune recette « ${name} »${opts.use ? " active" : ""} : vérifie le nom dans la liste`);
    if (opts.runId) this.noteRead(opts.runId, name);
    if (opts.use) this.markUse(name);
    const files = parseFiles(row.files);
    if (opts.file) {
      const content = files[opts.file];
      if (content === undefined) throw new SkillError(`la recette « ${name} » n'a pas de fichier ${opts.file}`);
      return { name, file: opts.file, content };
    }
    return toView(row);
  }

  /* ------------------------------ Écriture -------------------------------- */

  /** Nouvelle recette. Refusée si le nom existe déjà : il faut alors la modifier. */
  create(input: { name: string; description: string; audience: SkillAudience; body: string }, prov: SkillProvenance): SkillRow {
    const name = input.name.trim();
    const bad = invalidSkillName(name);
    if (bad) throw new SkillError(bad);
    if (this.current(name)) throw new SkillError(`la recette « ${name} » existe déjà : relis-la (skill_view) puis modifie-la`);
    return this.write(name, 1, { description: input.description, audience: input.audience, body: input.body, files: {} }, prov);
  }

  /**
   * Nouvelle version d'une recette : remplacement de champs, remplacement
   * exact d'un passage (`patch`), ou ajout d'un fichier d'appoint. Part de la
   * version de travail (un brouillon en attente est remplacé par le nouveau).
   */
  update(
    name: string,
    change: {
      description?: string;
      audience?: SkillAudience;
      body?: string;
      patch?: { old: string; new: string };
      file?: { path: string; content: string };
    },
    prov: SkillProvenance,
  ): SkillRow {
    const base = this.current(name);
    if (!base) throw new SkillError(`aucune recette « ${name} » : crée-la plutôt`);
    if (this.meta(name)?.pinned && prov.origin === "curator") throw new SkillError(`« ${name} » est épinglée par l'utilisateur : n'y touche pas`);
    if (prov.runId) this.requireRead(prov.runId, name);
    let body = change.body ?? base.body;
    if (change.patch) {
      const count = body.split(change.patch.old).length - 1;
      if (!change.patch.old || count === 0) throw new SkillError("passage introuvable : recopie-le exactement depuis skill_view");
      if (count > 1) throw new SkillError("passage présent plusieurs fois : allonge-le pour qu'il soit unique");
      body = body.replace(change.patch.old, () => change.patch!.new);
    }
    const files = parseFiles(base.files);
    if (change.file) {
      const badFile = invalidSkillFile(change.file.path);
      if (badFile) throw new SkillError(badFile);
      files[change.file.path] = change.file.content;
    }
    const next = { description: change.description ?? base.description, audience: change.audience ?? base.audience, body, files };
    if (next.description === base.description && next.audience === base.audience && next.body === base.body && JSON.stringify(next.files) === base.files) {
      throw new SkillError("aucun changement");
    }
    return this.write(name, this.nextVersion(name), next, prov);
  }

  /** Valide le brouillon d'une recette : il devient la version suivie. */
  approve(name: string, now = Date.now()): SkillRow {
    const draft = this.draft(name);
    if (!draft) throw new SkillError(`aucune proposition en attente pour « ${name} »`);
    this.activate(draft, now);
    return this.one("SELECT * FROM skills WHERE id = ?", draft.id)!;
  }

  /** Refuse le brouillon : la version suivie (s'il y en a une) reste inchangée. */
  reject(name: string, now = Date.now()): SkillRow {
    const draft = this.draft(name);
    if (!draft) throw new SkillError(`aucune proposition en attente pour « ${name} »`);
    this.db.db.prepare("UPDATE skills SET state = 'rejected', decided_at = ? WHERE id = ?").run(now, draft.id);
    return { ...draft, state: "rejected", decided_at: now };
  }

  /** Met une recette de côté (récupérable) ; son brouillon éventuel tombe avec elle. */
  archive(name: string, now = Date.now()): void {
    const active = this.active(name);
    if (!active) throw new SkillError(`aucune recette active « ${name} »`);
    this.db.tx(() => {
      this.db.db.prepare("UPDATE skills SET state = 'archived', decided_at = ? WHERE id = ?").run(now, active.id);
      this.db.db.prepare("UPDATE skills SET state = 'rejected', decided_at = ? WHERE name = ? AND state = 'draft'").run(now, name);
    });
  }

  /** Réactive la dernière version archivée d'une recette. */
  restore(name: string, now = Date.now()): SkillRow {
    if (this.active(name)) throw new SkillError(`« ${name} » est déjà active`);
    const archived = this.one("SELECT * FROM skills WHERE name = ? AND state = 'archived' ORDER BY version DESC LIMIT 1", name);
    if (!archived) throw new SkillError(`aucune version archivée de « ${name} »`);
    this.db.db.prepare("UPDATE skills SET state = 'active', decided_at = ? WHERE id = ?").run(now, archived.id);
    this.touchMeta(name, now);
    return { ...archived, state: "active", decided_at: now };
  }

  pin(name: string, pinned: boolean): void {
    if (!this.current(name)) throw new SkillError(`aucune recette « ${name} »`);
    this.touchMeta(name);
    this.db.db.prepare("UPDATE skill_meta SET pinned = ? WHERE name = ?").run(pinned ? 1 : 0, name);
  }

  markAnnounced(ids: string[], now = Date.now()) {
    const stmt = this.db.db.prepare("UPDATE skills SET announced_at = ? WHERE id = ? AND announced_at IS NULL");
    this.db.tx(() => ids.forEach((id) => stmt.run(now, id)));
  }

  /**
   * Rangement déterministe : une recette d'agent jamais ouverte depuis 90 jours
   * est archivée (sauf épinglée) ; une proposition sans réponse depuis 14 jours
   * expire. Les recettes du dialogue, toujours dans son prompt, n'ont pas
   * d'usage mesurable : elles ne sont jamais archivées ainsi.
   */
  applyTransitions(now = Date.now()): { archived: string[]; expired: string[] } {
    const archived: string[] = [];
    for (const row of this.activeFor("agents")) {
      if (row.audience !== "agents") continue;
      const meta = this.meta(row.name);
      if (meta?.pinned) continue;
      const lastActivity = Math.max(meta?.last_used_at ?? 0, row.decided_at ?? row.created_at);
      if (now - lastActivity >= ARCHIVE_UNUSED_MS) {
        this.archive(row.name, now);
        archived.push(row.name);
      }
    }
    const expired = this.pending()
      .filter((d) => now - d.created_at >= DRAFT_EXPIRY_MS)
      .map((d) => {
        this.db.db.prepare("UPDATE skills SET state = 'rejected', decided_at = ? WHERE id = ?").run(now, d.id);
        return d.name;
      });
    return { archived, expired };
  }

  /* ---------------------- Lecture avant écriture (relecture) ---------------------- */

  noteRead(runId: string, name: string) {
    const set = this.reads.get(runId) ?? new Set<string>();
    set.add(name);
    this.reads.set(runId, set);
  }

  private requireRead(runId: string, name: string) {
    if (!this.reads.get(runId)?.has(name)) {
      throw new SkillError(`relis d'abord « ${name} » avec skill_view pendant cette relecture, puis modifie-la à partir de ce que tu as lu`);
    }
  }

  /** Fin d'une relecture : sa liste de lectures est oubliée. */
  endRun(runId: string) {
    this.reads.delete(runId);
  }

  /* ------------------------------- Interne -------------------------------- */

  private nextVersion(name: string): number {
    const row = this.db.db.prepare("SELECT max(version) v FROM skills WHERE name = ?").get(name) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  private write(
    name: string,
    version: number,
    content: { description: string; audience: SkillAudience; body: string; files: Record<string, string> },
    prov: SkillProvenance,
  ): SkillRow {
    const description = content.description.replace(/\s+/g, " ").trim();
    const body = content.body.trim();
    if (!SKILL_AUDIENCES.includes(content.audience)) throw new SkillError("public inconnu : dialogue, agents ou all");
    if (!description) throw new SkillError("description vide : dis quand ouvrir cette recette");
    if (description.length > DESCRIPTION_MAX) throw new SkillError(`description trop longue (${DESCRIPTION_MAX} caractères au plus)`);
    if (!body) throw new SkillError("recette vide");
    if (body.length > BODY_MAX) {
      throw new SkillError(`recette trop longue (${body.length}/${BODY_MAX} caractères) : garde les règles permanentes, mets le détail dans references/`);
    }
    const files = Object.entries(content.files);
    if (files.length > FILES_MAX) throw new SkillError(`trop de fichiers d'appoint (${FILES_MAX} au plus) : complète un fichier existant`);
    for (const [path, text] of files) {
      if (text.length > FILE_MAX) throw new SkillError(`${path} trop long (${FILE_MAX} caractères au plus)`);
    }
    for (const text of [description, body, ...files.map(([, t]) => t)]) {
      const unsafe = unsafeContent(text);
      if (unsafe) throw new SkillError(`refusé : ${unsafe}`);
    }

    const now = Date.now();
    // Une proposition de l'utilisateur lui-même, ou l'adoption automatique, n'attend pas.
    const immediate = prov.origin === "user" || this.config.learningAutoApprove;
    const row: SkillRow = {
      id: newId("skill"),
      name,
      version,
      state: "draft",
      audience: content.audience,
      description,
      body,
      files: JSON.stringify(Object.fromEntries(files)),
      origin: prov.origin,
      reason: prov.reason?.trim() || null,
      run_id: prov.runId ?? null,
      created_at: now,
      decided_at: null,
      announced_at: null,
    };
    this.db.tx(() => {
      // Le nouveau brouillon remplace celui qui attendait encore.
      this.db.db.prepare("UPDATE skills SET state = 'superseded' WHERE name = ? AND state = 'draft'").run(name);
      this.db.db
        .prepare(
          "INSERT INTO skills (id,name,version,state,audience,description,body,files,origin,reason,run_id,created_at,decided_at,announced_at) VALUES (@id,@name,@version,@state,@audience,@description,@body,@files,@origin,@reason,@run_id,@created_at,@decided_at,@announced_at)",
        )
        .run(row);
      this.touchMeta(name, now);
      if (immediate) this.activate(row, now);
    });
    return this.one("SELECT * FROM skills WHERE id = ?", row.id)!;
  }

  private activate(row: SkillRow, now: number) {
    this.db.tx(() => {
      this.db.db.prepare("UPDATE skills SET state = 'superseded' WHERE name = ? AND state IN ('active', 'archived')").run(row.name);
      this.db.db.prepare("UPDATE skills SET state = 'active', decided_at = ? WHERE id = ?").run(now, row.id);
    });
  }

  private touchMeta(name: string, now = Date.now()) {
    this.db.db.prepare("INSERT OR IGNORE INTO skill_meta (name, pinned, uses, last_used_at, created_at) VALUES (?, 0, 0, NULL, ?)").run(name, now);
  }

  private markUse(name: string, now = Date.now()) {
    this.touchMeta(name, now);
    this.db.db.prepare("UPDATE skill_meta SET uses = uses + 1, last_used_at = ? WHERE name = ?").run(now, name);
  }
}

export function parseFiles(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function toView(row: SkillRow): SkillView {
  return {
    name: row.name,
    version: row.version,
    state: row.state,
    audience: row.audience,
    description: row.description,
    body: row.body,
    files: Object.keys(parseFiles(row.files)),
  };
}
