import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ViewCalendarEvent, ViewData, ViewSpec } from "@kopilia/contracts";
import { SessionGuard } from "../http/session.guard.js";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { DashboardError, DashboardService } from "../dashboard/dashboard.service.js";
import { CalendarService } from "../calendar/calendar.service.js";
import { BriefService } from "../veille/brief.service.js";
import { startOfDay } from "../common/dates.js";
import type { Impact } from "../calendar/forex-factory.js";
import { catalogText, viewSummary } from "./view-spec.js";

/** Annonces d'un bloc calendrier, au plus. */
const MAX_EVENTS = 20;
/** Une annonce passée depuis moins de ce temps reste dans le calendrier (le chiffre vient de tomber). */
const RECENT_MS = 2 * 3_600_000;
const IMPACTS: Record<string, Impact[]> = { high: ["high"], medium: ["high", "medium"], all: ["high", "medium", "low", "holiday"] };

/** Les données des blocs que l'écran n'a pas déjà (calendrier, brief), par position du bloc. */
export function viewData(
  spec: ViewSpec,
  deps: {
    events: (start: number, end: number, impacts: Impact[], currencies: string[]) => ViewCalendarEvent[];
    brief: () => { id: string; title: string; spoken: string; created_at: number } | undefined;
  },
  now = Date.now(),
): ViewData {
  const blocks: ViewData["blocks"] = {};
  spec.blocks.forEach((b, i) => {
    if (b.type === "calendar") {
      // Aujourd'hui, et les jours suivants demandés (1 par défaut : demain compris).
      const end = startOfDay(now).getTime() + ((b.days ?? 1) + 1) * 86_400_000;
      blocks[i] = { events: deps.events(now - RECENT_MS, end, IMPACTS[b.impact ?? "medium"], b.currencies ?? []).slice(0, MAX_EVENTS) };
    } else if (b.type === "brief") {
      const r = deps.brief();
      blocks[i] = { brief: r ? { briefId: r.id, title: r.title, spoken: r.spoken, createdAt: r.created_at } : null };
    }
  });
  return { blocks };
}

/** Les vues vues de l'écran : les données de leurs blocs servis par le serveur. */
@Controller("api/views")
@UseGuards(SessionGuard)
export class ViewsScreenController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly calendar: CalendarService,
    private readonly briefs: BriefService,
  ) {}

  @Get(":id/data")
  data(@Param("id") id: string): ViewData {
    const panel = this.dashboard.get(id);
    if (!panel?.view) throw new NotFoundException("aucune vue de cet identifiant");
    return viewData(panel.view, { events: (s, e, i, c) => this.calendar.events(s, e, i, c), brief: () => this.briefs.latest() });
  }
}

/**
 * Les vues pilotées à la voix (API interne, jeton du dialogue) : le catalogue
 * des blocs, créer une vue, la changer. La fermer : panel_close, comme tout encart.
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class ViewsControlController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("views/catalog")
  catalog() {
    return catalogText();
  }

  @Post("views")
  async open(@Body() body: { title?: unknown; blocks?: unknown }) {
    return this.guard(async () => {
      const r = await this.dashboard.openView(body?.title, body?.blocks);
      return { ...info(r.panel), created: r.created, note: "Dis en une phrase ce que montre la vue." };
    });
  }

  @Post("views/update")
  async update(@Body() body: { panel?: string; title?: unknown; blocks?: unknown }) {
    return this.guard(async () => {
      if (!body?.panel) throw new DashboardError("dis quelle vue changer (panel : son identifiant ou son titre)");
      return info(await this.dashboard.updateView(body.panel, { title: body.title, blocks: body.blocks }));
    });
  }

  /** Une erreur de vue revient à Kopilia comme un résultat, pour qu'il corrige. */
  private async guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DashboardError) return { error: e.message };
      if (e instanceof BadRequestException) return { error: e.message };
      throw e;
    }
  }
}

function info(p: { id: string; title: string; view?: ViewSpec }) {
  return { panelId: p.id, kind: "view", title: p.title, shows: p.view ? viewSummary(p.view) : "", blocks: p.view?.blocks ?? [] };
}
