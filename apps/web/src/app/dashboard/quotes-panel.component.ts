import { ChangeDetectionStrategy, Component, inject, input } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import type { PanelView, ProductView, QuoteView } from "./views";
import { changeSince, formatPrice } from "./candles";

/** Le suivi : une ligne par produit, prix du moment et variation du jour. */
@Component({
  selector: "kp-quotes-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      /* Un peu d'air sous la dernière ligne : la liste ne colle pas au bas du cadre. */
      ul { list-style: none; margin: 6px 0 4px; padding: 0; }
      li { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-top: 1px solid var(--border); font-size: 14px; }
      .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .px { font-variant-numeric: tabular-nums; }
      .delta { font-size: 12px; min-width: 64px; text-align: right; }
      .muted { color: var(--muted); }
    `,
  ],
  template: `
    <ul>
      @for (s of panel().symbols ?? []; track s.symbol) {
        <li>
          <span class="name" [attr.title]="s.symbol">{{ s.name }}</span>
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
        </li>
      }
    </ul>
  `,
})
export class QuotesPanelComponent {
  readonly panel = input.required<PanelView>();
  readonly kopilia = inject(KopiliaService);

  quoteOf(s: ProductView): QuoteView | undefined {
    return this.kopilia.quotes()[s.symbol];
  }

  price(q: QuoteView, s: ProductView): string {
    return formatPrice(q.bid, s.digits ?? q.digits);
  }

  change(q: QuoteView) {
    return changeSince(q.dayOpen, q.bid);
  }
}
