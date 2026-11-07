import { BadRequestException, Body, Controller, Get, Optional, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../http/session.guard.js";
import { MarketService } from "../market/market.service.js";
import { BrokerPauseService } from "../market/broker-pause.service.js";
import { alertTimeframeOf, isChartTimeframe } from "../market/timeframes.js";
import { DashboardError, DashboardService } from "./dashboard.service.js";
import { LevelService } from "../setups/level.service.js";
import { SetupError } from "../setups/scenario.service.js";
import { JobService } from "../jobs/job.service.js";
import { TradingError, TradingService } from "../trading/trading.service.js";
import { ACTIVITY_MAX, ACTIVITY_MS, activityItem } from "./activity.js";
import type { ActivityItem } from "@kopilia/contracts";

/**
 * Le tableau de bord vu et piloté depuis l'écran (même origine, loopback) :
 * les encarts et les dernières cotations, les bougies d'un graphique, fermer
 * ou régler un encart à la main (unité de temps, indicateurs), tracer,
 * déplacer et effacer à la souris, poser, régler et retirer des alertes. La
 * session et son jeton, ceux du WebSocket, dans x-session-id et x-session-token.
 */
@Controller("api/dashboard")
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly market: MarketService,
    private readonly levels: LevelService,
    private readonly jobs: JobService,
    private readonly trading: TradingService,
    @Optional() private readonly broker?: BrokerPauseService,
  ) {}

  @Get()
  async overview() {
    return { ...this.dashboard.view(), quotes: this.market.feed.snapshot(), account: await this.market.accountLabel() };
  }

  /** Bougies d'un graphique (symbole exact d'un encart), jusqu'à `before` (epoch s) pour remonter le temps. */
  @Get("candles")
  async candles(@Query("symbol") symbol?: string, @Query("timeframe") timeframe?: string, @Query("before") before?: string, @Query("limit") limit?: string) {
    if (!symbol) throw new BadRequestException("symbol requis");
    if (!isChartTimeframe(timeframe)) throw new BadRequestException("unité de temps inconnue");
    // Un graphique ouvert ou changé à l'écran : le courtier ne s'endort pas sous ses yeux.
    this.broker?.touch();
    const r = await this.market.chartCandles(symbol, timeframe, { before: Number(before) || undefined, limit: Number(limit) || undefined });
    if ("error" in r) throw new BadRequestException(r.error);
    return r;
  }

  /**
   * Réglage d'un graphique à la main : unité de temps, la liste entière de ses
   * indicateurs, ou un autre produit (un clic dans la liste des produits).
   */
  @Post("panels/:id")
  async update(@Param("id") id: string, @Body() body: { timeframe?: string; indicators?: unknown[]; symbol?: string }) {
    return this.guard(async () => {
      if (this.dashboard.get(id)?.kind !== "chart") throw new DashboardError("seul un graphique se règle depuis l'écran");
      const symbol = typeof body?.symbol === "string" && body.symbol ? body.symbol : undefined;
      // Un seul graphique par produit : celui qui l'affiche déjà sert.
      if (symbol && this.dashboard.list().some((p) => p.kind === "chart" && p.id !== id && p.symbol === symbol))
        throw new DashboardError("ce produit a déjà son graphique à l'écran");
      return (
        await this.dashboard.update(id, { timeframe: body?.timeframe, indicators: Array.isArray(body?.indicators) ? body.indicators : undefined, symbol })
      ).panel;
    });
  }

  /** Un tracé à la souris sur le produit d'un graphique affiché. */
  @Post("drawings")
  draw(@Body() body: { symbol?: string; shape?: unknown; label?: string }) {
    return this.guard(() => {
      const symbol = body?.symbol ?? "";
      if (!this.dashboard.list().some((p) => p.kind === "chart" && p.symbol === symbol)) throw new DashboardError("aucun graphique de ce produit à l'écran");
      return this.dashboard.drawings.create(symbol, body.shape, { label: body.label, by: "user" });
    });
  }

  /** Un tracé déplacé ou renommé à la souris ; un niveau de l'IA qu'il modifie devient le sien. */
  @Post("drawings/:id")
  moveDrawing(@Param("id") id: string, @Body() body: { shape?: unknown; label?: string | null }) {
    return this.guard(() => {
      if (this.dashboard.drawings.get(id)?.createdBy === "ia") this.levels.keep(id, "modifié par l'utilisateur");
      return this.dashboard.drawings.update(id, { shape: body?.shape, label: body?.label });
    });
  }

  /**
   * Un tracé effacé ; un niveau de l'IA effacé est retiré (ses dossiers sont
   * relus). La boîte d'un trade en cours reste : un ticket à confirmer propose
   * de retirer l'ordre (ou de fermer la position), elle part ensuite.
   */
  @Post("drawings/:id/delete")
  eraseDrawing(@Param("id") id: string) {
    return this.guard(async () => {
      if (this.dashboard.drawings.guard([id]).length) {
        const ticket = await this.trading.eraseBoxTicket(id);
        return { erased: [], kept: [id], ticket: ticket.id };
      }
      if (this.dashboard.drawings.get(id)?.createdBy === "ia") return { erased: [this.levels.dismiss(id).id] };
      return { erased: this.dashboard.drawings.remove([id]).map((d) => d.id) };
    });
  }

  /** Une alerte à la souris sur le produit d'un graphique affiché : à un prix, ou sur une de ses lignes. */
  @Post("alerts")
  createAlert(@Body() body: { symbol?: string; target?: unknown; condition?: string; trigger?: string; timeframe?: string; message?: string }) {
    return this.guard(() => {
      const panel = this.dashboard.list().find((p) => p.kind === "chart" && p.symbol === body?.symbol);
      if (!panel?.symbol) throw new DashboardError("aucun graphique de ce produit à l'écran");
      const product = { symbol: panel.symbol, name: panel.name ?? panel.title, ...(panel.digits !== undefined ? { digits: panel.digits } : {}) };
      const { target, condition, trigger, timeframe, message } = body;
      return this.dashboard.alerts.create(product, { target, condition, trigger, timeframe: timeframe || alertTimeframeOf(panel.timeframe), message }, "user");
    });
  }

  /** Une alerte réglée, déplacée (son prix), suspendue ou réactivée à la souris ; `message` null retire la consigne. */
  @Post("alerts/:id")
  updateAlert(
    @Param("id") id: string,
    @Body() body: { price?: number; condition?: string; trigger?: string; timeframe?: string; message?: string | null; state?: "active" | "paused" },
  ) {
    return this.guard(() => {
      const { price, condition, trigger, timeframe, message, state } = body ?? {};
      return this.dashboard.alerts.update(id, { price, condition, trigger, timeframe, message, state });
    });
  }

  @Post("alerts/:id/delete")
  deleteAlert(@Param("id") id: string) {
    return this.guard(() => ({ deleted: this.dashboard.alerts.remove([id]).map((a) => a.id) }));
  }

  @Post("panels/:id/close")
  close(@Param("id") id: string) {
    return this.guard(() => ({ closed: this.dashboard.close(id).map((p) => p.id) }));
  }

  /** Le graphique d'un produit ouvert depuis l'écran (la liste des setups repérés), dans l'unité de temps donnée. */
  @Post("charts")
  openChart(@Body() body: { symbol?: string; timeframe?: string }) {
    return this.guard(async () => {
      if (!body?.symbol) throw new DashboardError("quel produit ?");
      return (await this.dashboard.openChart(body.symbol, isChartTimeframe(body.timeframe) ? body.timeframe : undefined)).panel;
    });
  }

  /** L'activité : les agents et tâches récents de l'utilisateur, toutes conversations confondues. */
  @Get("activity")
  activity(): ActivityItem[] {
    return this.jobs.recentForUser(Date.now() - ACTIVITY_MS, ACTIVITY_MAX).map((j) => activityItem(j, this.jobs.folderOf(j)));
  }

  /** La liste des setups repérés, ouverte depuis l'écran (les opportunités). */
  @Post("setups")
  openSetups() {
    return this.guard(() => this.dashboard.openSetups().panel);
  }

  @Post("close-all")
  closeAll() {
    return { closed: this.dashboard.close(undefined, { all: true }).map((p) => p.id) };
  }

  private async guard<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DashboardError || e instanceof SetupError || e instanceof TradingError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
