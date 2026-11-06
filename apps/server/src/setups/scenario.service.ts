import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  AUTHORS,
  Alert,
  Author,
  DIRECTIONS,
  FEEDBACK_REACTIONS,
  FeedbackReaction,
  HORIZONS,
  HYPOTHESIS_BIASES,
  Hypothesis,
  HypothesisState,
  MAX_ACTIVE_HYPOTHESES,
  MAX_OPEN_SCENARIOS,
  MAX_SCENARIOS_PER_PRODUCT,
  Scenario,
  ScenarioDepends,
  ScenarioEvent,
  ScenarioEventKind,
  ScenarioOutcome,
  ScenarioState,
  SetupStatsRow,
  hypothesisSchema,
  isOpenScenario,
  rewardRisk,
  scenarioSchema,
} from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { DatabaseService } from "../db/database.service.js";
import { AlertInput, AlertService } from "../alerts/alert.service.js";
import { DashboardError } from "../dashboard/drawing.service.js";
import type { Product } from "../market/market.service.js";
import { isChartTimeframe } from "../market/timeframes.js";
import { frenchPrice } from "../market/metaapi.js";

/** Une hypothèse sans échéance donnée vit jusqu'à la fin de la séance (intraday) ou quelques jours (swing). */
const HYPOTHESIS_LIFE_MS = { intraday: 18 * 3_600_000, swing: 5 * 86_400_000 } as const;
/** Échéance d'un scénario au plus loin. */
const MAX_SCENARIO_LIFE_MS = 10 * 86_400_000;
/** Les scénarios clos restent montrés à l'écran ce temps-là. */
const RECENT_MS = 36 * 3_600_000;
/** Hypothèses et scénarios terminés depuis plus longtemps sont retirés au démarrage (leurs résultats gardent les statistiques). */
const PURGE_HYPOTHESES_MS = 30 * 86_400_000;
/** Vérification des échéances. */
const TICK_MS = 30_000;
/** Longueurs des textes d'un dossier. */
const MAX_TEXT = 1500;
const MAX_EVENT_TEXT = 1200;

/** Erreur à dire telle quelle à l'agent ou à l'utilisateur (« ce scénario est déjà clos »). */
export class SetupError extends Error {}

interface HypothesisRow {
  id: string;
  author: Author;
  statement: string;
  products: string;
  bias: Hypothesis["bias"];
  horizon: Hypothesis["horizon"];
  catalysts: string | null;
  invalidation: string;
  source: string | null;
  state: HypothesisState;
  state_reason: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

interface ScenarioRow {
  id: string;
  symbol: string;
  spec: string;
  state: ScenarioState;
  state_reason: string | null;
  review: string | null;
  wake_at: number | null;
  wake_reason: string | null;
  feedback: string | null;
  outcome: string | null;
  checked_at: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  proposed_at: number | null;
  told_at: number | null;
  closed_at: number | null;
}

/** Ce que garde la colonne spec d'un scénario : tout le dossier, hors états et instants. */
type ScenarioSpec = Pick<
  Scenario,
  | "name"
  | "digits"
  | "direction"
  | "horizon"
  | "timeframe"
  | "contextTimeframe"
  | "title"
  | "why"
  | "snapshot"
  | "plan"
  | "invalidation"
  | "depends"
  | "entry"
  | "stop"
  | "targets"
>;

interface EventRow {
  id: string;
  scenario_id: string;
  at: number;
  kind: ScenarioEventKind;
  text: string;
  by: ScenarioEvent["by"];
  job_id: string | null;
}

export interface HypothesisInput {
  statement: string;
  products?: Product[];
  bias: string;
  horizon: string;
  catalysts?: string;
  invalidation?: string;
  source?: string;
  expiresAt?: number;
}

export interface HypothesisPatch extends Partial<Omit<HypothesisInput, "bias" | "horizon">> {
  bias?: string;
  horizon?: string;
  state?: HypothesisState;
  /** Pourquoi elle change d'état : toujours donné avec `state`. */
  reason?: string;
}

/** Le dossier d'un nouveau scénario : tout ce qu'il faudra relire au réveil. */
export interface ScenarioInput {
  product: Product;
  direction: string;
  horizon: string;
  timeframe: string;
  contextTimeframe?: string;
  title: string;
  why: string;
  snapshot: string;
  plan: string;
  invalidation: string;
  depends?: Partial<ScenarioDepends>;
  entry?: number;
  stop?: number;
  targets?: number[];
  expiresAt: number;
}

export type ScenarioPatch = Partial<Omit<ScenarioInput, "product" | "direction">>;

/** Ce qu'il faut pour poser une alerte de l'IA : la cible et les réglages d'une alerte, l'intention à vérifier. */
export interface WatchInput {
  target: unknown;
  condition?: string;
  trigger?: string;
  timeframe?: string;
  intention: string;
  expiresAt?: number;
}

/** Qui agit sur un dossier : l'agent (et son travail), l'utilisateur, ou le serveur. */
export interface Actor {
  by: ScenarioEvent["by"];
  jobId?: string;
}

export interface ScenarioEvents {
  /** Quelque chose a changé (hypothèses, scénarios, fil) : les écrans se mettent à jour. */
  changed: [];
  /** Une hypothèse a changé : `before` absent si elle est nouvelle ; `jobId` : le travail qui l'a changée. */
  hypothesis: [{ after: Hypothesis; before?: Hypothesis; jobId?: string }];
  /** Un setup vient d'être proposé. */
  proposed: [Scenario];
  /** Un scénario se ferme : abandonné, expiré, ou clos avec son résultat. */
  closed: [Scenario];
  /** L'utilisateur a réagi ou fait une remarque sur un scénario (`wake` : l'agent doit relire le dossier). */
  feedback: [{ scenario: Scenario; text: string; wake: boolean }];
}

/**
 * Hypothèses et scénarios de la recherche d'opportunités, gardés en base.
 * Un scénario est un dossier : pourquoi, ce que l'IA voyait, son plan,
 * ce qui l'invaliderait, ce dont il dépend, ses niveaux, et le fil de ce qui
 * lui arrive (scenario_events). Ses alertes (posées par l'IA, avec une
 * échéance) et son rendez-vous y sont rattachés ; fermé, il les retire. Les
 * échéances sont vérifiées toutes les 30 s.
 */
@Injectable()
export class ScenarioService extends EventEmitter<ScenarioEvents> implements OnModuleInit, OnModuleDestroy {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();
  private ticker?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly alerts: AlertService,
    private readonly logger: AppLogger,
  ) {
    super();
    // Une alerte de l'IA expirée ou retirée laisse une trace dans le fil de son scénario.
    alerts.on("triggered", (f) => {
      if (f.alert.scenarioId) this.touch();
    });
  }

  onModuleInit() {
    this.db.db.prepare("DELETE FROM hypotheses WHERE state <> 'active' AND updated_at < ?").run(this.now() - PURGE_HYPOTHESES_MS);
    this.expireDue();
    this.ticker = setInterval(() => this.expireDue(), TICK_MS);
    this.ticker.unref();
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
  }

  /* ------------------------------- Hypothèses ------------------------------- */

  /** Les hypothèses actives, et celles qui ont changé d'état depuis `since` ; les plus récentes d'abord. */
  hypotheses(opts: { since?: number } = {}): Hypothesis[] {
    const rows = this.db.db
      .prepare("SELECT * FROM hypotheses WHERE state = 'active' OR updated_at >= ? ORDER BY updated_at DESC")
      .all(opts.since ?? Number.MAX_SAFE_INTEGER) as HypothesisRow[];
    return rows.map(toHypothesis).filter((h): h is Hypothesis => h !== undefined);
  }

  hypothesis(id: string): Hypothesis | undefined {
    const row = this.db.db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id.trim()) as HypothesisRow | undefined;
    return row ? toHypothesis(row) : undefined;
  }

  /** Une hypothèse nouvelle ; la même, déjà active et du même auteur, est mise à jour plutôt que doublée. */
  addHypothesis(input: HypothesisInput, author: Author, jobId?: string): Hypothesis {
    const statement = text(input.statement, "l'énoncé de l'hypothèse");
    const existing = this.hypotheses().find((h) => h.author === author && h.statement.toLowerCase() === statement.toLowerCase());
    if (existing) return this.updateHypothesis(existing.id, input, author, jobId);
    const active = this.hypotheses().filter((h) => h.state === "active").length;
    if (active >= MAX_ACTIVE_HYPOTHESES)
      throw new SetupError(`${MAX_ACTIVE_HYPOTHESES} hypothèses actives au plus : invalide ou confirme d'abord celles qui sont dépassées`);
    const bias = oneOf(input.bias, HYPOTHESIS_BIASES, "sens (up, down ou neutral)");
    const horizon = oneOf(input.horizon, HORIZONS, "horizon (intraday ou swing)");
    // L'hypothèse de l'utilisateur peut venir sans condition d'invalidation : l'IA la lui demandera.
    const invalidation = input.invalidation?.trim() || (author === "user" ? "non précisée par l'utilisateur" : "");
    if (!invalidation) throw new SetupError("dis ce qui invaliderait cette hypothèse (invalidation)");
    const now = this.now();
    const expiresAt = this.future(input.expiresAt, now + HYPOTHESIS_LIFE_MS[horizon], "l'échéance de l'hypothèse");
    const id = `h_${randomBytes(3).toString("hex")}`;
    this.db.db
      .prepare(
        `INSERT INTO hypotheses (id, author, statement, products, bias, horizon, catalysts, invalidation, source, state, state_reason, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
      )
      .run(
        id,
        author,
        statement,
        JSON.stringify((input.products ?? []).map((p) => ({ symbol: p.symbol, name: p.name }))),
        bias,
        horizon,
        input.catalysts?.trim() || null,
        clip(invalidation),
        input.source?.trim() || null,
        now,
        now,
        expiresAt,
      );
    const h = this.hypothesis(id)!;
    this.logger.log(`hypothèse ${id} (${author}) : ${statement}`, "setups");
    this.emit("hypothesis", { after: h, ...(jobId ? { jobId } : {}) });
    this.touch();
    return h;
  }

  /**
   * Change une hypothèse : son contenu, ou son état (avec la raison). L'IA ne
   * touche pas à celles de l'utilisateur : elle peut les contredire par les
   * siennes, pas les réécrire.
   */
  updateHypothesis(id: string, patch: HypothesisPatch, by: Author, jobId?: string): Hypothesis {
    const before = this.hypothesis(id);
    if (!before) throw new SetupError(`aucune hypothèse « ${id} »`);
    if (before.author === "user" && by !== "user")
      throw new SetupError("c'est une hypothèse de l'utilisateur : tu ne peux pas la modifier (émets la tienne, même contraire)");
    if (patch.state && patch.state !== before.state && !patch.reason?.trim()) throw new SetupError("dis pourquoi l'hypothèse change d'état (reason)");
    const now = this.now();
    const next = {
      statement: patch.statement !== undefined ? text(patch.statement, "l'énoncé") : before.statement,
      products: patch.products ? patch.products.map((p) => ({ symbol: p.symbol, name: p.name })) : before.products,
      bias: patch.bias !== undefined ? oneOf(patch.bias, HYPOTHESIS_BIASES, "sens (up, down ou neutral)") : before.bias,
      horizon: patch.horizon !== undefined ? oneOf(patch.horizon, HORIZONS, "horizon (intraday ou swing)") : before.horizon,
      catalysts: patch.catalysts !== undefined ? patch.catalysts.trim() || undefined : before.catalysts,
      invalidation: patch.invalidation?.trim() ? clip(patch.invalidation) : before.invalidation,
      source: patch.source !== undefined ? patch.source.trim() || undefined : before.source,
      state: patch.state ?? before.state,
      // L'utilisateur qui confirme ou invalide une hypothèse de l'IA dit là son avis : on le garde comme tel.
      stateReason:
        patch.state && patch.state !== before.state
          ? clip(`${by === "user" && before.author !== "user" ? "par l'utilisateur : " : ""}${patch.reason!.trim()}`)
          : before.stateReason,
      expiresAt: patch.expiresAt !== undefined ? this.future(patch.expiresAt, before.expiresAt, "l'échéance de l'hypothèse") : before.expiresAt,
    };
    this.db.db
      .prepare(
        `UPDATE hypotheses SET statement = ?, products = ?, bias = ?, horizon = ?, catalysts = ?, invalidation = ?, source = ?, state = ?,
         state_reason = ?, updated_at = ?, expires_at = ? WHERE id = ?`,
      )
      .run(
        next.statement,
        JSON.stringify(next.products),
        next.bias,
        next.horizon,
        next.catalysts ?? null,
        next.invalidation,
        next.source ?? null,
        next.state,
        next.stateReason ?? null,
        now,
        next.expiresAt,
        before.id,
      );
    const after = this.hypothesis(before.id)!;
    if (after.state !== before.state) this.logger.log(`hypothèse ${before.id} : ${before.state} -> ${after.state} (${after.stateReason ?? ""})`, "setups");
    this.emit("hypothesis", { after, before, ...(jobId ? { jobId } : {}) });
    this.touch();
    return after;
  }

  /* -------------------------------- Scénarios -------------------------------- */

  /** Les scénarios ouverts, puis ceux clos depuis peu (`recent`) ; `events` : avec leur fil. */
  list(opts: { symbol?: string; recent?: boolean; events?: boolean } = {}): Scenario[] {
    const since = opts.recent ? this.now() - RECENT_MS : Number.MAX_SAFE_INTEGER;
    const rows = this.db.db
      .prepare(
        `SELECT * FROM scenarios WHERE (state IN ('watching', 'proposed') OR closed_at >= ?) ${opts.symbol ? "AND symbol = ?" : ""}
         ORDER BY CASE state WHEN 'proposed' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END, updated_at DESC`,
      )
      .all(...(opts.symbol ? [since, opts.symbol] : [since])) as ScenarioRow[];
    return rows.map((r) => this.readable(r, opts.events)).filter((s): s is Scenario => s !== undefined);
  }

  get(id: string, withEvents = false): Scenario | undefined {
    const row = this.db.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id.trim()) as ScenarioRow | undefined;
    return row ? this.readable(row, withEvents) : undefined;
  }

  /** Le fil d'un scénario, du plus ancien au plus récent (les `limit` derniers). */
  events(id: string, limit = 200): ScenarioEvent[] {
    const rows = this.db.db
      .prepare("SELECT * FROM (SELECT *, rowid AS seq FROM scenario_events WHERE scenario_id = ? ORDER BY at DESC, rowid DESC LIMIT ?) ORDER BY at, seq")
      .all(id, limit) as EventRow[];
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, text: r.text, by: r.by }));
  }

  /** Les événements d'un fil depuis `since` (exclu), d'un ou plusieurs genres. */
  eventsSince(id: string, since: number, kinds?: ScenarioEventKind[]): ScenarioEvent[] {
    return this.events(id).filter((e) => e.at > since && (!kinds || kinds.includes(e.kind)));
  }

  /** Ouvre un dossier. Tout ce qui servira à le relire au réveil est exigé : pourquoi, photo, plan, invalidation, échéance. */
  open(input: ScenarioInput, actor: Actor): Scenario {
    const open = this.list();
    if (open.length >= MAX_OPEN_SCENARIOS) throw new SetupError(`${MAX_OPEN_SCENARIOS} scénarios ouverts au plus : ferme d'abord ceux qui ne tiennent plus`);
    if (open.filter((s) => s.symbol === input.product.symbol).length >= MAX_SCENARIOS_PER_PRODUCT) {
      throw new SetupError(`${MAX_SCENARIOS_PER_PRODUCT} scénarios ouverts au plus sur ${input.product.name} : complète ou ferme ceux qui existent`);
    }
    const now = this.now();
    const spec: ScenarioSpec = {
      name: input.product.name,
      ...(input.product.digits !== undefined ? { digits: input.product.digits } : {}),
      direction: oneOf(input.direction, DIRECTIONS, "sens (long ou short)"),
      horizon: oneOf(input.horizon, HORIZONS, "horizon (intraday ou swing)"),
      timeframe: timeframe(input.timeframe, "unité de temps de l'entrée"),
      ...(input.contextTimeframe ? { contextTimeframe: timeframe(input.contextTimeframe, "unité de temps du contexte") } : {}),
      title: text(input.title, "le titre", 120),
      why: text(input.why, "le pourquoi"),
      snapshot: text(input.snapshot, "ce que tu voyais (snapshot)"),
      plan: text(input.plan, "le plan « si… alors… »"),
      invalidation: text(input.invalidation, "ce qui invaliderait le scénario"),
      depends: this.checkDepends(input.depends),
      ...levels(input),
    };
    const expiresAt = this.future(input.expiresAt, undefined, "l'échéance du scénario");
    if (expiresAt > now + MAX_SCENARIO_LIFE_MS) throw new SetupError("l'échéance d'un scénario est à dix jours au plus");
    const id = `sc_${randomBytes(3).toString("hex")}`;
    this.db.db
      .prepare(
        `INSERT INTO scenarios (id, symbol, spec, state, checked_at, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, 'watching', ?, ?, ?, ?)`,
      )
      .run(id, input.product.symbol, JSON.stringify(spec), now, now, now, expiresAt);
    // Le dossier se relit en entier ; le fil garde le plan de départ, pour voir ce qui a changé ensuite.
    this.record(id, "opened", `Ouvert : ${spec.title}. Plan de départ : ${spec.plan}`, actor);
    this.logger.log(`scénario ${id} ouvert (${input.product.symbol}) : ${spec.title}`, "setups");
    this.touch();
    return this.get(id)!;
  }

  /** Met à jour un dossier ouvert ; la raison est écrite dans le fil. */
  update(id: string, patch: ScenarioPatch, reason: string, actor: Actor): Scenario {
    const { row, spec } = this.openRow(id);
    const why = text(reason, "la raison de la mise à jour");
    const next: ScenarioSpec = {
      ...spec,
      ...(patch.horizon !== undefined ? { horizon: oneOf(patch.horizon, HORIZONS, "horizon (intraday ou swing)") } : {}),
      ...(patch.timeframe !== undefined ? { timeframe: timeframe(patch.timeframe, "unité de temps de l'entrée") } : {}),
      ...(patch.contextTimeframe !== undefined ? { contextTimeframe: timeframe(patch.contextTimeframe, "unité de temps du contexte") } : {}),
      ...(patch.title !== undefined ? { title: text(patch.title, "le titre", 120) } : {}),
      ...(patch.why !== undefined ? { why: text(patch.why, "le pourquoi") } : {}),
      ...(patch.snapshot !== undefined ? { snapshot: text(patch.snapshot, "la photo") } : {}),
      ...(patch.plan !== undefined ? { plan: text(patch.plan, "le plan") } : {}),
      ...(patch.invalidation !== undefined ? { invalidation: text(patch.invalidation, "l'invalidation") } : {}),
      ...(patch.depends !== undefined ? { depends: this.checkDepends({ ...spec.depends, ...patch.depends }) } : {}),
    };
    const lv = levels({
      entry: patch.entry ?? spec.entry,
      stop: patch.stop ?? spec.stop,
      targets: patch.targets ?? spec.targets,
    });
    const merged: ScenarioSpec = { ...next, entry: lv.entry, stop: lv.stop, targets: lv.targets };
    const expiresAt = patch.expiresAt !== undefined ? this.future(patch.expiresAt, undefined, "l'échéance du scénario") : row.expires_at;
    if (expiresAt > this.now() + MAX_SCENARIO_LIFE_MS) throw new SetupError("l'échéance d'un scénario est à dix jours au plus");
    this.db.db.prepare("UPDATE scenarios SET spec = ?, expires_at = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), expiresAt, this.now(), row.id);
    // Ses alertes ne vont pas au-delà de son échéance.
    for (const a of this.alerts.ofScenario(row.id)) {
      if (a.expiresAt && a.expiresAt > expiresAt && (a.state === "active" || a.state === "paused")) this.alerts.update(a.id, { expiresAt });
    }
    const changed = Object.keys(patch).filter((k) => patch[k as keyof ScenarioPatch] !== undefined);
    this.record(row.id, "update", `Mis à jour (${changed.join(", ") || "rien"}) : ${why}`, actor);
    this.touch();
    return this.get(row.id)!;
  }

  /** Une note au fil (un constat, un contexte, une décision « j'attends »). */
  note(id: string, kind: ScenarioEventKind, note: string, actor: Actor): ScenarioEvent {
    const row = this.row(id);
    const e = this.record(row.id, kind, text(note, "la note", MAX_EVENT_TEXT), actor);
    this.touch();
    return e;
  }

  /** Les tracés dont dépend un dossier ouvert, remplacés ; l'appelant dit pourquoi au fil. */
  linkDrawings(id: string, drawings: string[]): void {
    const { row, spec } = this.openRow(id);
    const next: ScenarioSpec = { ...spec, depends: { ...spec.depends, drawings: [...new Set(drawings)] } };
    this.db.db.prepare("UPDATE scenarios SET spec = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), this.now(), row.id);
    this.touch();
  }

  /**
   * L'utilisateur a agi sur un niveau du dossier (gardé, retiré) : c'est écrit
   * au fil, et, s'il le faut, le dossier est relu par son agent.
   */
  levelFeedback(id: string, line: string, wake: boolean): void {
    const row = this.row(id);
    this.record(row.id, "feedback", line, { by: "user" });
    const s = this.get(row.id)!;
    this.emit("feedback", { scenario: s, text: line, wake: wake && isOpenScenario(s.state) });
    this.touch();
  }

  /** Une alerte de l'IA pour ce scénario : son intention est écrite dans le fil ; elle ne survit pas au scénario. */
  watch(id: string, input: WatchInput, actor: Actor): Alert {
    const { row, spec } = this.openRow(id);
    const intention = text(input.intention, "l'intention de l'alerte (ce que tu vérifieras quand elle partira)", 300);
    const expiresAt = Math.min(input.expiresAt ?? row.expires_at, row.expires_at);
    const alertInput: AlertInput = {
      target: input.target,
      condition: input.condition,
      trigger: input.trigger,
      timeframe: input.timeframe ?? spec.timeframe,
      message: intention,
      scenarioId: row.id,
      expiresAt,
    };
    let alert: Alert;
    try {
      alert = this.alerts.create({ symbol: row.symbol, name: spec.name, digits: spec.digits }, alertInput, "kopilia");
    } catch (e) {
      if (e instanceof DashboardError) throw new SetupError(e.message);
      throw e;
    }
    this.record(row.id, "alert", `Alerte ${alert.id} posée : ${describeTarget(alert)} ; intention : ${intention}`, actor);
    this.touch();
    return alert;
  }

  /** Retire des alertes de ce scénario. */
  unwatch(id: string, alertIds: string[], reason: string, actor: Actor): Alert[] {
    const row = this.row(id);
    const own = new Set(this.alerts.ofScenario(row.id).map((a) => a.id));
    const strangers = alertIds.filter((a) => !own.has(a));
    if (strangers.length) throw new SetupError(`ces alertes ne sont pas à ce scénario : ${strangers.join(", ")}`);
    const gone = this.alerts.remove(alertIds);
    if (gone.length) this.record(row.id, "alert", `Alerte(s) retirée(s) : ${gone.map((a) => a.id).join(", ")} ; ${text(reason, "la raison")}`, actor);
    this.touch();
    return gone;
  }

  /** Le rendez-vous de l'agent (un seul : le nouveau remplace l'ancien), avant l'échéance du scénario. */
  setWake(id: string, at: number, reason: string, actor: Actor): Scenario {
    const { row } = this.openRow(id);
    const now = this.now();
    if (!(Number.isFinite(at) && at > now)) throw new SetupError("le rendez-vous est dans le futur");
    if (at > row.expires_at) throw new SetupError("le rendez-vous tombe après l'échéance du scénario : repousse d'abord l'échéance");
    const why = text(reason, "ce que tu vérifieras au rendez-vous", 300);
    this.db.db.prepare("UPDATE scenarios SET wake_at = ?, wake_reason = ?, updated_at = ? WHERE id = ?").run(at, why, now, row.id);
    this.record(row.id, "rendezvous", `Rendez-vous ${clockText(at)} : ${why}`, actor);
    this.touch();
    return this.get(row.id)!;
  }

  /** Le rendez-vous est passé : l'agent est réveillé (ou le réveil reporté), il ne repart pas. */
  clearWake(id: string): void {
    this.db.db.prepare("UPDATE scenarios SET wake_at = NULL, wake_reason = NULL WHERE id = ?").run(id);
  }

  /** Les scénarios ouverts dont le rendez-vous est passé. */
  dueWakes(): Scenario[] {
    const rows = this.db.db
      .prepare("SELECT * FROM scenarios WHERE state IN ('watching', 'proposed') AND wake_at IS NOT NULL AND wake_at <= ?")
      .all(this.now()) as ScenarioRow[];
    return rows.map((r) => this.readable(r)).filter((s): s is Scenario => s !== undefined);
  }

  /** L'IA a relu le dossier (à cet instant) : le prochain « ce qui a changé depuis » part de là ; ce qui était à revoir l'a été. */
  markChecked(id: string, at = this.now()): void {
    this.db.db.prepare("UPDATE scenarios SET checked_at = MAX(checked_at, ?), review = NULL WHERE id = ?").run(at, id);
    this.touch();
  }

  /** Une dépendance a changé : le dossier est à revoir (la raison s'ajoute aux précédentes). */
  markReview(id: string, reason: string): void {
    const row = this.row(id);
    const review = row.review ? `${row.review} ; ${reason}` : reason;
    this.db.db.prepare("UPDATE scenarios SET review = ?, updated_at = ? WHERE id = ?").run(clip(review), this.now(), row.id);
    this.touch();
  }

  /** Le setup est en place : il est proposé à l'utilisateur, avec ses niveaux. */
  propose(id: string, p: { summary: string; entry?: number; stop?: number; targets?: number[] }, actor: Actor): Scenario {
    const { row, spec } = this.openRow(id);
    if (row.state !== "watching") throw new SetupError("ce setup est déjà proposé");
    const lv = levels({ entry: p.entry ?? spec.entry, stop: p.stop ?? spec.stop, targets: p.targets ?? spec.targets });
    if (lv.entry === undefined || lv.stop === undefined || !lv.targets.length)
      throw new SetupError("un setup se propose avec une entrée, un stop et au moins un objectif");
    const rr = rewardRisk({ direction: spec.direction, ...lv });
    if (rr === undefined) {
      throw new SetupError(
        spec.direction === "long"
          ? "à l'achat : le stop sous l'entrée, l'objectif au-dessus"
          : "à la vente : le stop au-dessus de l'entrée, l'objectif au-dessous",
      );
    }
    const summary = text(p.summary, "ce que tu diras à l'utilisateur", 600);
    const now = this.now();
    this.db.db
      .prepare("UPDATE scenarios SET spec = ?, state = 'proposed', proposed_at = ?, outcome = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ ...spec, ...lv }), now, JSON.stringify({ result: "open" } satisfies ScenarioOutcome), now, row.id);
    this.record(row.id, "proposed", `Setup proposé (rapport ${rr.toFixed(1)}) : ${summary}`, actor);
    const s = this.get(row.id)!;
    this.logger.log(`scénario ${row.id} proposé : ${summary}`, "setups");
    this.emit("proposed", s);
    this.touch();
    return s;
  }

  /** Abandonne un scénario : ses alertes et son rendez-vous partent, la raison reste au fil. */
  abandon(id: string, reason: string, actor: Actor): Scenario {
    const { row } = this.openRow(id);
    return this.finish(row, "invalidated", text(reason, "la raison de l'abandon"), actor);
  }

  /** Un setup proposé dont le suivi est terminé : son résultat. */
  conclude(id: string, outcome: ScenarioOutcome, reason: string): Scenario {
    const row = this.row(id);
    if (row.state !== "proposed") throw new SetupError("seul un setup proposé a un résultat");
    this.db.db.prepare("UPDATE scenarios SET outcome = ? WHERE id = ?").run(JSON.stringify(outcome), row.id);
    return this.finish({ ...row, outcome: JSON.stringify(outcome) }, "closed", reason, { by: "system" });
  }

  /** Le résultat provisoire d'un setup proposé (entrée atteinte, toujours en cours). */
  setOutcome(id: string, outcome: ScenarioOutcome): void {
    this.db.db.prepare("UPDATE scenarios SET outcome = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(outcome), this.now(), id);
    this.touch();
  }

  /** L'utilisateur a été prévenu de ce setup. */
  markTold(id: string): void {
    this.db.db.prepare("UPDATE scenarios SET told_at = COALESCE(told_at, ?) WHERE id = ?").run(this.now(), id);
  }

  /** Les setups proposés dont l'utilisateur n'a pas encore été prévenu (dits au décroché). */
  untold(): Scenario[] {
    const rows = this.db.db.prepare("SELECT * FROM scenarios WHERE state = 'proposed' AND told_at IS NULL ORDER BY proposed_at").all() as ScenarioRow[];
    return rows.map((r) => this.readable(r)).filter((s): s is Scenario => s !== undefined);
  }

  /**
   * La réaction de l'utilisateur à un setup (pris, pas pour lui, modifié) ou
   * une remarque. Une remarque, ou un setup modifié, fait relire le dossier.
   */
  feedback(id: string, reaction: string, note: string | undefined): Scenario {
    const row = this.row(id);
    const r = oneOf(reaction, FEEDBACK_REACTIONS, "réaction (taken, declined, modified ou comment)");
    const said = note?.trim() ? clip(note.trim()) : undefined;
    if (r === "comment" && !said) throw new SetupError("quelle remarque ?");
    const now = this.now();
    if (r !== "comment") {
      this.db.db
        .prepare("UPDATE scenarios SET feedback = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ reaction: r, ...(said ? { note: said } : {}), at: now }), now, row.id);
    }
    const line = `${REACTION_TEXT[r]}${said ? ` : « ${said} »` : ""}`;
    this.record(row.id, "feedback", line, { by: "user" });
    const s = this.get(row.id)!;
    this.emit("feedback", { scenario: s, text: line, wake: isOpenScenario(s.state) && (r === "comment" || r === "modified") });
    this.touch();
    return s;
  }

  /** Les scénarios ouverts qui dépendent de cette hypothèse ou de l'un de ces tracés. */
  dependents(dep: { hypothesisId?: string; drawingIds?: string[] }): Scenario[] {
    return this.list().filter(
      (s) =>
        (dep.hypothesisId !== undefined && s.depends.hypotheses.includes(dep.hypothesisId)) ||
        (dep.drawingIds !== undefined && s.depends.drawings.some((d) => dep.drawingIds!.includes(d))),
    );
  }

  /** Les réveils (agents lancés) depuis cet instant. */
  wakesSince(since: number): number {
    return (
      this.db.db.prepare("SELECT COUNT(*) AS n FROM scenario_events WHERE kind = 'wake' AND at >= ? AND text NOT LIKE 'Réveil reporté%'").get(since) as {
        n: number;
      }
    ).n;
  }

  /**
   * Les statistiques des setups proposés : tous, par unité de temps de
   * l'entrée, selon l'auteur des hypothèses dont ils dépendent, et ceux que
   * l'utilisateur a pris.
   */
  stats(): SetupStatsRow[] {
    const rows = this.db.db.prepare("SELECT * FROM scenarios WHERE proposed_at IS NOT NULL ORDER BY proposed_at").all() as ScenarioRow[];
    const all = rows.map((r) => this.readable(r)).filter((s): s is Scenario => s !== undefined);
    if (!all.length) return [];
    const authors = new Map<string, Author>();
    for (const r of this.db.db.prepare("SELECT id, author FROM hypotheses").all() as Array<{ id: string; author: Author }>) authors.set(r.id, r.author);
    const groups: Array<[string, Scenario[]]> = [["Tous", all]];
    for (const tf of [...new Set(all.map((s) => s.timeframe))]) groups.push([`En ${tf}`, all.filter((s) => s.timeframe === tf)]);
    const byAuthor = (a: Author) => all.filter((s) => s.depends.hypotheses.some((h) => authors.get(h) === a));
    groups.push(["Sur une hypothèse de l'IA", byAuthor("kopilia")], ["Sur ton hypothèse", byAuthor("user")]);
    groups.push(["Que tu as pris", all.filter((s) => s.feedback?.reaction === "taken")]);
    return groups.filter(([, list]) => list.length).map(([label, list]) => statsRow(label, list));
  }

  /* ------------------------------ Échéances ------------------------------ */

  /**
   * Les échéances passées : une hypothèse expire ; un scénario surveillé
   * expire (ses alertes partent) ; un setup proposé dont l'entrée n'a jamais
   * été atteinte est clos (« entrée jamais atteinte »), celui qui est en cours
   * reste suivi jusqu'à son stop ou son objectif.
   */
  expireDue(): void {
    const now = this.now();
    const hyps = this.db.db.prepare("SELECT * FROM hypotheses WHERE state = 'active' AND expires_at <= ?").all(now) as HypothesisRow[];
    for (const h of hyps) {
      this.db.db.prepare("UPDATE hypotheses SET state = 'expired', state_reason = 'échéance passée', updated_at = ? WHERE id = ?").run(now, h.id);
      const after = this.hypothesis(h.id);
      const before = toHypothesis(h);
      if (after && before) this.emit("hypothesis", { after, before });
    }
    const rows = this.db.db.prepare("SELECT * FROM scenarios WHERE state IN ('watching', 'proposed') AND expires_at <= ?").all(now) as ScenarioRow[];
    for (const row of rows) {
      const outcome = row.outcome ? (JSON.parse(row.outcome) as ScenarioOutcome) : undefined;
      if (row.state === "proposed" && outcome?.enteredAt) continue;
      if (row.state === "proposed") this.conclude(row.id, { result: "missed", at: now }, "échéance passée sans que l'entrée soit atteinte");
      else this.finish(row, "expired", "échéance passée sans que le plan se réalise", { by: "system" });
    }
    if (hyps.length) this.touch();
  }

  /* ------------------------------- Interne ------------------------------- */

  private finish(row: ScenarioRow, state: Exclude<ScenarioState, "watching" | "proposed">, reason: string, actor: Actor): Scenario {
    const now = this.now();
    this.db.db
      .prepare("UPDATE scenarios SET state = ?, state_reason = ?, wake_at = NULL, wake_reason = NULL, closed_at = ?, updated_at = ? WHERE id = ?")
      .run(state, clip(reason), now, now, row.id);
    this.alerts.removeScenario(row.id);
    this.record(row.id, "closed", `${state === "invalidated" ? "Abandonné" : state === "expired" ? "Expiré" : "Clos"} : ${reason}`, actor);
    const s = this.get(row.id)!;
    this.logger.log(`scénario ${row.id} ${state} : ${reason}`, "setups");
    this.emit("closed", s);
    this.touch();
    return s;
  }

  private record(scenarioId: string, kind: ScenarioEventKind, note: string, actor: Actor): ScenarioEvent {
    const e: ScenarioEvent = { id: `se_${randomBytes(4).toString("hex")}`, at: this.now(), kind, text: note.slice(0, MAX_EVENT_TEXT * 2), by: actor.by };
    this.db.db
      .prepare("INSERT INTO scenario_events (id, scenario_id, at, kind, text, by, job_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, scenarioId, e.at, kind, e.text, actor.by, actor.jobId ?? null);
    this.db.db.prepare("UPDATE scenarios SET updated_at = ? WHERE id = ?").run(e.at, scenarioId);
    return e;
  }

  /** Les dépendances, vérifiées : des hypothèses qui existent ; des tracés et des annonces tels quels. */
  private checkDepends(d: Partial<ScenarioDepends> | undefined): ScenarioDepends {
    const hypotheses = [...new Set((d?.hypotheses ?? []).map((h) => h.trim()).filter(Boolean))];
    const unknown = hypotheses.filter((h) => !this.hypothesis(h));
    if (unknown.length) throw new SetupError(`hypothèse(s) inconnue(s) : ${unknown.join(", ")}`);
    const drawings = [...new Set((d?.drawings ?? []).map((x) => x.trim()).filter(Boolean))];
    const events = (d?.events ?? []).filter((e) => Number.isFinite(e.at) && e.at > 0).map((e) => ({ at: e.at, country: e.country, title: e.title }));
    return { hypotheses, drawings, events };
  }

  private row(id: string): ScenarioRow {
    const row = this.db.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id.trim()) as ScenarioRow | undefined;
    if (!row) throw new SetupError(`aucun scénario « ${id} »`);
    return row;
  }

  private openRow(id: string): { row: ScenarioRow; spec: ScenarioSpec } {
    const row = this.row(id);
    if (!isOpenScenario(row.state))
      throw new SetupError(`ce scénario est ${row.state === "invalidated" ? "abandonné" : row.state === "expired" ? "expiré" : "clos"}`);
    return { row, spec: JSON.parse(row.spec) as ScenarioSpec };
  }

  private readable(r: ScenarioRow, withEvents = false): Scenario | undefined {
    try {
      const spec = JSON.parse(r.spec) as ScenarioSpec;
      const s = scenarioSchema.safeParse({
        ...spec,
        id: r.id,
        symbol: r.symbol,
        state: r.state,
        ...(r.state_reason ? { stateReason: r.state_reason } : {}),
        ...(r.review ? { review: r.review } : {}),
        ...(r.wake_at ? { wakeAt: r.wake_at, wakeReason: r.wake_reason ?? "" } : {}),
        ...(r.feedback ? { feedback: JSON.parse(r.feedback) } : {}),
        ...(r.outcome ? { outcome: JSON.parse(r.outcome) } : {}),
        checkedAt: r.checked_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        expiresAt: r.expires_at,
        ...(r.proposed_at ? { proposedAt: r.proposed_at } : {}),
        ...(r.told_at ? { toldAt: r.told_at } : {}),
        ...(r.closed_at ? { closedAt: r.closed_at } : {}),
        ...(withEvents ? { events: this.events(r.id, 60) } : {}),
      });
      if (!s.success) this.logger.warn(`scénario ${r.id} illisible : ${s.error.issues[0]?.message}`, "setups");
      return s.success ? s.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Une échéance donnée (dans le futur), sinon celle par défaut. */
  private future(at: number | undefined, fallback: number | undefined, what: string): number {
    if (at === undefined) {
      if (fallback === undefined) throw new SetupError(`donne ${what} (expires)`);
      return fallback;
    }
    if (!(Number.isFinite(at) && at > this.now())) throw new SetupError(`${what} est dans le futur`);
    return at;
  }

  /** Quelque chose a changé pour les écrans (aussi les suggestions sur les tracés, gardées à part). */
  touch() {
    this.emit("changed");
  }
}

const REACTION_TEXT: Record<FeedbackReaction, string> = {
  taken: "L'utilisateur l'a pris",
  declined: "Pas pour l'utilisateur",
  modified: "L'utilisateur l'a modifié",
  comment: "Remarque de l'utilisateur",
};

/** Un texte exigé, débarrassé de ses espaces, coupé à `max`. */
function text(value: string | undefined, what: string, max = MAX_TEXT): string {
  const t = value?.trim();
  if (!t) throw new SetupError(`il manque ${what}`);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T {
  const v = value?.trim().toLowerCase();
  if (!v || !allowed.includes(v as T)) throw new SetupError(`${what} : « ${value ?? ""} » inconnu`);
  return v as T;
}

function timeframe(value: string, what: string): string {
  if (!isChartTimeframe(value)) throw new SetupError(`${what} inconnue (« ${value} ») : 1m, 5m, 15m, 30m, 1h, 4h ou 1d`);
  return value;
}

/** Les niveaux d'un scénario : des prix positifs (les objectifs dans l'ordre donné). */
function levels(input: { entry?: number; stop?: number; targets?: number[] }): Pick<ScenarioSpec, "entry" | "stop" | "targets"> {
  const price = (v: number | undefined, what: string) => {
    if (v === undefined || v === null) return undefined;
    if (!(Number.isFinite(v) && v > 0)) throw new SetupError(`${what} : un prix positif`);
    return v;
  };
  return {
    ...(input.entry !== undefined ? { entry: price(input.entry, "entrée") } : {}),
    ...(input.stop !== undefined ? { stop: price(input.stop, "stop") } : {}),
    targets: (input.targets ?? []).map((t) => price(t, "objectif")!).slice(0, 3),
  };
}

/** Ce que surveille une alerte, en bref, pour le fil (prix aux décimales du produit). */
function describeTarget(a: Alert): string {
  const t = a.target;
  const p = (v: number) => frenchPrice(v, a.digits);
  const how = a.trigger === "close" ? `sur clôture ${a.timeframe}` : a.trigger === "bar" ? `une fois par bougie ${a.timeframe}` : "au contact";
  if (t.kind === "price") return `prix ${p(t.price)}, ${how}`;
  if (t.kind === "band") return `bande ${p(t.bottom)} – ${p(t.top)}, ${how}`;
  return `tracé ${t.drawingId}, ${how}`;
}

/** « à 10:45 » aujourd'hui, sinon « le 05/11 à 10:45 ». */
function clockText(at: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date().toDateString()) return `à ${hm}`;
  return `le ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} à ${hm}`;
}

function statsRow(label: string, list: Scenario[]): SetupStatsRow {
  const count = (r: string) => list.filter((s) => (s.outcome?.result ?? "open") === r).length;
  const r = list.reduce((sum, s) => sum + (s.outcome?.result === "target" || s.outcome?.result === "stop" ? (s.outcome.r ?? 0) : 0), 0);
  return {
    label,
    proposed: list.length,
    target: count("target"),
    stop: count("stop"),
    missed: count("missed"),
    open: count("open"),
    r: Math.round(r * 100) / 100,
  };
}

function toHypothesis(r: HypothesisRow): Hypothesis | undefined {
  try {
    const h = hypothesisSchema.safeParse({
      id: r.id,
      author: AUTHORS.includes(r.author) ? r.author : "kopilia",
      statement: r.statement,
      products: JSON.parse(r.products),
      bias: r.bias,
      horizon: r.horizon,
      ...(r.catalysts ? { catalysts: r.catalysts } : {}),
      invalidation: r.invalidation,
      ...(r.source ? { source: r.source } : {}),
      state: r.state,
      ...(r.state_reason ? { stateReason: r.state_reason } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
    });
    return h.success ? h.data : undefined;
  } catch {
    return undefined;
  }
}
