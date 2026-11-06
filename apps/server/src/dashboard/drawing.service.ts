import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  Drawing,
  DrawingShape,
  MAX_AI_LEVELS,
  MAX_DRAWINGS,
  drawingSchema,
  drawingShapeSchema,
  fibLevels,
  fibRatioLabel,
  positionDistances,
  positionProblem,
  positionRatio,
  ratioLabel,
} from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { DatabaseService } from "../db/database.service.js";
import { frenchPrice } from "../market/metaapi.js";

/** Erreur lisible du tableau de bord, renvoyée telle quelle à Kopilia ou à l'écran. */
export class DashboardError extends Error {}

interface DrawingRow {
  id: string;
  symbol: string;
  kind: Drawing["kind"];
  spec: string;
  label: string | null;
  created_by: Drawing["createdBy"];
  created_at: number;
  updated_at: number;
  scenario_id?: string | null;
  reason?: string | null;
}

/**
 * Les tracés d'analyse technique de chaque produit (lignes horizontales,
 * obliques, zones, Fibonacci, boîtes de trade), à la souris ou par Kopilia. Rattachés au produit et non à
 * un encart : ils se retrouvent dans toutes les unités de temps et après avoir
 * fermé puis rouvert le graphique. Gardés en base, avec un identifiant stable
 * (les alertes s'y rattacheront). Émet `changed` (le symbole) à chaque
 * changement. Les niveaux de travail de l'IA sont des tracés aussi (« ia »),
 * rattachés à leur scénario, avec leur propre plafond.
 */
@Injectable()
export class DrawingService extends EventEmitter<{ changed: [string] }> {
  constructor(
    private readonly db: DatabaseService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  /** Les tracés de ces produits (de tous sans liste), les plus anciens d'abord. */
  list(symbols?: string[]): Drawing[] {
    if (symbols && !symbols.length) return [];
    const rows = symbols
      ? (this.db.db
          .prepare(`SELECT * FROM drawings WHERE symbol IN (${symbols.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
          .all(...symbols) as DrawingRow[])
      : (this.db.db.prepare("SELECT * FROM drawings ORDER BY created_at, rowid").all() as DrawingRow[]);
    return this.readable(rows);
  }

  get(id: string): Drawing | undefined {
    const row = this.db.db.prepare("SELECT * FROM drawings WHERE id = ?").get(id.trim()) as DrawingRow | undefined;
    return row ? this.readable([row])[0] : undefined;
  }

  /** Un nouveau tracé sur ce produit (symbole exact du courtier) ; un niveau de l'IA porte son scénario et sa raison. */
  create(symbol: string, shape: unknown, opts: { label?: string; by: Drawing["createdBy"]; scenarioId?: string; reason?: string }): Drawing {
    const parsed = checkShape(shape);
    const ai = opts.by === "ia";
    const { n } = this.db.db.prepare(`SELECT COUNT(*) AS n FROM drawings WHERE symbol = ? AND created_by ${ai ? "=" : "<>"} 'ia'`).get(symbol) as { n: number };
    if (ai && n >= MAX_AI_LEVELS)
      throw new DashboardError(`${MAX_AI_LEVELS} niveaux de l'IA au plus sur un produit : retire ceux des dossiers fermés ou inutiles`);
    if (!ai && n >= MAX_DRAWINGS) throw new DashboardError(`${MAX_DRAWINGS} tracés au plus sur un produit : efface-en d'abord`);
    const now = Date.now();
    const row: DrawingRow = {
      id: `d_${randomBytes(3).toString("hex")}`,
      symbol,
      kind: parsed.kind,
      spec: specOf(parsed),
      label: labelOf(opts.label) ?? null,
      created_by: opts.by,
      created_at: now,
      updated_at: now,
      scenario_id: ai ? (opts.scenarioId ?? null) : null,
      reason: ai ? (opts.reason?.trim().slice(0, 400) ?? null) : null,
    };
    this.db.db
      .prepare(
        "INSERT INTO drawings (id, symbol, kind, spec, label, created_by, created_at, updated_at, scenario_id, reason) VALUES (@id,@symbol,@kind,@spec,@label,@created_by,@created_at,@updated_at,@scenario_id,@reason)",
      )
      .run(row);
    this.emit("changed", symbol);
    return toDrawing(row);
  }

  /** Déplace ou renomme un tracé (même genre) ; `label` null retire son nom. */
  update(id: string, patch: { shape?: unknown; label?: string | null }): Drawing {
    const current = this.get(id);
    if (!current) throw new DashboardError(`aucun tracé « ${id} »`);
    let spec: string | undefined;
    if (patch.shape !== undefined) {
      const parsed = checkShape(patch.shape);
      if (parsed.kind !== current.kind) throw new DashboardError("un tracé ne change pas de genre : efface-le et trace l'autre");
      spec = specOf(parsed);
    }
    const label = patch.label === undefined ? undefined : (labelOf(patch.label ?? undefined) ?? null);
    if (spec === undefined && label === undefined) throw new DashboardError("rien à changer : donne la forme ou le nom du tracé");
    this.db.db
      .prepare("UPDATE drawings SET spec = COALESCE(?, spec), label = CASE WHEN ? THEN ? ELSE label END, updated_at = ? WHERE id = ?")
      .run(spec ?? null, label !== undefined ? 1 : 0, label ?? null, Date.now(), current.id);
    this.emit("changed", current.symbol);
    return this.get(current.id)!;
  }

  /** Les niveaux de l'IA rattachés à ce scénario. */
  ofScenario(scenarioId: string): Drawing[] {
    return this.readable(this.db.db.prepare("SELECT * FROM drawings WHERE scenario_id = ? ORDER BY created_at, rowid").all(scenarioId) as DrawingRow[]);
  }

  /**
   * Un niveau de l'IA change de main : rattaché à un autre scénario, ou gardé
   * par l'utilisateur (`owner` null) et devenu le sien, avec sa raison.
   */
  reassign(id: string, owner: string | null): Drawing {
    const d = this.get(id);
    if (!d || d.createdBy !== "ia") throw new DashboardError(`aucun niveau de l'IA « ${id} »`);
    if (owner) this.db.db.prepare("UPDATE drawings SET scenario_id = ? WHERE id = ?").run(owner, d.id);
    // Gardé tel quel : sa forme n'a pas changé, les dossiers qui s'y appuient n'ont rien à relire.
    else this.db.db.prepare("UPDATE drawings SET created_by = 'user', scenario_id = NULL WHERE id = ?").run(d.id);
    this.emit("changed", d.symbol);
    return this.get(d.id)!;
  }

  /**
   * Les tracés qu'aucun geste n'efface : les boîtes d'un trade en cours (ordre
   * en attente, position ouverte), données par la prise de position. Effacer
   * l'une d'elles passe par un ticket à confirmer, qui retire l'ordre ; la
   * boîte part une fois le trade terminé chez le courtier.
   */
  guard: (ids: string[]) => string[] = () => [];

  /** Efface ces tracés, sauf ceux que la garde retient ; renvoie ceux qui sont effacés. */
  remove(ids: string[]): Drawing[] {
    const kept = new Set(this.guard(ids));
    const found = ids
      .filter((id) => !kept.has(id))
      .map((id) => this.get(id))
      .filter((d): d is Drawing => d !== undefined);
    if (!found.length) return [];
    const del = this.db.db.prepare("DELETE FROM drawings WHERE id = ?");
    this.db.tx(() => {
      for (const d of found) del.run(d.id);
    });
    for (const symbol of new Set(found.map((d) => d.symbol))) this.emit("changed", symbol);
    return found;
  }

  /** Efface tous les tracés d'un produit, sauf les niveaux de l'IA (ils vont et viennent avec ses scénarios). */
  clear(symbol: string): Drawing[] {
    return this.remove(
      this.list([symbol])
        .filter((d) => d.createdBy !== "ia")
        .map((d) => d.id),
    );
  }

  /**
   * Les tracés lisibles. Une ligne abîmée ne peut être ni affichée ni réparée :
   * elle est retirée, sinon chaque écran qui relit la liste échouerait.
   */
  private readable(rows: DrawingRow[]): Drawing[] {
    const out: Drawing[] = [];
    for (const r of rows) {
      const d = parseRow(r);
      if (d) out.push(d);
      else {
        this.db.db.prepare("DELETE FROM drawings WHERE id = ?").run(r.id);
        this.logger.warn(`tracé ${r.id} (${r.symbol}) illisible en base : retiré`, "dashboard");
      }
    }
    return out;
  }
}

/**
 * La forme reçue, vérifiée et rangée : une zone a son haut au-dessus de son
 * bas, et son début avant sa fin ; une oblique, deux points différents ; un
 * Fibonacci, un mouvement (deux instants et deux prix différents) ; une boîte
 * de trade, ses niveaux dans l'ordre de son sens.
 */
function checkShape(shape: unknown): DrawingShape {
  const r = drawingShapeSchema.safeParse(shape);
  if (!r.success) throw new DashboardError(`tracé illisible : ${r.error.issues.map((i) => `${i.path.join(".") || "forme"} ${i.message}`).join(" ; ")}`);
  const s = r.data;
  if (s.kind === "zone") {
    const [bottom, top] = s.bottom <= s.top ? [s.bottom, s.top] : [s.top, s.bottom];
    if (top === bottom) throw new DashboardError("une zone va d'un prix à un autre : donne deux prix différents");
    const [from, to] = s.from !== undefined && s.to !== undefined && s.from > s.to ? [s.to, s.from] : [s.from, s.to];
    return { kind: "zone", top, bottom, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  }
  // Un Fibonacci mesure un mouvement : deux points à des instants et des prix différents.
  if ((s.kind === "fib" || s.kind === "fibext") && (s.a.t === s.b.t || s.a.price === s.b.price)) {
    throw new DashboardError(
      s.kind === "fib"
        ? "un retracement va d'un plus haut à un plus bas (ou l'inverse) : deux points à des instants et des prix différents"
        : "l'impulsion d'une extension va d'un point à un autre : a et b à des instants et des prix différents",
    );
  }
  // Une boîte de trade : ses niveaux dans le bon ordre pour son sens, et une largeur (son début avant sa fin).
  if (s.kind === "position") {
    const problem = positionProblem(s);
    if (problem) throw new DashboardError(`boîte de trade illisible : ${problem}`);
    if (s.to === undefined) return s;
    if (s.to === s.from) throw new DashboardError("une boîte de trade a une largeur : sa fin (to) après son début (from)");
    return s.to > s.from ? s : { ...s, from: s.to, to: s.from };
  }
  if (s.kind === "trendline" && s.a.t === s.b.t && s.a.price === s.b.price) throw new DashboardError("une oblique relie deux points différents");
  // Une verticale marque un instant : la prolonger vers la droite n'a pas de sens.
  if (s.kind === "trendline" && s.a.t === s.b.t) return { ...s, extend: false };
  return s;
}

/** La forme sans son genre (rangé à part), telle que gardée en base. */
function specOf(shape: DrawingShape): string {
  const { kind: _kind, ...spec } = shape;
  return JSON.stringify(spec);
}

function labelOf(label?: string): string | undefined {
  const l = label?.trim().slice(0, 40);
  return l || undefined;
}

function parseRow(r: DrawingRow): Drawing | undefined {
  try {
    const d = drawingSchema.safeParse(toDrawing(r));
    return d.success ? d.data : undefined;
  } catch {
    return undefined;
  }
}

function toDrawing(r: DrawingRow): Drawing {
  return {
    ...(JSON.parse(r.spec) as object),
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    ...(r.label ? { label: r.label } : {}),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.scenario_id ? { scenarioId: r.scenario_id } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  } as Drawing;
}

/**
 * Le tracé en quelques mots, pour Kopilia : « ligne à 2 680,50 « résistance » »,
 * « zone 2 650 – 2 660 », « oblique de 2 600 (3 nov. 10:00) à 2 640
 * (3 nov. 14:00), prolongée », « retracement de Fibonacci de … ; niveaux
 * 0 à 2 700, 0,236 à 2 676,40… » (sans ses niveaux si `levels` est faux).
 */
export function describeDrawing(d: Drawing, digits?: number, opts: { levels?: boolean } = {}): string {
  const p = (v: number) => frenchPrice(v, digits);
  const named = d.label ? ` « ${d.label} »` : "";
  if (d.kind === "hline") return `ligne à ${p(d.price)}${named}`;
  if (d.kind === "zone") {
    const span = [d.from !== undefined ? `depuis le ${shortMoment(d.from)}` : "", d.to !== undefined ? `jusqu'au ${shortMoment(d.to)}` : ""]
      .filter(Boolean)
      .join(" ");
    return `zone ${p(d.bottom)} – ${p(d.top)}${span ? ` ${span}` : ""}${named}`;
  }
  if (d.kind === "fib" || d.kind === "fibext") {
    // Les niveaux avec leur prix : Kopilia peut les dire sans les recalculer.
    const levels = fibLevels(d)
      .map((l) => `${fibRatioLabel(l.ratio)} à ${p(l.price)}`)
      .join(", ");
    const head =
      d.kind === "fib"
        ? `retracement de Fibonacci de ${p(d.a.price)} (${shortMoment(d.a.t)}) à ${p(d.b.price)} (${shortMoment(d.b.t)})`
        : `extension de Fibonacci de l'impulsion ${p(d.a.price)} (${shortMoment(d.a.t)}) – ${p(d.b.price)} (${shortMoment(d.b.t)}), projetée depuis ${p(d.c.price)} (${shortMoment(d.c.t)})`;
    const extended = d.extend ? (d.kind === "fib" ? ", prolongé" : ", prolongée") : "";
    return `${head}${extended}${named}${opts.levels === false ? "" : ` ; niveaux ${levels}`}`;
  }
  if (d.kind === "position") {
    // Les distances et le rapport avec leurs prix : Kopilia peut les dire sans les recalculer.
    const { risk, reward } = positionDistances(d);
    const ratio = positionRatio(d);
    const span = d.to !== undefined ? `du ${shortMoment(d.from)} au ${shortMoment(d.to)}` : `depuis le ${shortMoment(d.from)}`;
    return `boîte ${d.side === "long" ? "d'achat" : "de vente"}${named} : entrée ${p(d.entry)}, stop ${p(d.stop)} (${p(risk)} de risque), objectif ${p(d.target)} (${p(reward)} de gain)${ratio !== undefined ? `, rapport gain / risque ${ratioLabel(ratio)}` : ""}, ${span}`;
  }
  if (d.a.t === d.b.t)
    return `ligne verticale le ${shortMoment(d.a.t)}, de ${p(Math.min(d.a.price, d.b.price))} à ${p(Math.max(d.a.price, d.b.price))}${named}`;
  return `oblique de ${p(d.a.price)} (${shortMoment(d.a.t)}) à ${p(d.b.price)} (${shortMoment(d.b.t)})${d.extend ? ", prolongée" : ""}${named}`;
}

/** « 3 nov. 10:00 », heure locale ; `t` en secondes. */
export function shortMoment(t: number): string {
  const d = new Date(t * 1000);
  const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(d);
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
