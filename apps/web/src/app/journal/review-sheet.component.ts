import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import { whenText } from "./journal-view";

/**
 * L'analyse de son trading, en plein écran : à gauche les chiffres comptés
 * par le serveur, à droite ce qu'en tire l'IA (en violet), chaque constat
 * avec ses trades (un clic ouvre la page du trade). La règle proposée pour
 * son carnet ne s'écrit qu'à sa demande, à la voix.
 */
@Component({
  selector: "kp-review-sheet",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto; }
      .inner { max-width: 1040px; margin: 0 auto; padding: 0 16px 48px; }
      header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 16px 0 10px; background: var(--bg); border-bottom: 1px solid var(--border); }
      h1 { margin: 0; font-size: 18px; flex: 1; min-width: 0; }
      h1 small { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 6px; }
      .summary { margin: 16px 0 4px; font-size: 16px; line-height: 1.55; }
      .grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 24px; margin-top: 12px; }
      @media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
      h2 { margin: 14px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
      ul { list-style: none; margin: 0; padding: 0; }
      .stats li { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; border-top: 1px solid var(--border); font-size: 14px; }
      .stats li:first-child { border-top: none; }
      .stats .label { flex: 1; min-width: 0; }
      .stats .value { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .ok { color: var(--accent-2); }
      .warn { color: var(--danger); }
      .info { color: var(--muted); }
      .finding { margin: 0 0 12px; padding: 2px 0 2px 12px; border-left: 2px solid var(--ai); border-radius: 0; }
      .finding h3 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
      .finding p { margin: 0 0 4px; font-size: 14px; line-height: 1.5; }
      .trades { display: flex; flex-wrap: wrap; gap: 6px; }
      .trade { padding: 0 8px; border-radius: 999px; border: 1px solid var(--border); background: none; color: var(--muted); font-size: 12px; }
      .trade:hover { color: var(--text); border-color: var(--muted); }
      .carnet { margin: 14px 0 0; padding: 8px 12px; border-radius: var(--radius); background: var(--panel); font-size: 13.5px; color: var(--muted); }
      .carnet q { color: var(--text); }
      .none { font-size: 14px; color: var(--muted); }
    `,
  ],
  template: `
    @if (kopilia.reviewOpen(); as r) {
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Analyse de ton trading">
        <div class="inner">
          <header>
            <h1>Analyse de ton trading<small>{{ r.days }} derniers jours · {{ when(r.createdAt) }}</small></h1>
            <button type="button" class="icon" aria-label="Fermer l'analyse" (click)="kopilia.closeReview()">×</button>
          </header>
          <p class="summary">{{ r.summary }}</p>
          <div class="grid">
            <div>
              <h2>Les faits, comptés par le serveur</h2>
              <ul class="stats">
                @for (s of r.stats; track s.key) {
                  <li>
                    <span class="label">{{ s.label }}</span><span [class]="'value ' + s.tone">{{ s.value }}</span>
                  </li>
                }
              </ul>
            </div>
            <div>
              <h2>Ce qu'en tire l'IA</h2>
              @for (f of r.findings; track $index) {
                <div class="finding">
                  <h3>{{ f.title }}</h3>
                  <p>{{ f.text }}</p>
                  <div class="trades">
                    @for (id of f.trades; track id) {
                      <button type="button" class="trade" [attr.title]="'Ouvrir la page du trade ' + id" (click)="kopilia.openTrade(id)">{{ id }}</button>
                    }
                  </div>
                </div>
              } @empty {
                <p class="none">Pas de constat appuyé sur un trade pour cette période.</p>
              }
              @if (r.carnet) {
                <p class="carnet">Une règle tirée de tes notes : <q>{{ r.carnet }}</q>. Dis « note-la dans mon carnet » si tu veux la garder.</p>
              }
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class ReviewSheetComponent {
  readonly kopilia = inject(KopiliaService);
  readonly when = (ms: number) => whenText(ms);
}
