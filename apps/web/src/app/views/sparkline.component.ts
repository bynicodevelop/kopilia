import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from "@angular/core";
import type { ViewProduct } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { formatPrice } from "../dashboard/candles";
import { periodChange, sparkPoints } from "./views";

/** Les bougies d'une courbe sont relues à ce rythme ; le dernier point suit la cotation en direct. */
const REFRESH_MS = 60_000;
const W = 240;
const H = 44;

/** Bloc « courbe » d'une vue : les clôtures d'un produit sur ses dernières bougies ; un clic ouvre son graphique. */
@Component({
  selector: "kp-sparkline",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      button { width: 100%; display: block; border: none; background: none; color: var(--text); padding: 2px 0; text-align: left; border-radius: 6px; }
      button:hover { background: var(--panel-2); }
      .line { display: flex; align-items: baseline; gap: 6px; font-size: 14px; white-space: nowrap; }
      .name { font-weight: 600; }
      .tf { font-size: 12px; color: var(--muted); }
      .spacer { flex: 1; }
      .px { font-variant-numeric: tabular-nums; }
      .delta { font-size: 12px; }
      svg { display: block; width: 100%; height: 44px; margin-top: 2px; }
      polyline { fill: none; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .up { stroke: var(--accent-2); }
      .down { stroke: var(--danger); }
      .flat { stroke: var(--muted); }
      .muted { color: var(--muted); font-size: 12px; }
    `,
  ],
  template: `
    <button type="button" [attr.title]="'Ouvrir le graphique ' + product().name + ' ' + timeframe()" (click)="kopilia.openChart(product().symbol, timeframe())">
      <span class="line">
        <span class="name">{{ title() }}</span>
        <span class="tf">{{ timeframe() }} · {{ closes().length }} bougies</span>
        <span class="spacer"></span>
        @if (last(); as l) { <span class="px">{{ l }}</span> }
        @if (change(); as c) {
          <span class="delta" [class.trend-up]="c.sign > 0" [class.trend-down]="c.sign < 0" [class.trend-flat]="c.sign === 0">{{ c.text }}</span>
        }
      </span>
      @if (points()) {
        <svg [attr.viewBox]="'0 0 ' + w + ' ' + h" preserveAspectRatio="none" aria-hidden="true">
          <polyline [attr.points]="points()" [class.up]="(change()?.sign ?? 0) > 0" [class.down]="(change()?.sign ?? 0) < 0" [class.flat]="!change()?.sign" />
        </svg>
      } @else {
        <span class="muted">{{ failed() ? 'Bougies indisponibles' : 'Chargement…' }}</span>
      }
    </button>
  `,
})
export class SparklineComponent {
  readonly product = input.required<ViewProduct>();
  readonly timeframe = input.required<string>();
  readonly bars = input.required<number>();
  readonly kopilia = inject(KopiliaService);
  readonly w = W;
  readonly h = H;
  /** Les clôtures relues, sans la dernière cotation. */
  private readonly loaded = signal<number[]>([]);
  readonly failed = signal(false);

  /** Les clôtures, la dernière remplacée par la cotation du moment. */
  readonly closes = computed(() => {
    const all = this.loaded();
    const q = this.kopilia.quotes()[this.product().symbol];
    return q && all.length ? [...all.slice(0, -1), q.bid] : all;
  });
  readonly points = computed(() => sparkPoints(this.closes(), W, H));
  readonly change = computed(() => {
    const c = this.closes();
    return c.length > 1 ? periodChange(c[0], c[c.length - 1]) : undefined;
  });
  readonly last = computed(() => {
    const c = this.closes();
    return c.length ? formatPrice(c[c.length - 1], this.product().digits) : undefined;
  });
  readonly title = computed(() => {
    const n = this.product().name;
    return n.charAt(0).toUpperCase() + n.slice(1);
  });

  constructor() {
    let timer: ReturnType<typeof setInterval> | undefined;
    effect(() => {
      const symbol = this.product().symbol;
      const tf = this.timeframe();
      const bars = this.bars();
      clearInterval(timer);
      const load = () =>
        this.kopilia.loadCandles(symbol, tf, undefined, bars).then(
          (r) => {
            this.failed.set(false);
            this.loaded.set(r.candles.map((c) => c.c));
          },
          () => this.failed.set(true),
        );
      void load();
      timer = setInterval(() => void load(), REFRESH_MS);
    });
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
