import { Injectable } from "@nestjs/common";
import { Resvg } from "@resvg/resvg-js";
import { DashboardService } from "../dashboard/dashboard.service.js";
import { MarketService } from "../market/market.service.js";
import { ChartTimeframe, isChartTimeframe } from "../market/timeframes.js";
import type { AlertFired } from "../alerts/alert.service.js";
import { CHART_BARS, CHART_WIDTH, chartSvg } from "./chart-svg.js";

/** Bougies chargées : celles montrées, et de quoi amorcer une moyenne 200. */
const CANDLES = CHART_BARS + 200;

/** Le produit d'une image : son symbole exact, son nom courant, ses décimales. */
export interface ChartProduct {
  symbol: string;
  name: string;
  digits?: number;
}

/**
 * L'image du graphique d'un produit, dessinée par le serveur (l'écran peut
 * être fermé) : les bougies du courtier dans l'unité de temps voulue, les
 * tracés et les alertes du produit, et les indicateurs de son encart (ceux
 * gardés pour le produit si son encart est fermé). En PNG, deux fois la taille logique (net sur un téléphone).
 */
@Injectable()
export class ChartImageService {
  constructor(
    private readonly market: MarketService,
    private readonly dashboard: DashboardService,
  ) {}

  /** L'unité de temps par défaut d'un produit : celle de son graphique affiché, sinon 15 minutes. */
  timeframeOf(symbol: string): ChartTimeframe {
    const tf = this.dashboard.list().find((p) => p.kind === "chart" && p.symbol === symbol)?.timeframe;
    return isChartTimeframe(tf) ? tf : "15m";
  }

  async render(product: ChartProduct, timeframe: ChartTimeframe, opts: { fired?: AlertFired; now?: number } = {}): Promise<Buffer | { error: string }> {
    const r = await this.market.chartCandles(product.symbol, timeframe, { limit: CANDLES });
    if ("error" in r) return { error: r.error ?? "bougies indisponibles" };
    const panel = this.dashboard.list().find((p) => p.kind === "chart" && p.symbol === product.symbol);
    const alerts = this.dashboard.alerts.list([product.symbol]).filter((a) => a.state === "active" || a.state === "paused");
    const svg = chartSvg({
      ...product,
      timeframe,
      candles: r.candles,
      drawings: this.dashboard.drawings.list([product.symbol]),
      alerts,
      // Son encart fermé : les indicateurs qu'il retrouverait à sa réouverture.
      indicators: panel?.indicators ?? this.dashboard.indicatorsFor(product.symbol),
      ...(opts.fired ? { fired: { level: opts.fired.level, price: opts.fired.price, at: opts.fired.at } } : {}),
      now: opts.now ?? opts.fired?.at,
    });
    return rasterize(svg);
  }

  /** Le graphique d'une alerte qui vient de partir : son produit, dans l'unité de temps de l'alerte. */
  async alertImage(f: AlertFired): Promise<Buffer | { error: string }> {
    const a = f.alert;
    const tf = isChartTimeframe(a.timeframe) ? a.timeframe : this.timeframeOf(a.symbol);
    return this.render({ symbol: a.symbol, name: a.name, ...(a.digits !== undefined ? { digits: a.digits } : {}) }, tf, { fired: f });
  }
}

/** Un SVG en PNG, deux fois plus grand, avec les polices du Mac. */
export function rasterize(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CHART_WIDTH * 2 },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
  });
  return resvg.render().asPng();
}
