import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, Optional, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Drawing, JobState, Scenario, isOpenScenario } from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { DatabaseService } from "../db/database.service.js";
import { AppLogger } from "../common/logger.js";
import { startOfDay } from "../common/dates.js";
import { JobFinished, JobService } from "../jobs/job.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { SkillService } from "../learning/skill.service.js";
import { AlertFired, AlertService } from "../alerts/alert.service.js";
import { alertNewsLine } from "../alerts/alert-texts.js";
import { DrawingService, describeDrawing } from "../dashboard/drawing.service.js";
import { MarketService } from "../market/market.service.js";
import { ChartTimeframe, TIMEFRAME_SECONDS, isChartTimeframe } from "../market/timeframes.js";
import { frenchPrice } from "../market/metaapi.js";
import { CalendarService, calendarSnapshot } from "../calendar/calendar.service.js";
import { BriefReady, BriefService, VEILLE_SESSION_ID } from "../veille/brief.service.js";
import { ensureSystemSession } from "../session/system-session.js";
import { AnalysisService } from "../analyses/analysis.service.js";
import { analysisLine } from "../analyses/analysis-texts.js";
import { ScenarioService } from "./scenario.service.js";
import { SETUPS_SESSION_ID } from "./session-id.js";
import { ExampleService } from "./example.service.js";
import { trackOutcome } from "./outcome.js";
import { candlesText, dossierText, filText, hypothesisLine, scenarioLine, statsLines, when } from "./setup-texts.js";
import { scenarioWakePrompt, setupPassPrompt, setupSystemPrompt } from "./setup-prompts.js";

/** Agents réveillés en même temps au plus (une passe en plus). */
const MAX_WAKE_AGENTS = 2;
const WAKE_TIMEOUT_MS = 8 * 60_000;
const PASS_TIMEOUT_MS = 20 * 60_000;
/** Rendez-vous, annonces publiées, file des réveils : vérifiés à ce rythme. */
const TICK_MS = 20_000;
/** Suivi des setups proposés. */
const TRACK_MS = 2 * 60_000;
/** Une annonce dont dépend un scénario le réveille ce temps-là après sa publication (le chiffre est sorti). */
const PUBLICATION_DELAY_MS = 3 * 60_000;
/** Un « next_close » compte quelques secondes de plus : le temps que le courtier livre la bougie close. */
const CLOSE_DELAY_MS = 20_000;
/** Un wrap plus ancien ne sert plus à une passe. */
const BRIEF_FRESH_MS = 18 * 3_600_000;
/** Le wrap mis dans l'invite d'une passe, au plus. */
const BRIEF_CHARS = 6000;
/** Une passe voit aussi les hypothèses qui ont changé d'état et les dossiers fermés depuis ce temps-là, avec leurs raisons. */
const RECENT_MS = 24 * 3_600_000;

/** Une passe en cours ou demandée ; `byUser` : il l'a demandée (à la voix ou depuis l'écran), et il en attend le résultat. */
interface PassRequest {
  reason: string;
  focus?: string;
  byUser?: boolean;
}

/** Une passe finie : ce qu'elle a repéré (setups en attente) et abandonné, et son compte rendu. */
export interface PassDone {
  jobId: string;
  byUser: boolean;
  reason: string;
  focus?: string;
  /** Elle n'a pas abouti (erreur, délai, annulée). */
  failed: boolean;
  opened: Scenario[];
  closed: Scenario[];
  /** Les setups en attente ou déclenchés après elle. */
  open: Scenario[];
  /** Son compte rendu (pour le journal, et pour que Kopilia le résume). */
  result: string;
}

export interface SetupAgentsEvents {
  /** Une passe est finie. */
  pass: [PassDone];
}

/**
 * Les agents de la recherche d'opportunités. Les passes (après le wrap du
 * matin et de midi, ou à la demande) revoient les dossiers ouverts, mettent les
 * hypothèses à jour et ouvrent de nouveaux scénarios. Les réveils lancent
 * l'agent d'un dossier quand une de ses alertes part, à son rendez-vous, à la
 * publication d'une annonce dont il dépend, quand l'utilisateur déplace ou
 * efface un tracé dont il dépend, quand une hypothèse dont il dépend change,
 * ou sur une remarque de l'utilisateur. Chaque réveil reçoit le dossier, son
 * fil et ce qui a changé depuis sa dernière lecture : la continuité vient de ce
 * qui est écrit, pas de la mémoire du modèle. Les réveils ont un budget par jour.
 * Les setups proposés sont suivis jusqu'à leur stop ou leur objectif.
 */
@Injectable()
export class SetupAgentsService extends EventEmitter<SetupAgentsEvents> implements OnModuleInit, OnModuleDestroy {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();
  private pass?: { jobId: string; request: PassRequest };
  private passQueued?: PassRequest;
  /** Réveils en cours : travail -> scénario, et l'instant où il a commencé. */
  private readonly running = new Map<string, { scenarioId: string; startedAt: number }>();
  /** Réveils en attente, par scénario, avec leurs raisons. */
  private readonly queue = new Map<string, string[]>();
  /** Annonces déjà réveillées (scénario|instant). */
  private readonly published = new Set<string>();
  private ticker?: NodeJS.Timeout;
  private tracker?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly jobs: JobService,
    private readonly scenarios: ScenarioService,
    private readonly alerts: AlertService,
    private readonly drawings: DrawingService,
    private readonly market: MarketService,
    private readonly calendar: CalendarService,
    private readonly briefs: BriefService,
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly examples: ExampleService,
    private readonly logger: AppLogger,
    @Optional() private readonly analyses?: AnalysisService,
  ) {
    super();
  }

  get enabled(): boolean {
    return this.config.setupsReady;
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.jobs.on("job.finished", (e) => this.safely(() => this.onFinished(e)));
    this.alerts.on("triggered", (f) => this.safely(() => this.onAlert(f)));
    this.drawings.on("changed", (symbol) => this.safely(() => this.onDrawings(symbol)));
    this.scenarios.on("hypothesis", (e) => this.safely(() => this.onHypothesis(e.after, e.before, e.jobId)));
    this.scenarios.on("feedback", (e) => {
      if (e.wake) this.wake(e.scenario.id, e.text);
    });
    this.briefs.on("brief.ready", ({ brief }: BriefReady) => {
      if (brief.trigger === "scheduled") this.search({ reason: "après le wrap programmé" });
    });
    this.briefs.on("brief.failed", ({ job }) => {
      if (job.session_id === VEILLE_SESSION_ID) this.search({ reason: "à l'heure du wrap (le wrap n'a pas pu être fait)" });
    });
    this.ticker = setInterval(() => this.safely(() => this.tick()), TICK_MS);
    this.ticker.unref();
    this.tracker = setInterval(() => void this.track().catch((e: Error) => this.logger.warn(`suivi des setups : ${e.message}`, "setups")), TRACK_MS);
    this.tracker.unref();
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
    clearInterval(this.tracker);
  }

  /* -------------------------------- Passes -------------------------------- */

  /**
   * Lance une passe : une seule à la fois ; demandée pendant une autre, elle
   * part juste après (la dernière demande l'emporte).
   */
  search(request: PassRequest): { started: boolean; jobId?: string; queued?: boolean; error?: string } {
    if (!this.enabled) return { started: false, error: "recherche d'opportunités désactivée (il faut les cours MetaApi et KOPILIA_SETUPS)" };
    if (this.pass) {
      this.passQueued = request;
      return { started: false, queued: true, jobId: this.pass.jobId };
    }
    try {
      ensureSystemSession(this.db, SETUPS_SESSION_ID);
      const prompt = setupPassPrompt(this.passContext(request));
      const job = this.jobs.start({
        sessionId: SETUPS_SESSION_ID,
        kind: "agent",
        title: `Recherche de setups (${request.reason})`,
        prompt,
        internal: this.internal(PASS_TIMEOUT_MS),
      });
      this.pass = { jobId: job.id, request };
      this.logger.log(`passe ${job.id} lancée : ${request.reason}`, "setups");
      return { started: true, jobId: job.id };
    } catch (e) {
      this.logger.warn(`passe non lancée : ${(e as Error).message}`, "setups");
      return { started: false, error: (e as Error).message };
    }
  }

  private passContext(request: PassRequest) {
    const now = this.now();
    // Les produits de l'utilisateur, et eux seuls (un graphique ouvert par curiosité n'en ajoute pas).
    const products = this.config.setupProducts;
    const brief = this.briefs.latest();
    const agenda = this.calendar
      .events(now, now + 24 * 3_600_000, ["high", "medium"])
      .map(
        (e) =>
          `- ${when(e.at, now)} ${e.country} ${e.title} (${e.impact === "high" ? "fort" : "moyen"}${e.forecast ? `, prévision ${e.forecast}` : ""}${e.previous ? `, précédent ${e.previous}` : ""})`,
      )
      .join("\n");
    return {
      reason: request.reason,
      ...(request.focus ? { focus: request.focus } : {}),
      products,
      ...(brief && now - brief.created_at <= BRIEF_FRESH_MS
        ? { brief: { title: brief.title, spoken: brief.spoken, at: when(brief.created_at, now), content: brief.content.slice(0, BRIEF_CHARS) } }
        : {}),
      ...(agenda ? { agenda } : {}),
      hypotheses: this.scenarios.hypotheses({ since: now - RECENT_MS }).map((h) => hypothesisLine(h, now)),
      analyses: (this.analyses?.list({ closedSince: now - RECENT_MS }) ?? []).map((a) => analysisLine(a, now)),
      scenarios: this.scenarios.list().map((s) => scenarioLine(s, now)),
      closed: this.scenarios
        .list({ recent: true })
        .filter((s) => !isOpenScenario(s.state))
        .map((s) => `${scenarioLine(s, now)} : ${s.stateReason ?? ""}`),
    };
  }

  /* -------------------------------- Réveils -------------------------------- */

  /** Réveille l'agent d'un dossier (la raison s'ajoute à celles en attente) ; il part dès qu'une place se libère. */
  wake(scenarioId: string, reason: string): void {
    if (!this.enabled) return;
    const s = this.scenarios.get(scenarioId);
    if (!s || !isOpenScenario(s.state)) return;
    this.queue.set(scenarioId, [...(this.queue.get(scenarioId) ?? []), reason]);
    setImmediate(() => this.safely(() => void this.drain()));
  }

  private async drain() {
    for (const [scenarioId, reasons] of [...this.queue]) {
      if ([...this.running.values()].some((r) => r.scenarioId === scenarioId)) continue;
      if (this.running.size >= MAX_WAKE_AGENTS) return;
      this.queue.delete(scenarioId);
      const s = this.scenarios.get(scenarioId);
      if (!s || !isOpenScenario(s.state)) continue;
      const spent = this.scenarios.wakesSince(startOfDay(this.now()).getTime());
      if (spent >= this.config.setupWakesPerDay) {
        this.scenarios.note(s.id, "wake", `Réveil reporté : budget du jour atteint (${spent} réveils). Motif : ${reasons.join(" ; ")}`, { by: "system" });
        this.scenarios.markReview(s.id, reasons.join(" ; "));
        continue;
      }
      await this.launchWake(s, reasons);
    }
  }

  private async launchWake(s: Scenario, reasons: string[]) {
    const startedAt = this.now();
    const prompt = scenarioWakePrompt(await this.wakeContext(s, reasons));
    try {
      ensureSystemSession(this.db, SETUPS_SESSION_ID);
      const job = this.jobs.start({
        sessionId: SETUPS_SESSION_ID,
        kind: "agent",
        title: `Réveil : ${s.title}`,
        prompt,
        internal: this.internal(WAKE_TIMEOUT_MS),
      });
      this.running.set(job.id, { scenarioId: s.id, startedAt });
      this.scenarios.note(s.id, "wake", `Réveil : ${reasons.join(" ; ")}`, { by: "system", jobId: job.id });
      this.logger.log(`réveil ${job.id} de ${s.id} : ${reasons.join(" ; ")}`, "setups");
    } catch (e) {
      this.scenarios.note(s.id, "wake", `Réveil reporté : ${(e as Error).message}. Motif : ${reasons.join(" ; ")}`, { by: "system" });
      this.scenarios.markReview(s.id, reasons.join(" ; "));
    }
  }

  /** Ce que reçoit l'agent réveillé : le dossier, son fil, ce qui a changé depuis sa dernière lecture, les dernières bougies. */
  private async wakeContext(s: Scenario, triggers: string[]) {
    const now = this.now();
    const hyps = s.depends.hypotheses.map((id) => this.scenarios.hypothesis(id)).filter((h) => h !== undefined);
    const tf = s.timeframe as ChartTimeframe;
    const candles = await this.market.chartCandles(s.symbol, tf, { limit: 8 });
    const last = this.market.feed.latest(s.symbol);
    return {
      triggers,
      dossier: dossierText(s, this.alerts.ofScenario(s.id), { hypotheses: hyps, drawings: this.drawings.list([s.symbol]), now }),
      fil: filText(this.scenarios.events(s.id, 40), now),
      changes: await this.changesSince(s),
      ...("error" in candles || !candles.candles.length ? {} : { candles: candlesText(candles.candles, s.digits, TIMEFRAME_SECONDS[tf], now) }),
      ...(last ? { price: `${frenchPrice(last.bid, s.digits)} à ${when(last.time, now)}` } : {}),
      siblings: this.scenarios
        .list({ symbol: s.symbol })
        .filter((o) => o.id !== s.id)
        .map((o) => scenarioLine(o, now)),
    };
  }

  /**
   * Ce qui a changé depuis la dernière lecture du dossier : ses hypothèses, les
   * nouvelles hypothèses sur ce produit, ses tracés et les nouveaux, les
   * annonces publiées et à venir, les remarques de l'utilisateur, un nouveau
   * wrap, le chemin du prix, les autres scénarios du produit, ses alertes.
   */
  async changesSince(s: Scenario): Promise<string[]> {
    const since = s.checkedAt;
    const now = this.now();
    const out: string[] = [];
    if (s.review) out.push(`À revoir (signalé par le serveur) : ${s.review}`);
    for (const id of s.depends.hypotheses) {
      const h = this.scenarios.hypothesis(id);
      if (!h) out.push(`L'hypothèse ${id} n'existe plus.`);
      else if (h.updatedAt > since) out.push(`Hypothèse modifiée : ${hypothesisLine(h, now)}`);
    }
    for (const h of this.scenarios.hypotheses({ since })) {
      if (s.depends.hypotheses.includes(h.id) || h.createdAt <= since) continue;
      if (h.products.length && !h.products.some((p) => p.symbol === s.symbol)) continue;
      out.push(`Nouvelle hypothèse : ${hypothesisLine(h, now)}`);
    }
    for (const id of s.depends.drawings) {
      const d = this.drawings.get(id);
      if (!d) out.push(`Le tracé ${id} dont dépend le dossier a été effacé.`);
      else if (d.updatedAt > since) out.push(`Le tracé ${id} a changé : c'est maintenant une ${describeDrawing(d, s.digits)}.`);
    }
    for (const d of this.drawings.list([s.symbol])) {
      if (d.createdAt > since && !s.depends.drawings.includes(d.id)) out.push(`Nouveau ${drawingAuthor(d)} ${d.id} : ${describeDrawing(d, s.digits)}.`);
    }
    const currencies = [...new Set(["USD", ...s.depends.events.map((e) => e.country)])];
    for (const e of this.calendar.events(since, now, ["high", "medium"], currencies)) {
      out.push(
        `Annonce publiée ${when(e.at, now)} : ${e.country} ${e.title} (prévision ${e.forecast ?? "?"}, précédent ${e.previous ?? "?"} ; le chiffre publié est à chercher)`,
      );
    }
    for (const e of this.calendar.events(now, now + 3 * 3_600_000, ["high"], currencies)) {
      out.push(`Annonce à venir ${when(e.at, now)} : ${e.country} ${e.title} (prévision ${e.forecast ?? "?"})`);
    }
    for (const e of this.scenarios.eventsSince(s.id, since, ["feedback"])) out.push(`${e.text} (${when(e.at, now)}).`);
    const brief = this.briefs.latest();
    if (brief && brief.created_at > since) out.push(`Nouveau wrap (${when(brief.created_at, now)}) « ${brief.title} » : ${brief.spoken}`);
    const path = await this.pricePath(s, since);
    if (path) out.push(path);
    for (const o of this.scenarios.list({ symbol: s.symbol, recent: true })) {
      if (o.id === s.id || o.updatedAt <= since) continue;
      if (o.state === "proposed" && (o.proposedAt ?? 0) > since) out.push(`Le scénario ${o.id} (${o.title}) s'est confirmé : setup proposé.`);
      else if (!isOpenScenario(o.state) && (o.closedAt ?? 0) > since) out.push(`Le scénario ${o.id} (${o.title}) est fermé : ${o.stateReason ?? o.state}.`);
    }
    return out;
  }

  /** Le chemin du prix depuis un instant : plus haut, plus bas, dernier (bougies de 5 minutes, ou d'une heure au-delà d'un jour). */
  private async pricePath(s: Scenario, since: number): Promise<string | undefined> {
    const span = this.now() - since;
    if (span < 60_000) return undefined;
    const tf: ChartTimeframe = span > 86_400_000 ? "1h" : "5m";
    const bars = Math.min(500, Math.ceil(span / 1000 / TIMEFRAME_SECONDS[tf]) + 1);
    const r = await this.market.chartCandles(s.symbol, tf, { limit: bars });
    if ("error" in r) return undefined;
    const kept = r.candles.filter((c) => (c.t + TIMEFRAME_SECONDS[tf]) * 1000 > since);
    if (!kept.length) return undefined;
    const p = (v: number) => frenchPrice(v, s.digits);
    const high = Math.max(...kept.map((c) => c.h));
    const low = Math.min(...kept.map((c) => c.l));
    return `Prix depuis ta dernière lecture (${when(since, this.now())}) : plus haut ${p(high)}, plus bas ${p(low)}, dernier ${p(kept[kept.length - 1].c)}.`;
  }

  /** L'instant d'un « next_close » : la fin de la bougie en cours de cette unité, d'après le courtier, plus le temps de la lire. */
  async nextClose(symbol: string, timeframe: string): Promise<number> {
    const tf = isChartTimeframe(timeframe) ? timeframe : "15m";
    const seconds = TIMEFRAME_SECONDS[tf];
    const now = this.now();
    const r = await this.market.chartCandles(symbol, tf, { limit: 2 });
    const last = "error" in r ? undefined : r.candles.at(-1);
    let end = last ? (last.t + seconds) * 1000 : (Math.floor(now / 1000 / seconds) + 1) * seconds * 1000;
    while (end <= now) end += seconds * 1000;
    return end + CLOSE_DELAY_MS;
  }

  /* ------------------------------- Écoutes ------------------------------- */

  private onAlert(f: AlertFired) {
    const id = f.alert.scenarioId;
    if (!id) return;
    this.scenarios.note(id, "alert", `Alerte ${f.alert.id} partie : ${alertNewsLine(f, this.now())}`, { by: "system" });
    this.wake(
      id,
      `ton alerte ${f.alert.id} vient de partir (${alertNewsLine(f, this.now())}) ; ton intention en la posant : « ${f.alert.message ?? "non écrite"} »`,
    );
  }

  /**
   * Un tracé a changé : les scénarios qui en dépendent et dont un tracé de
   * l'utilisateur a été posé, a bougé ou a disparu depuis leur dernière
   * lecture sont réveillés. Les niveaux de l'IA ne bougent que par elle (ce que
   * l'utilisateur en fait passe par LevelService, qui le dit au fil).
   */
  private onDrawings(symbol: string) {
    for (const s of this.scenarios.list({ symbol })) {
      const touched = s.depends.drawings.filter((id) => {
        const d = this.drawings.get(id);
        if (!d) return true;
        // Un niveau de l'IA gardé tel quel (il garde sa raison, jamais déplacé) n'a pas changé pour le dossier.
        const keptAsIs = d.reason !== undefined && d.updatedAt === d.createdAt;
        return d.createdBy !== "ia" && !keptAsIs && d.updatedAt > s.checkedAt;
      });
      if (!touched.length || this.queue.get(s.id)?.some((r) => r.startsWith("un tracé"))) continue;
      this.scenarios.note(s.id, "context", `Tracé(s) de l'utilisateur modifié(s) ou effacé(s) : ${touched.join(", ")}`, { by: "system" });
      this.wake(s.id, `un tracé dont dépend le dossier a été posé, déplacé ou effacé par l'utilisateur (${touched.join(", ")})`);
    }
  }

  /** Une hypothèse a changé d'état : les dossiers qui en dépendent sont revus (sauf par le travail qui l'a changée, ou pendant la passe qui s'en charge). */
  private onHypothesis(after: { id: string; state: string; statement: string; stateReason?: string }, before?: { state: string }, jobId?: string) {
    if (!before || before.state === after.state) return;
    for (const s of this.scenarios.dependents({ hypothesisId: after.id })) {
      if (jobId && (this.pass?.jobId === jobId || this.running.get(jobId)?.scenarioId === s.id)) continue;
      const reason = `l'hypothèse ${after.id} (« ${after.statement} ») est maintenant ${after.state === "invalidated" ? "invalidée" : after.state === "confirmed" ? "confirmée" : after.state === "expired" ? "expirée" : after.state}${after.stateReason ? ` : ${after.stateReason}` : ""}`;
      this.scenarios.note(s.id, "context", `Changement de contexte : ${reason}`, { by: "system" });
      this.wake(s.id, reason);
    }
  }

  /** Une passe ou un réveil est fini : le dossier est relu (à l'instant où l'agent a commencé), sa conclusion reste au fil. */
  private onFinished({ job, result }: JobFinished) {
    if (this.pass?.jobId === job.id) {
      const { request } = this.pass;
      this.pass = undefined;
      const touched = this.db.db.prepare("SELECT DISTINCT scenario_id FROM scenario_events WHERE job_id = ?").all(job.id) as Array<{ scenario_id: string }>;
      for (const t of touched) this.scenarios.markChecked(t.scenario_id, job.created_at);
      this.logger.log(`passe ${job.id} : ${job.state}`, "setups");
      this.emit("pass", this.passDone(request, job.id, job.state !== JobState.Succeeded, result));
      const next = this.passQueued;
      this.passQueued = undefined;
      if (next) this.search(next);
      void this.drain();
      return;
    }
    const run = this.running.get(job.id);
    if (!run) return;
    this.running.delete(job.id);
    const s = this.scenarios.get(run.scenarioId);
    if (s) {
      const decided = (
        this.db.db
          .prepare("SELECT COUNT(*) AS n FROM scenario_events WHERE scenario_id = ? AND job_id = ? AND kind IN ('decision', 'proposed', 'closed', 'update')")
          .get(s.id, job.id) as { n: number }
      ).n;
      if (job.state !== JobState.Succeeded) {
        this.scenarios.note(s.id, "wake", `Réveil interrompu (${job.state}) : ${job.summary ?? ""}`, { by: "system", jobId: job.id });
        if (isOpenScenario(s.state)) this.scenarios.markReview(s.id, "le dernier réveil n'a pas abouti");
      } else {
        if (!decided && result.trim()) this.scenarios.note(s.id, "decision", result.trim(), { by: "agent", jobId: job.id });
        this.scenarios.markChecked(s.id, run.startedAt);
      }
    }
    void this.drain();
  }

  /** Ce qu'une passe a ouvert et fermé (d'après le fil des dossiers), et ce qui reste ouvert. */
  private passDone(request: PassRequest, jobId: string, failed: boolean, result: string): PassDone {
    const touched = (kind: "opened" | "closed") =>
      (this.db.db.prepare("SELECT DISTINCT scenario_id AS id FROM scenario_events WHERE job_id = ? AND kind = ?").all(jobId, kind) as Array<{ id: string }>)
        .map((r) => this.scenarios.get(r.id))
        .filter((x): x is Scenario => !!x);
    return {
      jobId,
      byUser: !!request.byUser,
      reason: request.reason,
      ...(request.focus ? { focus: request.focus } : {}),
      failed,
      opened: touched("opened").filter((x) => isOpenScenario(x.state)),
      closed: touched("closed"),
      open: this.scenarios.list(),
      result: result.trim(),
    };
  }

  /* ---------------------------- Horloge et suivi ---------------------------- */

  /** Rendez-vous arrivés, annonces publiées dont dépend un dossier, puis la file. */
  tick() {
    const now = this.now();
    for (const s of this.scenarios.dueWakes()) {
      this.scenarios.clearWake(s.id);
      this.wake(s.id, `ton rendez-vous de ${when(s.wakeAt!, now)} : ${s.wakeReason ?? ""}`);
    }
    for (const s of this.scenarios.list()) {
      for (const e of s.depends.events) {
        const key = `${s.id}|${e.at}`;
        if (e.at <= s.checkedAt || e.at + PUBLICATION_DELAY_MS > now || this.published.has(key)) continue;
        this.published.add(key);
        this.wake(
          s.id,
          `l'annonce ${e.country} « ${e.title} » de ${when(e.at, now)}, dont dépend le dossier, vient d'être publiée : cherche le chiffre et juge son effet`,
        );
      }
    }
    void this.drain();
  }

  /**
   * Les setups proposés : l'entrée est-elle atteinte, puis le stop ou
   * l'objectif ? Sur les bougies d'une minute (de cinq au-delà de quinze
   * heures, d'un quart d'heure au-delà de trois jours).
   */
  async track() {
    for (const s of this.scenarios.list().filter((x) => x.state === "proposed" && x.proposedAt)) {
      const minutes = (this.now() - s.proposedAt!) / 60_000;
      const tf: ChartTimeframe = minutes <= 900 ? "1m" : minutes <= 4300 ? "5m" : "15m";
      const r = await this.market.chartCandles(s.symbol, tf, { limit: Math.min(1000, Math.ceil(minutes / (TIMEFRAME_SECONDS[tf] / 60)) + 2) });
      if ("error" in r) continue;
      const o = trackOutcome(s, r.candles, TIMEFRAME_SECONDS[tf]);
      const p = (v: number) => frenchPrice(v, s.digits);
      if (o.enteredAt && !s.outcome?.enteredAt) {
        this.scenarios.setOutcome(s.id, { result: "open", enteredAt: o.enteredAt });
        this.scenarios.note(s.id, "note", `Entrée atteinte à ${when(o.enteredAt, this.now())} (${p(s.entry!)}).`, { by: "system" });
      }
      if (o.result) {
        const what = o.result === "target" ? `objectif ${p(s.targets[0])} atteint` : `stop ${p(s.stop!)} touché`;
        this.scenarios.conclude(
          s.id,
          { result: o.result, enteredAt: o.enteredAt, at: o.at, ...(o.r !== undefined ? { r: Math.round(o.r * 100) / 100 } : {}) },
          `${what} à ${when(o.at!, this.now())}`,
        );
      }
    }
  }

  /* ------------------------------- Consignes ------------------------------- */

  /** Réglages internes d'un agent de la recherche d'opportunités : son dossier, son modèle, sa consigne système, ses outils. */
  private internal(timeoutMs: number) {
    const dir = resolve(this.config.dataDir, "setups");
    mkdirSync(dir, { recursive: true });
    const snapshot = this.memory.snapshot();
    const reactions = (
      this.db.db
        .prepare(
          `SELECT e.text, e.at, s.spec FROM scenario_events e JOIN scenarios s ON s.id = e.scenario_id
           WHERE e.kind = 'feedback' ORDER BY e.at DESC LIMIT 8`,
        )
        .all() as Array<{ text: string; at: number; spec: string }>
    ).map((r) => `${when(r.at, this.now())}, « ${(JSON.parse(r.spec) as { title: string }).title} » : ${r.text}`);
    return {
      cwd: dir,
      model: this.config.setupModel,
      quiet: true,
      timeoutMs,
      setups: true,
      appendSystemPrompt: setupSystemPrompt(
        {
          facts: snapshot.profile,
          environment: snapshot.environment,
          trading: snapshot.trading,
          examples: this.examples.lines(10),
          reactions,
          stats: statsLines(this.scenarios.stats()),
          skills: this.config.agentToolsReady ? this.skills.activeFor("agents").map((s) => ({ name: s.name, description: s.description })) : [],
          calendarFile: calendarSnapshot(this.config.dataDir),
        },
        new Date(this.now()),
      ),
    };
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.logger.error(`recherche d'opportunités : ${(e as Error).message}`, "setups");
    }
  }
}

/** « tracé de l'utilisateur », « tracé de Kopilia », « niveau de l'IA (sc_…) ». */
function drawingAuthor(d: Drawing): string {
  return d.createdBy === "ia"
    ? `niveau de l'IA${d.scenarioId ? ` (${d.scenarioId})` : ""}`
    : d.createdBy === "user"
      ? "tracé de l'utilisateur"
      : "tracé de Kopilia";
}
