import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from "@angular/core";
import {
  ALERT_CONDITIONS,
  ALERT_CONDITION_NAMES,
  ALERT_TRIGGERS,
  ALERT_TRIGGER_NAMES,
  Alert,
  AlertTrigger,
  Drawing,
  MAX_ALERT_MESSAGE,
} from "@kopilia/contracts";
import { AlertDraft, alertLabel, alertStatus, draftError, draftTitle } from "./chart-alerts";
import { TIMEFRAME_CHIP } from "./candles";

/**
 * Le panneau des alertes d'un graphique (ouvert par la cloche de la barre
 * d'outils, ou par le clic droit, le « + » et Alt+A sur le graphique) : la
 * liste des alertes du produit (suspendre, réactiver, régler, retirer), ou le
 * réglage d'une alerte : son prix, son sens, quand elle part, la consigne
 * que Kopilia suivra. Le graphique garde l'alerte en cours de réglage ; ce
 * panneau en règle une copie et la rend à l'enregistrement.
 */
@Component({
  selector: "kp-alert-menu",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      .head { display: flex; justify-content: space-between; padding: 2px 4px 6px; font-weight: 600; }
      .muted { color: var(--muted); font-weight: 400; }
      .item { display: flex; align-items: center; gap: 4px; padding: 2px 2px 2px 6px; border-radius: 6px; }
      .item:hover { background: var(--panel-2); }
      .item.off .name { color: var(--muted); }
      .bell { flex: none; width: 13px; height: 13px; fill: none; stroke: var(--warn); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .item.off .bell { stroke: var(--muted); }
      .name { flex: 1; min-width: 0; padding: 3px 4px; border: none; background: none; color: var(--text); font: inherit; text-align: left; }
      .name span, .name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .name small { color: var(--muted); font-size: 11px; }
      .mini { flex: none; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 5px; background: none; color: var(--muted); }
      .mini svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .mini:hover { color: var(--text); background: var(--panel); }
      .mini.danger:hover { color: var(--danger); }
      .empty { margin: 4px 6px 8px; color: var(--muted); }
      form { display: grid; gap: 6px; padding: 2px; }
      .title { font-weight: 600; padding: 0 2px 2px; }
      .row { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 6px; }
      .row > span, .col > span { color: var(--muted); }
      .col { display: grid; gap: 3px; }
      select, input, textarea {
        min-width: 0; padding: 3px 6px; border: 1px solid var(--border); border-radius: 6px;
        background: var(--panel-2); color: var(--text); font: inherit;
      }
      textarea { resize: vertical; min-height: 44px; }
      .note { margin: 0; color: var(--muted); }
      .err { margin: 0; color: var(--danger); }
      .actions { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
      .grow { flex: 1; }
      .actions button { padding: 4px 10px; border-radius: 6px; font: inherit; border: 1px solid var(--border); background: none; color: var(--text); }
      .actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      .actions .primary:disabled { opacity: .5; }
      .actions .danger { color: var(--danger); border-color: transparent; padding-left: 4px; padding-right: 4px; }
      .actions .danger:hover { border-color: var(--danger); }
    `,
  ],
  template: `
    @if (form(); as f) {
      <form (submit)="$event.preventDefault(); submit()">
        <div class="title">{{ title() }}</div>
        @if (f.target.kind === 'price') {
          <label class="row"><span>Prix</span>
            <input type="number" min="0" [attr.step]="step()" [value]="f.target.price" (input)="setPrice($event)" />
          </label>
        }
        <label class="row"><span>Condition</span>
          <select (change)="patch({ condition: $any($event.target).value })">
            @for (c of conditions; track c) {
              <option [value]="c" [selected]="c === f.condition">{{ conditionNames[c] }}</option>
            }
          </select>
        </label>
        <label class="row"><span>Déclenchement</span>
          <select (change)="patch({ trigger: $any($event.target).value })">
            @for (t of triggers; track t) {
              <option [value]="t" [selected]="t === f.trigger">{{ triggerName(t) }}</option>
            }
          </select>
        </label>
        <label class="col"><span>Consigne pour Kopilia (facultatif)</span>
          <textarea rows="2" [attr.maxlength]="maxMessage" placeholder="Regarde le RSI 1 h et dis-moi si la cassure tient" [value]="f.message" (input)="patch({ message: $any($event.target).value })"></textarea>
        </label>
        @if (f.stopped) {
          <p class="note">{{ f.stopped === 'expired' ? "Expirée" : "Déjà partie" }} : l'enregistrer la réarme.</p>
        }
        @if (error(); as err) {
          <p class="err">{{ err }}</p>
        }
        <div class="actions">
          @if (f.id) {
            <button type="button" class="danger" (click)="remove.emit(f.id)">Supprimer</button>
          }
          <span class="grow"></span>
          <button type="button" (click)="cancel.emit()">Annuler</button>
          <button type="submit" class="primary" [disabled]="!!error()">{{ f.id ? "Enregistrer" : "Créer l'alerte" }}</button>
        </div>
      </form>
    } @else {
      <div class="head">
        <span>Alertes</span><span class="muted">{{ watched() }} surveillée{{ watched() > 1 ? "s" : "" }}</span>
      </div>
      @for (a of alerts(); track a.id) {
        <div class="item" [class.off]="a.state !== 'active'">
          <svg class="bell" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1.2H3z" /><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" /></svg>
          <button type="button" class="name" title="Régler" (click)="edit.emit(a)">
            <span>{{ label(a) }}</span><small>{{ status(a) }}{{ a.message ? " · consigne" : "" }}</small>
          </button>
          @if (a.state === 'active') {
            <button type="button" class="mini" title="Suspendre" [attr.aria-label]="aria('Suspendre', a)" (click)="pause.emit({ id: a.id, paused: true })">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4v8M10 4v8" /></svg>
            </button>
          } @else {
            <button type="button" class="mini" title="Réactiver" [attr.aria-label]="aria('Réactiver', a)" (click)="pause.emit({ id: a.id, paused: false })">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.8v8.4L12 8z" /></svg>
            </button>
          }
          <button type="button" class="mini danger" title="Supprimer" [attr.aria-label]="aria('Supprimer', a)" (click)="remove.emit(a.id)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      } @empty {
        <p class="empty">Aucune alerte. Clic droit sur une ligne, ou le + contre l'axe des prix (Alt+A).</p>
      }
    }
  `,
})
export class AlertMenuComponent {
  /** Les alertes du produit, les tracés (pour nommer leurs lignes), ses décimales. */
  readonly alerts = input.required<Alert[]>();
  readonly drawings = input.required<Drawing[]>();
  readonly digits = input.required<number>();
  /** L'alerte à régler (null : la liste). */
  readonly draft = input<AlertDraft | null>(null);

  readonly edit = output<Alert>();
  readonly save = output<AlertDraft>();
  readonly cancel = output<void>();
  readonly remove = output<string>();
  readonly pause = output<{ id: string; paused: boolean }>();

  readonly conditions = ALERT_CONDITIONS;
  readonly conditionNames = ALERT_CONDITION_NAMES;
  readonly triggers = ALERT_TRIGGERS;
  readonly maxMessage = MAX_ALERT_MESSAGE;
  /** La copie réglée ici. */
  readonly form = signal<AlertDraft | null>(null);
  readonly title = computed(() => {
    const f = this.form();
    return f ? draftTitle(f, this.drawings(), this.digits()) : "";
  });
  readonly error = computed(() => {
    const f = this.form();
    return f ? draftError(f) : undefined;
  });
  readonly watched = computed(() => this.alerts().filter((a) => a.state === "active").length);
  /** Le pas du champ de prix : une unité de la dernière décimale. */
  readonly step = computed(() => (10 ** -this.digits()).toFixed(this.digits()));

  constructor() {
    effect(() => {
      const d = this.draft();
      untracked(() => this.form.set(d ? { ...d, target: { ...d.target } } : null));
    });
  }

  label(a: Alert): string {
    return alertLabel(a, this.drawings(), this.digits());
  }

  /** « Suspendre l'alerte 3 960,00 · à la hausse » : le nom d'un bouton de la liste. */
  aria(verb: string, a: Alert): string {
    return `${verb} l'alerte ${this.label(a)}`;
  }

  status(a: Alert): string {
    return alertStatus(a, (tf) => TIMEFRAME_CHIP[tf] ?? tf);
  }

  /** « Une fois par bougie (15m) » : dans l'unité où l'alerte est posée. */
  triggerName(t: AlertTrigger): string {
    const f = this.form();
    return t === "once" || !f ? ALERT_TRIGGER_NAMES[t] : `${ALERT_TRIGGER_NAMES[t]} (${TIMEFRAME_CHIP[f.timeframe] ?? f.timeframe})`;
  }

  patch(changes: Partial<AlertDraft>): void {
    this.form.update((f) => (f ? { ...f, ...changes } : f));
  }

  setPrice(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.form.update((f) => (f && f.target.kind === "price" ? { ...f, target: { kind: "price", price: v === "" ? NaN : Number(v) } } : f));
  }

  submit(): void {
    const f = this.form();
    if (f && !this.error()) this.save.emit(f);
  }
}
