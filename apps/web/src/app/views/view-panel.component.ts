import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from "@angular/core";
import type { Hypothesis, ViewBlock, ViewCalendarEvent, ViewData } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { formatDateTime } from "../format";
import type { PanelView } from "../dashboard/views";
import { QuotesPanelComponent } from "../dashboard/quotes-panel.component";
import { SetupsListComponent } from "../setups/setups-list.component";
import { SparklineComponent } from "./sparkline.component";
import { eventTime } from "./views";

/** Les données servies par le serveur (calendrier, brief) sont relues à ce rythme. */
const REFRESH_MS = 60_000;
const BIAS: Record<string, string> = { up: "haussière", down: "baissière", neutral: "neutre" };
const TREND: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

type Brief = { briefId: string; title: string; spoken: string; createdAt: number } | null;

/**
 * Une vue : un encart composé par Kopilia à partir du catalogue de blocs. Les
 * blocs écrits montrent ce qu'il y a mis ; les blocs vivants reprennent les
 * composants de l'écran (cours de la liste de surveillance, liste des setups)
 * ou leurs données (hypothèses, cotations), et le serveur sert le calendrier et
 * le brief. Tout texte reste du texte : une vue ne contient jamais de HTML.
 */
@Component({
  selector: "kp-view-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QuotesPanelComponent, SetupsListComponent, SparklineComponent],
  styles: [
    `
      :host { display: block; }
      .body { max-height: calc(100vh - 150px); overflow-y: auto; padding-bottom: 4px; }
      .block { margin-top: 8px; }
      h3 { margin: 12px 0 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
      .text { margin: 0; font-size: 14px; white-space: pre-line; }
      .text.muted { color: var(--muted); }
      .text.warn { color: var(--warn); }
      .stat { border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; }
      .stat .label { font-size: 12px; color: var(--muted); }
      .stat .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .stat .detail { font-size: 12px; color: var(--muted); margin-left: 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
      th { text-align: left; font-weight: normal; color: var(--muted); font-size: 12px; padding: 3px 4px; border-bottom: 1px solid var(--border); }
      td { padding: 4px; border-bottom: 1px solid var(--border); }
      ul { list-style: none; margin: 0; padding: 0; }
      .item { display: flex; gap: 6px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--border); font-size: 14px; }
      .item .main { flex: 1; min-width: 0; }
      .item small { display: block; color: var(--muted); font-size: 12px; }
      .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
      .tag.ai { color: var(--ai); }
      .ev { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; border-top: 1px solid var(--border); font-size: 13px; }
      .ev.past { color: var(--muted); }
      .ev time { min-width: 64px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .ev .cur { font-size: 12px; min-width: 30px; color: var(--muted); }
      .ev .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .ev .num { display: block; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; background: var(--muted); }
      .dot.high { background: var(--danger); }
      .dot.medium { background: var(--warn); }
      .brief .title { font-weight: 600; font-size: 14px; }
      .brief p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
      .link { border: none; background: none; color: var(--accent); padding: 2px 0; font-size: 13px; }
      .none { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
    `,
  ],
  template: `
    <div class="body">
      @for (b of blocks(); track $index; let i = $index) {
        <div class="block">
          @switch (b.type) {
            @case ("heading") {
              <h3>{{ b.text }}</h3>
            }
            @case ("text") {
              <p class="text" [class.muted]="b.tone === 'muted'" [class.warn]="b.tone === 'warn'">{{ b.text }}</p>
            }
            @case ("stat") {
              <div class="stat">
                <div class="label">{{ b.label }}</div>
                <span class="value" [class.trend-up]="b.trend === 'up'" [class.trend-down]="b.trend === 'down'">{{ b.value }}@if (b.trend) { {{ trend[b.trend] }} }</span>
                @if (b.detail) { <span class="detail">{{ b.detail }}</span> }
              </div>
            }
            @case ("table") {
              <table>
                <thead><tr>@for (c of b.columns; track $index) { <th>{{ c }}</th> }</tr></thead>
                <tbody>
                  @for (r of b.rows; track $index) {
                    <tr>@for (cell of r; track $index) { <td>{{ cell }}</td> }</tr>
                  }
                </tbody>
              </table>
            }
            @case ("list") {
              <ul>
                @for (it of b.items; track $index) {
                  <li class="item">
                    <span class="main">{{ it.text }}@if (it.detail) { <small>{{ it.detail }}</small> }</span>
                    @if (it.tag) { <span class="tag">{{ it.tag }}</span> }
                  </li>
                }
              </ul>
            }
            @case ("quotes") {
              @if (quotesPanels()[i]; as qp) { <kp-quotes-panel [panel]="qp" /> }
            }
            @case ("sparkline") {
              <kp-sparkline [product]="b.product" [timeframe]="b.timeframe" [bars]="b.bars" />
            }
            @case ("calendar") {
              @if (eventsOf(i); as evs) {
                @if (evs.length) {
                  <ul>
                    @for (e of evs; track $index) {
                      <li class="ev" [class.past]="e.at < now()">
                        <span class="dot" [class.high]="e.impact === 'high'" [class.medium]="e.impact === 'medium'" [attr.title]="'Impact ' + e.impact"></span>
                        <time>{{ when(e.at) }}</time>
                        <span class="cur">{{ e.country }}</span>
                        <span class="what"
                          >{{ e.title }}
                          @if (e.forecast || e.previous) {
                            <span class="num">prévision {{ e.forecast ?? '—' }} · précédent {{ e.previous ?? '—' }}</span>
                          }
                        </span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="none">Aucune annonce à venir.</p>
                }
              } @else {
                <p class="none">Chargement du calendrier…</p>
              }
            }
            @case ("setups") {
              <kp-setups-list [symbol]="b.product?.symbol" [states]="b.states" />
            }
            @case ("hypotheses") {
              @if (hypothesesFor(b.product?.symbol); as hs) {
                @if (hs.length) {
                  <ul>
                    @for (h of hs; track h.id) {
                      <li class="item">
                        <span class="tag" [class.ai]="h.author === 'kopilia'">{{ h.author === 'user' ? 'Toi' : 'IA' }}</span>
                        <span class="main">{{ h.statement }}<small>{{ bias[h.bias] }} · invalidée si {{ h.invalidation }}</small></span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="none">Aucune hypothèse active.</p>
                }
              }
            }
            @case ("brief") {
              @if (briefOf(i); as br) {
                <div class="brief">
                  <div class="title">{{ br.title }}</div>
                  <p>{{ br.spoken }}</p>
                  <button type="button" class="link" (click)="kopilia.openBrief(br.briefId)">Ouvrir le brief · {{ date(br.createdAt) }}</button>
                </div>
              } @else {
                <p class="none">{{ loaded() ? 'Aucun brief pour l’instant.' : 'Chargement du brief…' }}</p>
              }
            }
          }
        </div>
      }
    </div>
  `,
})
export class ViewPanelComponent {
  readonly panel = input.required<PanelView>();
  readonly kopilia = inject(KopiliaService);
  readonly trend = TREND;
  readonly bias = BIAS;
  readonly blocks = computed<ViewBlock[]>(() => this.panel().view?.blocks ?? []);
  /** Les données servies par le serveur, par position de bloc. */
  private readonly data = signal<ViewData["blocks"]>({});
  readonly loaded = signal(false);
  /** L'heure, à la minute : une annonce passée s'atténue. */
  readonly now = signal(Date.now());

  /** Les blocs de cours, sous la forme d'un suivi : ils reprennent le composant de la liste de surveillance. */
  readonly quotesPanels = computed<Record<number, PanelView>>(() => {
    const p = this.panel();
    const out: Record<number, PanelView> = {};
    this.blocks().forEach((b, i) => {
      if (b.type === "quotes")
        out[i] = { id: `${p.id}_${i}`, kind: "quotes", title: p.title, symbols: b.products, createdAt: p.createdAt, updatedAt: p.updatedAt };
    });
    return out;
  });

  constructor() {
    let timer: ReturnType<typeof setInterval> | undefined;
    // Relu quand la vue change (ses blocs) ; seulement si elle a un calendrier ou un brief.
    effect(() => {
      const p = this.panel();
      clearInterval(timer);
      if (!p.view?.blocks.some((b) => b.type === "calendar" || b.type === "brief")) return;
      const load = () =>
        this.kopilia.viewData(p.id).then(
          (d) => {
            this.data.set(d.blocks);
            this.loaded.set(true);
            this.now.set(Date.now());
          },
          () => this.loaded.set(true),
        );
      void load();
      timer = setInterval(() => void load(), REFRESH_MS);
    });
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  eventsOf(i: number): ViewCalendarEvent[] | undefined {
    const d = this.data()[i];
    return d && "events" in d ? d.events : undefined;
  }

  briefOf(i: number): Brief | undefined {
    const d = this.data()[i];
    return d && "brief" in d ? d.brief : undefined;
  }

  /** Les hypothèses actives, d'un produit ou de toutes. */
  hypothesesFor(symbol: string | undefined): Hypothesis[] {
    return this.kopilia.hypotheses().filter((h) => h.state === "active" && (!symbol || h.products.some((p) => p.symbol === symbol)));
  }

  when(at: number): string {
    return eventTime(at, this.now());
  }

  date(ms: number): string {
    return formatDateTime(ms);
  }
}
