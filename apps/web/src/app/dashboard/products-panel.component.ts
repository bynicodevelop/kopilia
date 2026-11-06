import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import type { PanelView, ProductView, QuoteView } from "./views";
import { changeSince, formatPrice } from "./candles";
import { displayName, groupProducts, listClick, productLabel } from "./products";

/** Le graphique ouvert depuis la liste, que les clics suivants font changer de produit (gardé sur cet écran). */
const FOLLOW_KEY = "kopilia.productsChart";
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

function readFollow(): string | null {
  try {
    return localStorage.getItem(FOLLOW_KEY);
  } catch {
    return null;
  }
}

function writeFollow(id: string): void {
  try {
    localStorage.setItem(FOLLOW_KEY, id);
  } catch {
    /* stockage indisponible */
  }
}

/**
 * La liste de tous ses produits, comme la liste de surveillance de
 * TradingView : rangés par famille, prix du moment et variation du jour. Un
 * clic sur une ligne montre le graphique du produit : le sien s'il est déjà à
 * l'écran, sinon le graphique ouvert depuis la liste change de produit, sinon
 * un graphique s'ouvre ; ⌘ (Ctrl) en ouvre toujours un nouveau. Un point
 * marque les produits dont le graphique est affiché.
 */
@Component({
  selector: "kp-products-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /* La hauteur vient du cadre (sa marge, la fenêtre ou la pile) : la liste prend le reste et défile. */
      :host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
      .list { flex: 1 1 auto; min-height: 0; margin: 2px 0 4px; overflow-y: auto; overscroll-behavior: contain; }
      /* Écran étroit : les encarts sont dans la colonne, sans marge pour la borner. */
      @media (max-width: 1239px) {
        .list { max-height: 50vh; }
      }
      h3 {
        margin: 10px 0 2px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted);
      }
      h3:first-child { margin-top: 4px; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { border-top: 1px solid var(--border); }
      .row {
        width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 5px 0; text-align: left;
        border: none; border-radius: 0; background: none; color: var(--text); font-size: 14px;
      }
      .row:hover .name { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; align-self: center; background: transparent; }
      .shown .dot { background: var(--accent); opacity: 0.45; }
      .current .dot { opacity: 1; }
      .current .name { color: var(--accent); }
      .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .px { font-variant-numeric: tabular-nums; }
      .delta { font-size: 12px; min-width: 58px; text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: var(--muted); }
    `,
  ],
  template: `
    <div class="list">
      @for (g of groups(); track g.family) {
        @if (groups().length > 1) {
          <h3>{{ g.family }}</h3>
        }
        <ul>
          @for (s of g.products; track s.symbol) {
            <li>
              <button
                type="button"
                class="row"
                [class.shown]="shown().has(s.symbol)"
                [class.current]="s.symbol === current()"
                [attr.title]="tip(s)"
                [attr.aria-label]="tip(s)"
                (click)="open(s, $event)"
              >
                <span class="dot"></span>
                <span class="name">{{ name(s) }}</span>
                @if (quoteOf(s); as q) {
                  <span class="px">{{ price(q, s) }}</span>
                  @if (change(q); as c) {
                    <span class="delta" [class.trend-up]="c.sign > 0" [class.trend-down]="c.sign < 0" [class.trend-flat]="c.sign === 0">{{ c.text }}</span>
                  } @else {
                    <span class="delta muted"></span>
                  }
                } @else {
                  <span class="px muted">—</span>
                  <span class="delta muted"></span>
                }
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class ProductsPanelComponent {
  readonly panel = input.required<PanelView>();
  readonly kopilia = inject(KopiliaService);
  readonly groups = computed(() => groupProducts(this.panel().symbols ?? []));
  private readonly charts = computed(() => this.kopilia.panels().filter((p) => p.kind === "chart"));
  /** Produits dont le graphique est à l'écran. */
  readonly shown = computed(() => new Set(this.charts().map((p) => p.symbol ?? "")));
  private readonly follow = signal<string | null>(readFollow());
  /** Le produit du graphique que la liste fait changer, s'il est encore à l'écran. */
  readonly current = computed(() => this.charts().find((p) => p.id === this.follow())?.symbol ?? null);
  private busy = false;

  name(s: ProductView): string {
    return productLabel(s);
  }

  tip(s: ProductView): string {
    return `${displayName(s.name)} · clic : son graphique · ${MOD_KEY}-clic : dans un graphique à part`;
  }

  quoteOf(s: ProductView): QuoteView | undefined {
    return this.kopilia.quotes()[s.symbol];
  }

  price(q: QuoteView, s: ProductView): string {
    return formatPrice(q.bid, s.digits ?? q.digits);
  }

  change(q: QuoteView) {
    return changeSince(q.dayOpen, q.bid);
  }

  async open(s: ProductView, e: MouseEvent): Promise<void> {
    if (this.busy) return; // un double-clic n'ouvre pas deux graphiques
    this.busy = true;
    try {
      const separate = e.metaKey || e.ctrlKey;
      const click = listClick(s.symbol, this.charts(), this.follow(), separate);
      if (click.action === "front") {
        this.kopilia.focusPanel(click.id);
      } else if (click.action === "switch") {
        if (await this.kopilia.switchChart(click.id, s.symbol)) this.kopilia.focusPanel(click.id);
      } else {
        const panel = await this.kopilia.openChartPanel(s.symbol);
        // Ouvert à part (⌘) : le graphique de la liste reste celui d'avant, s'il y en a un.
        if (panel && (!separate || !this.current())) {
          this.follow.set(panel.id);
          writeFollow(panel.id);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
