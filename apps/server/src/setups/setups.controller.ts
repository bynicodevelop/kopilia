import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Hypothesis } from "@kopilia/contracts";
import { localMoment } from "../common/dates.js";
import { ConfigService } from "../config/config.service.js";
import { DashboardError, DashboardService } from "../dashboard/dashboard.service.js";
import { DrawingService, describeDrawing } from "../dashboard/drawing.service.js";
import { MarketService, Product } from "../market/market.service.js";
import { TIMEFRAME_SECONDS, isChartTimeframe } from "../market/timeframes.js";
import { frenchPrice } from "../market/metaapi.js";
import { AlertService } from "../alerts/alert.service.js";
import { Access, InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { ScenarioService, SetupError } from "./scenario.service.js";
import { SetupAgentsService } from "./setup-agents.service.js";
import { MapService } from "./map.service.js";
import { LevelInput, LevelService } from "./level.service.js";
import { ExampleService } from "./example.service.js";
import { ScanEntry, dossierText, filText, hypothesisLine, scanText, scenarioLine, statsLines, when } from "./setup-texts.js";

/** Ce que les outils donnent pour un dossier (ouverture ou mise à jour). */
interface DossierBody {
  horizon?: string;
  timeframe?: string;
  context_timeframe?: string;
  title?: string;
  why?: string;
  snapshot?: string;
  plan?: string;
  invalidation?: string;
  hypotheses?: string[];
  drawings?: string[];
  events?: Array<{ time?: string; currency?: string; title?: string }>;
  entry?: number;
  stop?: number;
  targets?: number[];
  expires?: string;
}

/** Ce que les outils donnent pour une hypothèse (de l'IA ou de l'utilisateur). */
interface HypothesisBody {
  id?: string;
  statement?: string;
  products?: string[];
  bias?: string;
  horizon?: string;
  catalysts?: string;
  invalidation?: string;
  source?: string;
  expires?: string;
  state?: string;
  reason?: string;
}

/**
 * API interne de la recherche d'opportunités, sur le loopback :
 * - les outils des agents de la recherche d'opportunités (leur jeton) :
 *   hypothèses, dossiers, alertes de l'IA, rendez-vous, carte corrigée ; chaque
 *   appel porte l'identifiant de leur travail (x-setup-job), écrit au fil ;
 * - les lectures des agents (cours, carte, bougies) ;
 * - les outils du dialogue : lancer une passe, lister, noter une réaction, une
 *   hypothèse ou un exemple de l'utilisateur.
 * Une erreur attendue revient en { error } : le modèle la lit et corrige.
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class SetupsController {
  constructor(
    private readonly scenarios: ScenarioService,
    private readonly agents: SetupAgentsService,
    private readonly maps: MapService,
    private readonly examples: ExampleService,
    private readonly market: MarketService,
    private readonly alerts: AlertService,
    private readonly dashboard: DashboardService,
    private readonly drawings: DrawingService,
    private readonly config: ConfigService,
    private readonly aiLevels: LevelService,
  ) {}

  /* ------------------------------- Lectures ------------------------------- */

  /** Carte technique d'un produit : ses tracés, la carte automatique corrigée, les alertes de l'IA. */
  @Get("levels")
  @Access("agent")
  async levels(@Query("symbol") symbol?: string, @Query("timeframe") timeframe?: string) {
    return this.guard(async () => {
      const product = await this.product(symbol);
      return this.maps.levels(product, timeframe && isChartTimeframe(timeframe) ? timeframe : "1h");
    });
  }

  /** Les dernières bougies d'un produit, la bougie en cours marquée. */
  @Get("candles")
  @Access("agent")
  async candles(@Query("symbol") symbol?: string, @Query("timeframe") timeframe?: string, @Query("count") count?: string) {
    return this.guard(async () => {
      if (!isChartTimeframe(timeframe)) throw new SetupError(`unité de temps inconnue (« ${timeframe ?? ""} »)`);
      const product = await this.product(symbol);
      const n = Math.min(60, Math.max(1, Number(count) || 12));
      const r = await this.market.chartCandles(product.symbol, timeframe, { limit: n });
      if ("error" in r) throw new SetupError(r.error ?? "bougies indisponibles");
      const tf = TIMEFRAME_SECONDS[timeframe];
      const p = (v: number) => frenchPrice(v, product.digits);
      const now = Date.now();
      return {
        product: product.name,
        timeframe,
        candles: r.candles.map((c) => ({
          time: when(c.t * 1000, 0),
          open: p(c.o),
          high: p(c.h),
          low: p(c.l),
          close: p(c.c),
          ...((c.t + tf) * 1000 > now ? { forming: true } : {}),
        })),
        note: "Heure de Paris, heure d'ouverture de chaque bougie ; forming : la bougie en cours, pas encore close.",
      };
    });
  }

  /**
   * Le tour d'horizon des produits de l'utilisateur (ou de ceux demandés) :
   * une ligne chacun, du plus près d'un niveau au plus loin, pour choisir
   * ceux à creuser avec market_levels et market_candles.
   */
  @Get("scan")
  @Access("agent")
  async scan(@Query("timeframe") timeframe?: string, @Query("symbols") symbols?: string) {
    return this.guard(async () => {
      const tf = timeframe && isChartTimeframe(timeframe) ? timeframe : "1h";
      const names = symbols?.trim()
        ? symbols
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : this.config.setupProducts;
      if (!names.length) throw new SetupError("aucun produit à passer en revue (KOPILIA_SETUP_PRODUCTS est vide)");
      const products = await Promise.all(names.map((n) => this.market.resolve(n)));
      const found = products.filter((p): p is Product => !("error" in p));
      const maps = await this.maps.scan(
        found.map((p) => p.symbol),
        tf,
      );
      const open = this.scenarios.list();
      const entries: ScanEntry[] = products.map((p, i) =>
        "error" in p
          ? { name: names[i], map: { error: p.error }, drawings: [], open: 0 }
          : {
              name: p.name,
              symbol: p.symbol,
              digits: p.digits,
              map: maps[found.indexOf(p)],
              drawings: this.drawings.list([p.symbol]).filter((d) => d.createdBy !== "ia"),
              open: open.filter((s) => s.symbol === p.symbol).length,
            },
      );
      return { scan: scanText(entries, tf, TIMEFRAME_SECONDS[tf]) };
    });
  }

  /* --------------------------- Outils des agents --------------------------- */

  @Post("setups/hypotheses")
  @Access("setups")
  async agentHypothesis(@Body() body: HypothesisBody, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => ({ hypothesis: hypothesisLine(await this.setHypothesis(body ?? {}, "kopilia", job)) }));
  }

  @Post("setups/scenarios")
  @Access("setups")
  async open(@Body() body: DossierBody & { product?: string; direction?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => {
      const product = await this.product(body?.product);
      const s = this.scenarios.open(
        {
          product,
          direction: body.direction ?? "",
          horizon: body.horizon ?? "",
          timeframe: body.timeframe ?? "",
          ...(body.context_timeframe ? { contextTimeframe: body.context_timeframe } : {}),
          title: body.title ?? "",
          why: body.why ?? "",
          snapshot: body.snapshot ?? "",
          plan: body.plan ?? "",
          invalidation: body.invalidation ?? "",
          depends: { hypotheses: body.hypotheses ?? [], drawings: body.drawings ?? [], events: this.events(body.events) },
          entry: body.entry,
          stop: body.stop,
          targets: body.targets,
          expiresAt: this.moment(body.expires, "l'échéance (expires)"),
        },
        { by: "agent", jobId: job },
      );
      return { scenarioId: s.id, scenario: scenarioLine(s), note: "Pose maintenant ses alertes (scenario_watch) ou un rendez-vous (scenario_rendezvous)." };
    });
  }

  @Get("setups/scenarios/:id")
  @Access("setups")
  view(@Param("id") id: string) {
    return this.guard(async () => this.dossier(id));
  }

  @Post("setups/scenarios/:id/update")
  @Access("setups")
  update(@Param("id") id: string, @Body() body: DossierBody & { reason?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => {
      const s = this.scenarios.update(
        id,
        {
          ...(body.horizon !== undefined ? { horizon: body.horizon } : {}),
          ...(body.timeframe !== undefined ? { timeframe: body.timeframe } : {}),
          ...(body.context_timeframe !== undefined ? { contextTimeframe: body.context_timeframe } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.why !== undefined ? { why: body.why } : {}),
          ...(body.snapshot !== undefined ? { snapshot: body.snapshot } : {}),
          ...(body.plan !== undefined ? { plan: body.plan } : {}),
          ...(body.invalidation !== undefined ? { invalidation: body.invalidation } : {}),
          ...(body.hypotheses !== undefined || body.drawings !== undefined || body.events !== undefined
            ? {
                depends: {
                  ...(body.hypotheses !== undefined ? { hypotheses: body.hypotheses } : {}),
                  ...(body.drawings !== undefined ? { drawings: body.drawings } : {}),
                  ...(body.events !== undefined ? { events: this.events(body.events) } : {}),
                },
              }
            : {}),
          ...(body.entry !== undefined ? { entry: body.entry } : {}),
          ...(body.stop !== undefined ? { stop: body.stop } : {}),
          ...(body.targets !== undefined ? { targets: body.targets } : {}),
          ...(body.expires !== undefined ? { expiresAt: this.moment(body.expires, "l'échéance (expires)") } : {}),
        },
        body.reason ?? "",
        { by: "agent", jobId: job },
      );
      return { scenario: scenarioLine(s) };
    });
  }

  @Post("setups/scenarios/:id/note")
  @Access("setups")
  note(@Param("id") id: string, @Body() body: { kind?: string; text?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => {
      const kind = body.kind === "context" || body.kind === "note" ? body.kind : "decision";
      const e = this.scenarios.note(id, kind, body.text ?? "", { by: "agent", jobId: job });
      return { noted: e.text };
    });
  }

  @Post("setups/scenarios/:id/watch")
  @Access("setups")
  watch(
    @Param("id") id: string,
    @Body()
    body: {
      price?: number;
      drawing?: string;
      zone_top?: number;
      zone_bottom?: number;
      condition?: string;
      trigger?: string;
      timeframe?: string;
      intention?: string;
      expires?: string;
    },
    @Headers("x-setup-job") job?: string,
  ) {
    return this.guard(async () => {
      const given = [body.price !== undefined, !!body.drawing, body.zone_top !== undefined || body.zone_bottom !== undefined].filter(Boolean).length;
      if (given !== 1) throw new SetupError("une seule cible : un prix (price), un tracé (drawing) ou une bande (zone_top et zone_bottom)");
      // Une bande qui reprend un tracé (le niveau du dossier, ou une zone de l'utilisateur) se pose sur lui : une seule zone à l'écran.
      const same = body.zone_top !== undefined ? this.aiLevels.zoneFor(id, body.zone_top, body.zone_bottom) : undefined;
      const drawingId = body.drawing ?? same?.id;
      const target = drawingId
        ? { kind: "drawing", drawingId }
        : body.price !== undefined
          ? { kind: "price", price: body.price }
          : { kind: "band", top: body.zone_top, bottom: body.zone_bottom };
      const a = this.scenarios.watch(
        id,
        {
          target,
          condition: body.condition,
          trigger: body.trigger,
          timeframe: body.timeframe,
          intention: body.intention ?? "",
          ...(body.expires ? { expiresAt: this.moment(body.expires, "l'échéance de l'alerte") } : {}),
        },
        { by: "agent", jobId: job },
      );
      return {
        alertId: a.id,
        expires: a.expiresAt ? when(a.expiresAt, Date.now()) : undefined,
        ...(same ? { note: `Ces bornes sont celles du tracé ${same.id} : l'alerte est posée sur lui (elle le suivra s'il bouge).` } : {}),
      };
    });
  }

  @Post("setups/scenarios/:id/unwatch")
  @Access("setups")
  unwatch(@Param("id") id: string, @Body() body: { alerts?: string[]; reason?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => ({
      removed: this.scenarios.unwatch(id, (body.alerts ?? []).map(String), body.reason ?? "", { by: "agent", jobId: job }).map((a) => a.id),
    }));
  }

  @Post("setups/scenarios/:id/rendezvous")
  @Access("setups")
  rendezvous(@Param("id") id: string, @Body() body: { at?: string; timeframe?: string; reason?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => {
      const s = this.scenarios.get(id);
      if (!s) throw new SetupError(`aucun scénario « ${id} »`);
      const at =
        body.at?.trim() === "next_close"
          ? await this.agents.nextClose(s.symbol, body.timeframe ?? s.timeframe)
          : this.moment(body.at, "l'heure du rendez-vous (at)");
      this.scenarios.setWake(id, at, body.reason ?? "", { by: "agent", jobId: job });
      return { rendezvous: when(at, Date.now()) };
    });
  }

  @Post("setups/scenarios/:id/propose")
  @Access("setups")
  propose(
    @Param("id") id: string,
    @Body() body: { summary?: string; entry?: number; stop?: number; targets?: number[] },
    @Headers("x-setup-job") job?: string,
  ) {
    return this.guard(async () => {
      const s = this.scenarios.propose(
        id,
        { summary: body.summary ?? "", entry: body.entry, stop: body.stop, targets: body.targets },
        { by: "agent", jobId: job },
      );
      return { proposed: scenarioLine(s), note: "Kopilia prévient l'utilisateur ; le résultat sera suivi." };
    });
  }

  @Post("setups/scenarios/:id/abandon")
  @Access("setups")
  abandon(@Param("id") id: string, @Body() body: { reason?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => ({ abandoned: scenarioLine(this.scenarios.abandon(id, body.reason ?? "", { by: "agent", jobId: job })) }));
  }

  @Post("setups/map-adjustments")
  @Access("setups")
  adjust(
    @Body() body: { symbol?: string; timeframe?: string; key?: string; action?: string; top?: number; bottom?: number; reason?: string },
    @Headers("x-setup-job") job?: string,
  ) {
    return this.guard(async () => {
      const product = await this.product(body.symbol);
      return this.maps.adjust(
        product.symbol,
        body.timeframe ?? "",
        { key: body.key ?? "", action: body.action ?? "", top: body.top, bottom: body.bottom, reason: body.reason ?? "" },
        job,
      );
    });
  }

  /** Un niveau de travail tracé pour un dossier : un candidat de la carte contrôlé, ou le sien. */
  @Post("setups/scenarios/:id/levels")
  @Access("setups")
  drawLevel(@Param("id") id: string, @Body() body: LevelInput, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => {
      const { drawing, shared } = await this.aiLevels.draw(id, body ?? {}, job);
      const s = this.scenarios.get(id);
      return {
        level: { drawingId: drawing.id, description: describeDrawing(drawing, s?.digits) },
        ...(shared ? { note: "Un niveau de l'IA était déjà là (un autre dossier) : partagé, sans le doubler." } : {}),
      };
    });
  }

  @Post("setups/scenarios/:id/levels/:drawingId/erase")
  @Access("setups")
  eraseLevel(@Param("id") id: string, @Param("drawingId") drawingId: string, @Body() body: { reason?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => {
      this.aiLevels.erase(id, drawingId, body?.reason, job);
      return { erased: drawingId };
    });
  }

  @Post("setups/suggestions")
  @Access("setups")
  suggest(@Body() body: { drawing_id?: string; text?: string; scenario_id?: string }, @Headers("x-setup-job") job?: string) {
    return this.guard(async () => ({ suggestion: this.aiLevels.suggest(body?.drawing_id ?? "", body?.text, body?.scenario_id, job) }));
  }

  /* --------------------------- Outils du dialogue --------------------------- */

  /** « Garde la zone de l'IA » : ses niveaux deviennent ceux de l'utilisateur. */
  @Post("setups/levels/keep")
  keepLevels(@Body() body: { ids?: string[]; note?: string }) {
    return this.guard(async () => {
      const ids = (body?.ids ?? []).map(String).filter(Boolean);
      if (!ids.length) throw new SetupError("quels niveaux de l'IA garder ? (ids d_…, donnés par chart_drawings)");
      return { kept: ids.map((id) => this.aiLevels.keep(id, body?.note).id) };
    });
  }

  /** Lance une passe tout de suite (« cherche-moi des setups sur l'or »). */
  @Post("setups/search")
  search(@Body() body: { focus?: string }) {
    const r = this.agents.search({ reason: "à la demande de l'utilisateur", byUser: true, ...(body?.focus?.trim() ? { focus: body.focus.trim() } : {}) });
    if (r.error) return { error: r.error };
    return r.queued
      ? { queued: true, note: "Une recherche tourne déjà : celle-ci partira juste après (quelques minutes)." }
      : {
          started: true,
          note: "La recherche tourne en arrière-plan (quelques minutes) : son résultat (les setups en attente qu'elle repère, ou pourquoi rien) te sera transmis à la fin.",
        };
  }

  /** Les setups déclenchés (proposés), ceux en attente (surveillés), les hypothèses et les résultats ; avec un identifiant, un dossier et son fil. */
  @Get("setups")
  list(@Query("id") id?: string) {
    return this.guard(async () => {
      if (id) return this.dossier(id);
      const now = Date.now();
      const all = this.scenarios.list({ recent: true });
      return {
        triggered: all.filter((s) => s.state === "proposed").map((s) => scenarioLine(s, now)),
        waiting: all.filter((s) => s.state === "watching").map((s) => scenarioLine(s, now)),
        recentlyClosed: all.filter((s) => s.state !== "proposed" && s.state !== "watching").map((s) => `${scenarioLine(s, now)} : ${s.stateReason ?? ""}`),
        hypotheses: this.scenarios.hypotheses().map((h) => hypothesisLine(h, now)),
        results: statsLines(this.scenarios.stats()),
        suggestionsOnHisDrawings: this.aiLevels.suggestions().map((x) => {
          const d = this.drawings.get(x.drawingId);
          return `${x.symbol}, tracé ${x.drawingId}${d ? ` (${describeDrawing(d)})` : ""} : ${x.text}`;
        }),
      };
    });
  }

  /**
   * La réaction de l'utilisateur à un setup, ou une remarque sur un produit
   * (attachée à ses scénarios ouverts, que l'IA relira).
   */
  @Post("setups/feedback")
  feedback(@Body() body: { scenario?: string; product?: string; reaction?: string; note?: string }) {
    return this.guard(async () => {
      if (body.scenario) {
        const s = this.scenarios.feedback(body.scenario, body.reaction ?? "comment", body.note);
        return { noted: true, scenario: scenarioLine(s) };
      }
      const product = await this.product(body.product);
      const open = this.scenarios.list({ symbol: product.symbol });
      if (!open.length)
        return {
          noted: false,
          note: `aucun scénario ouvert sur ${product.name} : si c'est son analyse du produit, note-la dans sa fiche (analysis_note)`,
        };
      for (const s of open) this.scenarios.feedback(s.id, "comment", body.note);
      return { noted: true, scenarios: open.map((s) => s.id) };
    });
  }

  /** « Ça, c'est un setup » : l'instant et son contexte, gardés comme exemple. */
  @Post("setups/examples")
  examplesAdd(@Body() body: { product?: string; timeframe?: string; at?: string; positive?: boolean; note?: string }) {
    return this.guard(async () => {
      const product = await this.product(body.product);
      const chart = this.dashboard.list().find((p) => p.kind === "chart" && p.symbol === product.symbol);
      const timeframe = body.timeframe || chart?.timeframe || "15m";
      return this.examples.add(product, {
        timeframe,
        ...(body.at ? { at: this.moment(body.at, "l'instant de l'exemple (at)") } : {}),
        positive: body.positive !== false,
        note: body.note,
      });
    });
  }

  /* ------------------------------- Interne ------------------------------- */

  private async setHypothesis(body: HypothesisBody, author: Hypothesis["author"], job?: string): Promise<Hypothesis> {
    const products = body.products?.length ? await Promise.all(body.products.map((p) => this.product(p))) : undefined;
    const expiresAt = body.expires ? this.moment(body.expires, "l'échéance de l'hypothèse") : undefined;
    const content = {
      ...(body.statement !== undefined ? { statement: body.statement } : {}),
      ...(products ? { products } : {}),
      ...(body.bias !== undefined ? { bias: body.bias } : {}),
      ...(body.horizon !== undefined ? { horizon: body.horizon } : {}),
      ...(body.catalysts !== undefined ? { catalysts: body.catalysts } : {}),
      ...(body.invalidation !== undefined ? { invalidation: body.invalidation } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    if (body.id) {
      const state = body.state === "active" || body.state === "confirmed" || body.state === "invalidated" ? body.state : undefined;
      return this.scenarios.updateHypothesis(body.id, { ...content, ...(state ? { state, reason: body.reason } : {}) }, author, job);
    }
    return this.scenarios.addHypothesis(
      {
        statement: body.statement ?? "",
        bias: body.bias ?? "",
        horizon: body.horizon ?? "intraday",
        ...content,
        source: body.source ?? (author === "user" ? "l'utilisateur" : undefined),
      },
      author,
      job,
    );
  }

  /** Un dossier, son fil et ses alertes, tel qu'un agent ou le dialogue le relit. */
  private dossier(id: string) {
    const s = this.scenarios.get(id);
    if (!s) throw new SetupError(`aucun scénario « ${id} »`);
    const now = Date.now();
    const hyps = s.depends.hypotheses.map((h) => this.scenarios.hypothesis(h)).filter((h) => h !== undefined);
    return {
      dossier: dossierText(s, this.alerts.ofScenario(s.id), { hypotheses: hyps, drawings: this.dashboard.drawings.list([s.symbol]), now }),
      fil: filText(this.scenarios.events(s.id, 60), now),
    };
  }

  private async product(query: string | undefined): Promise<Product> {
    if (!query?.trim()) throw new SetupError("dis de quel produit il s'agit");
    const p = await this.market.resolve(query);
    if ("error" in p) throw new SetupError(`${p.error}${p.suggestions?.length ? ` (proches : ${p.suggestions.join(", ")})` : ""}`);
    return p;
  }

  private moment(value: string | undefined, what: string): number {
    const at = value ? localMoment(value) : undefined;
    if (at === undefined) throw new SetupError(`${what} : « AAAA-MM-JJ HH:MM », heure de Paris`);
    return at;
  }

  private events(list: DossierBody["events"]) {
    return (list ?? []).map((e) => {
      const at = e.time ? localMoment(e.time) : undefined;
      if (at === undefined || !e.title) throw new SetupError("une annonce : son heure (« AAAA-MM-JJ HH:MM »), sa devise et son titre");
      return { at, country: (e.currency ?? "USD").toUpperCase(), title: e.title };
    });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SetupError || e instanceof DashboardError) return { error: e.message };
      throw e;
    }
  }
}
