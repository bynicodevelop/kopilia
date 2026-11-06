import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { DrawingSuggestion, OUTCOME_NAMES, REACTION_NAMES, STATE_NAMES, Scenario, ScenarioEvent, rewardRisk } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { formatPrice } from "../dashboard/candles";
import { formatDateTime } from "../format";

const SIDE: Record<Scenario["direction"], string> = { long: "Achat", short: "Vente" };
const BIAS: Record<string, string> = { up: "haussière", down: "baissière", neutral: "neutre" };
const HORIZON: Record<string, string> = { intraday: "séance", swing: "plusieurs jours" };
const KIND: Record<ScenarioEvent["kind"], string> = {
  opened: "Ouvert",
  alert: "Alerte",
  rendezvous: "Rendez-vous",
  wake: "Réveil",
  decision: "Décision",
  context: "Contexte",
  feedback: "Toi",
  update: "Mise à jour",
  note: "Note",
  proposed: "Déclenché",
  closed: "Fermé",
};

/**
 * La recherche d'opportunités en plein écran : les setups déclenchés (avec de
 * quoi dire « je le prends » ou « pas pour moi »), ceux en attente qu'elle
 * surveille, chacun avec son dossier et le fil de ses décisions, les
 * hypothèses (les siennes et les tiennes), ce qui s'est fermé et pourquoi, et
 * les résultats des setups proposés.
 */
@Component({
  selector: "kp-setups-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto; }
      .inner { max-width: 760px; margin: 0 auto; padding: 0 16px 56px; }
      header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 18px 0 12px; background: var(--bg); border-bottom: 1px solid var(--border); }
      h1 { font-size: 18px; margin: 0; flex: 1; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 28px 0 10px; }
      h2 small { text-transform: none; letter-spacing: 0; font-weight: normal; margin-left: 6px; }
      .icon { border: none; background: none; color: inherit; padding: 0 4px; font-size: 22px; line-height: 1; }
      .small { padding: 4px 10px; font-size: 13px; border-radius: 8px; }
      .note { color: var(--muted); font-size: 14px; margin: 6px 0; }
      .card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 12px 14px; margin: 8px 0; }
      .card.proposed { border-color: var(--ai); }
      .card.review { border-color: var(--warn); }
      .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .name { font-weight: 600; }
      .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
      .tag.long { color: var(--accent-2); }
      .tag.short { color: var(--danger); }
      .tag.ai { color: var(--ai); }
      .tag.warn { color: var(--warn); }
      .spacer { flex: 1; }
      .levels { font-variant-numeric: tabular-nums; margin: 8px 0 0; font-size: 14px; }
      .text { font-size: 14px; margin: 6px 0 0; }
      .text b { font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin-right: 4px; }
      .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      details { margin-top: 8px; }
      summary { cursor: pointer; color: var(--accent); font-size: 13px; }
      ol.fil { list-style: none; padding: 0; margin: 6px 0 0; border-left: 2px solid var(--border); }
      ol.fil li { font-size: 13px; padding: 4px 0 4px 10px; }
      ol.fil time { color: var(--muted); margin-right: 6px; font-variant-numeric: tabular-nums; }
      ol.fil .k { font-weight: 600; margin-right: 4px; }
      ol.fil .user { color: var(--accent); }
      ul.hyps { list-style: none; padding: 0; margin: 0; }
      ul.hyps li { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
      ul.hyps li.off { color: var(--muted); }
      table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
      th, td { text-align: right; padding: 6px 4px; border-bottom: 1px solid var(--border); }
      th:first-child, td:first-child { text-align: left; }
      th { color: var(--muted); font-weight: normal; font-size: 12px; }
      .win { color: var(--accent-2); }
      .loss { color: var(--danger); }
    `,
  ],
  template: `
    @if (kopilia.setupsOpen()) {
      <div class="sheet">
      <div class="inner" role="dialog" aria-modal="true" aria-label="Opportunités">
        <header>
          <h1>Opportunités</h1>
          <button type="button" class="small" title="Afficher la liste des setups dans un encart du tableau de bord" (click)="kopilia.showSetupsPanel()">Liste à l’écran</button>
          <button type="button" class="small" [disabled]="kopilia.setupSearching()" (click)="kopilia.searchSetups()">
            {{ kopilia.setupSearching() ? 'Recherche en cours…' : 'Chercher maintenant' }}
          </button>
          <button type="button" class="icon" aria-label="Fermer les opportunités" (click)="kopilia.closeSetups()">×</button>
        </header>

        @if (!kopilia.scenarios().length && !kopilia.hypotheses().length) {
          <p class="note">
            Rien pour l'instant. L'IA passe en revue tes produits après le wrap du matin et de midi ; « Chercher maintenant » lance une passe tout de suite.
            Elle s'appuie sur tes tracés, tes hypothèses et ta façon de trader.
          </p>
        }

        @if (proposed().length) {
          <h2>Setups déclenchés <small>analyses de l'IA, pas des ordres</small></h2>
          @for (s of proposed(); track s.id) {
            <div class="card proposed">
              <div class="row">
                <span class="name">{{ s.title }}</span>
                <span class="tag" [class.long]="s.direction === 'long'" [class.short]="s.direction === 'short'">{{ side[s.direction] }}</span>
                <span class="tag">{{ frames(s) }}</span>
                <span class="spacer"></span>
                <span class="note">{{ s.proposedAt ? when(s.proposedAt) : '' }}</span>
              </div>
              <p class="levels">{{ levels(s) }}</p>
              @if (analysis(s); as a) { <p class="text">{{ a }}</p> }
              @if (s.outcome?.enteredAt) { <p class="text"><b>Suivi</b>entrée atteinte {{ when(s.outcome!.enteredAt!) }}, en cours</p> }
              @if (s.feedback) { <p class="text"><b>Ta réaction</b>{{ reaction[s.feedback.reaction] }}@if (s.feedback.note) { — « {{ s.feedback.note }} » }</p> }
              <div class="actions">
                <button type="button" class="primary small" (click)="kopilia.setupFeedback(s.id, 'taken')">Je le prends</button>
                <button type="button" class="small" (click)="kopilia.setupFeedback(s.id, 'declined')">Pas pour moi</button>
                <button type="button" class="small" (click)="kopilia.openSetupChart(s)">Voir le graphique</button>
                <button type="button" class="small" (click)="kopilia.abandonScenario(s.id)">Fermer</button>
              </div>
              <ng-container *ngTemplateOutlet="dossier; context: { $implicit: s }" />
            </div>
          }
        }

        @if (watching().length) {
          <h2>Setups en attente <small>repérés, pas encore déclenchés : l'IA surveille leur zone</small></h2>
          @for (s of watching(); track s.id) {
            <div class="card" [class.review]="!!s.review">
              <div class="row">
                <span class="name">{{ s.title }}</span>
                <span class="tag" [class.long]="s.direction === 'long'" [class.short]="s.direction === 'short'">{{ side[s.direction] }}</span>
                <span class="tag">{{ frames(s) }}</span>
                @if (s.review) { <span class="tag warn" [attr.title]="s.review">à revoir</span> }
                <span class="spacer"></span>
                <span class="note">jusqu'à {{ when(s.expiresAt) }}</span>
              </div>
              <p class="text"><b>Plan</b>{{ s.plan }}</p>
              <p class="text"><b>Invalidé si</b>{{ s.invalidation }}</p>
              @if (s.wakeAt) { <p class="text"><b>Rendez-vous</b>{{ when(s.wakeAt) }} — {{ s.wakeReason }}</p> }
              <div class="actions">
                <button type="button" class="small" (click)="kopilia.openSetupChart(s)">Voir le graphique</button>
                <button type="button" class="small" (click)="kopilia.abandonScenario(s.id)">Fermer ce setup</button>
              </div>
              <ng-container *ngTemplateOutlet="dossier; context: { $implicit: s }" />
            </div>
          }
        }

        @if (kopilia.drawingSuggestions().length) {
          <h2>Suggestions sur tes tracés <small>l'IA ne les modifie jamais : à toi de voir</small></h2>
          <ul class="hyps">
            @for (x of kopilia.drawingSuggestions(); track x.id) {
              <li>
                <div class="row">
                  <span class="tag ai">IA</span>
                  <span class="name">{{ x.text }}</span>
                </div>
                <p class="text"><b>Tracé</b>{{ x.drawingId }} · {{ suggestionWhere(x) }} · {{ when(x.createdAt) }}</p>
                <div class="actions">
                  <button type="button" class="small" (click)="kopilia.dismissSuggestion(x.id)">Ignorer</button>
                </div>
              </li>
            }
          </ul>
        }

        @if (kopilia.hypotheses().length) {
          <h2>Hypothèses <small>le sens attendu, la tienne compte autant que celle de l'IA</small></h2>
          <ul class="hyps">
            @for (h of kopilia.hypotheses(); track h.id) {
              <li [class.off]="h.state !== 'active'">
                <div class="row">
                  <span class="tag" [class.ai]="h.author === 'kopilia'">{{ h.author === 'user' ? 'Toi' : 'IA' }}</span>
                  <span class="name">{{ h.statement }}</span>
                  <span class="tag">{{ bias[h.bias] }} · {{ horizon[h.horizon] }}</span>
                  @if (h.state !== 'active') { <span class="tag warn">{{ hypState[h.state] }}</span> }
                </div>
                <p class="text"><b>Invalidée si</b>{{ h.invalidation }}@if (h.products.length) { · {{ productNames(h) }} }</p>
                @if (h.stateReason) { <p class="text"><b>Pourquoi</b>{{ h.stateReason }}</p> }
                @if (h.state === 'active') {
                  <div class="actions">
                    <button type="button" class="small" (click)="kopilia.setHypothesisState(h.id, 'confirmed')">Confirmée</button>
                    <button type="button" class="small" (click)="kopilia.setHypothesisState(h.id, 'invalidated')">Invalidée</button>
                  </div>
                }
              </li>
            }
          </ul>
        }

        @if (closed().length) {
          <h2>Fermés depuis hier</h2>
          @for (s of closed(); track s.id) {
            <div class="card">
              <div class="row">
                <span class="name">{{ s.title }}</span>
                <span class="tag">{{ state[s.state] }}</span>
                @if (s.outcome && s.outcome.result !== 'open') {
                  <span class="tag" [class.long]="s.outcome.result === 'target'" [class.short]="s.outcome.result === 'stop'">{{ outcome[s.outcome.result] }}</span>
                }
                <span class="spacer"></span>
                <span class="note">{{ s.closedAt ? when(s.closedAt) : '' }}</span>
              </div>
              @if (s.stateReason) { <p class="text"><b>Pourquoi</b>{{ s.stateReason }}</p> }
              <ng-container *ngTemplateOutlet="dossier; context: { $implicit: s }" />
            </div>
          }
        }

        @if (kopilia.setupStats().length) {
          <h2>Résultats des setups déclenchés</h2>
          <table>
            <thead><tr><th></th><th>Déclenchés</th><th>Objectif</th><th>Stop</th><th>Sans entrée</th><th>En cours</th><th>R</th></tr></thead>
            <tbody>
              @for (r of kopilia.setupStats(); track r.label) {
                <tr>
                  <td>{{ r.label }}</td><td>{{ r.proposed }}</td><td class="win">{{ r.target }}</td><td class="loss">{{ r.stop }}</td><td>{{ r.missed }}</td><td>{{ r.open }}</td>
                  <td [class.win]="r.r > 0" [class.loss]="r.r < 0">{{ r.r > 0 ? '+' : '' }}{{ r.r.toFixed(1) }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
      </div>
    }

    <ng-template #dossier let-s>
      <details>
        <summary>Dossier et fil</summary>
        <p class="text"><b>Pourquoi</b>{{ s.why }}</p>
        <p class="text"><b>Ce que l'IA voyait</b>{{ s.snapshot }}</p>
        @if (s.state !== 'watching') { <p class="text"><b>Plan</b>{{ s.plan }}</p> }
        <ol class="fil">
          @for (e of fil(s); track e.id) {
            <li [class.user]="e.by === 'user'"><time>{{ when(e.at) }}</time><span class="k">{{ kindName(e.kind) }}</span>{{ e.text }}</li>
          }
        </ol>
      </details>
    </ng-template>
  `,
  imports: [NgTemplateOutlet],
})
export class SetupsPanelComponent {
  readonly kopilia = inject(KopiliaService);
  readonly side = SIDE;
  readonly bias = BIAS;
  readonly horizon = HORIZON;
  readonly state = STATE_NAMES;
  readonly outcome = OUTCOME_NAMES;
  readonly reaction = REACTION_NAMES;
  readonly hypState: Record<string, string> = { confirmed: "confirmée", invalidated: "invalidée", expired: "expirée" };

  readonly proposed = computed(() => this.kopilia.scenarios().filter((s) => s.state === "proposed"));
  readonly watching = computed(() => this.kopilia.scenarios().filter((s) => s.state === "watching"));
  readonly closed = computed(() => this.kopilia.scenarios().filter((s) => s.state !== "watching" && s.state !== "proposed"));

  /** Où porte une suggestion : le dossier qui l'a faite, sinon le produit. */
  suggestionWhere(x: DrawingSuggestion): string {
    const s = x.scenarioId ? this.kopilia.scenarios().find((o) => o.id === x.scenarioId) : undefined;
    return s ? s.title : x.symbol;
  }

  /** « 15m · contexte 4h ». */
  frames(s: Scenario): string {
    return s.contextTimeframe ? `${s.timeframe} · contexte ${s.contextTimeframe}` : s.timeframe;
  }

  /** « Entrée 3 955,00 · stop 3 962,00 · objectif 3 930,00 · rapport 3,6 ». */
  levels(s: Scenario): string {
    const d = s.digits ?? 2;
    const parts = [
      s.entry !== undefined ? `Entrée ${formatPrice(s.entry, d)}` : "",
      s.stop !== undefined ? `stop ${formatPrice(s.stop, d)}` : "",
      s.targets.length ? `objectif${s.targets.length > 1 ? "s" : ""} ${s.targets.map((t) => formatPrice(t, d)).join(", ")}` : "",
    ].filter(Boolean);
    const rr = rewardRisk(s);
    if (rr !== undefined) parts.push(`rapport ${rr.toFixed(1).replace(".", ",")}`);
    return parts.join(" · ");
  }

  /** L'analyse écrite par l'IA en proposant le setup. */
  analysis(s: Scenario): string | undefined {
    const e = [...(s.events ?? [])].reverse().find((x) => x.kind === "proposed");
    return e?.text.replace(/^Setup proposé \([^)]*\) : /, "");
  }

  /** Le fil d'un dossier, du plus ancien au plus récent. */
  fil(s: Scenario): ScenarioEvent[] {
    return s.events ?? [];
  }

  kindName(kind: ScenarioEvent["kind"]): string {
    return KIND[kind];
  }

  productNames(h: { products: Array<{ name: string }> }): string {
    return h.products.map((p) => p.name).join(", ");
  }

  when(ms: number): string {
    return formatDateTime(ms);
  }
}
