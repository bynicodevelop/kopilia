import { signal } from "@angular/core";
import type { Alert, Drawing, DrawingShape, Indicator, PanelDisplay } from "@kopilia/contracts";
import type { ScreenApi } from "../api";
import type { CandleView, FiredAlertView, PanelView, QuoteView } from "./views";
import { notifyHidden, ring } from "./alert-signals";

/** Une alerte partie reste signalée ce temps-là (ou jusqu'à ce qu'on la ferme). */
const FIRED_MS = 120_000;

/** Ce qu'on donne pour poser une alerte, ou en changer. */
export interface AlertRequest {
  target?: Alert["target"];
  price?: number;
  condition?: string;
  trigger?: string;
  message?: string | null;
  state?: "active" | "paused";
}

/**
 * Le tableau de bord vu de l'écran : les encarts, les tracés et les alertes
 * (le serveur les garde), les cotations, les alertes qui viennent de partir,
 * les commandes à la main.
 */
export class DashboardStore {
  /** Les encarts, dans l'ordre. */
  readonly panels = signal<PanelView[]>([]);
  /** Vrai dès que le serveur a dit quels encarts existent (avant, la liste vide ne veut rien dire). */
  readonly panelsKnown = signal(false);
  /** Dernière cotation de chaque produit affiché. */
  readonly quotes = signal<Record<string, QuoteView>>({});
  /** Les tracés des produits affichés en graphique. */
  readonly drawings = signal<Drawing[]>([]);
  /** Les alertes des produits affichés en graphique. */
  readonly alerts = signal<Alert[]>([]);
  /** Les alertes qui viennent de partir, la plus récente d'abord (trois au plus). */
  readonly fired = signal<FiredAlertView[]>([]);
  /** La dernière alerte de l'IA partie : sa ligne clignote, sans bandeau ni son (l'agent décidera s'il faut prévenir). */
  readonly aiFired = signal<{ key: string; alertId: string; symbol: string } | null>(null);
  /** Un affichage demandé à la voix (agrandir, réduire, ramener dans sa marge), que le tableau de bord applique puis efface. */
  readonly display = signal<{ panelId?: string; display: PanelDisplay } | null>(null);
  /** Un encart à faire passer devant et à signaler d'un éclair (un clic dans la liste des produits sur un produit déjà affiché). */
  readonly focus = signal<{ panelId: string; at: number } | null>(null);

  constructor(
    private readonly api: ScreenApi,
    private readonly report: (message: string) => void,
  ) {}

  updated(panels: PanelView[], drawings: Drawing[] | undefined, alerts: Alert[] | undefined): void {
    this.panels.set(panels);
    // Un serveur pas encore redémarré n'envoie ni tracés ni alertes : la page reste utilisable.
    this.drawings.set(drawings ?? []);
    this.alerts.set(alerts ?? []);
    this.panelsKnown.set(true);
  }

  /** Agrandir, réduire, ramener dans sa marge, à la voix : comme le bouton, Échap ou le double-clic. */
  displayed(panelId: string | undefined, display: PanelDisplay): void {
    this.display.set({ ...(panelId ? { panelId } : {}), display });
  }

  /** Une alerte part : bandeau, deux notes, et une notification si la page est cachée ; `quiet` : le bandeau seul. */
  triggered(f: FiredAlertView, quiet = false): void {
    this.fired.update((all) => [f, ...all.filter((x) => x.key !== f.key)].slice(0, 3));
    setTimeout(() => this.dismiss(f.key), FIRED_MS);
    if (quiet) return;
    ring();
    notifyHidden(f.title, f.detail, f.alertId);
  }

  /** Une alerte de l'IA est partie : seulement le clignotement de sa ligne. */
  aiTriggered(f: { key: string; alertId: string; symbol: string }): void {
    this.aiFired.set(f);
  }

  dismiss(key: string): void {
    this.fired.update((all) => all.filter((x) => x.key !== key));
  }

  quote(q: QuoteView): void {
    this.quotes.update((all) => ({
      ...all,
      [q.symbol]: { symbol: q.symbol, bid: q.bid, ask: q.ask, time: q.time, digits: q.digits, dayOpen: q.dayOpen },
    }));
  }

  /** Bougies d'un graphique ; `before` (epoch s) pour remonter le temps. */
  loadCandles(symbol: string, timeframe: string, before?: number, limit?: number): Promise<{ candles: CandleView[]; more: boolean }> {
    const q = new URLSearchParams({ symbol, timeframe });
    if (before) q.set("before", String(before));
    if (limit) q.set("limit", String(limit));
    return this.api.json(`/api/dashboard/candles?${q}`);
  }

  async closePanel(id: string): Promise<void> {
    await this.action(`/panels/${encodeURIComponent(id)}/close`, "POST");
  }

  /** Le graphique d'un produit, dans cette unité de temps (déjà affiché, il en change). */
  openChart(symbol: string, timeframe: string): Promise<boolean> {
    return this.action("/charts", "POST", { symbol, timeframe });
  }

  /** Le graphique d'un produit, ouvert depuis la liste des produits (unité de temps par défaut du serveur) : l'encart, ou null. */
  async openChartPanel(symbol: string): Promise<PanelView | null> {
    try {
      return await this.api.json<PanelView>("/api/dashboard/charts", "POST", { symbol });
    } catch (e) {
      this.report((e as Error).message);
      return null;
    }
  }

  /** Un graphique affiché change de produit (il garde sa place, sa taille et son unité de temps). */
  switchChart(id: string, symbol: string): Promise<boolean> {
    return this.action(`/panels/${encodeURIComponent(id)}`, "POST", { symbol });
  }

  /** Fait passer un encart devant, avec un éclair. */
  focusPanel(panelId: string): void {
    this.focus.set({ panelId, at: Date.now() });
  }

  /** La liste des setups repérés, dans un encart (déjà affichée, rien ne change). */
  openSetups(): Promise<boolean> {
    return this.action("/setups", "POST");
  }

  async closeAll(): Promise<void> {
    await this.action("/close-all", "POST");
  }

  setTimeframe(id: string, timeframe: string): Promise<boolean> {
    return this.action(`/panels/${encodeURIComponent(id)}`, "POST", { timeframe });
  }

  /** La liste entière des indicateurs d'un graphique. */
  setIndicators(id: string, indicators: Indicator[]): Promise<boolean> {
    return this.action(`/panels/${encodeURIComponent(id)}`, "POST", { indicators });
  }

  /** Un tracé posé à la souris sur le produit d'un graphique ; le serveur le renvoie à tous les écrans. */
  draw(symbol: string, shape: DrawingShape): Promise<boolean> {
    return this.action("/drawings", "POST", { symbol, shape });
  }

  editDrawing(id: string, shape: DrawingShape): Promise<boolean> {
    return this.action(`/drawings/${encodeURIComponent(id)}`, "POST", { shape });
  }

  eraseDrawing(id: string): Promise<boolean> {
    return this.action(`/drawings/${encodeURIComponent(id)}/delete`, "POST");
  }

  /** Une alerte sur le produit d'un graphique : à un prix, ou sur une de ses lignes ; dans l'unité du graphique. */
  createAlert(symbol: string, timeframe: string, r: AlertRequest): Promise<boolean> {
    return this.action("/alerts", "POST", { symbol, timeframe, target: r.target, condition: r.condition, trigger: r.trigger, message: r.message || undefined });
  }

  /** Règle, déplace (prix), suspend ou réactive une alerte ; `message` null ou vide retire la consigne. */
  updateAlert(id: string, r: AlertRequest): Promise<boolean> {
    return this.action(`/alerts/${encodeURIComponent(id)}`, "POST", r);
  }

  deleteAlert(id: string): Promise<boolean> {
    return this.action(`/alerts/${encodeURIComponent(id)}/delete`, "POST");
  }

  /** Vrai si le serveur a accepté ; sinon l'erreur est signalée. */
  private async action(path: string, method: string, body?: unknown): Promise<boolean> {
    try {
      await this.api.json(`/api/dashboard${path}`, method, body);
      return true;
    } catch (e) {
      this.report((e as Error).message);
      return false;
    }
  }
}
