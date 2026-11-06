import { randomBytes } from "node:crypto";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { Drawing, DrawingShape, DrawingSuggestion, SAME_LEVEL_ATR, Scenario, isOpenScenario } from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { localMoment } from "../common/dates.js";
import { DatabaseService } from "../db/database.service.js";
import { DashboardError, DrawingService, describeDrawing } from "../dashboard/drawing.service.js";
import { ChartTimeframe, TIMEFRAME_SECONDS, isChartTimeframe } from "../market/timeframes.js";
import { MapService } from "./map.service.js";
import { ScenarioService, SetupError } from "./scenario.service.js";
import { Line, PriceBand, bandOfDrawing, sameBounds, sameLevelIn } from "./overlap.js";
import { AlertService } from "../alerts/alert.service.js";

/** Une zone tracée par l'IA va de deux ATR au plus (trois sans candidat de l'algorithme), et à vingt ATR du prix au plus. */
const MAX_ZONE_ATR = 2;
const MAX_FREE_ZONE_ATR = 3;
const MAX_AWAY_ATR = 20;
/** Une correction d'un candidat de l'algorithme ne le déplace pas de plus d'un ATR. */
const MAX_SHIFT_ATR = 1;

/** Ce que l'agent demande de tracer : un candidat de la carte automatique (from), ou son propre niveau. */
export interface LevelInput {
  kind?: string;
  /** Clé d'un élément de la carte automatique (« z:… », « s:… », « r:… ») à adopter. */
  from?: string;
  /** Unité de la carte où il l'a vu (ou qui mesure l'ATR) ; celle du contexte du dossier par défaut. */
  timeframe?: string;
  top?: number;
  bottom?: number;
  price?: number;
  /** Points d'une oblique : « AAAA-MM-JJ HH:MM », heure de Paris, et un prix. */
  a?: { time?: string; price?: number };
  b?: { time?: string; price?: number };
  label?: string;
  reason?: string;
}

interface SuggestionRow {
  id: string;
  symbol: string;
  drawing_id: string;
  scenario_id: string | null;
  text: string;
  state: "open" | "done" | "dismissed";
  job_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Les niveaux de travail des scénarios de l'IA, sous l'autorité des tracés de
 * l'utilisateur :
 * - l'IA trace un niveau pour un dossier (un candidat de l'algorithme qu'elle
 *   a contrôlé, ou le sien), jamais là où l'utilisateur a déjà tracé : elle
 *   s'appuie alors sur son tracé ;
 * - un tracé de l'utilisateur posé au même endroit qu'un niveau de l'IA le
 *   remplace dans les dossiers ;
 * - l'utilisateur garde un niveau (il devient le sien) ou le retire (le
 *   dossier est relu), et ce choix nourrit sa façon de trader ;
 * - l'IA ne modifie jamais un tracé de l'utilisateur : elle lui suggère une
 *   correction, qu'il fait ou non ;
 * - un niveau part avec son dossier, sauf si un autre dossier ouvert s'y appuie.
 */
@Injectable()
export class LevelService implements OnModuleInit {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();
  /** Produits dont la fusion est en cours, et ceux qui ont encore changé pendant ce temps (elle sera refaite). */
  private readonly absorbing = new Set<string>();
  private readonly again = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly drawings: DrawingService,
    private readonly scenarios: ScenarioService,
    private readonly maps: MapService,
    private readonly alerts: AlertService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit() {
    this.drawings.on("changed", (symbol) => {
      this.closeSuggestions(symbol);
      this.absorbLater(symbol);
    });
    this.scenarios.on("closed", (s) => this.release(s));
  }

  /* ------------------------------- L'agent ------------------------------- */

  /**
   * Trace un niveau de travail pour un dossier ouvert. Refusé là où
   * l'utilisateur a tracé ; un niveau de l'IA déjà au même endroit (d'un
   * autre dossier) est partagé plutôt que doublé.
   */
  async draw(scenarioId: string, input: LevelInput, jobId?: string): Promise<{ drawing: Drawing; shared?: true }> {
    const s = this.open(scenarioId);
    const reason = input.reason?.trim();
    if (!reason) throw new SetupError("dis pourquoi ce niveau compte pour le dossier (reason)");
    const label = input.label?.trim();
    if (!label) throw new SetupError("donne-lui un nom court, affiché sur le graphique (label : « support 1h », « oblique de résistance »)");
    const tf = this.timeframe(input.timeframe, s);
    const ctx = await this.maps.context(s.symbol, tf);
    if ("error" in ctx) throw new SetupError(ctx.error);
    const shape = input.from ? await this.adopt(s, tf, input, ctx.atr) : this.free(input, ctx);
    const level = levelOf(shape);
    const near = { tol: SAME_LEVEL_ATR * ctx.atr, times: ctx.times, tf: TIMEFRAME_SECONDS[tf], nowS: this.now() / 1000 };
    const all = this.drawings.list([s.symbol]);
    const mine = sameLevelIn(
      level,
      all.filter((d) => d.createdBy !== "ia"),
      near,
    );
    if (mine)
      throw new SetupError(
        `ce niveau est déjà tracé par l'utilisateur (${mine.id} : ${describeDrawing(mine, s.digits)}) : appuie-toi sur son tracé (ajoute-le aux dépendances du dossier avec scenario_update) ; s'il te semble mal placé, dis-le-lui (drawing_suggest), sans le doubler`,
      );
    const twin = sameLevelIn(
      level,
      all.filter((d) => d.createdBy === "ia"),
      near,
    );
    if (twin) {
      this.scenarios.linkDrawings(s.id, [...s.depends.drawings, twin.id]);
      this.scenarios.note(
        s.id,
        "note",
        `Niveau ${twin.id} (${describeDrawing(twin, s.digits)}) déjà tracé pour ${twin.scenarioId ?? "un autre dossier"} : partagé. ${reason}`,
        {
          by: "agent",
          jobId,
        },
      );
      return { drawing: twin, shared: true };
    }
    let d: Drawing;
    try {
      d = this.drawings.create(s.symbol, shape, { by: "ia", label, scenarioId: s.id, reason });
    } catch (e) {
      if (e instanceof DashboardError) throw new SetupError(e.message);
      throw e;
    }
    this.scenarios.linkDrawings(s.id, [...s.depends.drawings, d.id]);
    this.scenarios.note(
      s.id,
      "note",
      `Niveau tracé ${d.id} : ${describeDrawing(d, s.digits)}${input.from ? ` (candidat ${input.from} de l'algorithme en ${tf})` : ""}. ${reason}`,
      {
        by: "agent",
        jobId,
      },
    );
    this.logger.log(`niveau ${d.id} tracé pour ${s.id} (${s.symbol}) : ${describeDrawing(d, s.digits)}`, "setups");
    this.rebind(s, d, jobId);
    return { drawing: d };
  }

  /**
   * Le tracé d'un produit qui a ces bornes (ceux du dossier d'abord) : une
   * alerte sur une bande qui le reprend se pose sur lui, sans dessiner une
   * seconde zone au même endroit (et elle le suivra s'il bouge).
   */
  zoneFor(scenarioId: string, top: number | undefined, bottom: number | undefined): Drawing | undefined {
    const s = this.scenarios.get(scenarioId);
    if (!s || top === undefined || bottom === undefined || !Number.isFinite(top) || !Number.isFinite(bottom)) return undefined;
    const band = { lo: Math.min(top, bottom), hi: Math.max(top, bottom) };
    const nowS = this.now() / 1000;
    const all = this.drawings.list([s.symbol]).filter((d) => d.kind === "zone");
    const ordered = [...all.filter((d) => s.depends.drawings.includes(d.id)), ...all.filter((d) => !s.depends.drawings.includes(d.id))];
    return ordered.find((d) => {
      const b = bandOfDrawing(d, nowS);
      return b !== undefined && sameBounds(band, b);
    });
  }

  /** L'agent retire un niveau de son dossier ; il disparaît, sauf si un autre dossier ouvert s'y appuie. */
  erase(scenarioId: string, drawingId: string, reason: string | undefined, jobId?: string): void {
    const s = this.open(scenarioId);
    const why = reason?.trim();
    if (!why) throw new SetupError("dis pourquoi tu retires ce niveau (reason)");
    const d = this.drawings.get(drawingId);
    if (!d || d.createdBy !== "ia")
      throw new SetupError(
        `${drawingId} n'est pas un niveau de l'IA : un tracé de l'utilisateur ne s'efface pas, retire-le seulement des dépendances du dossier`,
      );
    if (!s.depends.drawings.includes(d.id)) throw new SetupError(`le dossier ${s.id} ne s'appuie pas sur ${d.id}`);
    this.scenarios.linkDrawings(
      s.id,
      s.depends.drawings.filter((x) => x !== d.id),
    );
    this.scenarios.note(s.id, "note", `Niveau ${d.id} retiré (${describeDrawing(d, s.digits)}) : ${why}`, { by: "agent", jobId });
    this.orphan(d, s.id);
  }

  /**
   * Une suggestion sur un tracé de l'utilisateur : l'IA ne le modifie pas, elle
   * le lui signale (une seule suggestion en attente par tracé : la dernière).
   */
  suggest(drawingId: string, text: string | undefined, scenarioId: string | undefined, jobId?: string): DrawingSuggestion {
    const what = text?.trim();
    if (!what) throw new SetupError("quelle suggestion ? (text : « ta zone coupe les mèches de 28 070 : la descendre à 28 065 ? »)");
    const d = this.drawings.get(drawingId);
    if (!d) throw new SetupError(`aucun tracé « ${drawingId} »`);
    if (d.createdBy === "ia") throw new SetupError(`${d.id} est un niveau de l'IA : corrige-le toi-même (level_erase puis level_draw)`);
    const s = scenarioId ? this.scenarios.get(scenarioId) : undefined;
    if (scenarioId && !s) throw new SetupError(`aucun scénario ${scenarioId}`);
    const now = this.now();
    this.db.db.prepare("UPDATE drawing_suggestions SET state = 'done', updated_at = ? WHERE drawing_id = ? AND state = 'open'").run(now, d.id);
    const row: SuggestionRow = {
      id: `ds_${randomBytes(4).toString("hex")}`,
      symbol: d.symbol,
      drawing_id: d.id,
      scenario_id: s?.id ?? null,
      text: what.slice(0, 300),
      state: "open",
      job_id: jobId ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db.db
      .prepare(
        "INSERT INTO drawing_suggestions (id, symbol, drawing_id, scenario_id, text, state, job_id, created_at, updated_at) VALUES (@id,@symbol,@drawing_id,@scenario_id,@text,@state,@job_id,@created_at,@updated_at)",
      )
      .run(row);
    if (s) this.scenarios.note(s.id, "note", `Suggestion à l'utilisateur sur son tracé ${d.id} : ${row.text}`, { by: "agent", jobId });
    else this.scenarios.touch();
    return suggestionOf(row);
  }

  /* ----------------------------- L'utilisateur ----------------------------- */

  /** L'utilisateur garde un niveau de l'IA : il devient le sien, et les dossiers continuent de s'y appuyer. */
  keep(drawingId: string, note?: string): Drawing {
    const d = this.level(drawingId);
    this.remember(d, "keep", note);
    const kept = this.drawings.reassign(d.id, null);
    for (const s of this.scenarios.dependents({ drawingIds: [d.id] }))
      this.scenarios.levelFeedback(s.id, `L'utilisateur a gardé ton niveau ${d.id} (${describeDrawing(d, s.digits)}) : c'est maintenant son tracé.`, false);
    return kept;
  }

  /** L'utilisateur retire un niveau de l'IA : les dossiers qui s'y appuyaient le perdent et sont relus. */
  dismiss(drawingId: string, note?: string): Drawing {
    const d = this.level(drawingId);
    this.remember(d, "dismiss", note);
    const said = note?.trim() ? ` (« ${note.trim()} »)` : "";
    for (const s of this.scenarios.dependents({ drawingIds: [d.id] })) {
      this.scenarios.linkDrawings(
        s.id,
        s.depends.drawings.filter((x) => x !== d.id),
      );
      this.scenarios.levelFeedback(
        s.id,
        `L'utilisateur a retiré ton niveau ${d.id} (${describeDrawing(d, s.digits)})${said} : ne le retrace pas sans fait nouveau ; revois si le dossier tient sans lui.`,
        true,
      );
    }
    this.drawings.remove([d.id]);
    return d;
  }

  /** L'utilisateur écarte une suggestion de l'IA sur un de ses tracés. */
  dismissSuggestion(id: string): void {
    const r = this.db.db.prepare("UPDATE drawing_suggestions SET state = 'dismissed', updated_at = ? WHERE id = ? AND state = 'open'").run(this.now(), id);
    if (!r.changes) throw new SetupError(`aucune suggestion en attente « ${id} »`);
    this.scenarios.touch();
  }

  /** Les suggestions en attente (d'un produit, ou de tous). */
  suggestions(symbol?: string): DrawingSuggestion[] {
    const rows = (
      symbol
        ? this.db.db.prepare("SELECT * FROM drawing_suggestions WHERE state = 'open' AND symbol = ? ORDER BY created_at").all(symbol)
        : this.db.db.prepare("SELECT * FROM drawing_suggestions WHERE state = 'open' ORDER BY created_at").all()
    ) as SuggestionRow[];
    return rows.map(suggestionOf);
  }

  /* -------------------------------- Interne -------------------------------- */

  /**
   * Un tracé de l'utilisateur au même endroit qu'un niveau de l'IA le
   * remplace : les dossiers s'appuient désormais sur le sien (son tracé, plus
   * récent que leur dernière lecture, les fait relire), et le niveau de l'IA
   * disparaît. Gardé comme un niveau qu'il retient.
   */
  async absorb(symbol: string): Promise<void> {
    if (this.absorbing.has(symbol)) {
      this.again.add(symbol);
      return;
    }
    const all = this.drawings.list([symbol]);
    const levels = all.filter((d) => d.createdBy === "ia");
    const mine = all.filter((d) => d.createdBy !== "ia");
    if (!levels.length || !mine.length) return;
    this.absorbing.add(symbol);
    try {
      for (const level of levels) {
        const owner = level.scenarioId ? this.scenarios.get(level.scenarioId) : undefined;
        const tf = owner?.timeframe && isChartTimeframe(owner.timeframe) ? owner.timeframe : "1h";
        const ctx = await this.maps.context(symbol, tf);
        if ("error" in ctx) continue;
        const near = { tol: SAME_LEVEL_ATR * ctx.atr, times: ctx.times, tf: TIMEFRAME_SECONDS[tf], nowS: this.now() / 1000 };
        const theirs = sameLevelIn(levelOf(level), mine, near);
        if (!theirs || !this.drawings.get(level.id)) continue;
        this.remember(level, "keep", `retracé par l'utilisateur (${theirs.id})`);
        for (const s of this.scenarios.dependents({ drawingIds: [level.id] })) {
          this.scenarios.linkDrawings(s.id, [...s.depends.drawings.filter((x) => x !== level.id), theirs.id]);
          this.scenarios.note(
            s.id,
            "context",
            `Le tracé de l'utilisateur ${theirs.id} (${describeDrawing(theirs, s.digits)}) recouvre ton niveau ${level.id} : le dossier s'appuie désormais sur le sien.`,
            { by: "system" },
          );
        }
        this.drawings.remove([level.id]);
        this.logger.log(`niveau ${level.id} remplacé par le tracé ${theirs.id} de l'utilisateur (${symbol})`, "setups");
      }
    } finally {
      this.absorbing.delete(symbol);
      if (this.again.delete(symbol)) this.absorbLater(symbol);
    }
  }

  private absorbLater(symbol: string) {
    void this.absorb(symbol).catch((e: Error) => this.logger.warn(`niveaux de l'IA (${symbol}) : ${e.message}`, "setups"));
  }

  /** Les alertes du dossier sur une bande aux bornes du niveau qu'il vient de tracer passent sur ce niveau (une seule zone à l'écran). */
  private rebind(s: Scenario, d: Drawing, jobId?: string) {
    if (d.kind !== "zone") return;
    const band = { lo: Math.min(d.top, d.bottom), hi: Math.max(d.top, d.bottom) };
    for (const a of this.alerts.ofScenario(s.id)) {
      if (a.target.kind !== "band" || (a.state !== "active" && a.state !== "paused")) continue;
      if (!sameBounds({ lo: a.target.bottom, hi: a.target.top }, band)) continue;
      const actor = { by: "agent" as const, jobId };
      this.scenarios.watch(
        s.id,
        {
          target: { kind: "drawing", drawingId: d.id },
          condition: a.condition,
          trigger: a.trigger,
          timeframe: a.timeframe,
          intention: a.message ?? "le prix entre dans le niveau",
          ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
        },
        actor,
      );
      this.scenarios.unwatch(s.id, [a.id], `remplacée par la même alerte sur le niveau ${d.id} (mêmes bornes)`, actor);
    }
  }

  /** Un dossier se ferme : ses niveaux partent avec lui, sauf ceux sur lesquels un autre dossier ouvert s'appuie. */
  private release(s: Scenario) {
    for (const d of this.drawings.ofScenario(s.id)) this.orphan(d, s.id);
  }

  /** Un niveau que son dossier quitte : passé à un autre dossier ouvert qui s'y appuie, sinon effacé. */
  private orphan(d: Drawing, from: string) {
    const heir = this.scenarios.dependents({ drawingIds: [d.id] }).find((x) => x.id !== from);
    if (heir) this.drawings.reassign(d.id, heir.id);
    else this.drawings.remove([d.id]);
  }

  /** Les suggestions sur un tracé qui a été modifié ou effacé depuis sont faites (ou sans objet). */
  private closeSuggestions(symbol: string) {
    const open = this.db.db.prepare("SELECT * FROM drawing_suggestions WHERE state = 'open' AND symbol = ?").all(symbol) as SuggestionRow[];
    let changed = false;
    for (const r of open) {
      const d = this.drawings.get(r.drawing_id);
      if (d && d.updatedAt <= r.created_at) continue;
      this.db.db.prepare("UPDATE drawing_suggestions SET state = 'done', updated_at = ? WHERE id = ?").run(this.now(), r.id);
      changed = true;
    }
    if (changed) this.scenarios.touch();
  }

  /** Ce que l'utilisateur a gardé ou retiré, pour la relecture de sa façon de trader. */
  private remember(d: Drawing, verdict: "keep" | "dismiss", note?: string) {
    const { id: _id, symbol, kind, label, reason, scenarioId, createdBy: _by, createdAt: _c, updatedAt: _u, ...spec } = d;
    this.db.db
      .prepare(
        "INSERT INTO level_feedback (id, symbol, kind, spec, label, reason, verdict, note, scenario_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `lf_${randomBytes(4).toString("hex")}`,
        symbol,
        kind,
        JSON.stringify(spec),
        label ?? null,
        reason ?? null,
        verdict,
        note?.trim() || null,
        scenarioId ?? null,
        this.now(),
      );
  }

  private level(id: string): Drawing {
    const d = this.drawings.get(id);
    if (!d || d.createdBy !== "ia") throw new SetupError(`aucun niveau de l'IA « ${id} »`);
    return d;
  }

  private open(id: string): Scenario {
    const s = this.scenarios.get(id);
    if (!s) throw new SetupError(`aucun scénario ${id}`);
    if (!isOpenScenario(s.state)) throw new SetupError(`le scénario ${id} est fermé`);
    return s;
  }

  private timeframe(tf: string | undefined, s: Scenario): ChartTimeframe {
    const t = tf?.trim() || s.contextTimeframe || s.timeframe;
    if (!isChartTimeframe(t)) throw new SetupError(`unité de temps inconnue (« ${t} »)`);
    return t;
  }

  /** Un candidat de la carte automatique, contrôlé : la zone éventuellement corrigée dans ses bornes, l'oblique telle quelle. */
  private async adopt(s: Scenario, tf: ChartTimeframe, input: LevelInput, atr: number): Promise<DrawingShape> {
    const map = await this.maps.view(s.symbol, tf);
    if ("error" in map) throw new SetupError(map.error);
    const key = input.from!.trim();
    const covered = map.absorbed.find((x) => x.key === key);
    if (covered) throw new SetupError(`${key} est au même endroit que le tracé ${covered.drawingId} : appuie-toi sur lui (scenario_update)`);
    const zone = map.zones.find((z) => z.key === key);
    if (zone) {
      const top = input.top ?? zone.top;
      const bottom = input.bottom ?? zone.bottom;
      if (!(top > bottom)) throw new SetupError("le haut de la zone au-dessus de son bas");
      if (Math.max(Math.abs(top - zone.top), Math.abs(bottom - zone.bottom)) > MAX_SHIFT_ATR * atr + 1e-9)
        throw new SetupError(`tu peux corriger les bornes du candidat d'un ATR au plus (${round(atr)}) : au-delà, c'est un autre niveau (trace-le sans from)`);
      if (top - bottom > Math.max(MAX_ZONE_ATR * atr, 2 * (zone.top - zone.bottom)) + 1e-9) throw new SetupError("une zone reste de deux ATR de large au plus");
      return { kind: "zone", top, bottom, from: zone.first };
    }
    const line = map.trendlines.find((t) => t.key === key);
    if (line) return { kind: "trendline", a: line.a, b: line.b, extend: true };
    throw new SetupError(`aucun candidat « ${key} » sur la carte ${tf} du moment : relis-la (market_levels)`);
  }

  /** Un niveau de l'IA, sans candidat : borné en largeur et en distance au prix. */
  private free(input: LevelInput, ctx: { atr: number; price?: number }): DrawingShape {
    const kind = input.kind?.trim();
    const away = (v: number) => {
      if (!Number.isFinite(v) || v <= 0) throw new SetupError("des prix positifs");
      if (ctx.price !== undefined && Math.abs(v - ctx.price) > MAX_AWAY_ATR * ctx.atr)
        throw new SetupError(`un niveau à plus de ${MAX_AWAY_ATR} ATR du prix n'est pas un niveau de travail`);
      return v;
    };
    if (kind === "zone") {
      if (input.top === undefined || input.bottom === undefined) throw new SetupError("une zone : top et bottom");
      const top = away(Math.max(input.top, input.bottom));
      const bottom = away(Math.min(input.top, input.bottom));
      if (top === bottom) throw new SetupError("une zone va d'un prix à un autre");
      if (top - bottom > MAX_FREE_ZONE_ATR * ctx.atr + 1e-9) throw new SetupError(`une zone de l'IA fait ${MAX_FREE_ZONE_ATR} ATR de large au plus`);
      return { kind: "zone", top, bottom };
    }
    if (kind === "line") {
      if (input.price === undefined) throw new SetupError("une ligne : price");
      return { kind: "hline", price: away(input.price) };
    }
    if (kind === "trendline") {
      const point = (p: LevelInput["a"], which: string) => {
        const at = p?.time ? localMoment(p.time) : undefined;
        if (at === undefined || p?.price === undefined)
          throw new SetupError(`le point ${which} de l'oblique : time « AAAA-MM-JJ HH:MM » (heure de Paris) et price`);
        return { t: Math.floor(at / 1000), price: away(p.price) };
      };
      const a = point(input.a, "a");
      const b = point(input.b, "b");
      if (a.t === b.t) throw new SetupError("une oblique relie deux instants différents");
      return { kind: "trendline", a, b, extend: true };
    }
    throw new SetupError("kind : zone, line ou trendline (ou from : la clé d'un candidat de la carte automatique)");
  }
}

/** Le niveau d'une forme ou d'un tracé, pour le comparer : une bande de prix, ou une oblique. */
function levelOf(shape: DrawingShape | Drawing): { band?: PriceBand; line?: Line } {
  if (shape.kind === "hline") return { band: { lo: shape.price, hi: shape.price } };
  if (shape.kind === "zone") return { band: { lo: Math.min(shape.top, shape.bottom), hi: Math.max(shape.top, shape.bottom) } };
  // Une boîte de trade n'est pas un niveau : elle ne se compare pas.
  if (shape.kind === "position") return {};
  return shape.a.t !== shape.b.t ? { line: { a: shape.a, b: shape.b } } : {};
}

function suggestionOf(r: SuggestionRow): DrawingSuggestion {
  return {
    id: r.id,
    symbol: r.symbol,
    drawingId: r.drawing_id,
    ...(r.scenario_id ? { scenarioId: r.scenario_id } : {}),
    text: r.text,
    createdAt: r.created_at,
  };
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
