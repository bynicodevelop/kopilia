import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { RobotService } from "../algo/robot.service.js";
import {
  Alert,
  Drawing,
  Indicator,
  IndicatorInput,
  MA_TYPES,
  MAX_INDICATORS,
  Panel,
  RobotSummary,
  PanelDisplay,
  Scenario,
  ViewSpec,
  viewSpecSchema,
  viewSymbols,
  completeIndicator,
  indicatorInputSchema,
  indicatorLabel,
  indicatorSchema,
  sameIndicator,
  upgradeIndicator,
} from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { DatabaseService } from "../db/database.service.js";
import { MarketService, Product } from "../market/market.service.js";
import { normalize, resolveSymbol } from "../market/metaapi.js";
import { CHART_TIMEFRAMES, ChartTimeframe, isChartTimeframe, TIMEFRAME_LABELS } from "../market/timeframes.js";
import { DashboardError, DrawingService, describeDrawing } from "./drawing.service.js";
import { AlertService } from "../alerts/alert.service.js";
import { describeAlert } from "../alerts/alert-texts.js";
import { ScenarioService } from "../setups/scenario.service.js";
import { resolveView, viewSummary, viewTitle } from "../views/view-spec.js";

export { DashboardError } from "./drawing.service.js";

/** Ce que l'écran montre : les encarts, et les tracés et alertes des produits de leurs graphiques. */
export interface DashboardView {
  panels: Panel[];
  drawings: Drawing[];
  alerts: Alert[];
}

/** Encarts affichés au plus : deux de chaque côté de l'orbe, les suivants empilés sur le dernier (l'écran les décale). */
export const MAX_PANELS = 12;
/** Produits d'un suivi au plus (une ligne chacun). */
export const MAX_QUOTES = 8;
export const DEFAULT_TIMEFRAME: ChartTimeframe = "15m";
/** Produits nommés au plus dans un réglage groupé d'indicateurs (sa liste en compte 28). */
const MAX_BULK_PRODUCTS = 60;
/** Les réglages du modèle commun, dans chart_settings : ceux des produits qui n'ont pas les leurs. */
const COMMON = "*";

interface PanelRow {
  id: string;
  kind: "chart" | "quotes" | "setups" | "activity" | "news" | "products" | "journal" | "robots" | "view";
  title: string;
  spec: string;
  position: number;
  created_at: number;
  updated_at: number;
}

interface ChartSpec extends Product {
  timeframe: ChartTimeframe;
  indicators?: Indicator[];
}

interface QuotesSpec {
  symbols: Product[];
}

/** La liste des setups, l'activité : rien à régler, elles suivent les setups de l'IA, les agents et les tâches. */
type EmptySpec = Record<string, never>;

/** L'encart News : toutes les news, ou celles d'un produit. */
interface NewsSpec {
  symbol?: string;
  name?: string;
}

/**
 * Le tableau de bord : les encarts affichés autour de l'orbe (graphique d'un
 * produit, avec ses indicateurs ; suivi de plusieurs ; liste des setups
 * repérés, dont les produits sont suivis tant qu'elle est là ; activité, les
 * agents et tâches récents ; vue composée
 * par Kopilia à partir du catalogue de blocs), ouverts, modifiés et
 * fermés à la voix par Kopilia ou à l'écran. Gardé en base : un rechargement
 * ou un redémarrage le retrouve, et tous les écrans montrent le même. Émet
 * `updated` (encarts, tracés, alertes) à chaque changement, tracés et alertes
 * compris ; le flux de cotations suit les produits affichés.
 */
@Injectable()
export class DashboardService
  extends EventEmitter<{ updated: [DashboardView]; display: [{ panelId?: string; display: PanelDisplay }] }>
  implements OnModuleInit
{
  /** Les produits des trades en cours, suivis pour l'encart Journal (voir followTrades). */
  private tradeSymbols: string[] = [];
  constructor(
    private readonly db: DatabaseService,
    private readonly market: MarketService,
    readonly drawings: DrawingService,
    readonly alerts: AlertService,
    private readonly logger: AppLogger,
    @Optional() private readonly scenarios?: ScenarioService,
    @Optional() private readonly robotsLib?: RobotService,
  ) {
    super();
    // Un tracé ou une alerte d'un produit affiché change l'écran ; ceux d'un produit absent attendent son graphique.
    const shown = (symbol: string) => {
      if (this.chartSymbols().includes(symbol)) this.emit("updated", this.view());
    };
    drawings.on("changed", shown);
    alerts.on("changed", shown);
    // La liste des setups affichée : les cotations suivent les produits des setups ouverts.
    let followed = "";
    scenarios?.on("changed", () => {
      if (!this.rows().some((r) => r.kind === "setups")) return;
      const now = this.setupSymbols().join(",");
      if (now === followed) return;
      followed = now;
      this.market.feed.setSymbols(this.symbols());
    });
  }

  /**
   * Au démarrage, les cotations des encarts gardés reprennent ; les
   * indicateurs des graphiques affichés deviennent ceux de leur produit s'il
   * n'en a pas encore (graphiques ouverts avant qu'ils soient gardés par produit).
   */
  onModuleInit() {
    for (const r of this.rows()) {
      if (r.kind !== "chart") continue;
      const spec = parseSpec(r) as ChartSpec;
      if (spec.indicators?.length && !this.settings(spec.symbol)) this.saveSettings(spec.symbol, spec.indicators);
    }
    this.market.feed.setSymbols(this.symbols());
  }

  /* ------------------------ Indicateurs gardés par produit ------------------------ */

  /** Les indicateurs gardés d'un produit (ou du modèle commun, COMMON) ; undefined s'il n'en a pas. */
  private settings(symbol: string): Indicator[] | undefined {
    const row = this.db.db.prepare("SELECT indicators FROM chart_settings WHERE symbol = ?").get(symbol) as { indicators: string } | undefined;
    if (!row) return undefined;
    try {
      const list = JSON.parse(row.indicators) as unknown[];
      return list.map((i) => indicatorSchema.safeParse(i)).flatMap((r) => (r.success ? [r.data] : []));
    } catch {
      return undefined;
    }
  }

  /** Ce qu'un graphique de ce produit montre à son ouverture : ses indicateurs, sinon le modèle commun (l'image Telegram aussi). */
  indicatorsFor(symbol: string): Indicator[] {
    return this.settings(symbol) ?? this.settings(COMMON) ?? [];
  }

  private saveSettings(symbol: string, indicators: Indicator[]) {
    this.db.db
      .prepare(
        "INSERT INTO chart_settings (symbol, indicators, updated_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET indicators = excluded.indicators, updated_at = excluded.updated_at",
      )
      .run(symbol, JSON.stringify(indicators), Date.now());
  }

  /**
   * Indicateurs de plusieurs graphiques d'un coup, ouverts ou non, sans rien
   * ouvrir : `all` change le modèle commun (les produits sans réglages le
   * suivent) et chaque produit qui a les siens ; sinon, les produits nommés.
   * Les graphiques affichés suivent aussitôt. Sans ajout ni retrait : l'état.
   */
  async applyIndicators(
    target: { all?: boolean; products?: string[] },
    patch: { addIndicators?: unknown[]; removeIndicators?: IndicatorRemoval[] },
  ): Promise<{ changed: number; model?: Indicator[]; products: Array<{ symbol: string; name: string; indicators: Indicator[] }>; errors: string[] }> {
    const errors: string[] = [];
    const change = !!(patch.addIndicators?.length || patch.removeIndicators?.length);
    // Les graphiques affichés d'abord : leurs indicateurs sont ceux de leur produit.
    for (const r of this.rows()) {
      if (r.kind !== "chart") continue;
      const spec = parseSpec(r) as ChartSpec;
      if (!this.settings(spec.symbol) && spec.indicators?.length) this.saveSettings(spec.symbol, spec.indicators);
    }
    let symbols: string[];
    const names = new Map<string, string>();
    if (target.all) {
      const kept = (this.db.db.prepare("SELECT symbol FROM chart_settings WHERE symbol != ?").all(COMMON) as Array<{ symbol: string }>).map((r) => r.symbol);
      symbols = [COMMON, ...kept];
    } else {
      if (!target.products?.length) throw new DashboardError("dis sur quels produits (products), ou tous (all)");
      const { products, errors: unknown } = await this.products(target.products, MAX_BULK_PRODUCTS);
      errors.push(...unknown);
      for (const p of products) names.set(p.symbol, p.name);
      symbols = products.map((p) => p.symbol);
    }
    let changed = 0;
    const result: Array<{ symbol: string; name: string; indicators: Indicator[] }> = [];
    let model: Indicator[] | undefined;
    for (const symbol of symbols) {
      const current = symbol === COMMON ? (this.settings(COMMON) ?? []) : this.indicatorsFor(symbol);
      let next = current;
      if (change) {
        try {
          next = nextIndicators(current, patch) ?? current;
        } catch (e) {
          errors.push(`${names.get(symbol) ?? (symbol === COMMON ? "modèle commun" : symbol)} : ${(e as Error).message}`);
          continue;
        }
        this.saveSettings(symbol, next);
        changed++;
      }
      if (symbol === COMMON) model = next;
      else result.push({ symbol, name: names.get(symbol) ?? symbol, indicators: next });
    }
    // Les graphiques affichés suivent : ceux des produits changés, et ceux qui suivent le modèle.
    if (change) {
      for (const r of this.rows()) {
        if (r.kind !== "chart") continue;
        const spec = parseSpec(r) as ChartSpec;
        if (!target.all && !symbols.includes(spec.symbol)) continue;
        const { indicators: _old, ...rest } = spec;
        this.db.db
          .prepare("UPDATE panels SET spec = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ ...rest, ...withIndicators(this.indicatorsFor(spec.symbol)) }), Date.now(), r.id);
      }
      this.changed();
    }
    return { changed, ...(model ? { model } : {}), products: result, errors };
  }

  list(): Panel[] {
    return this.rows().map(toPanel);
  }

  /** Ce que l'écran montre : les encarts, et les tracés et alertes des produits de leurs graphiques. */
  view(): DashboardView {
    const symbols = this.chartSymbols();
    return { panels: this.list(), drawings: this.drawings.list(symbols), alerts: this.alerts.list(symbols) };
  }

  get(id: string): Panel | undefined {
    const row = this.rows().find((r) => r.id === id);
    return row && toPanel(row);
  }

  /** Le graphique d'un produit ; déjà affiché, il change d'unité de temps si elle est donnée. */
  async openChart(query: string, timeframe?: string): Promise<{ panel: Panel; created: boolean }> {
    const tf = timeframeOf(timeframe);
    const product = await this.product(query);
    const existing = this.rows().find((r) => r.kind === "chart" && (parseSpec(r) as ChartSpec).symbol === product.symbol);
    if (existing) {
      if (tf) this.writeSpec(existing.id, { ...(parseSpec(existing) as ChartSpec), timeframe: tf });
      return { panel: this.get(existing.id)!, created: false };
    }
    this.ensureRoom();
    const row = this.insert("chart", titleOf(product.name), {
      ...product,
      timeframe: tf ?? DEFAULT_TIMEFRAME,
      ...withIndicators(this.indicatorsFor(product.symbol)),
    });
    return { panel: toPanel(row), created: true };
  }

  /** Le suivi de plusieurs produits (un seul encart de ce genre : il s'y ajoute). */
  async openQuotes(queries: string[]): Promise<{ panel: Panel; created: boolean; errors: string[] }> {
    const { products, errors } = await this.products(queries);
    const existing = this.rows().find((r) => r.kind === "quotes");
    if (existing) {
      this.writeSpec(existing.id, { symbols: mergeProducts((parseSpec(existing) as QuotesSpec).symbols, products) });
      return { panel: this.get(existing.id)!, created: false, errors };
    }
    if (!products.length) throw new DashboardError(errors.join(" ; ") || "aucun produit à suivre");
    this.ensureRoom();
    const row = this.insert("quotes", "Suivi", { symbols: products.slice(0, MAX_QUOTES) });
    return { panel: toPanel(row), created: true, errors };
  }

  /**
   * La liste de tous ses produits (une seule), comme la liste de surveillance
   * de TradingView : sa liste entière, relue à chaque ouverture (elle a pu
   * changer dans le .env), dans son ordre. Un produit introuvable chez le
   * courtier est signalé, les autres restent.
   */
  async openProducts(queries: string[]): Promise<{ panel: Panel; created: boolean; errors: string[] }> {
    const { products, errors } = await this.products(queries, MAX_BULK_PRODUCTS);
    if (!products.length) throw new DashboardError(errors.join(" ; ") || "aucun produit dans ta liste (KOPILIA_SETUP_PRODUCTS dans le fichier .env)");
    const spec: QuotesSpec = { symbols: products };
    const existing = this.rows().find((r) => r.kind === "products");
    if (existing) {
      if (existing.spec !== JSON.stringify(spec)) this.writeSpec(existing.id, spec);
      return { panel: this.get(existing.id)!, created: false, errors };
    }
    this.ensureRoom();
    return { panel: toPanel(this.insert("products", "Produits", spec)), created: true, errors };
  }

  /** La liste des setups repérés (une seule) : ouverte, ou déjà là ; avec les setups ouverts, pour les dire. */
  openSetups(): { panel: Panel; created: boolean; setups: Scenario[] } {
    const setups = this.scenarios?.list() ?? [];
    const existing = this.rows().find((r) => r.kind === "setups");
    if (existing) return { panel: toPanel(existing), created: false, setups };
    this.ensureRoom();
    return { panel: toPanel(this.insert("setups", "Setups", {})), created: true, setups };
  }

  /** L'activité (une seule) : ouverte, ou déjà là. */
  openActivity(): { panel: Panel; created: boolean } {
    const existing = this.rows().find((r) => r.kind === "activity");
    if (existing) return { panel: toPanel(existing), created: false };
    this.ensureRoom();
    return { panel: toPanel(this.insert("activity", "Activité", {})), created: true };
  }

  /** Les robots du laboratoire de stratégies (une seule liste) : ouverte, ou déjà là ; avec les robots, pour les dire. */
  openRobots(): { panel: Panel; created: boolean; robots: RobotSummary[] } {
    const robots = this.robotsLib?.list() ?? [];
    const existing = this.rows().find((r) => r.kind === "robots");
    if (existing) return { panel: toPanel(existing), created: false, robots };
    this.ensureRoom();
    return { panel: toPanel(this.insert("robots", "Robots", {})), created: true, robots };
  }

  /** Le journal de trading (un seul) : ouvert, ou déjà là. */
  openJournal(): { panel: Panel; created: boolean } {
    const existing = this.rows().find((r) => r.kind === "journal");
    if (existing) return { panel: toPanel(existing), created: false };
    this.ensureRoom();
    return { panel: toPanel(this.insert("journal", "Journal", {})), created: true };
  }

  /**
   * L'encart News (un seul) : ouvert, ou déjà là ; un produit le filtre sur
   * ses news (« les news sur l'or »), sans produit il les montre toutes.
   */
  async openNews(query?: string): Promise<{ panel: Panel; created: boolean }> {
    const product = query?.trim() ? await this.product(query) : undefined;
    const spec: NewsSpec = product ? { symbol: product.symbol, name: product.name } : {};
    const title = product ? `News · ${titleOf(product.name)}` : "News";
    const existing = this.rows().find((r) => r.kind === "news");
    if (existing) {
      if (existing.spec !== JSON.stringify(spec) || existing.title !== title) this.writeSpec(existing.id, spec, title);
      return { panel: toPanel(this.rows().find((r) => r.id === existing.id)!), created: false };
    }
    this.ensureRoom();
    return { panel: toPanel(this.insert("news", title, spec)), created: true };
  }

  /** L'activité est affichée. */
  showsActivity(): boolean {
    return this.rows().some((r) => r.kind === "activity");
  }

  /**
   * Une vue composée par Kopilia : ses blocs vérifiés contre le catalogue,
   * leurs produits résolus. Une vue du même titre est remplacée plutôt que
   * doublée.
   */
  async openView(title: unknown, blocks: unknown): Promise<{ panel: Panel; created: boolean }> {
    const name = viewTitle(title);
    const spec = await resolveView(blocks, (q) => this.market.resolve(q));
    const same = this.rows().find((r) => r.kind === "view" && normalize(r.title) === normalize(name));
    if (same) {
      this.writeSpec(same.id, spec, name);
      return { panel: this.get(same.id)!, created: false };
    }
    this.ensureRoom();
    return { panel: toPanel(this.insert("view", name, spec)), created: true };
  }

  /** Change le titre ou les blocs d'une vue (la liste entière des blocs). */
  async updateView(ref: string, patch: { title?: unknown; blocks?: unknown }): Promise<Panel> {
    const panel = this.findOrThrow(ref);
    if (panel.kind !== "view") throw new DashboardError(`l'encart ${panel.title} n'est pas une vue : panel_update le règle`);
    if (patch.title === undefined && patch.blocks === undefined) throw new DashboardError("rien à changer : donne title ou blocks");
    const spec = patch.blocks !== undefined ? await resolveView(patch.blocks, (q) => this.market.resolve(q)) : panel.view!;
    this.writeSpec(panel.id, spec, patch.title !== undefined ? viewTitle(patch.title) : undefined);
    return this.get(panel.id)!;
  }

  /**
   * Change l'unité de temps, le produit ou les indicateurs d'un graphique
   * (`indicators` : la liste entière, celle de l'écran ; `addIndicators`,
   * `editIndicators`, `removeIndicators` : à la voix) ; ajoute ou retire des
   * produits d'un suivi.
   */
  async update(
    ref: string,
    patch: {
      timeframe?: string;
      symbol?: string;
      add?: string[];
      remove?: string[];
      indicators?: unknown[];
      addIndicators?: unknown[];
      editIndicators?: unknown[];
      removeIndicators?: IndicatorRemoval[];
    },
  ): Promise<{ panel: Panel; errors: string[] }> {
    const panel = this.findOrThrow(ref);
    const row = this.rows().find((r) => r.id === panel.id)!;
    const errors: string[] = [];
    if (row.kind === "setups") throw new DashboardError("la liste des setups ne se règle pas : elle suit d'elle-même les setups de l'IA");
    if (row.kind === "view") throw new DashboardError("une vue se change avec view_update (ses blocs, son titre)");
    if (row.kind === "activity") throw new DashboardError("l'activité ne se règle pas : elle suit d'elle-même les agents et les tâches");
    if (row.kind === "robots") throw new DashboardError("la liste des robots ne se règle pas : elle suit d'elle-même le laboratoire");
    if (row.kind === "journal")
      throw new DashboardError("le journal ne se règle pas : il suit de lui-même ses trades et ses fiches (journal_get pour le lire)");
    if (row.kind === "products")
      throw new DashboardError(
        "la liste des produits ne se règle pas : c'est la liste de l'utilisateur (KOPILIA_SETUP_PRODUCTS dans son .env) ; pour quelques produits à part, un suivi (kind quotes)",
      );
    // L'encart News se règle par produit : un produit le filtre, aucun lui rend toutes les news.
    if (row.kind === "news") return { panel: (await this.openNews(patch.symbol)).panel, errors };
    if (row.kind === "chart") {
      const spec = parseSpec(row) as ChartSpec;
      const tf = timeframeOf(patch.timeframe);
      const product = patch.symbol ? await this.product(patch.symbol) : undefined;
      // Un autre produit vient avec ses indicateurs (les siens, sinon le modèle commun).
      const base = product ? this.indicatorsFor(product.symbol) : (spec.indicators ?? []);
      const indicators = nextIndicators(base, patch);
      if (!tf && !product && !indicators) throw new DashboardError("rien à changer : donne timeframe, symbol ou des indicateurs");
      const { indicators: _kept, ...current } = spec;
      const next: ChartSpec = { ...(product ?? current), timeframe: tf ?? spec.timeframe, ...withIndicators(indicators ?? base) };
      // Gardés pour le produit : rouvert plus tard, son graphique les retrouve.
      if (indicators) this.saveSettings(next.symbol, indicators);
      this.writeSpec(row.id, next, product ? titleOf(product.name) : undefined);
    } else {
      const spec = parseSpec(row) as QuotesSpec;
      const added = patch.add?.length ? await this.products(patch.add) : { products: [], errors: [] };
      errors.push(...added.errors);
      let symbols = mergeProducts(spec.symbols, added.products);
      for (const r of patch.remove ?? []) {
        const found = resolveSymbol(
          r,
          symbols.map((s) => s.symbol),
        );
        if ("symbol" in found) symbols = symbols.filter((s) => s.symbol !== found.symbol);
        else errors.push(`« ${r} » n'est pas dans le suivi`);
      }
      if (!symbols.length) {
        // Plus rien à suivre : l'encart se ferme plutôt que de rester vide.
        this.close(row.id);
        return { panel: { ...panel, symbols: [] }, errors };
      }
      this.writeSpec(row.id, { symbols });
    }
    return { panel: this.get(row.id)!, errors };
  }

  /** Ferme un encart (désigné par son identifiant, son produit, « suivi » ou « setups »), ou tous, sauf exceptions. */
  close(ref?: string, opts: { all?: boolean; except?: string[] } = {}): Panel[] {
    let targets: Panel[];
    if (opts.all) {
      const keep = new Set((opts.except ?? []).map((r) => this.find(r)?.id).filter((id): id is string => !!id));
      targets = this.list().filter((p) => !keep.has(p.id));
    } else {
      if (!ref) throw new DashboardError("dis quel encart fermer (produit ou identifiant), ou all pour tout fermer");
      targets = [this.findOrThrow(ref)];
    }
    if (!targets.length) return [];
    const del = this.db.db.prepare("DELETE FROM panels WHERE id = ?");
    this.db.tx(() => {
      for (const p of targets) del.run(p.id);
    });
    this.changed();
    return targets;
  }

  /**
   * Un encart à montrer autrement, à la voix : un graphique agrandi, rendu à sa
   * taille et à sa place d'avant, ou un encart ramené dans sa marge. Chaque
   * écran l'applique (la taille et la place restent des choix de l'écran, que
   * le serveur ne garde pas). Sans encart, restore : tous les graphiques agrandis.
   */
  display(ref: string | undefined, display: PanelDisplay): Panel | undefined {
    if (!ref) {
      if (display !== "restore") throw new DashboardError("dis quel encart (produit ou identifiant)");
      this.emit("display", { display });
      return undefined;
    }
    const panel = this.findOrThrow(ref);
    if (display === "maximize" && panel.kind !== "chart") throw new DashboardError(`seul un graphique s'agrandit : ${panel.title} n'en est pas un`);
    this.emit("display", { panelId: panel.id, display });
    return panel;
  }

  /**
   * L'encart désigné à la voix : par son identifiant, par « setups » (ou
   * opportunités, dossiers, même « liste des setups »), par « activité » (ou
   * agents, tâches, travaux), par « produits » (la liste de tous ses
   * produits), par « suivi » (ou liste, tableau), par le titre d'une vue, sinon par le produit d'un
   * graphique (« l'or », « EURUSD », « Nasdaq »), avec les mêmes règles que les
   * outils de cours.
   */
  find(ref: string): Panel | undefined {
    const panels = this.list();
    const q = normalize(ref);
    if (!q) return undefined;
    const byId = panels.find((p) => p.id === ref.trim());
    if (byId) return byId;
    const view = panels.find((p) => p.kind === "view" && (normalize(p.title) === q || `VUE${normalize(p.title)}` === q));
    if (view) return view;
    if (/SETUP|OPPORTUNIT|DOSSIER|SCENARIO/.test(q)) return panels.find((p) => p.kind === "setups");
    if (/ACTIVITE|AGENT|TACHE|TRAVAU/.test(q)) return panels.find((p) => p.kind === "activity");
    if (/JOURNAL/.test(q)) return panels.find((p) => p.kind === "journal");
    if (/ROBOT|STRATEG|LABO/.test(q)) return panels.find((p) => p.kind === "robots");
    if (/^(NEWS|ACTU|INFO|DEPECHE|FIL)/.test(q)) return panels.find((p) => p.kind === "news");
    // « Mes produits », « la liste des produits » : avant « liste », qui désigne le suivi.
    if (/PRODUIT/.test(q)) return panels.find((p) => p.kind === "products");
    if (/^(SUIVI|LISTE|TABLEAU|WATCHLIST)/.test(q)) return panels.find((p) => p.kind === "quotes");
    const charts = panels.filter((p) => p.kind === "chart");
    const bySymbol = resolveSymbol(
      ref,
      charts.map((p) => p.symbol!),
    );
    if ("symbol" in bySymbol) return charts.find((p) => p.symbol === bySymbol.symbol);
    return charts.find((p) => normalize(p.name ?? "") === q || normalize(p.title) === q);
  }

  /** Note ajoutée devant la phrase de l'utilisateur : ce qui est à l'écran, avec les identifiants. Vide sans encart. */
  describe(): string {
    const panels = this.list();
    if (!panels.length) return "";
    const drawings = this.drawings.list(this.chartSymbols());
    const alerts = this.alerts.list(this.chartSymbols());
    const parts = panels.map((p) => {
      if (p.kind === "setups") return `${p.id} : liste des setups repérés (en attente et déclenchés, mise à jour d'elle-même)`;
      if (p.kind === "view") return `${p.id} : vue « ${p.title} » (${p.view ? viewSummary(p.view) : ""})`;
      if (p.kind === "activity") return `${p.id} : activité (agents et tâches récents, mise à jour d'elle-même)`;
      if (p.kind === "robots") return `${p.id} : robots (les stratégies du laboratoire et leurs chiffres, mise à jour d'elle-même)`;
      if (p.kind === "journal")
        return `${p.id} : journal de trading (ses trades rangés par fiche, mis à jour de lui-même ; un clic sur un trade ouvre sa page)`;
      if (p.kind === "news") return `${p.id} : news en temps réel${p.name ? ` sur ${p.name}` : ""} (traduites, mises à jour d'elles-mêmes)`;
      // Sans les noms : ce sont tous ses produits, et la note précède chaque phrase.
      if (p.kind === "products")
        return `${p.id} : liste de ses ${p.symbols?.length ?? 0} produits (prix et variation du jour ; un clic sur une ligne ouvre le graphique)`;
      if (p.kind !== "chart") return `${p.id} : suivi de ${(p.symbols ?? []).map((s) => s.name).join(", ")}`;
      const indicators = (p.indicators ?? []).map((i) => `${i.id} ${indicatorLabel(i)}${i.hidden ? " (masqué)" : ""}`);
      // Sans les niveaux d'un Fibonacci : la note précède chaque phrase, chart_drawings les donne.
      const drawn = drawings.filter((d) => d.symbol === p.symbol).map((d) => `${d.id} ${describeDrawing(d, p.digits, { levels: false })}`);
      const watched = alerts.filter((a) => a.symbol === p.symbol).map((a) => `${a.id} ${describeAlert(a, lineOf(a, drawings))}`);
      return [
        `${p.id} : graphique ${p.title} (${p.symbol}) en ${TIMEFRAME_LABELS[p.timeframe as ChartTimeframe] ?? p.timeframe}`,
        indicators.length ? `, avec ${indicators.join(", ")}` : "",
        drawn.length ? `, tracés : ${drawn.join(", ")}` : "",
        watched.length ? `, alertes : ${watched.join(", ")}` : "",
      ].join("");
    });
    return `[Encarts à l'écran : ${parts.join(" ; ")}.]`;
  }

  /**
   * Le produit d'un tracé : celui d'un graphique affiché (son identifiant, son
   * produit), sinon un produit du courtier (le tracé l'attendra).
   */
  async drawingProduct(ref: string): Promise<Product> {
    const panel = this.find(ref);
    if (panel?.kind === "chart")
      return { symbol: panel.symbol!, name: panel.name ?? panel.title, ...(panel.digits !== undefined ? { digits: panel.digits } : {}) };
    if (panel) throw new DashboardError(`l'encart ${panel.title} n'a pas de tracés : désigne un graphique ou un produit`);
    return this.product(ref);
  }

  private findOrThrow(ref: string): Panel {
    const panel = this.find(ref);
    if (panel) return panel;
    const shown = this.list().map((p) => `${p.title} (${p.id})`);
    throw new DashboardError(`aucun encart « ${ref} » à l'écran${shown.length ? ` ; affichés : ${shown.join(", ")}` : ""}`);
  }

  private ensureRoom() {
    if (this.rows().length >= MAX_PANELS) throw new DashboardError(`${MAX_PANELS} encarts au plus : ferme-en un d'abord`);
  }

  private insert(kind: PanelRow["kind"], title: string, spec: ChartSpec | QuotesSpec | EmptySpec | NewsSpec | ViewSpec): PanelRow {
    const now = Date.now();
    const { max } = this.db.db.prepare("SELECT COALESCE(MAX(position), 0) AS max FROM panels").get() as { max: number };
    const row: PanelRow = {
      id: `p_${randomBytes(3).toString("hex")}`,
      kind,
      title,
      spec: JSON.stringify(spec),
      position: max + 1,
      created_at: now,
      updated_at: now,
    };
    this.db.db
      .prepare("INSERT INTO panels (id, kind, title, spec, position, created_at, updated_at) VALUES (@id,@kind,@title,@spec,@position,@created_at,@updated_at)")
      .run(row);
    this.changed();
    return row;
  }

  private writeSpec(id: string, spec: ChartSpec | QuotesSpec | NewsSpec | ViewSpec, title?: string) {
    this.db.db
      .prepare("UPDATE panels SET spec = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?")
      .run(JSON.stringify(spec), title ?? null, Date.now(), id);
    this.changed();
  }

  private async product(query: string): Promise<Product> {
    const r = await this.market.resolve(query);
    if ("error" in r) throw new DashboardError(r.suggestions?.length ? `${r.error} ; symboles proches : ${r.suggestions.join(", ")}` : r.error);
    return r;
  }

  /** Plusieurs produits d'un coup : ceux trouvés, et une erreur par introuvable. */
  private async products(queries: string[], limit = MAX_QUOTES): Promise<{ products: Product[]; errors: string[] }> {
    const wanted = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, limit);
    const results = await Promise.all(wanted.map((q) => this.market.resolve(q)));
    const products: Product[] = [];
    const errors: string[] = [];
    results.forEach((r) => ("error" in r ? errors.push(r.error) : products.push(r)));
    return { products, errors };
  }

  /**
   * Les encarts gardés, dans l'ordre. Une ligne illisible (spec abîmée) ne peut
   * être ni affichée ni réparée : elle est retirée, sinon chaque connexion
   * d'écran (qui relit la liste) échouerait.
   */
  private rows(): PanelRow[] {
    const rows = this.db.db.prepare("SELECT * FROM panels ORDER BY position").all() as PanelRow[];
    const bad = rows.filter((r) => !validSpec(r));
    for (const r of bad) {
      this.db.db.prepare("DELETE FROM panels WHERE id = ?").run(r.id);
      this.logger.warn(`encart ${r.id} (« ${r.title} ») illisible en base : retiré`, "dashboard");
    }
    const good = bad.length ? rows.filter((r) => !bad.includes(r)) : rows;
    for (const r of good) this.upgrade(r);
    return good;
  }

  /**
   * Indicateurs gardés avant leurs réglages (`{kind: "sma", period}`) :
   * complétés et réécrits une fois, pour que leur identifiant ne change plus.
   */
  private upgrade(r: PanelRow) {
    const spec = parseSpec(r);
    if (!("timeframe" in spec) || !spec.indicators?.length) return;
    if (spec.indicators.every((i) => indicatorSchema.safeParse(i).success)) return;
    const indicators = spec.indicators.map((i) => upgradeIndicator(i, newIndicatorId)).filter((i): i is Indicator => i !== undefined);
    r.spec = JSON.stringify({ ...spec, ...withIndicators(indicators), ...(indicators.length ? {} : { indicators: undefined }) });
    this.db.db.prepare("UPDATE panels SET spec = ? WHERE id = ?").run(r.spec, r.id);
  }

  /** Tous les symboles affichés (graphiques, suivi, produits des setups ouverts si leur liste est là), sans doublon. */
  private symbols(): string[] {
    const all: string[] = [];
    for (const r of this.rows()) {
      if (r.kind === "setups") {
        all.push(...this.setupSymbols());
        continue;
      }
      if (r.kind === "view") {
        all.push(...viewSymbols(JSON.parse(r.spec) as ViewSpec));
        continue;
      }
      if (r.kind === "journal") {
        all.push(...this.tradeSymbols);
        continue;
      }
      if (r.kind === "activity" || r.kind === "news" || r.kind === "robots") continue;
      const spec = parseSpec(r);
      if ("timeframe" in spec) all.push(spec.symbol);
      else all.push(...spec.symbols.map((s) => s.symbol));
    }
    return [...new Set(all)];
  }

  /**
   * Les produits des trades en cours (ordres en attente, positions ouvertes),
   * donnés par la prise de position : l'encart Journal les montre en direct,
   * leurs cotations le suivent tant qu'il est là.
   */
  followTrades(symbols: string[]): void {
    const next = [...new Set(symbols)].sort();
    if (next.join(",") === this.tradeSymbols.join(",")) return;
    this.tradeSymbols = next;
    if (this.rows().some((r) => r.kind === "journal")) this.market.feed.setSymbols(this.symbols());
  }

  /** Les produits des setups ouverts, triés. */
  private setupSymbols(): string[] {
    return [...new Set((this.scenarios?.list() ?? []).map((s) => s.symbol))].sort();
  }

  /** Les produits des graphiques affichés (ceux dont les tracés sont à l'écran). */
  private chartSymbols(): string[] {
    return [...new Set(this.list().flatMap((p) => (p.kind === "chart" && p.symbol ? [p.symbol] : [])))];
  }

  private changed() {
    this.market.feed.setSymbols(this.symbols());
    this.emit("updated", this.view());
  }
}

/** La ligne que suit une alerte, parmi ces tracés. */
function lineOf(a: Alert, drawings: Drawing[]): Drawing | undefined {
  const t = a.target;
  return t.kind === "drawing" ? drawings.find((d) => d.id === t.drawingId) : undefined;
}

/** « euro-dollar » -> « Euro-dollar » : le titre d'un encart. */
function titleOf(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function timeframeOf(v?: string): ChartTimeframe | undefined {
  if (v === undefined || v === "") return undefined;
  if (!isChartTimeframe(v)) throw new DashboardError(`unité de temps inconnue (« ${v} ») : ${CHART_TIMEFRAMES.join(", ")}`);
  return v;
}

/** La spec d'une ligne a la forme attendue pour son genre d'encart. */
function validSpec(r: PanelRow): boolean {
  try {
    const s = JSON.parse(r.spec) as Partial<ChartSpec & QuotesSpec> | null;
    if (r.kind === "chart") return typeof s?.symbol === "string" && typeof s.timeframe === "string";
    if (r.kind === "quotes" || r.kind === "products") return Array.isArray(s?.symbols) && s.symbols.every((p) => typeof p?.symbol === "string");
    if (r.kind === "view") return viewSpecSchema.safeParse(s).success;
    return (
      (r.kind === "setups" || r.kind === "activity" || r.kind === "news" || r.kind === "journal" || r.kind === "robots") && typeof s === "object" && s !== null
    );
  } catch {
    return false;
  }
}

function parseSpec(r: PanelRow): ChartSpec | QuotesSpec {
  return JSON.parse(r.spec) as ChartSpec | QuotesSpec;
}

function toPanel(r: PanelRow): Panel {
  const base = { id: r.id, kind: r.kind, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
  if (r.kind === "setups" || r.kind === "activity" || r.kind === "journal" || r.kind === "robots") return base;
  if (r.kind === "news") {
    const n = JSON.parse(r.spec) as NewsSpec;
    return { ...base, ...(n.symbol ? { symbol: n.symbol } : {}), ...(n.name ? { name: n.name } : {}) };
  }
  if (r.kind === "view") return { ...base, view: JSON.parse(r.spec) as ViewSpec };
  const spec = parseSpec(r);
  if ("timeframe" in spec) {
    return {
      ...base,
      symbol: spec.symbol,
      name: spec.name,
      ...(spec.digits !== undefined ? { digits: spec.digits } : {}),
      timeframe: spec.timeframe,
      ...withIndicators(spec.indicators),
    };
  }
  return { ...base, symbols: spec.symbols };
}

/** Un indicateur à retirer : par son identifiant, ou par son genre (`ma`, `rsi`, `sma`…) et sa longueur. */
export interface IndicatorRemoval {
  id?: string;
  kind?: string;
  type?: string;
  period?: number;
}

/** « i_3f2a » : l'identifiant d'un nouvel indicateur. */
function newIndicatorId(): string {
  return `i_${randomBytes(2).toString("hex")}`;
}

/**
 * Les indicateurs après un réglage (undefined : pas de changement demandé).
 * La liste entière remplace (l'écran) ; sinon, réglages, ajouts (réglages
 * d'usage pour ce qui manque), puis retraits. Sans doublon de calcul, plafonnés :
 * au-delà, une erreur lisible.
 */
function nextIndicators(
  current: Indicator[],
  patch: { indicators?: unknown[]; addIndicators?: unknown[]; editIndicators?: unknown[]; removeIndicators?: IndicatorRemoval[] },
): Indicator[] | undefined {
  if (!patch.indicators && !patch.addIndicators?.length && !patch.editIndicators?.length && !patch.removeIndicators?.length) return undefined;
  let next: Indicator[];
  if (patch.indicators) next = patch.indicators.map((raw) => fullIndicator(raw));
  else {
    next = [...current];
    for (const raw of patch.editIndicators ?? []) {
      const id = (raw as { id?: unknown })?.id;
      const k = next.findIndex((i) => i.id === id);
      if (k < 0) throw new DashboardError(`aucun indicateur « ${String(id ?? "")} » sur ce graphique`);
      const { id: _id, ...changes } = raw as Record<string, unknown>;
      next[k] = fullIndicator({ ...toInput(next[k]), ...changes }, next[k].id);
    }
    next.push(...(patch.addIndicators ?? []).map((raw) => fullIndicator(raw)));
    for (const r of patch.removeIndicators ?? []) next = next.filter((i) => !removes(r, i));
  }
  next = next.filter((i, k) => next.findIndex((j) => sameIndicator(i, j)) === k);
  if (next.length > MAX_INDICATORS) throw new DashboardError(`${MAX_INDICATORS} indicateurs au plus sur un graphique : retire-en d'abord`);
  return next;
}

/** Un indicateur complet : tel quel s'il l'est, sinon complété (réglages d'usage), avec son identifiant ou un nouveau. */
function fullIndicator(raw: unknown, id?: string): Indicator {
  const ready = indicatorSchema.safeParse(raw);
  if (ready.success && (!id || ready.data.id === id)) return ready.data;
  const input = indicatorInputSchema.safeParse(raw);
  if (!input.success) {
    throw new DashboardError(`indicateur illisible (${JSON.stringify(raw)}) : genre ma (moyenne : type ${MA_TYPES.join(", ")}) ou rsi`);
  }
  try {
    return completeIndicator(input.data, id ?? ((raw as { id?: string }).id || newIndicatorId()));
  } catch (e) {
    throw new DashboardError((e as Error).message);
  }
}

/** Les réglages d'un indicateur, tels qu'on les demande (pour en changer une partie). */
function toInput(i: Indicator): IndicatorInput {
  const { id: _id, ...rest } = i;
  return rest;
}

function removes(r: IndicatorRemoval, i: Indicator): boolean {
  if (r.id) return i.id === r.id;
  const type = r.type ?? (MA_TYPES.includes(r.kind as (typeof MA_TYPES)[number]) ? r.kind : undefined);
  const kind = type ? "ma" : r.kind;
  if (!kind || i.kind !== kind) return false;
  if (type && i.kind === "ma" && i.type !== type) return false;
  return r.period === undefined || i.period === r.period;
}

/** `indicators` seulement s'il y en a : un graphique sans indicateur garde sa forme d'avant. */
function withIndicators(list?: Indicator[]): { indicators?: Indicator[] } {
  return list?.length ? { indicators: list } : {};
}

/** Produits d'un suivi, sans doublon, dans l'ordre d'arrivée, plafonnés. */
function mergeProducts(current: Product[], added: Product[]): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of [...current, ...added]) {
    if (seen.has(p.symbol)) continue;
    seen.add(p.symbol);
    out.push(p);
  }
  return out.slice(0, MAX_QUOTES);
}
