import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JobState, type RobotSummary } from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { JobError, JobFinished, JobService } from "../jobs/job.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { MarketService } from "../market/market.service.js";
import { isChartTimeframe } from "../market/timeframes.js";
import { algoSystemPrompt, developPrompt } from "./algo-prompts.js";
import { robotLine } from "./algo-texts.js";
import { RobotError, RobotService } from "./robot.service.js";

/*
 * Les recherches du laboratoire : à « développe une stratégie de… », un robot
 * est créé avec l'idée, et un agent quant (Sonnet) part en fond, dans la
 * session du dialogue, avec ses outils et sa consigne. À la fin du travail, le
 * statut du robot suit le verdict du code et la fiche garde la trace ; Kopilia
 * annonce le résultat comme pour tout agent.
 */

/** Une recherche dure au plus ce temps-là. */
const RESEARCH_TIMEOUT_MS = 40 * 60_000;

export interface DevelopRequest {
  sessionId: string;
  idea: string;
  products?: string[];
  timeframe?: string;
  name?: string;
  details?: string;
}

@Injectable()
export class AlgoAgentsService implements OnModuleInit, OnModuleDestroy {
  private readonly onFinished = (e: JobFinished) => this.safely(() => this.finished(e));

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly jobs: JobService,
    private readonly memory: MemoryService,
    private readonly market: MarketService,
    private readonly robots: RobotService,
  ) {}

  onModuleInit() {
    this.jobs.on("job.finished", this.onFinished);
  }

  onModuleDestroy() {
    this.jobs.off("job.finished", this.onFinished);
  }

  /** Les recherches sont possibles si les agents ont leurs outils et si les cours du courtier sont là. */
  get enabled(): boolean {
    return this.config.agentToolsReady && this.config.marketToolsReady;
  }

  /** Crée le robot et lance la recherche ; renvoie le robot et le travail. */
  async develop(req: DevelopRequest): Promise<{ robot: RobotSummary; jobId: string }> {
    if (!this.enabled) throw new RobotError("le laboratoire a besoin des cours MetaApi et du serveur MCP des agents compilé");
    const idea = req.idea.trim();
    if (idea.length < 8) throw new RobotError("dis l'idée de la stratégie avec les mots de l'utilisateur (une phrase au moins)");
    const timeframe = req.timeframe ?? "15m";
    if (!isChartTimeframe(timeframe) || timeframe === "1mn") throw new RobotError(`unité de temps inconnue ou inutile : ${timeframe}`);
    const queries = (req.products?.length ? req.products : this.config.setupProducts.slice(0, 1)).map((q) => q.trim()).filter(Boolean);
    const products: string[] = [];
    const errors: string[] = [];
    for (const q of queries.slice(0, 6)) {
      const r = await this.market.resolve(q);
      if ("error" in r) errors.push(r.error);
      else if (!products.includes(r.symbol)) products.push(r.symbol);
    }
    if (!products.length) throw new RobotError(`aucun produit reconnu : ${errors.join(" ; ") || "dis sur quel produit"}`);
    const robot = this.robots.create({ idea, name: req.name, products, timeframe, sessionId: req.sessionId });
    try {
      const job = this.jobs.start({
        sessionId: req.sessionId,
        kind: "agent",
        title: `Robot : ${robot.name}`,
        prompt: developPrompt({ robotId: robot.id, idea, products, timeframe, details: req.details }),
        internal: this.internal(),
      });
      this.robots.update(robot.id, { jobId: job.id, status: "testing" });
      this.robots.note(robot.id, "decision", `Recherche lancée (${job.id}) : ${products.join(", ")} en ${timeframe}.`, { jobId: job.id });
      this.logger.log(`recherche ${job.id} lancée pour ${robot.id} (${robot.name})`, "algo");
      return { robot: this.robots.summary(robot.id)!, jobId: job.id };
    } catch (e) {
      this.robots.note(robot.id, "error", `Recherche non lancée : ${(e as Error).message}`);
      if (e instanceof JobError) throw new RobotError(e.message);
      throw e;
    }
  }

  private internal() {
    const dir = resolve(this.config.dataDir, "algo");
    mkdirSync(dir, { recursive: true });
    const snapshot = this.memory.snapshot();
    return {
      cwd: dir,
      model: this.config.algoModel,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      algo: true,
      appendSystemPrompt: algoSystemPrompt({
        facts: snapshot.profile,
        environment: snapshot.environment,
        trading: snapshot.trading,
        library: this.robots.list().slice(0, 20).map(robotLine),
        lessons: this.robots.lessons(30).map((l) => `${l.text} (${l.products.join(", ")}${l.timeframe ? `, ${l.timeframe}` : ""})`),
      }),
    };
  }

  private finished(e: JobFinished) {
    const robot = this.robots.byJob(e.job.id);
    if (!robot) return;
    if (e.job.state === JobState.Succeeded) {
      const final = this.robots.finishResearch(robot.id);
      this.robots.note(robot.id, "verdict", e.result.trim().slice(0, 2000) || "Recherche terminée sans compte rendu.", { jobId: e.job.id });
      this.logger.log(`recherche ${e.job.id} finie : ${robot.name} → ${final.status}`, "algo");
    } else {
      this.robots.note(robot.id, "error", `Recherche ${e.job.state} : ${(e.job.summary ?? "").slice(0, 500)}`, { jobId: e.job.id });
      this.robots.finishResearch(robot.id);
    }
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.logger.warn(`laboratoire : ${(err as Error).message}`, "algo");
    }
  }
}
