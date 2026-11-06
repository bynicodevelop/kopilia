import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { FIDELITY_LABELS, moneyLabel, type JournalTrade } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { formatPrice } from "../dashboard/candles";
import { durationText, itemLabel, outcomeText, rText, tone, whenText } from "./journal-view";

/**
 * La page d'un trade du journal, en plein écran : son graphique figé au ticket
 * (les tracés de ce moment, son stop et son objectif marche par marche, son
 * entrée et ses sorties), ce que le serveur en constate, et le fil daté de sa
 * fiche et du trade. Rien à cliquer de plus : les notes se dictent.
 */
@Component({
  selector: "kp-trade-sheet",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .sheet { position: fixed; inset: 0; z-index: 11; background: var(--bg); overflow-y: auto; }
      .inner { max-width: 1120px; margin: 0 auto; padding: 0 16px 48px; }
      header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 16px 0 10px; background: var(--bg); border-bottom: 1px solid var(--border); }
      h1 { margin: 0; font-size: 18px; flex: 1; min-width: 0; }
      h1 small { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 6px; }
      .res { font-size: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .chip { margin-left: 8px; padding: 1px 9px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; opacity: 0.85; }
      .grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 20px; margin-top: 14px; }
      @media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
      .chart { width: 100%; aspect-ratio: 640 / 400; border-radius: var(--radius); border: 1px solid var(--border); background: var(--panel); display: block; }
      .chart.wait { display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; }
      h2 { margin: 16px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
      .levels { margin: 8px 0 0; font-size: 13px; color: var(--muted); }
      ul { list-style: none; margin: 0; padding: 0; }
      .facts li { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--border); font-size: 14px; }
      .facts li:first-child { border-top: none; }
      .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; transform: translateY(-2px); background: var(--muted); opacity: 0.5; }
      .dot.ok { background: var(--accent-2); opacity: 1; }
      .dot.warn { background: var(--warn); opacity: 1; }
      .thread li { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 10px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 14px; }
      .thread li:first-child { border-top: none; }
      .thread time { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 2px; }
      .thread .label { display: block; font-size: 11px; color: var(--muted); }
      .thread .note { color: var(--accent); }
      .thread .ai { color: var(--ai); }
      .thread .sys { color: var(--muted); }
      .hint { margin: 14px 0 0; font-size: 12.5px; color: var(--muted); }
      .up { color: var(--accent-2); }
      .down { color: var(--danger); }
      .flat { color: var(--muted); }
    `,
  ],
  template: `
    @if (kopilia.tradeOpen(); as s) {
      <div class="sheet" role="dialog" aria-modal="true" [attr.aria-label]="'Trade ' + s.page.trade.name">
        <div class="inner">
          <header>
            <h1>
              {{ cap(s.page.trade.name) }} · {{ s.page.trade.side === 'long' ? 'achat' : 'vente' }}<small>{{ when(s.page.trade.createdAt) }} · {{ fidelity(s.page) }}</small>
            </h1>
            <span [class]="'res ' + tone(s.page.outcome)"
              >{{ result(s.page) }}
              @if (s.page.outcome) {
                <span class="chip">{{ outcome(s.page) }}</span>
              }
            </span>
            <button type="button" class="icon" aria-label="Fermer la page du trade" (click)="kopilia.closeTrade()">×</button>
          </header>
          <div class="grid">
            <div>
              @if (s.chart) {
                <img class="chart" [src]="s.chart" [attr.alt]="'Graphique figé du trade ' + s.page.trade.name" />
              } @else {
                <div class="chart wait">{{ s.chartError ? 'Graphique indisponible : ' + s.chartError : 'Le graphique se dessine…' }}</div>
              }
              <p class="levels">{{ levels(s.page) }}</p>
              <h2>Ce que le serveur constate</h2>
              <ul class="facts">
                @for (f of s.page.facts; track f.key + $index) {
                  <li><span [class]="'dot ' + f.tone" aria-hidden="true"></span><span>{{ f.text }}</span></li>
                }
              </ul>
            </div>
            <div>
              <h2>Le fil, fiche et trade</h2>
              <ul class="thread">
                @for (i of s.page.thread; track i.at + i.kind + $index) {
                  <li>
                    <time>{{ when(i.at) }}</time>
                    <span [class]="i.kind === 'note' ? 'note' : i.kind === 'challenge' ? 'ai' : ''"
                      ><span class="label">{{ label(i) }}</span>{{ i.text }}</span
                    >
                  </li>
                }
              </ul>
              <p class="hint">Dis « note dans mon journal que… » pour y ajouter un mot sur ce trade.</p>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class TradeSheetComponent {
  readonly kopilia = inject(KopiliaService);
  readonly tone = tone;
  readonly label = itemLabel;
  readonly when = (ms: number) => whenText(ms);

  cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  fidelity(p: JournalTrade): string {
    return FIDELITY_LABELS[p.fidelity];
  }

  outcome(p: JournalTrade): string {
    return outcomeText(p.outcome);
  }

  /** « −1 R · −98 $ », « en cours », « ordre en attente ». */
  result(p: JournalTrade): string {
    const t = p.trade;
    if (t.state === "closed" && t.r !== undefined)
      return `${rText(t.r)}${t.profit !== undefined ? ` · ${moneyLabel(t.profit, t.currency, { sign: true })}` : ""}`;
    if (t.state === "open") return `en cours${t.profit !== undefined ? ` · ${moneyLabel(t.profit, t.currency, { sign: true })}` : ""}`;
    if (t.state === "pending") return "ordre en attente";
    if (t.state === "cancelled") return "ordre retiré";
    return "";
  }

  /** Les niveaux en une ligne : entrée, stop de départ et d'arrivée, objectif, taille, risque, sortie, durée. */
  levels(p: JournalTrade): string {
    const t = p.trade;
    const price = (v: number) => formatPrice(v, t.digits);
    const stop = t.stop !== t.initialStop ? `stop ${price(t.initialStop)} → ${price(t.stop)}` : `stop ${price(t.stop)}`;
    return [
      `entrée ${price(t.entry)}`,
      stop,
      t.targets.length ? `objectif ${t.targets.map(price).join(" et ")}` : "",
      `${String(t.lots).replace(".", ",")} lot${t.lots >= 2 ? "s" : ""}`,
      `risque ${moneyLabel(t.risk, t.currency)} (${String(Number(t.riskPercent.toFixed(2))).replace(".", ",")} %)`,
      p.exit ?? "",
      p.durationMs !== undefined ? `${durationText(p.durationMs)} en position` : "",
      p.frozen ? "" : "graphique non figé (trade d'avant le journal)",
    ]
      .filter(Boolean)
      .join(" · ");
  }
}
