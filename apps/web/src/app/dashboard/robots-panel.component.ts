import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { ROBOT_STATUS_NAMES, type BacktestMetrics, type RobotSummary } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";

/** « 15m » → « 15 min », « 1h » → « 1 h », « 1d » → « jour ». */
const TF: Record<string, string> = { "1m": "1 min", "5m": "5 min", "15m": "15 min", "30m": "30 min", "1h": "1 h", "4h": "4 h", "1d": "jour", "1w": "semaine" };

function r(v: number, digits = 2): string {
  const s = Math.abs(v).toFixed(digits).replace(".", ",");
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s} R`;
}

/**
 * Les robots du laboratoire de stratégies, comme une liste de surveillance :
 * une ligne par robot, son nom, son statut, ses chiffres en R du meilleur
 * backtest (trades, gagnants, R moyen, R total). Pas de bouton : on parle à
 * Kopilia (« qu'a donné le robot… ») ; un clic ouvre le graphique de son
 * produit dans son unité de temps. Le contenu vient de robots.updated.
 */
@Component({
  selector: "kp-robots-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
      .list { flex: 1 1 auto; min-height: 0; margin: 2px 0 4px; overflow-y: auto; overscroll-behavior: contain; }
      @media (max-width: 1239px) {
        .list { max-height: 50vh; }
      }
      ul { list-style: none; margin: 0; padding: 0; }
      li { border-top: 1px solid var(--border); }
      li:first-child { border-top: none; }
      .row {
        width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 6px 0; text-align: left;
        border: none; border-radius: 0; background: none; color: var(--text); font-size: 14px; cursor: pointer;
      }
      .row:hover .name { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .total { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
      .sub { grid-column: 1 / -1; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .pill { font-size: 11px; padding: 0 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
      .pill.promising { color: var(--ai); }
      .pill.fragile { color: var(--warn); }
      .pill.testing { color: var(--accent); }
      .up { color: var(--accent-2); }
      .down { color: var(--danger); }
      .muted { color: var(--muted); }
      .empty { padding: 10px 0 6px; color: var(--muted); font-size: 13px; }
      .pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
    `,
  ],
  template: `
    <div class="list">
      @if (!robots().length) {
        <p class="empty">Aucun robot. Dis « développe une stratégie de… » avec ton idée : Kopilia l'écrit, la backteste et te rend compte.</p>
      } @else {
        <ul>
          @for (rb of robots(); track rb.id) {
            <li>
              <button type="button" class="row" [attr.title]="tip(rb)" [attr.aria-label]="tip(rb)" (click)="open(rb)">
                <span class="name">{{ rb.name }}</span>
                @if (rb.best; as b) {
                  <span class="total" [class.up]="b.inSample.totalR > 0" [class.down]="b.inSample.totalR < 0">{{ total(b.inSample) }}</span>
                } @else {
                  <span class="total muted">—</span>
                }
                <span class="sub">
                  <span class="pill" [class]="'pill ' + rb.status">{{ status(rb) }}</span>
                  @if (rb.jobId) {
                    <span class="pulse" title="recherche en cours"></span>
                  }
                  <span>{{ where(rb) }}</span>
                  @if (rb.best; as b) {
                    <span>{{ stats(b.inSample) }}</span>
                    @if (b.outOfSample?.trades) {
                      <span>vérif. {{ avg(b.outOfSample!) }}</span>
                    }
                  } @else if (rb.trials) {
                    <span>{{ rb.trials }} essai{{ rb.trials > 1 ? 's' : '' }}</span>
                  }
                </span>
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class RobotsPanelComponent {
  readonly kopilia = inject(KopiliaService);
  readonly robots = computed(() => this.kopilia.robots());
  private busy = false;

  status(rb: RobotSummary): string {
    return ROBOT_STATUS_NAMES[rb.status];
  }

  where(rb: RobotSummary): string {
    const tf = rb.timeframe ? (TF[rb.timeframe] ?? rb.timeframe) : "";
    return `${rb.products.join(", ")}${tf ? ` · ${tf}` : ""}`;
  }

  total(m: BacktestMetrics): string {
    return r(m.totalR, 1);
  }

  avg(m: BacktestMetrics): string {
    return r(m.avgR);
  }

  stats(m: BacktestMetrics): string {
    if (!m.trades) return "aucun trade";
    return `${m.trades} trades · ${Math.round(m.winRate * 100)} % · ${r(m.avgR)}/trade · DD ${r(m.maxDrawdownR, 1)}`;
  }

  tip(rb: RobotSummary): string {
    const best = rb.best ? ` · verdict ${best_(rb)} : ${rb.best.verdictReasons.join(" ; ")}` : "";
    return `${rb.idea}${best} · clic : le graphique de ${rb.products[0] ?? "son produit"}`;
  }

  async open(rb: RobotSummary): Promise<void> {
    if (this.busy || !rb.products.length) return;
    this.busy = true;
    try {
      const panel = await this.kopilia.openChartPanel(rb.products[0]);
      if (panel) this.kopilia.focusPanel(panel.id);
    } finally {
      this.busy = false;
    }
  }
}

function best_(rb: RobotSummary): string {
  return rb.best ? ({ promising: "prometteur", fragile: "fragile", rejected: "rejeté" } as const)[rb.best.verdict] : "";
}
