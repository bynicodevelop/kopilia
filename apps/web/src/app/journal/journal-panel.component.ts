import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, untracked } from "@angular/core";
import { FIDELITY_LABELS, NEUTRAL_R, moneyLabel, type JournalGroup, type JournalLine } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { lineDetail, outcomeText, rText, tone, whenText } from "./journal-view";

/** Relu aussi à ce rythme, au cas où un signal se serait perdu (reconnexion). */
const REFRESH_MS = 120_000;

/**
 * L'encart Journal : ses trades rangés par fiche d'analyse, comme la liste de
 * surveillance. Chaque fiche dit son idée (et l'idée de départ si elle a changé
 * de sens) et le total de ses trades en R ; chaque trade, son sens, sa date et
 * son résultat. Un clic sur un trade ouvre sa page ; le reste se dit à la voix
 * (« note dans mon journal… », « montre-moi mon trade du Nasdaq »).
 */
@Component({
  selector: "kp-journal-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      .list { margin: 2px 0 4px; max-height: calc(100vh - 160px); overflow-y: auto; overscroll-behavior: contain; }
      .sum {
        display: block; width: 100%; margin: 2px 0 6px; padding: 0; text-align: left; border: none; border-radius: 0; background: none;
        font-size: 12px; color: var(--muted);
      }
      .sum:hover { text-decoration: underline; text-decoration-color: var(--muted); }
      .sum b { font-weight: 600; color: var(--text); }
      section { border-top: 1px solid var(--border); padding: 6px 0 4px; }
      section:first-of-type { border-top: none; }
      .head { display: flex; align-items: baseline; gap: 8px; font-size: 14px; }
      .head .name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .head .since { font-size: 12px; font-weight: 400; color: var(--muted); }
      .idea { margin: 1px 0 2px; font-size: 12.5px; color: var(--muted); }
      .idea .turn { color: var(--accent); }
      ul { list-style: none; margin: 0; padding: 0; }
      li { border-top: 1px solid var(--border); }
      li:first-child { border-top: none; }
      .row {
        width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 2px 10px; align-items: baseline;
        padding: 5px 0 5px 10px; text-align: left; border: none; border-radius: 0; background: none; color: var(--text); font-size: 14px;
      }
      .row:hover .what { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .what { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .at { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .r { min-width: 58px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .detail { grid-column: 1 / -1; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .up { color: var(--accent-2); }
      .down { color: var(--danger); }
      .flat { color: var(--muted); }
      .chip { margin-left: 6px; padding: 0 7px; border-radius: 999px; border: 1px solid currentColor; font-size: 11px; opacity: 0.85; }
      .against { color: var(--warn); }
      .none { margin: 2px 0 2px 10px; font-size: 12.5px; color: var(--muted); }
      .empty { margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
      .review {
        width: 100%; display: block; margin: 0 0 6px; padding: 4px 0 6px 10px; text-align: left; border: none; border-left: 2px solid var(--ai);
        border-radius: 0; background: none; color: var(--text); font-size: 13px;
      }
      .review:hover .what { text-decoration: underline; text-decoration-color: var(--muted); }
      .review .what { color: var(--ai); font-size: 12px; }
      .review .text { display: block; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `,
  ],
  template: `
    @if (journal(); as j) {
      @if (j.groups.length) {
        <button type="button" class="sum" title="Ouvrir le calendrier du journal" (click)="kopilia.openCalendar()">
          30 jours ·
          @if (j.totals.count) {
            <b [class]="sign(j.totals.r)">{{ r(j.totals.r) }}</b> sur {{ j.totals.count }} trade{{ j.totals.count > 1 ? 's' : '' }} fermé{{ j.totals.count > 1 ? 's' : '' }} ·
            {{ j.totals.wins }} gagnant{{ j.totals.wins > 1 ? 's' : '' }}, {{ j.totals.losses }} perdant{{ j.totals.losses > 1 ? 's' : '' }}, {{ j.totals.neutral }} neutre{{ j.totals.neutral > 1 ? 's' : '' }}
          } @else {
            aucun trade fermé
          }
        </button>
        @if (j.reviewing) {
          <p class="review"><span class="what">Analyse de ton trading en cours…</span></p>
        } @else if (j.review) {
          <button type="button" class="review" title="Ouvrir l'analyse de ton trading" (click)="kopilia.openReview(j.review.id)">
            <span class="what">Analyse de l'IA · {{ j.review.days }} jours · {{ when(j.review.createdAt) }}</span>
            <span class="text">{{ j.review.summary }}</span>
          </button>
        }
        <div class="list">
          @for (g of j.groups; track key(g)) {
            <section>
              <div class="head">
                <span class="name"
                  >{{ cap(g.name) }}
                  @if (g.analysisId) {
                    <span class="since">· fiche {{ g.state === 'open' ? 'ouverte' : 'fermée' }} {{ when(g.openedAt!) }}</span>
                  }
                </span>
                @if (g.trades.length) {
                  <span [class]="'r ' + sign(g.r)">{{ r(g.r) }}</span>
                }
              </div>
              @if (g.idea || g.firstIdea) {
                <p class="idea">
                  @if (g.firstIdea) {
                    {{ g.firstIdea }} <span class="turn">→ {{ g.idea }}</span>
                  } @else {
                    {{ g.idea }}
                  }
                </p>
              }
              @if (g.trades.length) {
                <ul>
                  @for (l of g.trades; track l.id) {
                    <li>
                      <button type="button" class="row" [attr.title]="title(l)" (click)="kopilia.openTrade(l.id)">
                        <span class="what"
                          >{{ l.side === 'long' ? '↑ achat' : '↓ vente' }}
                          @if (l.fidelity === 'against') {
                            <span class="chip against">contre la fiche</span>
                          }
                        </span>
                        <span class="at">{{ when(l.at) }}</span>
                        <span [class]="'r ' + tone(l.outcome)"
                          >@if (l.r !== undefined && l.state === 'closed') {
                            {{ r(l.r) }}
                          } @else {
                            —
                          }</span
                        >
                        @if (detail(l)) {
                          <span class="detail">{{ detail(l) }}</span>
                        }
                      </button>
                    </li>
                  }
                </ul>
              } @else {
                <p class="none">{{ g.untaken ?? 'Pas encore de trade sur cette fiche.' }}</p>
              }
            </section>
          }
        </div>
      } @else {
        <p class="empty">Ton journal se remplit seul : chaque ordre passé par Kopilia s'y range avec la fiche du produit. Dis « note dans mon journal… » après un trade.</p>
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
  readonly when = (ms: number) => whenText(ms);
  readonly detail = lineDetail;

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

  /** Un total en R : gagné, perdu, ou neutre (sous 0,1 R, comme un trade). */
  sign(r: number): "up" | "down" | "flat" {
    return Math.abs(r) < NEUTRAL_R ? "flat" : r > 0 ? "up" : "down";
  }

  key(g: JournalGroup): string {
    return g.analysisId ?? "sans-fiche";
  }

  cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Au survol : le résultat en mots, en devise, et la fiche. */
  title(l: JournalLine): string {
    const money = l.profit !== undefined ? ` (${moneyLabel(l.profit, l.currency, { sign: true })})` : "";
    return [`${outcomeText(l.outcome) || l.remark || ""}${money}`.trim(), FIDELITY_LABELS[l.fidelity], "Ouvrir la page du trade"].filter(Boolean).join(" · ");
  }
}
