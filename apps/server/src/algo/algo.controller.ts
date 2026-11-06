import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ROBOT_STATUS_NAMES, type RobotNoteKind, VERDICT_NAMES } from "@kopilia/contracts";
import { Access, InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { DashboardError, DashboardService } from "../dashboard/dashboard.service.js";
import { TIMEFRAME_LABELS, isChartTimeframe } from "../market/timeframes.js";
import { JobError } from "../jobs/job.service.js";
import { MarketService } from "../market/market.service.js";
import { AlgoAgentsService } from "./algo-agents.service.js";
import { backtestText, metricsLine, robotLine, tfLabel } from "./algo-texts.js";
import { BacktestService, MAX_TRIALS_PER_JOB } from "./backtest.service.js";
import { RobotError, RobotService } from "./robot.service.js";

/*
 * API interne du laboratoire de stratégies, sur le loopback :
 * - les outils de l'agent quant (son jeton ; chaque appel porte x-algo-job) :
 *   bibliothèque, réserve de bougies, versions, backtests, trades
 *   d'apprentissage, fil, leçons ;
 * - les outils du dialogue (jeton du dialogue) : lancer une recherche, lister
 *   les robots, lire une fiche avec ses trades.
 * Une erreur que le modèle peut corriger revient en { error }.
 */

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
/** « 06/11 13:09 », heure de Paris. */
const STAMP = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const stamp = (ms: number) => STAMP.format(ms).replace(",", "");

@Controller("internal/algo")
@UseGuards(InternalAuthGuard)
export class AlgoController {
  constructor(
    private readonly robots: RobotService,
    private readonly backtests: BacktestService,
    private readonly agents: AlgoAgentsService,
    private readonly dashboard: DashboardService,
    private readonly market: MarketService,
  ) {}

  /* ------------------------------ Dialogue ------------------------------ */

  @Post("develop")
  async develop(@Body() body: { sessionId?: string; idea?: string; products?: string[]; timeframe?: string; name?: string; details?: string }) {
    return this.guard(async () => {
      if (!body.sessionId) throw new RobotError("session absente");
      const { robot, jobId } = await this.agents.develop({
        sessionId: body.sessionId,
        idea: String(body.idea ?? ""),
        products: Array.isArray(body.products) ? body.products.map(String) : undefined,
        timeframe: body.timeframe,
        name: body.name,
        details: body.details,
      });
      const panel = this.openPanel();
      return {
        robot: robot.id,
        name: robot.name,
        products: robot.products,
        timeframe: robot.timeframe,
        jobId,
        panel,
        say: `Dis que tu t'y mets (robot « ${robot.name} » sur ${robot.products.join(", ")} en ${tfLabel(robot.timeframe)}), que la recherche prend de dix à trente minutes en arrière-plan, et que tu reviendras avec le résultat ; l'encart Robots suit l'avancement.`,
      };
    });
  }

  @Get("robots")
  listForDialogue() {
    return this.guard(() => {
      const robots = this.robots.list();
      return {
        count: robots.length,
        robots: robots.map((r) => ({ id: r.id, name: r.name, status: ROBOT_STATUS_NAMES[r.status], line: robotLine(r), researching: !!r.jobId })),
        ...(robots.length ? {} : { hint: "Aucun robot : propose-lui de dire « développe une stratégie de… » avec son idée." }),
      };
    });
  }

  @Get("robots/:query")
  @Access("agent")
  robot(@Param("query") query: string, @Query("code") code?: string, @Query("trades") trades?: string) {
    return this.guard(() => {
      const found = this.robots.find(query);
      const sheet = this.robots.sheet(found.id);
      const best = sheet.best;
      const out: Record<string, unknown> = {
        id: sheet.id,
        name: sheet.name,
        status: ROBOT_STATUS_NAMES[sheet.status],
        researching: !!sheet.jobId,
        idea: sheet.idea,
        hypothesis: sheet.hypothesis,
        plan: sheet.plan,
        products: sheet.products,
        timeframe: sheet.timeframe,
        version: sheet.version,
        trials: sheet.trials,
        best: best ? backtestText(best) : "aucun backtest",
        bestBreakdown: best?.breakdown,
        backtests: sheet.backtests.map((b) => ({
          id: b.id,
          trial: b.trial,
          version: b.version,
          verdict: VERDICT_NAMES[b.verdict],
          inSample: metricsLine(b.inSample),
          ...(b.outOfSample ? { outOfSample: metricsLine(b.outOfSample) } : {}),
          ...(b.note ? { note: b.note } : {}),
        })),
        notes: sheet.notes.map((n) => `${stamp(n.at)} [${n.kind}] ${n.text}`),
        parents: sheet.parents,
        ...(code === "1" && sheet.code ? { code: sheet.code } : {}),
      };
      if (trades && best) out.trades = this.pickTrades(best.id, trades, 10, "all");
      return out;
    });
  }

  /* ------------------------------- Agent ------------------------------- */

  @Get("library")
  @Access("agent")
  library() {
    return this.guard(() => ({
      robots: this.robots.list().map(robotLine),
      lessons: this.robots
        .lessons(40)
        .map((l) => `${l.text} (${l.products.join(", ")}${l.timeframe ? `, ${l.timeframe}` : ""}${l.backtestId ? `, preuve ${l.backtestId}` : ""})`),
      budget: `${MAX_TRIALS_PER_JOB} essais par recherche`,
    }));
  }

  @Get("data")
  @Access("agent")
  data(@Query("product") product?: string, @Query("timeframe") timeframe?: string) {
    return this.guard(async () => {
      if (!timeframe || !isChartTimeframe(timeframe)) throw new RobotError("unité de temps manquante ou inconnue");
      const list = this.backtests.coverages();
      if (!product) return { coverages: list.map(this.coverageLine) };
      const r = await this.market.resolve(product);
      if ("error" in r) throw new RobotError(r.error);
      const c = list.find((x) => x.symbol === r.symbol && x.timeframe === timeframe);
      return {
        product: r.name,
        symbol: r.symbol,
        timeframe,
        ...(c ? { coverage: this.coverageLine(c) } : { coverage: "rien en réserve : un backtest la chargera (deux ans par défaut), ou demande load" }),
        loading: this.backtests.isLoading(r.symbol, timeframe),
      };
    });
  }

  @Post("data/load")
  @Access("agent")
  load(@Body() body: { product?: string; timeframe?: string; depthDays?: number }) {
    return this.guard(async () => {
      const { product, report } = await this.backtests.load(String(body.product ?? ""), String(body.timeframe ?? ""), body.depthDays);
      return {
        product: product.name,
        symbol: product.symbol,
        loaded: report.loaded,
        requests: report.requests,
        ...(report.coverage ? { coverage: this.coverageLine(report.coverage) } : {}),
        ...(report.error ? { error: `chargement interrompu : ${report.error}` } : {}),
      };
    });
  }

  @Post("robots/:id/versions")
  @Access("agent")
  saveVersion(@Param("id") id: string, @Body() body: { code?: string; plan?: string; hypothesis?: string; name?: string }) {
    return this.guard(async () => {
      const robot = this.robots.find(id);
      const code = String(body.code ?? "");
      const error = await this.backtests.check(code);
      if (error) return { error: `le code ne compile pas : ${error}` };
      if (body.hypothesis || body.name) this.robots.update(robot.id, { hypothesis: body.hypothesis, name: body.name });
      const version = this.robots.saveVersion(robot.id, code, body.plan);
      return { robot: robot.id, version, say: `version ${version} enregistrée : joue-la avec algo_backtest_run` };
    });
  }

  @Post("robots/:id/backtests")
  @Access("agent")
  runBacktest(
    @Param("id") id: string,
    @Body()
    body: {
      version?: number;
      products?: string[];
      timeframe?: string;
      contexts?: string[];
      minute?: boolean;
      depthDays?: number;
      params?: Record<string, unknown>;
      costs?: { spread?: number; commission?: number; slippage?: number };
      note?: string;
    },
    @Headers("x-algo-job") job?: string,
  ) {
    return this.guard(async () => {
      const robot = this.robots.find(id);
      if (body.note) this.robots.note(robot.id, "decision", body.note, { jobId: job });
      const r = await this.backtests.run({
        robotId: robot.id,
        version: body.version,
        products: body.products,
        timeframe: body.timeframe,
        contexts: body.contexts,
        minute: body.minute,
        depthDays: body.depthDays,
        params: body.params,
        costs: body.costs,
        note: body.note,
        jobId: job,
      });
      const used = job ? this.robots.trialsOf(job) : r.summary.trial;
      return {
        backtest: r.summary.id,
        trial: r.summary.trial,
        remainingBudget: job ? Math.max(0, MAX_TRIALS_PER_JOB - used) : undefined,
        summary: backtestText(r.summary),
        verdict: VERDICT_NAMES[r.summary.verdict],
        inSample: r.summary.inSample,
        outOfSample: r.summary.outOfSample,
        reserved: r.summary.reserved,
        breakdown: r.summary.breakdown,
        coverage: r.coverage.map((c) => `${c.name} : ${c.bars} bougies du ${day(c.from)} au ${day(c.to)}`),
        ...(r.logs.length ? { robotLogs: r.logs } : {}),
        ...(r.warnings.length ? { warnings: r.warnings } : {}),
      };
    });
  }

  @Get("backtests/:id/trades")
  @Access("agent")
  trades(@Param("id") id: string, @Query("which") which?: string, @Query("limit") limit?: string) {
    return this.guard(() => ({
      backtest: id,
      phase: "apprentissage",
      trades: this.pickTrades(id, which ?? "worst", Math.min(50, Number(limit) || 10), "inSample"),
    }));
  }

  @Post("robots/:id/notes")
  @Access("agent")
  note(@Param("id") id: string, @Body() body: { kind?: string; text?: string; backtestId?: string }, @Headers("x-algo-job") job?: string) {
    return this.guard(() => {
      const robot = this.robots.find(id);
      const note = this.robots.note(robot.id, (body.kind ?? "decision") as RobotNoteKind, String(body.text ?? ""), { backtestId: body.backtestId, jobId: job });
      return { ok: true, at: note.at };
    });
  }

  @Post("lessons")
  @Access("agent")
  lesson(@Body() body: { text?: string; products?: string[]; timeframe?: string; robotId?: string; backtestId?: string }) {
    return this.guard(() => {
      const lesson = this.robots.lesson({
        text: String(body.text ?? ""),
        products: Array.isArray(body.products) ? body.products.map(String) : [],
        timeframe: body.timeframe,
        robotId: body.robotId,
        backtestId: body.backtestId,
      });
      return { ok: true, lesson: lesson.id };
    });
  }

  /* ------------------------------- Interne ------------------------------- */

  private pickTrades(backtestId: string, which: string, limit: number, phase: "inSample" | "all") {
    const all = this.robots.trades(backtestId, { phase });
    const sorted =
      which === "best"
        ? [...all].sort((a, b) => b.r - a.r)
        : which === "last"
          ? [...all].reverse()
          : which === "first"
            ? all
            : [...all].sort((a, b) => a.r - b.r);
    return sorted.slice(0, limit).map((t) => ({
      symbol: t.symbol,
      side: t.side === "long" ? "achat" : "vente",
      entry: `${stamp(t.entryAt * 1000)} à ${t.entry}`,
      exit: `${stamp(t.exitAt * 1000)} à ${t.exit} (${t.reason})`,
      stop: t.stop,
      ...(t.target !== undefined ? { target: t.target } : {}),
      r: t.r,
      mae: t.mae,
      mfe: t.mfe,
    }));
  }

  private coverageLine = (c: { symbol: string; timeframe: string; first: number; last: number; count: number; complete: boolean }) =>
    `${c.symbol} ${isChartTimeframe(c.timeframe) ? TIMEFRAME_LABELS[c.timeframe] : c.timeframe} : ${c.count} bougies du ${day(c.first)} au ${day(c.last)}${c.complete ? " (tout le passé du courtier)" : ""}`;

  private openPanel(): string | undefined {
    try {
      return this.dashboard.openRobots().panel.id;
    } catch (e) {
      return e instanceof DashboardError ? undefined : undefined;
    }
  }

  private async guard<T>(fn: () => T | Promise<T>): Promise<T | { error: string }> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RobotError || e instanceof JobError || e instanceof DashboardError) return { error: e.message };
      throw e;
    }
  }
}
