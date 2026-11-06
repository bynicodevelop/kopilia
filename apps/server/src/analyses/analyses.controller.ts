import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ANALYSIS_MEMORY_MS, type Analysis, type AnalysisZone } from "@kopilia/contracts";
import { DrawingService, describeDrawing } from "../dashboard/drawing.service.js";
import { MarketService, type Product } from "../market/market.service.js";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { ScenarioService } from "../setups/scenario.service.js";
import { BriefService } from "../veille/brief.service.js";
import { confront } from "./analysis-check.js";
import { AnalysisError, AnalysisNote, AnalysisService } from "./analysis.service.js";
import { analysisLine, entryLine, relativeMoment, viewText } from "./analysis-texts.js";

/** Ce que l'outil du dialogue donne : les champs dits, à plat (le modèle les remplit mieux ainsi). */
interface NoteBody {
  product?: string;
  summary?: string;
  fundamental_bias?: string;
  fundamental_reason?: string;
  technical_bias?: string;
  technical_reason?: string;
  side?: string;
  zone?: string;
  zone_low?: number;
  zone_high?: number;
  zone_drawing?: string;
  trigger?: string;
  horizon?: string;
  timeframe?: string;
  invalidation?: string;
  catalysts?: string;
  answer?: string;
}

/** Un wrap plus ancien que ça n'est plus « le wrap du jour ». */
const WRAP_FRESH_MS = 20 * 3_600_000;
/** Fiches fermées rappelées dans la liste. */
const CLOSED_LISTED_MS = 7 * 86_400_000;

/**
 * API interne des fiches d'analyse, pour le dialogue : noter ce que
 * l'utilisateur dit d'un produit (et recevoir de quoi le contredire), relire
 * une fiche, la fermer. Une erreur attendue revient en { error } : le modèle
 * la lit et corrige.
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class AnalysesController {
  constructor(
    private readonly analyses: AnalysisService,
    private readonly market: MarketService,
    private readonly scenarios: ScenarioService,
    private readonly briefs: BriefService,
    private readonly drawings: DrawingService,
  ) {}

  /**
   * Ce qu'il vient de dire d'un produit, écrit dans sa fiche ; en retour, ce
   * que le contradicteur doit confronter : l'état d'avant, la fiche fermée
   * récemment, les setups du système, le wrap du jour, les points relevés.
   */
  @Post("analyses/note")
  note(@Body() body: NoteBody) {
    return this.guard(async () => {
      const product = await this.product(body?.product);
      const note = this.toNote(body ?? {}, product);
      const answer = body?.answer?.trim();
      if (!Object.keys(note).length) {
        if (!answer) throw new AnalysisError("rien à noter : dis sa lecture, un biais, son idée, ce qui l'invaliderait, ou sa réponse (answer)");
        const open = this.analyses.open(product.symbol);
        if (!open) throw new AnalysisError(`pas de fiche ouverte sur ${product.name} : note d'abord son analyse`);
        this.analyses.answer(open.id, answer);
        return { noted: `réponse notée dans la fiche ${product.name} (${open.id})` };
      }
      const now = this.analyses.now();
      const r = this.analyses.note(product, note);
      const a = r.analysis;
      const setups = this.scenarios.list({ symbol: product.symbol });
      const found = confront({
        ...(r.before ? { before: r.before } : {}),
        after: a.view,
        said: r.said,
        ...(r.closed
          ? {
              closed: {
                view: r.closed.view,
                closedAt: r.closed.closedAt ?? r.closed.updatedAt,
                ...(r.closed.closeReason ? { reason: r.closed.closeReason } : {}),
              },
            }
          : {}),
        setups: setups.map((s) => ({ id: s.id, direction: s.direction, state: s.state, horizon: s.horizon, timeframe: s.timeframe, title: s.title })),
        raised: this.analyses.raised(a.id),
        ...(a.digits !== undefined ? { digits: a.digits } : {}),
        now,
      });
      // Une objection à la fois : la plus importante ; les autres viendront aux lectures suivantes.
      const point = found.points[0];
      if (point) this.analyses.challenge(a.id, [point]);
      if (answer) this.analyses.answer(a.id, answer);
      const brief = this.briefs.latest();
      return {
        noted: `${r.opened ? "Fiche ouverte" : "Fiche mise à jour"} : ${analysisLine(a, now)}`,
        ...(r.before ? { before: `${relativeMoment(r.before.at, now)} : ${viewText(r.before.view, a.digits)}` } : {}),
        ...(r.closed ? { previousAnalysis: analysisLine(r.closed, now) } : {}),
        ...(point ? { point: point.text } : {}),
        ...(found.missing.length ? { ask: found.missing } : {}),
        systemSetups: setups.map(
          (s) =>
            `${s.id}, ${s.state === "proposed" ? "déclenché" : "en attente"}, ${s.direction === "long" ? "achat" : "vente"} (${s.horizon}, ${s.timeframe}) : ${s.title}`,
        ),
        ...(brief && now - brief.created_at <= WRAP_FRESH_MS
          ? { wrap: `${relativeMoment(brief.created_at, now)} : « ${brief.title} ». En bref : ${brief.spoken}` }
          : { wrap: "pas de wrap récent" }),
        consigne: point
          ? `Réponds en contradicteur, d'égal à égal : ce point en une ou deux phrases, en citant ce qu'il disait, puis demande ce qui a changé${found.missing.length ? " (et ce qui manque)" : ""}. Sa réponse à cette objection : analysis_note avec answer.`
          : found.missing.length
            ? "Demande-lui ce qui manque, en une phrase."
            : "Rien ne se contredit dans sa fiche : confirme en quelques mots ; si son biais fondamental va contre le wrap, dis-le.",
      };
    });
  }

  /** Une fiche et son fil (le produit) ; sans produit, les fiches ouvertes et celles fermées depuis une semaine. */
  @Get("analyses")
  list(@Query("product") productQuery?: string, @Query("closed") closed?: string) {
    return this.guard(async () => {
      const now = this.analyses.now();
      if (!productQuery?.trim()) {
        const all = this.analyses.list({ closedSince: now - CLOSED_LISTED_MS });
        return {
          open: all.filter((a) => a.state === "open").map((a) => analysisLine(a, now)),
          recentlyClosed: all.filter((a) => a.state === "closed").map((a) => analysisLine(a, now)),
        };
      }
      const product = await this.product(productQuery);
      const open = this.analyses.open(product.symbol);
      const previous = this.analyses.lastClosed(product.symbol, now - ANALYSIS_MEMORY_MS);
      const shown = closed === "1" || closed === "true" ? (previous ?? open) : (open ?? previous);
      if (!shown) return { none: `aucune fiche sur ${product.name}` };
      return {
        analysis: analysisLine(shown, now),
        fil: this.analyses.entries(shown.id, 40).map((e) => entryLine(e, now)),
        ...(shown === open && previous ? { previousAnalysis: analysisLine(previous, now) } : {}),
      };
    });
  }

  /** Ferme la fiche ouverte d'un produit, avec sa raison. */
  @Post("analyses/close")
  close(@Body() body: { product?: string; reason?: string }) {
    return this.guard(async () => {
      const product = await this.product(body?.product);
      const open = this.analyses.open(product.symbol);
      if (!open) throw new AnalysisError(`pas de fiche ouverte sur ${product.name}`);
      const a: Analysis = this.analyses.close(open.id, body?.reason, "user");
      return {
        closed: analysisLine(a, this.analyses.now()),
        note: "Sa prochaine analyse sur ce produit ouvrira une nouvelle fiche ; celle-ci restera rappelée deux semaines.",
      };
    });
  }

  /* ------------------------------- Interne ------------------------------- */

  private toNote(b: NoteBody, product: Product): AnalysisNote {
    const n: AnalysisNote = {};
    if (b.summary !== undefined) n.summary = b.summary;
    if (b.fundamental_bias !== undefined || b.fundamental_reason !== undefined) n.fundamental = { bias: b.fundamental_bias, reason: b.fundamental_reason };
    if (b.technical_bias !== undefined || b.technical_reason !== undefined) n.technical = { bias: b.technical_bias, reason: b.technical_reason };
    const zone = this.zone(b, product);
    if (b.side !== undefined || zone || b.trigger !== undefined || b.horizon !== undefined || b.timeframe !== undefined)
      n.idea = { side: b.side, ...(zone ? { zone } : {}), trigger: b.trigger, horizon: b.horizon, timeframe: b.timeframe };
    if (b.invalidation !== undefined) n.invalidation = b.invalidation;
    if (b.catalysts !== undefined) n.catalysts = b.catalysts;
    return compact(n) as AnalysisNote;
  }

  /** La zone de son idée : ses prix, ou son tracé (une zone, une ligne) du même produit. */
  private zone(b: NoteBody, product: Product): AnalysisZone | undefined {
    const zone: AnalysisZone = {};
    if (typeof b.zone_low === "number") zone.low = b.zone_low;
    if (typeof b.zone_high === "number") zone.high = b.zone_high;
    if (b.zone?.trim()) zone.text = b.zone.trim();
    if (b.zone_drawing?.trim()) {
      const d = this.drawings.get(b.zone_drawing.trim());
      if (!d || d.symbol !== product.symbol) throw new AnalysisError(`aucun tracé « ${b.zone_drawing} » sur ${product.name} (chart_drawings les donne)`);
      zone.drawingId = d.id;
      if (d.kind === "zone") Object.assign(zone, { low: d.bottom, high: d.top });
      else if (d.kind === "hline") Object.assign(zone, { low: d.price, high: d.price });
      if (!zone.text) zone.text = `son tracé : ${describeDrawing(d, product.digits, { levels: false })}`;
    }
    return Object.keys(zone).length ? zone : undefined;
  }

  private async product(query: string | undefined): Promise<Product> {
    if (!query?.trim()) throw new AnalysisError("dis de quel produit il s'agit");
    const p = await this.market.resolve(query);
    if ("error" in p) throw new AnalysisError(`${p.error}${p.suggestions?.length ? ` (proches : ${p.suggestions.join(", ")})` : ""}`);
    return p;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AnalysisError) return { error: e.message };
      throw e;
    }
  }
}

/** Sans les champs vides (texte blanc, objet vide) : « rien à noter » doit les voir comme absents. */
function compact(value: unknown): unknown {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const c = compact(v);
    if (c !== undefined && !(typeof c === "object" && c !== null && !Array.isArray(c) && !Object.keys(c).length)) out[k] = c;
  }
  return out;
}
