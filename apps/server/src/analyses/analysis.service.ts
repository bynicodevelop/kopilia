import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  ANALYSIS_BIASES,
  ANALYSIS_MEMORY_MS,
  ANALYSIS_SIDES,
  HORIZONS,
  type Analysis,
  type AnalysisEntry,
  type AnalysisEntryKind,
  type AnalysisView,
  type AnalysisZone,
  analysisViewSchema,
} from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import type { Product } from "../market/market.service.js";
import { type SaidView, ideaLabel, saidText } from "./analysis-texts.js";

/** Une erreur que le modèle peut corriger : elle lui revient en { error }. */
export class AnalysisError extends Error {}

/** Ce qu'il vient de dire d'un produit : seulement les champs dits (l'idée peut ne changer que sa zone). */
export interface AnalysisNote {
  summary?: string;
  fundamental?: { bias?: string; reason?: string };
  technical?: { bias?: string; reason?: string };
  idea?: { side?: string; zone?: AnalysisZone; trigger?: string; horizon?: string; timeframe?: string };
  invalidation?: string;
  catalysts?: string;
}

/** Ce qu'une lecture a donné : la fiche après, l'état d'avant et quand, et la fiche fermée qu'elle suit. */
export interface NoteResult {
  analysis: Analysis;
  /** Ce qu'il a dit (les champs dits, validés). */
  said: SaidView;
  /** L'état d'avant (absent : fiche neuve). */
  before?: { view: AnalysisView; at: number };
  opened: boolean;
  /** Fiche neuve : la précédente sur ce produit, fermée depuis moins de deux semaines. */
  closed?: Analysis;
}

interface AnalysisRow {
  id: string;
  symbol: string;
  name: string;
  digits: number | null;
  author: Analysis["author"];
  view: string;
  state: Analysis["state"];
  close_reason: string | null;
  closed_by: Analysis["closedBy"] | null;
  close_proposed_at: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface EntryRow {
  id: string;
  analysis_id: string;
  at: number;
  kind: AnalysisEntryKind;
  by: AnalysisEntry["by"];
  text: string;
  data: string | null;
}

const clean = (s: string | undefined) => (s?.trim() ? s.trim() : undefined);

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T | undefined {
  if (value === undefined || value === "") return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new AnalysisError(`${what} : ${allowed.join(", ")}`);
}

/**
 * Les fiches d'analyse de l'utilisateur, une ouverte par produit, gardées en
 * base avec leur fil. Une lecture (« view ») ne remplace que ce qu'il a dit ;
 * l'état complet est gardé à chaque lecture, pour comparer d'un jour à l'autre.
 * Rien n'est effacé : une fiche fermée reste lisible, et rappelée deux
 * semaines quand il en ouvre une nouvelle sur le même produit.
 */
@Injectable()
export class AnalysisService extends EventEmitter<{ changed: [] }> {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();

  constructor(private readonly db: DatabaseService) {
    super();
  }

  /** La fiche ouverte d'un produit. */
  open(symbol: string): Analysis | undefined {
    const row = this.db.db.prepare("SELECT * FROM analyses WHERE symbol = ? AND state = 'open'").get(symbol) as AnalysisRow | undefined;
    return row ? toAnalysis(row) : undefined;
  }

  get(id: string): Analysis | undefined {
    const row = this.db.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id.trim()) as AnalysisRow | undefined;
    return row ? toAnalysis(row) : undefined;
  }

  /** Les fiches ouvertes (les plus récentes d'abord), et avec `closedSince` celles fermées depuis. */
  list(opts: { closedSince?: number; symbol?: string } = {}): Analysis[] {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM analyses WHERE (state = 'open' OR closed_at >= ?) ${opts.symbol ? "AND symbol = ?" : ""} ORDER BY state = 'open' DESC, updated_at DESC`,
      )
      .all(...[opts.closedSince ?? Number.MAX_SAFE_INTEGER, ...(opts.symbol ? [opts.symbol] : [])]) as AnalysisRow[];
    return rows.map(toAnalysis);
  }

  /** La fiche d'un produit qui était ouverte à cet instant (la plus récente, s'il y en a eu plusieurs). */
  at(symbol: string, at: number): Analysis | undefined {
    const row = this.db.db
      .prepare("SELECT * FROM analyses WHERE symbol = ? AND created_at <= ? AND (closed_at IS NULL OR closed_at >= ?) ORDER BY created_at DESC LIMIT 1")
      .get(symbol, at, at) as AnalysisRow | undefined;
    return row ? toAnalysis(row) : undefined;
  }

  /** La dernière fiche fermée d'un produit, si elle l'a été depuis `since`. */
  lastClosed(symbol: string, since: number): Analysis | undefined {
    const row = this.db.db
      .prepare("SELECT * FROM analyses WHERE symbol = ? AND state = 'closed' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 1")
      .get(symbol, since) as AnalysisRow | undefined;
    return row ? toAnalysis(row) : undefined;
  }

  /** Le fil d'une fiche : les `limit` dernières entrées, de la plus ancienne à la plus récente. */
  entries(id: string, limit = 40): AnalysisEntry[] {
    const rows = this.db.db
      .prepare("SELECT * FROM (SELECT *, rowid AS seq FROM analysis_entries WHERE analysis_id = ? ORDER BY at DESC, rowid DESC LIMIT ?) ORDER BY at, seq")
      .all(id, limit) as EntryRow[];
    return rows.map(toEntry);
  }

  /** Les clés de ce que le contradicteur a déjà relevé sur une fiche. */
  raised(id: string): Set<string> {
    const keys = new Set<string>();
    for (const e of this.entriesOfKind(id, "challenge")) for (const k of e.keys ?? []) keys.add(k);
    return keys;
  }

  /**
   * Ce qu'il vient de dire d'un produit : écrit dans sa fiche ouverte (ouverte
   * si besoin). Renvoie l'état d'avant, pour que le contradicteur compare.
   */
  note(product: Product & { digits?: number }, note: AnalysisNote): NoteResult {
    const said = this.said(note);
    if (!Object.keys(said).length) throw new AnalysisError("rien à noter : dis sa lecture, un biais, son idée ou ce qui l'invaliderait");
    const now = this.now();
    return this.db.tx(() => {
      const current = this.open(product.symbol);
      const before = current ? this.lastView(current.id) : undefined;
      const view = merge(current?.view ?? {}, said);
      let id = current?.id;
      if (!current) {
        id = `an_${randomBytes(4).toString("hex")}`;
        this.db.db
          .prepare("INSERT INTO analyses (id, symbol, name, digits, author, view, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, 'open', ?, ?)")
          .run(id, product.symbol, product.name, product.digits ?? null, JSON.stringify(view), now, now);
      } else {
        // Une nouvelle lecture répond aussi à une fermeture proposée : la fiche continue.
        this.db.db.prepare("UPDATE analyses SET view = ?, updated_at = ?, close_proposed_at = NULL WHERE id = ?").run(JSON.stringify(view), now, id);
      }
      this.addEntry(id!, "view", "user", saidText(said, product.digits), { view });
      const analysis = this.get(id!)!;
      const closed = current ? undefined : this.lastClosed(product.symbol, now - ANALYSIS_MEMORY_MS);
      this.emit("changed");
      return { analysis, said, ...(before ? { before } : {}), opened: !current, ...(closed ? { closed } : {}) };
    });
  }

  /** Sa réponse à une objection, ou la raison d'un changement. */
  answer(id: string, text: string): AnalysisEntry {
    const t = clean(text);
    if (!t) throw new AnalysisError("sa réponse, avec ses mots");
    const e = this.addEntry(id, "why", "user", t);
    this.touch(id);
    return e;
  }

  /** Ce que le contradicteur a relevé (et ne relèvera plus sur cette fiche). */
  challenge(id: string, points: Array<{ key: string; text: string; covers?: string[] }>): AnalysisEntry | undefined {
    if (!points.length) return undefined;
    const keys = points.flatMap((p) => [p.key, ...(p.covers ?? [])]);
    return this.addEntry(id, "challenge", "kopilia", points.map((p) => p.text).join(" "), { keys });
  }

  /** Ferme une fiche, avec sa raison ; la suivante sur ce produit repartira de zéro. */
  close(id: string, reason: string | undefined, by: "user" | "kopilia" = "user"): Analysis {
    const a = this.get(id);
    if (!a) throw new AnalysisError(`aucune fiche « ${id} »`);
    if (a.state === "closed") throw new AnalysisError(`la fiche ${a.name} est déjà fermée`);
    const now = this.now();
    const why = clean(reason);
    this.db.tx(() => {
      this.db.db
        .prepare("UPDATE analyses SET state = 'closed', close_reason = ?, closed_by = ?, closed_at = ?, updated_at = ?, close_proposed_at = NULL WHERE id = ?")
        .run(why ?? null, by, now, now, id);
      this.addEntry(id, "closed", by === "user" ? "user" : "kopilia", why ?? "sans raison donnée");
    });
    this.emit("changed");
    return this.get(id)!;
  }

  /* ------------------------------- Interne ------------------------------- */

  /** La dernière lecture d'une fiche : son état complet et quand. */
  private lastView(id: string): { view: AnalysisView; at: number } | undefined {
    const row = this.db.db.prepare("SELECT * FROM analysis_entries WHERE analysis_id = ? AND kind = 'view' ORDER BY at DESC, rowid DESC LIMIT 1").get(id) as
      EntryRow | undefined;
    const e = row ? toEntry(row) : undefined;
    return e?.view ? { view: e.view, at: e.at } : undefined;
  }

  private entriesOfKind(id: string, kind: AnalysisEntryKind): AnalysisEntry[] {
    return (this.db.db.prepare("SELECT * FROM analysis_entries WHERE analysis_id = ? AND kind = ? ORDER BY at, rowid").all(id, kind) as EntryRow[]).map(
      toEntry,
    );
  }

  private addEntry(id: string, kind: AnalysisEntryKind, by: AnalysisEntry["by"], text: string, data?: { view?: AnalysisView; keys?: string[] }): AnalysisEntry {
    const entry = { id: `ae_${randomBytes(5).toString("hex")}`, at: this.now(), kind, by, text, ...data };
    this.db.db
      .prepare("INSERT INTO analysis_entries (id, analysis_id, at, kind, by, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, id, entry.at, kind, by, text, data ? JSON.stringify(data) : null);
    return entry;
  }

  private touch(id: string) {
    this.db.db.prepare("UPDATE analyses SET updated_at = ? WHERE id = ?").run(this.now(), id);
    this.emit("changed");
  }

  /** Les champs dits, validés (sens, biais, horizon), sans les vides. */
  private said(n: AnalysisNote): SaidView {
    const out: SaidView = {};
    const summary = clean(n.summary);
    if (summary) out.summary = summary;
    for (const key of ["fundamental", "technical"] as const) {
      const b = n[key];
      if (!b) continue;
      const bias = oneOf(b.bias, ANALYSIS_BIASES, key === "fundamental" ? "biais fondamental" : "biais technique");
      const reason = clean(b.reason);
      if (bias || reason) out[key] = { ...(bias ? { bias } : {}), ...(reason ? { reason } : {}) };
    }
    if (n.idea) {
      const side = oneOf(n.idea.side, ANALYSIS_SIDES, "le sens de son idée");
      const horizon = oneOf(n.idea.horizon, HORIZONS, "l'horizon");
      const zone = cleanZone(n.idea.zone);
      const trigger = clean(n.idea.trigger);
      const timeframe = clean(n.idea.timeframe);
      const idea = {
        ...(side ? { side } : {}),
        ...(zone ? { zone } : {}),
        ...(trigger ? { trigger } : {}),
        ...(horizon ? { horizon } : {}),
        ...(timeframe ? { timeframe } : {}),
      };
      if (Object.keys(idea).length) out.idea = idea;
    }
    const invalidation = clean(n.invalidation);
    if (invalidation) out.invalidation = invalidation;
    const catalysts = clean(n.catalysts);
    if (catalysts) out.catalysts = catalysts;
    return out;
  }
}

/** Une zone donnée : prix rangés (bas, haut), sans les vides. */
function cleanZone(z: AnalysisZone | undefined): AnalysisZone | undefined {
  if (!z) return undefined;
  const nums = [z.low, z.high].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const text = clean(z.text);
  const drawingId = clean(z.drawingId);
  const out: AnalysisZone = {
    ...(nums.length ? { low: Math.min(...nums), high: Math.max(...nums) } : {}),
    ...(drawingId ? { drawingId } : {}),
    ...(text ? { text } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * L'état après ce qu'il vient de dire. Un biais qui change de sens perd
 * l'ancienne raison (elle justifiait l'autre sens) ; une idée qui change de sens
 * repart de ce qu'il a dit (l'ancienne zone et l'ancienne invalidation allaient
 * avec l'autre sens), en gardant l'horizon.
 */
export function merge(before: AnalysisView, said: SaidView): AnalysisView {
  const out: AnalysisView = { ...before };
  if (said.summary) out.summary = said.summary;
  for (const key of ["fundamental", "technical"] as const) {
    const s = said[key];
    if (!s) continue;
    const prev = before[key];
    if (!s.bias) {
      if (!prev)
        throw new AnalysisError(
          `${key === "fundamental" ? "le biais fondamental" : "le biais technique"} : haussier (up), baissier (down) ou neutre (neutral) ?`,
        );
      out[key] = { bias: prev.bias, ...(s.reason ? { reason: s.reason } : {}) };
      continue;
    }
    const reason = s.reason ?? (prev?.bias === s.bias ? prev.reason : undefined);
    out[key] = { bias: s.bias, ...(reason ? { reason } : {}) };
  }
  if (said.idea) {
    const prev = before.idea;
    const side = said.idea.side ?? prev?.side;
    if (!side) throw new AnalysisError("le sens de son idée : achat (buy), vente (sell), ou pas d'idée (none) ?");
    if (!prev || side !== prev.side) {
      out.idea = { ...(prev?.horizon ? { horizon: prev.horizon } : {}), ...said.idea, side };
      if (prev && !said.invalidation) delete out.invalidation;
    } else {
      out.idea = { ...prev, ...said.idea, side };
    }
  }
  if (said.invalidation) out.invalidation = said.invalidation;
  if (said.catalysts) out.catalysts = said.catalysts;
  return analysisViewSchema.parse(out);
}

function toAnalysis(r: AnalysisRow): Analysis {
  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    ...(r.digits !== null ? { digits: r.digits } : {}),
    author: r.author,
    view: analysisViewSchema.parse(JSON.parse(r.view)),
    state: r.state,
    ...(r.close_reason ? { closeReason: r.close_reason } : {}),
    ...(r.closed_by ? { closedBy: r.closed_by } : {}),
    ...(r.close_proposed_at ? { closeProposedAt: r.close_proposed_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.closed_at ? { closedAt: r.closed_at } : {}),
  };
}

function toEntry(r: EntryRow): AnalysisEntry {
  const data = r.data ? (JSON.parse(r.data) as { view?: unknown; keys?: string[] }) : {};
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    by: r.by,
    text: r.text,
    ...(data.view ? { view: analysisViewSchema.parse(data.view) } : {}),
    ...(data.keys ? { keys: data.keys } : {}),
  };
}

/** « achat sur 2 600 » d'une fiche, pour une ligne courte (setups, liste). */
export function shortIdea(a: Analysis): string | undefined {
  return ideaLabel(a.view, a.digits);
}
