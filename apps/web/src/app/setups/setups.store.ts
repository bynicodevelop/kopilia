import { computed, signal } from "@angular/core";
import { watchlist } from "./watchlist";
import type { DrawingSuggestion, Hypothesis, Scenario, SetupStatsRow } from "@kopilia/contracts";
import type { ScreenApi } from "../api";
import type { ChartAutoMap } from "../dashboard/candle-chart";

/** La recherche d'opportunités telle que le serveur l'envoie (setups.updated). */
export interface SetupsView {
  hypotheses: Hypothesis[];
  scenarios: Scenario[];
  stats: SetupStatsRow[];
  suggestions?: DrawingSuggestion[];
}

/**
 * La recherche d'opportunités vue de l'écran : les hypothèses, les scénarios
 * (proposés, surveillés, fermés depuis peu) avec leur fil, les résultats, la
 * feuille Opportunités, les suggestions de l'IA sur ses tracés, et les
 * actions à la main (réagir à un setup, fermer un scénario, confirmer ou
 * invalider une hypothèse, chercher maintenant, garder ou retirer un niveau
 * de l'IA, écarter une suggestion).
 */
export class SetupsStore {
  readonly hypotheses = signal<Hypothesis[]>([]);
  readonly scenarios = signal<Scenario[]>([]);
  readonly stats = signal<SetupStatsRow[]>([]);
  /** Les suggestions de l'IA sur les tracés de l'utilisateur, en attente. */
  readonly suggestions = signal<DrawingSuggestion[]>([]);
  /** La feuille Opportunités est ouverte. */
  readonly open = signal(false);
  /** Une passe vient d'être demandée depuis l'écran. */
  readonly searching = signal(false);
  /** Les setups proposés, en attente de la réaction de l'utilisateur. */
  readonly proposed = computed(() => this.scenarios().filter((s) => s.state === "proposed"));
  /** Les setups repérés en cours (en attente ou déclenchés), pour la liste de l'écran principal. */
  readonly watchlist = computed(() => watchlist(this.scenarios()));
  /** Les setups qu'une recherche vient de repérer et qu'il n'a pas encore ouverts. */
  readonly fresh = signal<ReadonlySet<string>>(new Set());
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly api: ScreenApi,
    private readonly report: (message: string) => void,
  ) {}

  updated(view: SetupsView): void {
    this.hypotheses.set(view.hypotheses);
    this.scenarios.set(view.scenarios);
    this.stats.set(view.stats);
    this.suggestions.set(view.suggestions ?? []);
  }

  show(): void {
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  /** « Pris », « pas pour moi », « modifié », ou une remarque. */
  feedback(id: string, reaction: "taken" | "declined" | "modified" | "comment", note?: string): Promise<boolean> {
    return this.action(`/scenarios/${encodeURIComponent(id)}/feedback`, { reaction, ...(note ? { note } : {}) });
  }

  abandon(id: string, reason?: string): Promise<boolean> {
    return this.action(`/scenarios/${encodeURIComponent(id)}/abandon`, reason ? { reason } : {});
  }

  hypothesis(id: string, state: "confirmed" | "invalidated" | "active", reason?: string): Promise<boolean> {
    return this.action(`/hypotheses/${encodeURIComponent(id)}`, { state, ...(reason ? { reason } : {}) });
  }

  /** « Garder ce niveau » : le niveau de l'IA devient un tracé de l'utilisateur. */
  keepLevel(id: string): Promise<boolean> {
    return this.action(`/levels/${encodeURIComponent(id)}/keep`, {});
  }

  /** « Retirer ce niveau » : il disparaît, l'IA relit ses dossiers sans lui. */
  dismissLevel(id: string): Promise<boolean> {
    return this.action(`/levels/${encodeURIComponent(id)}/dismiss`, {});
  }

  dismissSuggestion(id: string): Promise<boolean> {
    return this.action(`/suggestions/${encodeURIComponent(id)}/dismiss`, {});
  }

  /** Une recherche est finie : le bouton n'est plus « en cours », ce qu'elle a repéré est marqué nouveau. */
  searched(opened: readonly string[]): void {
    clearTimeout(this.searchTimer);
    this.searching.set(false);
    if (opened.length) this.fresh.update((all) => new Set([...all, ...opened]));
  }

  /** Un setup repéré a été regardé : il n'est plus nouveau. */
  seen(id: string): void {
    if (!this.fresh().has(id)) return;
    this.fresh.update((all) => new Set([...all].filter((x) => x !== id)));
  }

  /** Lance une passe ; le bouton reste « en cours » quelques minutes, le temps qu'elle tourne. */
  async search(focus?: string): Promise<void> {
    if (!(await this.action("/search", focus ? { focus } : {}))) return;
    this.searching.set(true);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.searching.set(false), 4 * 60_000);
  }

  /** La carte automatique d'un graphique (undefined si elle est indisponible). */
  async autoMap(symbol: string, timeframe: string): Promise<ChartAutoMap | undefined> {
    try {
      return await this.api.json<ChartAutoMap>(`/api/setups/automap?${new URLSearchParams({ symbol, timeframe })}`);
    } catch {
      return undefined;
    }
  }

  private async action(path: string, body: unknown): Promise<boolean> {
    try {
      await this.api.json(`/api/setups${path}`, "POST", body);
      return true;
    } catch (e) {
      this.report((e as Error).message);
      return false;
    }
  }
}
