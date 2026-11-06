import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from "@angular/core";
import {
  capitalOf,
  findTier,
  lotsLabel,
  moneyLabel,
  percentLabel,
  riskLabel,
  sizePosition,
  type Drawing,
  type Risk,
  type RiskMode,
  type RiskTier,
  type TradingState,
} from "@kopilia/contracts";

type Box = Extract<Drawing, { kind: "position" }>;

/** La marge d'une position (le calcul du courtier) et la marge libre du compte. */
export interface MarginInfo {
  margin?: number;
  freeMargin?: number;
}
export type MarginQuery = { symbol: string; side: "long" | "short"; lots: number; price: number };

/** Délai entre la dernière frappe et le calcul de la marge (le courtier est interrogé). */
const MARGIN_DEBOUNCE_MS = 400;

/** « € », « $ », sinon le code de la devise. */
export function currencySymbol(code: string): string {
  try {
    const part = new Intl.NumberFormat("fr-FR", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/**
 * Le risque d'une boîte de trade (clic droit, « Risque… ») : ce qu'on fixe
 * (un pourcentage du capital, un montant ou des lots), et ce qui s'en déduit
 * en direct, comme le serveur le calculera : la taille, la perte au stop, le
 * gain à l'objectif, la commission, et la marge que demanderait le courtier.
 * Ses paliers (« A+ 3 % ») se choisissent d'un clic, avec leurs mots. « Par
 * défaut » la remet au risque du money management. Le même réglage se dit à
 * Kopilia (« mets la boîte à 2 % », « mets-la au palier A+ »).
 */
@Component({
  selector: "kp-risk-menu",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; overflow-x: hidden; }
      form { display: grid; gap: 7px; padding: 2px; min-width: 0; }
      .title { display: flex; justify-content: space-between; align-items: baseline; font-weight: 600; padding: 0 2px 2px; }
      .muted { color: var(--muted); font-weight: 400; }
      .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
      .tiers { display: flex; flex-wrap: wrap; gap: 4px; }
      .tiers button { padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--muted); font: inherit; }
      .tiers button.on { color: var(--text); border-color: var(--accent); }
      .modes button { padding: 3px 0; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--muted); font: inherit; }
      .modes button.on { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
      .value { display: flex; align-items: center; gap: 6px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); }
      .value input { flex: 1; min-width: 0; padding: 4px 0; border: none; background: none; color: var(--text); font: inherit; outline: none; }
      .value span { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); white-space: nowrap; }
      dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; margin: 2px 2px 0; }
      dt { color: var(--muted); }
      dd { margin: 0; text-align: right; }
      .down { color: var(--danger); }
      .up { color: var(--accent-2); }
      .note { margin: 0 2px; color: var(--muted); font-size: 11px; line-height: 1.4; }
      .warn { margin: 0 2px; color: var(--warn); font-size: 11px; line-height: 1.4; }
      .actions { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
      .grow { flex: 1; }
      .actions button { padding: 4px 10px; border-radius: 6px; font: inherit; border: 1px solid var(--border); background: none; color: var(--text); }
      .actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      .actions .primary:disabled { opacity: .5; }
      .actions .link { border-color: transparent; color: var(--muted); padding-left: 2px; padding-right: 2px; }
      .actions .link:hover { color: var(--text); }
    `,
  ],
  template: `
    <form (submit)="$event.preventDefault(); apply()">
      <div class="title">
        <span>Risque de la boîte</span>
        @if (state()?.account; as a) {
          <span class="muted">{{ a.demo ? "démo" : "réel" }}</span>
        }
      </div>
      @if (tiers().length) {
        <div class="tiers" role="radiogroup" aria-label="Tes paliers">
          @for (t of tiers(); track t.name) {
            <button type="button" role="radio" [attr.aria-checked]="tier() === t.name" [class.on]="tier() === t.name" [attr.title]="t.when ?? null" (click)="pickTier(t)">
              {{ t.name }} · {{ pct(t.percent) }}
            </button>
          }
        </div>
        @if (tierWhen(); as w) {
          <p class="note">{{ tier() }} : {{ w }}</p>
        }
      }
      <div class="modes" role="radiogroup" aria-label="Ce que tu fixes">
        @for (m of modes; track m.mode) {
          <button type="button" role="radio" [attr.aria-checked]="mode() === m.mode" [class.on]="mode() === m.mode" (click)="setMode(m.mode)">
            {{ m.mode === "amount" ? symbol() : m.label }}
          </button>
        }
      </div>
      <label class="value">
        <input #field type="number" min="0" [attr.step]="mode() === 'lots' ? lotStep() : mode() === 'percent' ? 0.1 : 1" [value]="value() ?? ''" (input)="setValue($event)" aria-label="Valeur du risque" />
        <span>{{ unit() }}</span>
      </label>
      @if (sizing(); as s) {
        <dl>
          <dt>Taille</dt>
          <dd>{{ s.lots ? lots(s.lots) : "—" }}</dd>
          <dt>Perte au stop</dt>
          <dd class="down">{{ s.lots ? money(-s.loss) + " · " + pct(s.riskPercent) : "—" }}</dd>
          <dt>Gain à l'objectif</dt>
          <dd class="up">{{ s.lots ? money(s.gain) : "—" }}</dd>
          @if (s.fees) {
            <dt>Commission comprise</dt>
            <dd>{{ plainMoney(s.fees) }}</dd>
          }
          @if (s.lots && margin(); as m) {
            @if (m.margin !== undefined) {
              <dt>Marge</dt>
              <dd>{{ plainMoney(m.margin) }}@if (m.freeMargin !== undefined) {<span class="muted"> / {{ plainMoney(m.freeMargin) }} libres</span>}</dd>
            }
          }
        </dl>
        @if (s.lots && marginShort()) {
          <p class="warn">Marge insuffisante : le courtier refuserait cet ordre.</p>
        }
        @if (s.problem) {
          <p class="warn">{{ s.problem }}</p>
        } @else if (s.capped === "max-risk") {
          <p class="warn">Réduite à ton plafond de {{ pct(state()!.settings.maxRiskPercent) }} par trade.</p>
        }
      } @else {
        <p class="note">{{ state()?.error ?? "Compte ou conditions du produit pas encore lus." }}</p>
      }
      @if (commissionNote(); as n) {
        <p class="note">{{ n }}</p>
      }
      <div class="actions">
        <button type="button" class="link" (click)="save.emit(null)" [attr.title]="'Risque du money management : ' + defaultText()">Par défaut</button>
        <span class="grow"></span>
        <button type="button" (click)="cancel.emit()">Annuler</button>
        <button type="submit" class="primary" [disabled]="!valid()">Appliquer</button>
      </div>
    </form>
  `,
})
export class RiskMenuComponent {
  readonly box = input.required<Box>();
  readonly state = input<TradingState | undefined>(undefined);
  /** Le calcul de marge du courtier (par le serveur) ; sans : pas de marge affichée. */
  readonly marginOf = input<((q: MarginQuery) => Promise<MarginInfo>) | undefined>(undefined);
  readonly save = output<Risk | null>();
  readonly cancel = output<void>();
  readonly modes: Array<{ mode: RiskMode; label: string }> = [
    { mode: "percent", label: "%" },
    { mode: "amount", label: "€" },
    { mode: "lots", label: "lots" },
  ];
  readonly mode = signal<RiskMode>("percent");
  readonly value = signal<number | undefined>(1);
  /** Le palier choisi (son nom) ; changer la valeur à la main le quitte. */
  readonly tier = signal<string | undefined>(undefined);
  readonly margin = signal<MarginInfo | undefined>(undefined);
  readonly tiers = computed<RiskTier[]>(() => this.state()?.settings.tiers ?? []);
  readonly tierWhen = computed(() => {
    const name = this.tier();
    return name ? findTier(this.tiers(), name)?.when : undefined;
  });
  readonly marginShort = computed(() => {
    const m = this.margin();
    return m?.margin !== undefined && m.freeMargin !== undefined && m.margin > m.freeMargin;
  });
  private marginTimer?: ReturnType<typeof setTimeout>;
  private marginSeq = 0;
  private marginKey = "";

  private readonly currency = computed(() => this.state()?.account?.currency ?? "");
  readonly symbol = computed(() => currencySymbol(this.currency() || "EUR"));
  readonly lotStep = computed(() => this.state()?.terms[this.box().symbol]?.volumeStep ?? 0.01);
  readonly unit = computed(() => {
    const a = this.state()?.account;
    if (this.mode() === "percent") return a ? `% de ${moneyLabel(capitalOf(a, this.state()!.settings), a.currency)}` : "%";
    if (this.mode() === "amount") return `de risque`;
    return "lots";
  });
  readonly valid = computed(() => {
    const v = this.value();
    return v !== undefined && v > 0 && Number.isFinite(v);
  });
  /** La taille et les montants pour le risque saisi, comme le serveur les calculera. */
  readonly sizing = computed(() => {
    const s = this.state();
    const terms = s?.terms[this.box().symbol];
    if (!s?.account || !terms || !this.valid()) return undefined;
    return sizePosition(
      this.box(),
      terms,
      capitalOf(s.account, s.settings),
      { mode: this.mode(), value: this.value()! },
      {
        maxRiskPercent: s.settings.maxRiskPercent,
        currency: s.account.currency,
      },
    );
  });
  readonly defaultText = computed(() => {
    const s = this.state();
    return s ? riskLabel(s.settings.defaultRisk, this.currency()) : "";
  });
  readonly commissionNote = computed(() => {
    const t = this.state()?.terms[this.box().symbol];
    if (!t) return "";
    if (t.commissionSource === "none") return "Commission inconnue, comptée à 0 : dis-la à Kopilia si ton compte en prend une.";
    return `Commission de ${this.plainMoney(t.commission)} par lot aller-retour, ${t.commissionSource === "user" ? "réglée par toi" : "lue sur tes transactions"}.`;
  });

  constructor() {
    // À l'ouverture : le risque de la boîte, sinon celui du money management ; un palier, à son pourcentage du moment.
    effect(() => {
      const r = this.box().risk ?? this.state()?.settings.defaultRisk;
      untracked(() => {
        if (!r) return;
        const tier = r.tier ? findTier(this.tiers(), r.tier) : undefined;
        this.mode.set(tier ? "percent" : r.mode);
        this.value.set(tier ? tier.percent : r.value);
        this.tier.set(tier?.name);
      });
    });
    // La marge de la taille saisie, demandée au courtier un instant après la dernière frappe.
    effect((onCleanup) => {
      const lots = this.sizing()?.lots;
      const ask = this.marginOf();
      const b = this.box();
      // Même taille, même prix : la marge déjà lue vaut encore (l'état change souvent sans elle).
      const key = `${b.symbol}:${b.side}:${lots}:${b.entry}`;
      if (key === this.marginKey) return;
      this.marginKey = key;
      clearTimeout(this.marginTimer);
      const seq = ++this.marginSeq;
      if (!ask || !lots) {
        untracked(() => this.margin.set(undefined));
        return;
      }
      this.marginTimer = setTimeout(() => {
        ask({ symbol: b.symbol, side: b.side, lots, price: b.entry })
          .then((m) => seq === this.marginSeq && this.margin.set(m))
          .catch(() => seq === this.marginSeq && this.margin.set(undefined));
      }, MARGIN_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(this.marginTimer));
    });
  }

  pickTier(t: RiskTier): void {
    this.mode.set("percent");
    this.value.set(t.percent);
    this.tier.set(t.name);
  }

  setMode(mode: RiskMode): void {
    if (mode === this.mode()) return;
    // Le même risque, dit autrement : la valeur suit ce que la boîte engage déjà.
    const s = this.sizing();
    const a = this.state()?.account;
    let next: number | undefined;
    if (s && s.lots && a) {
      if (mode === "lots") next = s.lots;
      else if (mode === "amount") next = Math.round(s.loss);
      else next = Number(s.riskPercent.toFixed(2));
    }
    this.mode.set(mode);
    this.value.set(next ?? this.value());
    this.tier.set(undefined);
  }

  setValue(e: Event): void {
    const v = (e.target as HTMLInputElement).valueAsNumber;
    this.value.set(Number.isFinite(v) ? v : undefined);
    this.tier.set(undefined);
  }

  apply(): void {
    if (!this.valid()) return;
    const tier = this.tier();
    this.save.emit({ mode: this.mode(), value: this.value()!, ...(tier ? { tier } : {}) });
  }

  lots(v: number): string {
    return lotsLabel(v);
  }
  pct(v: number): string {
    return percentLabel(v);
  }
  money(v: number): string {
    return moneyLabel(v, this.currency(), { sign: true });
  }
  plainMoney(v: number): string {
    return moneyLabel(v, this.currency());
  }
}
