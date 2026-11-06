import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import type { Scenario } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { dateFormat, formatDateTime } from "../format";
import { formatPrice } from "../dashboard/candles";
import { setupLabel, setupState } from "./watchlist";

const SIDE: Record<Scenario["direction"], string> = { long: "Achat", short: "Vente" };

/**
 * L'encart des setups repérés par l'IA, présenté comme la liste de
 * surveillance : une ligne par setup, le produit et son sens, le prix en
 * direct, en attente ou déclenché. Rien à cliquer d'autre que la ligne, qui
 * ouvre le graphique avec ses niveaux : le reste se demande à la voix. Ce
 * qu'attend le setup, son échéance, son pourquoi et son plan sont au survol.
 * Le cadre (titre, fermer, déplacer) est celui du tableau de bord. Sert aussi
 * de bloc « setups » dans une vue, filtré par produit ou par état.
 */
@Component({
  selector: "kp-setups-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      /* Comme la liste de surveillance : un peu d'air sous la dernière ligne. */
      ul { list-style: none; margin: 6px 0 4px; padding: 0; }
      li { border-top: 1px solid var(--border); }
      .row {
        width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 5px 0; text-align: left;
        border: none; border-radius: 0; background: none; color: var(--text); font-size: 14px;
      }
      .row:hover .name { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .side { font-size: 12px; margin-left: 4px; }
      .side.long { color: var(--accent-2); }
      .side.short { color: var(--danger); }
      .px { font-variant-numeric: tabular-nums; }
      .state { font-size: 12px; min-width: 64px; text-align: right; color: var(--muted); white-space: nowrap; }
      .state.on { color: var(--ai); font-weight: 600; }
      .new { width: 7px; height: 7px; border-radius: 50%; background: var(--ai); flex: none; align-self: center; }
      .muted { color: var(--muted); }
      .empty { margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
    `,
  ],
  template: `
    @if (items().length) {
      <ul>
        @for (s of items(); track s.id) {
          <li>
            <button type="button" class="row" [attr.title]="tip(s)" [attr.aria-label]="product(s) + ', ' + side[s.direction] + ', ' + state(s) + ' : ouvrir le graphique'" (click)="kopilia.openSetupChart(s)">
              @if (kopilia.freshSetups().has(s.id)) {
                <span class="new" aria-label="nouveau"></span>
              }
              <span class="name">{{ product(s) }}<span class="side" [class.long]="s.direction === 'long'" [class.short]="s.direction === 'short'">{{ side[s.direction] }}</span></span>
              @if (price(s); as p) {
                <span class="px">{{ p }}</span>
              } @else {
                <span class="px muted">—</span>
              }
              <span class="state" [class.on]="s.state === 'proposed'">{{ state(s) }}</span>
            </button>
          </li>
        }
      </ul>
    } @else if (symbol() || states()?.length) {
      <p class="empty">Aucun setup {{ symbol() ? 'sur ce produit' : 'de ce genre' }}.</p>
    } @else {
      <p class="empty">Aucun setup en cours. Dis « cherche des setups » pour lancer une recherche.</p>
    }
  `,
})
export class SetupsListComponent {
  readonly kopilia = inject(KopiliaService);
  /** Dans une vue : seulement ce produit (son symbole), ces états. */
  readonly symbol = input<string | undefined>(undefined);
  readonly states = input<ReadonlyArray<"waiting" | "triggered"> | undefined>(undefined);
  readonly items = computed(() => {
    const symbol = this.symbol();
    const states = this.states();
    return this.kopilia
      .watchlist()
      .filter((s) => (!symbol || s.symbol === symbol) && (!states?.length || states.includes(s.state === "proposed" ? "triggered" : "waiting")));
  });
  readonly side = SIDE;
  readonly state = setupState;

  /** « Or », « Euro contre dollar canadien ». */
  product(s: Scenario): string {
    return s.name.charAt(0).toUpperCase() + s.name.slice(1);
  }

  /** Le prix du moment (le flux suit les produits de la liste tant qu'elle est affichée). */
  price(s: Scenario): string | undefined {
    const q = this.kopilia.quotes()[s.symbol];
    return q ? formatPrice(q.bid, s.digits ?? q.digits) : undefined;
  }

  /** Au survol : ce qu'attend le setup, son unité et son échéance, le pourquoi de l'IA, son plan, et ce que fait le clic. */
  tip(s: Scenario): string {
    return `${this.product(s)} : ${setupLabel(s)}\n${SIDE[s.direction]} ${s.timeframe}, jusqu'à ${this.until(s.expiresAt)}\n\nPourquoi : ${s.why}\n\nPlan : ${s.plan}\n\nClic : ouvrir le graphique ${s.timeframe}`;
  }

  /** L'échéance : l'heure seule si c'est aujourd'hui. */
  until(ms: number): string {
    const today = new Date().toDateString() === new Date(ms).toDateString();
    return today ? dateFormat("clock", { hour: "2-digit", minute: "2-digit" }).format(ms) : formatDateTime(ms);
  }
}
