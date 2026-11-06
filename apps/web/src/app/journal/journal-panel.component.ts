import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, untracked } from "@angular/core";
import { FIDELITY_LABELS, NEUTRAL_R, moneyLabel } from "@kopilia/contracts";
import { formatPrice } from "../dashboard/candles";
import { KopiliaService } from "../kopilia.service";
import { distanceText, exitPrice, ficheChip, fillPrice, journalByState, liveTotals, orderText, tickerLabel, tradeBar, type StateLine } from "./journal-live";
import { lineDetail, outcomeText, rText, tone, whenText } from "./journal-view";

/** Relu aussi à ce rythme, au cas où un signal se serait perdu (reconnexion). */
const REFRESH_MS = 120_000;

/**
 * L'encart Journal, rangé par état : en haut trois chiffres (le résultat des
 * positions ouvertes, les ordres en attente et leur risque, les trades fermés
 * sur 30 jours), puis les positions ouvertes en direct (prix du moment,
 * résultat flottant, barre du stop à l'objectif), les ordres en attente (la
 * distance au déclenchement), les trades fermés et les idées non prises.
 * Chaque ligne commence par le ticker ; la fiche est une étiquette. Un clic
 * sur un trade ouvre sa page, un clic sur les fermés le calendrier ; le reste
 * se dit à la voix (« note dans mon journal… »).
 */
@Component({
  selector: "kp-journal-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      .list { margin: 2px 0 4px; max-height: calc(100vh - 230px); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
      .strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 2px 0 8px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 10px; }
      .cell { min-width: 0; padding: 0; text-align: left; border: none; border-radius: 0; background: none; color: var(--text); }
      button.cell:hover .k { text-decoration: underline; text-decoration-color: var(--muted); }
      .k { display: block; font-size: 11px; color: var(--muted); white-space: nowrap; }
      .v { display: block; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .s { display: block; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      section { border-top: 1px solid var(--border); padding: 5px 0 3px; }
      section:first-child { border-top: none; }
      h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 1px; font-size: 12px; font-weight: 400; color: var(--muted); }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-2); animation: blink 1.6s infinite; }
      @keyframes blink { 50% { opacity: 0.25; } }
      ul { list-style: none; margin: 0; padding: 0; }
      .row {
        display: block; width: 100%; margin: 0; padding: 5px 0 5px 2px; text-align: left; border: none; border-radius: 0; background: none;
        color: var(--text); font-size: 14px;
      }
      li + li .row { border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
      .row:hover .tk { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .row.gone { opacity: 0.6; }
      .line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .tk { font-weight: 600; letter-spacing: 0.2px; white-space: nowrap; }
      .line > * { flex-shrink: 0; }
      .line > .what { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .fill { flex: 1; }
      .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .money { font-size: 12px; color: var(--muted); }
      .r { min-width: 58px; text-align: right; font-weight: 600; }
      .sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub b { font-weight: 400; color: var(--text); }
      .idea { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 12.5px; }
      .chip { display: inline-block; margin-right: 6px; padding: 0 6px; line-height: 15px; border-radius: 999px; border: 1px solid var(--border); font-size: 11px; color: var(--muted); white-space: nowrap; }
      .chip.against { color: var(--warn); border-color: currentColor; }
      .bar { position: relative; height: 4px; margin: 7px 0 2px; border-radius: 2px; }
      .bar .tick { position: absolute; top: -3px; width: 1px; height: 10px; background: var(--muted); }
      .bar .now { position: absolute; top: -2px; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%; background: var(--text); transition: left 0.4s; }
      .levels { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .up { color: var(--accent-2); }
      .down { color: var(--danger); }
      .flat { color: var(--muted); }
      .quiet { margin: 2px 0; font-size: 12.5px; color: var(--muted); }
      .empty { margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
      .review {
        width: 100%; display: block; margin: 0 0 6px; padding: 4px 0 6px 10px; text-align: left; border: none; border-left: 2px solid var(--ai);
        border-radius: 0; background: none; color: var(--text); font-size: 13px;
      }
      .review:hover .rw { text-decoration: underline; text-decoration-color: var(--muted); }
      .review .rw { color: var(--ai); font-size: 12px; }
      .review .text { display: block; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `,
  ],
  template: `
    @if (journal(); as j) {
      @if (rows(); as v) {
        @if (v.open.length || v.pending.length || v.closed.length || v.ideas.length) {
          <div class="strip">
            <div class="cell">
              <span class="k">Ouvertes · {{ v.open.length }}</span>
              @if (v.open.length) {
                <span [class]="'v ' + sign(totals()!.openR)">{{ r(totals()!.openR) }}</span>
                <span class="s">{{ money(totals()!.openProfit, totals()!.currency) }}</span>
              } @else {
                <span class="v flat">—</span><span class="s">aucune position</span>
              }
            </div>
            <div class="cell">
              <span class="k">En attente · {{ v.pending.length }}</span>
              @if (v.pending.length) {
                <span class="v">{{ money(totals()!.pendingRisk, totals()!.currency, false) }}</span>
                <span class="s">risque prévu</span>
              } @else {
                <span class="v flat">—</span><span class="s">aucun ordre</span>
              }
            </div>
            <button type="button" class="cell" [attr.title]="closedWords() + ' · Ouvrir le calendrier du journal'" (click)="kopilia.openCalendar()">
              <span class="k">Fermés · 30 j</span>
              @if (j.totals.count) {
                <span [class]="'v ' + sign(j.totals.r)">{{ r(j.totals.r) }}</span>
                <span class="s">{{ plural(j.totals.count, 'trade') }}</span>
              } @else {
                <span class="v flat">—</span><span class="s">aucun trade fermé</span>
              }
            </button>
          </div>
          @if (j.reviewing) {
            <p class="review"><span class="rw">Analyse de ton trading en cours…</span></p>
          } @else if (j.review) {
            <button type="button" class="review" title="Ouvrir l'analyse de ton trading" (click)="kopilia.openReview(j.review.id)">
              <span class="rw">Analyse de l'IA · {{ j.review.days }} jours · {{ when(j.review.createdAt) }}</span>
              <span class="text">{{ j.review.summary }}</span>
            </button>
          }
          <div class="list">
            @if (v.open.length) {
              <section>
                <h4>
                  @if (v.streaming) {
                    <span class="dot" title="Cours en direct"></span>
                  }
                  Ouvertes
                </h4>
                <ul>
                  @for (o of v.open; track o.l.id) {
                    <li>
                      <button type="button" class="row" [attr.title]="title(o.l)" (click)="kopilia.openTrade(o.l.id)">
                        <span class="line">
                          <span class="tk">{{ ticker(o.l.symbol) }}</span>
                          <span class="what">{{ o.l.side === 'long' ? '↑ achat' : '↓ vente' }}</span>
                          <span class="fill"></span>
                          @if (o.l.profit !== undefined) {
                            <span class="num money">{{ money(o.l.profit, o.l.currency) }}</span>
                          }
                          <span [class]="'num r ' + (o.l.r !== undefined ? sign(o.l.r) : 'flat')">{{ o.l.r !== undefined ? r(o.l.r) : '—' }}</span>
                        </span>
                        <span class="sub" style="display: block"
                          >@if (chip(o.l); as c) {<span [class]="'chip' + (c.against ? ' against' : '')">{{ c.text }}</span>}@if (o.price) {prix <b class="num">{{ o.price }}</b> · }@if (o.l.lots) {{{ lots(o.l.lots) }} · }@if (o.l.openedAt) {depuis {{ when(o.l.openedAt) }}}</span
                        >
                        @if (o.bar) {
                          <span class="bar" style="display: block" [style.background]="barFill(o.bar.entry)">
                            <span class="tick" [style.left.%]="o.bar.entry * 100"></span>
                            @if (o.bar.price !== undefined) {
                              <span class="now" [style.left.%]="o.bar.price * 100"></span>
                            }
                          </span>
                          <span class="levels"
                            ><span>stop {{ px(o.l.stop!, o.l.digits) }}</span><span>entrée {{ px(o.l.entry!, o.l.digits) }}</span
                            ><span>obj. {{ px(o.l.target!, o.l.digits) }}</span></span
                          >
                        }
                      </button>
                    </li>
                  }
                </ul>
              </section>
            }
            @if (v.pending.length) {
              <section>
                <h4>En attente</h4>
                <ul>
                  @for (p of v.pending; track p.l.id) {
                    <li>
                      <button type="button" class="row" [attr.title]="title(p.l)" (click)="kopilia.openTrade(p.l.id)">
                        <span class="line">
                          <span class="tk">{{ ticker(p.l.symbol) }}</span>
                          <span class="what">{{ order(p.l) }}</span>
                          <span class="fill"></span>
                          @if (p.distance) {
                            <span class="num money">{{ p.distance }}</span>
                          }
                        </span>
                        <span class="sub" style="display: block"
                          >@if (chip(p.l); as c) {<span [class]="'chip' + (c.against ? ' against' : '')">{{ c.text }}</span>}@if (p.price) {prix <b class="num">{{ p.price }}</b> · }@if (p.l.risk) {risque {{ money(p.l.risk, p.l.currency, false) }} · }@if (p.l.createdAt) {posé {{ when(p.l.createdAt) }}}</span
                        >
                        @if (p.l.stop !== undefined && p.l.entry !== undefined) {
                          <span class="levels"
                            ><span>stop {{ px(p.l.stop, p.l.digits) }}</span><span>entrée {{ px(p.l.entry, p.l.digits) }}</span
                            >@if (p.l.target !== undefined) {<span>obj. {{ px(p.l.target, p.l.digits) }}</span>}</span
                          >
                        }
                      </button>
                    </li>
                  }
                </ul>
              </section>
            }
            @if (!v.open.length && !v.pending.length) {
              <section><p class="quiet">Aucune position ouverte ni ordre en attente.</p></section>
            }
            @if (v.closed.length) {
              <section>
                <h4>Fermés · 30 jours</h4>
                <ul>
                  @for (l of v.closed; track l.id) {
                    <li>
                      <button type="button" [class]="'row' + (l.state === 'cancelled' ? ' gone' : '')" [attr.title]="title(l)" (click)="kopilia.openTrade(l.id)">
                        <span class="line">
                          <span class="tk">{{ ticker(l.symbol) }}</span>
                          <span class="what">{{ l.side === 'long' ? '↑ achat' : '↓ vente' }}</span>
                          <span class="fill"></span>
                          @if (l.state === 'closed' && l.r !== undefined) {
                            @if (l.profit !== undefined) {
                              <span class="num money">{{ money(l.profit, l.currency) }}</span>
                            }
                            <span [class]="'num r ' + tone(l.outcome)">{{ r(l.r) }}</span>
                          } @else {
                            <span class="num r flat">—</span>
                          }
                        </span>
                        <span class="sub" style="display: block"
                          ><span class="num">{{ when(l.at) }}</span>@if (detail(l)) { · {{ detail(l) }} }</span
                        >
                      </button>
                    </li>
                  }
                </ul>
              </section>
            }
            @if (v.ideas.length) {
              <section>
                <h4>Idées non prises</h4>
                <ul>
                  @for (g of v.ideas; track g.analysisId) {
                    <li>
                      <div class="row" [attr.title]="cap(g.name)">
                        <span class="line">
                          <span class="tk">{{ g.symbol ? ticker(g.symbol) : cap(g.name) }}</span>
                          <span class="fill"></span>
                          @if (g.openedAt) {
                            <span class="chip">fiche {{ when(g.openedAt) }}</span>
                          }
                        </span>
                        <span class="idea">{{ g.idea ?? "pas encore d'idée de trade" }}</span>
                        <span class="sub" style="display: block">{{ g.untaken ?? 'Pas encore de trade sur cette fiche.' }}</span>
                      </div>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>
        } @else {
          <p class="empty">Ton journal se remplit seul : chaque ordre passé par Kopilia s'y range avec la fiche du produit. Dis « note dans mon journal… » après un trade.</p>
        }
      }
    } @else {
      <p class="empty">Lecture du journal…</p>
    }
  `,
})
export class JournalPanelComponent {
  readonly kopilia = inject(KopiliaService);
  readonly journal = computed(() => this.kopilia.journal());
  readonly r = rText;
  readonly tone = tone;
  readonly ticker = tickerLabel;
  readonly detail = lineDetail;
  readonly when = (ms: number) => whenText(ms);
  readonly px = (v: number, digits?: number) => formatPrice(v, digits);

  /** Le journal par état, mis à jour par la prise de position (toutes les 4 s) et par les cotations du moment. */
  readonly byState = computed(() => {
    const j = this.journal();
    return j ? journalByState(j, this.kopilia.trading()?.trades ?? []) : undefined;
  });
  readonly totals = computed(() => {
    const s = this.byState();
    return s ? liveTotals(s) : undefined;
  });
  readonly rows = computed(() => {
    const s = this.byState();
    if (!s) return undefined;
    const quotes = this.kopilia.quotes();
    let streaming = false;
    const open = s.open.map((l) => {
      const q = quotes[l.symbol];
      const price = exitPrice(l.side, q);
      if (price !== undefined) streaming = true;
      const digits = l.digits ?? q?.digits;
      const bar = l.stop !== undefined && l.entry !== undefined ? tradeBar(l.side, l.stop, l.entry, l.target, price) : undefined;
      return { l, price: price !== undefined ? formatPrice(price, digits) : undefined, bar };
    });
    const pending = s.pending.map((l) => {
      const q = quotes[l.symbol];
      const price = fillPrice(l.side, q);
      const digits = l.digits ?? q?.digits;
      return {
        l,
        price: price !== undefined ? formatPrice(price, digits) : undefined,
        distance: price !== undefined && l.entry !== undefined ? distanceText(l.symbol, price, l.entry, digits) : undefined,
      };
    });
    return { open, pending, closed: s.closed, ideas: s.ideas, streaming };
  });

  constructor() {
    void this.kopilia.loadJournal();
    const timer = setInterval(() => void this.kopilia.loadJournal(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    let seen = this.kopilia.journalVersion();
    effect(() => {
      const v = this.kopilia.journalVersion();
      if (v === seen) return;
      seen = v;
      untracked(() => void this.kopilia.loadJournal());
    });
  }

  /** Un résultat en R : gagné, perdu, ou neutre (sous 0,1 R, comme un trade). */
  sign(r: number): "up" | "down" | "flat" {
    return Math.abs(r) < NEUTRAL_R ? "flat" : r > 0 ? "up" : "down";
  }

  money(amount: number, currency: string, sign = true): string {
    return moneyLabel(amount, currency, { sign });
  }

  plural(n: number, word: string): string {
    return `${n} ${word}${n > 1 ? "s" : ""}`;
  }

  lots(n: number): string {
    return `${formatPrice(n)} lot${n >= 2 ? "s" : ""}`;
  }

  order(l: StateLine): string {
    return orderText(l.side, l.execution);
  }

  chip(l: StateLine) {
    return ficheChip(l.fidelity, !!l.fiche);
  }

  /** « 2 trades · 1 gagnant, 1 neutre » : seulement ce qui compte. */
  closedWords(): string {
    const t = this.journal()?.totals;
    if (!t) return "";
    const parts = [
      t.wins ? this.plural(t.wins, "gagnant") : "",
      t.losses ? this.plural(t.losses, "perdant") : "",
      t.neutral ? this.plural(t.neutral, "neutre") : "",
    ].filter(Boolean);
    return `${this.plural(t.count, "trade")} · ${parts.join(", ")}`;
  }

  /** Le fond de la barre : rouge pâle du stop à l'entrée, vert pâle de l'entrée à l'objectif. */
  barFill(entry: number): string {
    const at = `${Math.round(entry * 1000) / 10}%`;
    return `linear-gradient(to right, color-mix(in srgb, var(--danger) 30%, transparent) 0 ${at}, color-mix(in srgb, var(--accent-2) 30%, transparent) ${at} 100%)`;
  }

  cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Au survol : le résultat en mots, en devise, la fiche et son idée. */
  title(l: StateLine): string {
    const money = l.profit !== undefined ? ` (${moneyLabel(l.profit, l.currency, { sign: true })})` : "";
    const fiche = l.fiche ? `fiche ${l.fiche.name}${l.fiche.idea ? ` : ${l.fiche.idea}` : ""}` : "";
    return [
      `${outcomeText(l.outcome) || l.remark || ""}${money}`.trim(),
      l.fidelity === "against" ? FIDELITY_LABELS.against : fiche || FIDELITY_LABELS.none,
      "Ouvrir la page du trade",
    ]
      .filter(Boolean)
      .join(" · ");
  }
}
