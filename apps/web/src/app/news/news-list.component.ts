import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from "@angular/core";
import type { NewsFigure, NewsItem, NewsReaction } from "@kopilia/contracts";
import { KopiliaService } from "../kopilia.service";
import { dateFormat } from "../format";
import type { PanelView } from "../dashboard/views";
import { figureText, mergeNews, reactionText } from "./news";

/** Relues à ce rythme, au cas où un envoi se serait perdu (reconnexion). */
const REFRESH_MS = 5 * 60_000;

/**
 * L'encart News : les news en temps réel (FinancialJuice), traduites, les plus
 * récentes en haut, d'un produit si l'encart en suit un. La hiérarchie passe
 * par l'opacité : une forte en plein, une faible pâle. Sous le titre, la ligne
 * d'impact, et la réaction du marché quand elle a été mesurée. Un clic déplie
 * le titre d'origine, le chiffre publié et le lien vers la source ; le reste
 * se dit à la voix (« pourquoi l'or monte ? », « montre les news sur l'or »).
 */
@Component({
  selector: "kp-news-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: block; }
      ul { list-style: none; margin: 6px 0 4px; padding: 0; max-height: min(62vh, 560px); overflow-y: auto; }
      li { border-top: 1px solid var(--border); }
      li.medium { opacity: 0.82; }
      li.low { opacity: 0.5; }
      .row {
        width: 100%; display: flex; align-items: baseline; gap: 10px; padding: 6px 0; text-align: left;
        border: none; border-radius: 0; background: none; color: var(--text); font-size: 14px; line-height: 1.35;
      }
      .row:hover .title { text-decoration: underline; text-decoration-color: var(--muted); }
      .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .at { flex: none; min-width: 38px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      li.high .title { font-weight: 600; }
      .impact { font-size: 12.5px; color: var(--muted); }
      .moved { font-size: 12px; color: var(--accent); font-variant-numeric: tabular-nums; }
      .more { margin: 0 0 8px 48px; font-size: 12.5px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
      .more p { margin: 0; overflow-wrap: anywhere; }
      .more a { color: var(--muted); }
      .empty { margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
    `,
  ],
  template: `
    @if (rows().length) {
      <ul>
        @for (n of rows(); track n.id) {
          <li [class.medium]="n.level === 'medium'" [class.low]="n.level === 'low'" [class.high]="n.level === 'high'">
            <button type="button" class="row" [attr.aria-expanded]="open() === n.id" [attr.title]="open() === n.id ? 'Replier' : 'Déplier'" (click)="toggle(n.id)">
              <span class="at">{{ at(n.at) }}</span>
              <span class="body">
                <span class="title">{{ n.title }}</span>
                @if (n.impact) {
                  <span class="impact">{{ n.impact }}</span>
                }
                @if (n.reaction) {
                  <span class="moved">{{ moved(n.reaction) }}</span>
                }
              </span>
            </button>
            @if (open() === n.id) {
              <div class="more">
                @if (n.translated) {
                  <p>{{ n.original }}</p>
                }
                @if (n.figure) {
                  <p>{{ figure(n.figure) }}</p>
                }
                @if (n.link) {
                  <a [href]="n.link" target="_blank" rel="noopener noreferrer">Source : FinancialJuice</a>
                }
              </div>
            }
          </li>
        }
      </ul>
    } @else {
      <p class="empty">Aucune news pour l'instant : elles arrivent d'elles-mêmes, toutes les deux minutes.</p>
    }
  `,
})
export class NewsListComponent {
  readonly panel = input.required<PanelView>();
  readonly kopilia = inject(KopiliaService);
  /** Lues sur le serveur, puis complétées par celles du direct. */
  private readonly loaded = signal<NewsItem[]>([]);
  readonly rows = computed(() => mergeNews(this.loaded(), [], this.panel().symbol));
  readonly open = signal<string | null>(null);

  constructor() {
    const load = (symbol?: string) =>
      this.kopilia.newsList(symbol).then(
        (items) =>
          this.loaded.update((known) =>
            mergeNews(
              items,
              known.filter((n) => !symbol || n.symbols.includes(symbol)),
            ),
          ),
        () => undefined,
      );
    // Le produit suivi change (« montre les news sur l'or ») : relues pour lui.
    effect(() => {
      const symbol = this.panel().symbol;
      untracked(() => {
        this.loaded.set([]);
        void load(symbol);
      });
    });
    const timer = setInterval(() => void load(this.panel().symbol), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // Des news arrivent en direct : ajoutées (ou mises à jour) sans relire le serveur.
    effect(() => {
      const live = this.kopilia.newsLive();
      if (live.length) untracked(() => this.loaded.update((known) => mergeNews(known, live)));
    });
  }

  toggle(id: string): void {
    this.open.update((o) => (o === id ? null : id));
  }

  /** L'heure seule aujourd'hui ; avant, le jour en plus. */
  at(ms: number): string {
    return new Date(ms).toDateString() === new Date().toDateString()
      ? dateFormat("clock", { hour: "2-digit", minute: "2-digit" }).format(ms)
      : dateFormat("news-day", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
  }

  moved(r: NewsReaction): string {
    return reactionText(r);
  }

  figure(f: NewsFigure): string {
    return figureText(f);
  }
}
