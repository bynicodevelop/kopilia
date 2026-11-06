import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SetupsUpdatedView } from "./setups-view.js";
import { SessionGuard } from "../http/session.guard.js";
import { ScenarioService, SetupError } from "./scenario.service.js";
import { SetupAgentsService } from "./setup-agents.service.js";
import { MapService } from "./map.service.js";
import { LevelService } from "./level.service.js";

/**
 * La recherche d'opportunités vue et pilotée depuis l'écran : l'état
 * (hypothèses, scénarios avec leur fil, résultats), réagir à un setup, fermer
 * un scénario, changer l'état d'une hypothèse, lancer une passe, garder ou
 * retirer un niveau de l'IA, écarter une suggestion, et la carte automatique
 * d'un graphique. Même garde que le tableau de bord.
 */
@Controller("api/setups")
@UseGuards(SessionGuard)
export class SetupsScreenController {
  constructor(
    private readonly scenarios: ScenarioService,
    private readonly agents: SetupAgentsService,
    private readonly maps: MapService,
    private readonly view: SetupsUpdatedView,
    private readonly levels: LevelService,
  ) {}

  @Get()
  overview() {
    return this.view.build();
  }

  /** « Pris », « pas pour moi », « modifié » ou une remarque, depuis la fiche d'un setup. */
  @Post("scenarios/:id/feedback")
  feedback(@Param("id") id: string, @Body() body: { reaction?: string; note?: string }) {
    return this.guard(() => this.scenarios.feedback(id, body?.reaction ?? "", body?.note));
  }

  /** L'utilisateur ferme un scénario lui-même. */
  @Post("scenarios/:id/abandon")
  abandon(@Param("id") id: string, @Body() body: { reason?: string }) {
    return this.guard(() => this.scenarios.abandon(id, body?.reason?.trim() || "fermé par l'utilisateur", { by: "user" }));
  }

  /** L'utilisateur confirme ou invalide une hypothèse (la sienne ou celle de l'IA). */
  @Post("hypotheses/:id")
  hypothesis(@Param("id") id: string, @Body() body: { state?: string; reason?: string }) {
    return this.guard(() => {
      const state = body?.state === "active" || body?.state === "confirmed" || body?.state === "invalidated" ? body.state : undefined;
      if (!state) throw new SetupError("état : active, confirmed ou invalidated");
      return this.scenarios.updateHypothesis(id, { state, reason: body.reason?.trim() || "décidé par l'utilisateur" }, "user");
    });
  }

  /** « Garder ce niveau » : le niveau de l'IA devient un tracé de l'utilisateur. */
  @Post("levels/:id/keep")
  keep(@Param("id") id: string, @Body() body: { note?: string }) {
    return this.guard(() => this.levels.keep(id, body?.note));
  }

  /** « Retirer ce niveau » : il disparaît, et les dossiers qui s'y appuyaient sont relus. */
  @Post("levels/:id/dismiss")
  dismiss(@Param("id") id: string, @Body() body: { note?: string }) {
    return this.guard(() => this.levels.dismiss(id, body?.note));
  }

  /** L'utilisateur écarte une suggestion de l'IA sur un de ses tracés. */
  @Post("suggestions/:id/dismiss")
  dismissSuggestion(@Param("id") id: string) {
    return this.guard(() => {
      this.levels.dismissSuggestion(id);
      return { dismissed: id };
    });
  }

  @Post("search")
  search(@Body() body: { focus?: string }) {
    const r = this.agents.search({
      reason: "à la demande de l'utilisateur, depuis l'écran",
      byUser: true,
      ...(body?.focus?.trim() ? { focus: body.focus.trim() } : {}),
    });
    if (r.error) throw new BadRequestException(r.error);
    return r;
  }

  /** La carte automatique d'un graphique (zones, obliques, divergences), corrigée par l'IA. */
  @Get("automap")
  async automap(@Query("symbol") symbol?: string, @Query("timeframe") timeframe?: string) {
    if (!symbol || !timeframe) throw new BadRequestException("symbol et timeframe requis");
    const map = await this.maps.view(symbol, timeframe);
    if ("error" in map) throw new BadRequestException(map.error);
    return map;
  }

  private async guard<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SetupError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
