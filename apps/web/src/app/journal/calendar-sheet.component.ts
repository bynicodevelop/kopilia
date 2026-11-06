import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { NEUTRAL_R, moneyLabel, type JournalBilan } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { dayTint, lineDetail, monthGrid, rText, tone, whenText, type CalendarCell } from "./journal-view";

/**
 * Le calendrier du journal, en plein écran : les jours de bourse du mois,
 * chacun teinté en vert ou rouge pâle selon son R, le total de chaque semaine,
 * et à droite le bilan du mois (répartitions, ce qui revient). Un clic sur un
 * jour montre ses trades ; un clic sur un trade ouvre sa page. Le reste se dit
 * (« le mois d'octobre », « ma journée du 3 »).
 */
@Component({
  selector: "kp-calendar-sheet",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto; }
      .inner { max-width: 1120px; margin: 0 auto; padding: 0 16px 48px; }
      header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 16px 0 10px; background: var(--bg); border-bottom: 1px solid var(--border); }
      h1 { margin: 0; font-size: 18px; flex: 1; min-width: 0; }
      h1 small { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 6px; }
      .total { font-size: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 24px; margin-top: 14px; }
      @media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
      .cal { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) 78px; gap: 6px; }
      .dow { font-size: 11px; color: var(--muted); padding: 0 2px; }
      .cell {
        min-height: 64px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 10px; background: none; color: var(--text);
        text-align: left; display: flex; flex-direction: column; justify-content: space-between; font: inherit;
      }
      .cell.out { opacity: 0.3; }
      .cell.empty { cursor: default; }
      .cell.on { outline: 1px solid var(--accent); }
      .cell .d { font-size: 11px; color: var(--muted); }
      .cell .v { font-size: 15px; font-variant-numeric: tabular-nums; }
      .cell .n { font-size: 11px; color: var(--muted); }
      .week { padding: 6px 4px; font-size: 13px; font-variant-numeric: tabular-nums; display: flex; flex-direction: column; justify-content: center; }
      .week .n { font-size: 11px; color: var(--muted); }
      h2 { margin: 16px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
      ul { list-style: none; margin: 0; padding: 0; }
      .rows li { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--border); font-size: 13.5px; }
      .rows li:first-child { border-top: none; }
      .rows .label { flex: 1; min-width: 0; }
      .rows .n { color: var(--muted); font-size: 12px; }
      .rows .v { font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
      .day { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--border); }
      .day h3 { margin: 0 0 4px; font-size: 15px; }
      .trade {
        width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 2px 10px; align-items: baseline; padding: 6px 0;
        border: none; border-top: 1px solid var(--border); border-radius: 0; background: none; color: var(--text); text-align: left; font-size: 14px;
      }
      .trade:hover .what { text-decoration: underline; text-decoration-color: var(--muted); }
      .trade .at { font-size: 12px; color: var(--muted); }
      .trade .detail { grid-column: 1 / -1; font-size: 12px; color: var(--muted); }
      .hint { margin: 14px 0 0; font-size: 12.5px; color: var(--muted); }
      .up { color: var(--accent-2); }
      .down { color: var(--danger); }
      .flat { color: var(--muted); }
    `,
  ],
  template: `
    @if (kopilia.calendarOpen(); as c) {
      <div class="sheet" role="dialog" aria-modal="true" [attr.aria-label]="'Calendrier du journal, ' + c.bilan.label">
        <div class="inner">
          <header>
            <h1>Journal · {{ c.bilan.label }}<small>{{ summary(c.bilan) }}</small></h1>
            <span [class]="'total ' + sign(c.bilan.totals.r)">{{ c.bilan.totals.count ? r(c.bilan.totals.r) : '' }}</span>
            <button type="button" class="icon" aria-label="Fermer le calendrier" (click)="kopilia.closeCalendar()">×</button>
          </header>
          <div class="grid">
            <div>
              <div class="cal">
                @for (d of dows; track d) {
                  <span class="dow">{{ d }}</span>
                }
                <span class="dow">semaine</span>
                @for (w of weeks(); track w.cells[0].date) {
                  @for (cell of w.cells; track cell.date) {
                    <button
                      type="button"
                      class="cell"
                      [class.out]="!cell.inMonth"
                      [class.empty]="!cell.count"
                      [class.on]="c.day?.date === cell.date"
                      [style.background]="tint(cell)"
                      [attr.aria-label]="cellLabel(cell)"
                      [disabled]="!cell.count"
                      (click)="kopilia.selectCalendarDay(cell.date)"
                    >
                      <span class="d">{{ cell.day }}</span>
                      @if (cell.count) {
                        <span [class]="'v ' + sign(cell.r)">{{ r(cell.r) }}</span>
                        <span class="n">{{ cell.count }} trade{{ cell.count > 1 ? 's' : '' }}</span>
                      }
                    </button>
                  }
                  <span class="week">
                    @if (w.count) {
                      <span [class]="sign(w.r)">{{ r(w.r) }}</span>
                      <span class="n">{{ w.count }} trade{{ w.count > 1 ? 's' : '' }}</span>
                    } @else {
                      <span class="n">—</span>
                    }
                  </span>
                }
              </div>
              @if (c.day; as day) {
                <div class="day">
                  <h3>
                    {{ cap(day.bilan.label) }} · <span [class]="sign(day.bilan.totals.r)">{{ r(day.bilan.totals.r) }}</span>
                    <small class="flat">· {{ summary(day.bilan) }}</small>
                  </h3>
                  @for (l of day.bilan.trades; track l.id) {
                    <button type="button" class="trade" [attr.title]="'Ouvrir la page du trade ' + l.id" (click)="kopilia.openTrade(l.id)">
                      <span class="what">{{ l.name }} · {{ l.side === 'long' ? '↑ achat' : '↓ vente' }}</span>
                      <span class="at">{{ when(l.at) }}</span>
                      <span [class]="tone(l.outcome)">{{ l.r !== undefined ? r(l.r) : '—' }}</span>
                      @if (detail(l)) {
                        <span class="detail">{{ detail(l) }}</span>
                      }
                    </button>
                  }
                  @for (p of day.bilan.patterns; track p.key) {
                    <p class="hint">{{ p.label }} : {{ p.count }} trade{{ p.count > 1 ? 's' : '' }}, {{ r(p.r) }}</p>
                  }
                </div>
              }
              <p class="hint">Un clic sur un jour montre ses trades. Dis « le mois d'octobre » ou « ma journée du 3 » pour changer.</p>
            </div>
            <div>
              @if (c.bilan.totals.count) {
                <h2>Le mois</h2>
                <ul class="rows">
                  <li><span class="label">Par trade</span><span [class]="'v ' + sign(c.bilan.totals.avgR)">{{ r(c.bilan.totals.avgR) }}</span></li>
                  @if (c.bilan.totals.avgWin !== undefined) {
                    <li><span class="label">Gain moyen</span><span class="v up">{{ r(c.bilan.totals.avgWin) }}</span></li>
                  }
                  @if (c.bilan.totals.avgLoss !== undefined) {
                    <li><span class="label">Perte moyenne</span><span class="v down">{{ r(c.bilan.totals.avgLoss) }}</span></li>
                  }
                  @if (c.bilan.streak.maxLosses >= 2) {
                    <li><span class="label">Plus longue série de pertes</span><span class="v">{{ c.bilan.streak.maxLosses }}</span></li>
                  }
                  @if (c.bilan.totals.currency) {
                    <li><span class="label">En devise</span><span [class]="'v ' + sign(c.bilan.totals.r)">{{ money(c.bilan) }}</span></li>
                  }
                </ul>
                @for (b of c.bilan.breakdowns; track b.key) {
                  <h2>{{ b.label }}</h2>
                  <ul class="rows">
                    @for (row of b.rows; track row.label) {
                      <li>
                        <span class="label">{{ row.label }} <span class="n">· {{ row.count }}</span></span><span [class]="'v ' + sign(row.r)">{{ r(row.r) }}</span>
                      </li>
                    }
                  </ul>
                }
                @if (c.bilan.patterns.length) {
                  <h2>Ce qui revient</h2>
                  <ul class="rows">
                    @for (p of c.bilan.patterns; track p.key) {
                      <li>
                        <span class="label">{{ p.label }} <span class="n">· {{ p.count }}</span></span><span [class]="'v ' + sign(p.r)">{{ r(p.r) }}</span>
                      </li>
                    }
                  </ul>
                }
                @if (c.bilan.missingNotes.length) {
                  <p class="hint">{{ c.bilan.missingNotes.length }} trade{{ c.bilan.missingNotes.length > 1 ? 's' : '' }} sans note ce mois-ci : dis « note dans mon journal… ».</p>
                }
              } @else {
                <p class="hint">Aucun trade fermé ce mois-ci.</p>
              }
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class CalendarSheetComponent {
  readonly kopilia = inject(KopiliaService);
  readonly dows = ["lun.", "mar.", "mer.", "jeu.", "ven."];
  readonly weeks = computed(() => {
    const c = this.kopilia.calendarOpen();
    return c ? monthGrid(c.month, c.bilan.days) : [];
  });
  readonly r = rText;
  readonly tone = tone;
  readonly detail = lineDetail;
  readonly when = (ms: number) => whenText(ms);

  sign(r: number): "up" | "down" | "flat" {
    return Math.abs(r) < NEUTRAL_R ? "flat" : r > 0 ? "up" : "down";
  }

  tint(cell: CalendarCell): string | null {
    return cell.inMonth ? dayTint(cell.r, cell.count) : null;
  }

  cellLabel(cell: CalendarCell): string {
    return cell.count ? `${cell.day} : ${cell.count} trade${cell.count > 1 ? "s" : ""}, ${rText(cell.r)}` : `${cell.day} : aucun trade`;
  }

  summary(b: JournalBilan): string {
    const t = b.totals;
    if (!t.count) return "aucun trade fermé";
    return `${t.count} trade${t.count > 1 ? "s" : ""} · ${t.wins} gagnant${t.wins > 1 ? "s" : ""}, ${t.losses} perdant${t.losses > 1 ? "s" : ""}, ${t.neutral} neutre${t.neutral > 1 ? "s" : ""}`;
  }

  money(b: JournalBilan): string {
    return moneyLabel(b.totals.profit, b.totals.currency, { sign: true });
  }

  cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
