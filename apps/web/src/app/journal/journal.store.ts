import { signal } from "@angular/core";
import type { Journal, JournalBilan, JournalReview, JournalTrade } from "@kopilia/contracts";
import type { ScreenApi } from "../api";

/** La page d'un trade ouverte en plein écran : sa page, et l'image de son graphique figé (URL locale). */
export interface TradeSheet {
  page: JournalTrade;
  chart?: string;
  chartError?: string;
}

/** Le calendrier ouvert : le mois (AAAA-MM) et son bilan, et le jour choisi. */
export interface CalendarSheet {
  month: string;
  bilan: JournalBilan;
  day?: { date: string; bilan: JournalBilan };
}

/**
 * Le journal de trading vu de l'écran : la liste par fiche (encart Journal),
 * relue quand le serveur dit qu'il a changé, et la page d'un trade ouverte en
 * plein écran (au clic sur une ligne, ou quand Kopilia la montre).
 */
export class JournalStore {
  readonly journal = signal<Journal | undefined>(undefined);
  readonly open = signal<TradeSheet | null>(null);
  /** L'analyse de son trading ouverte en plein écran. */
  readonly review = signal<JournalReview | null>(null);
  /** Le calendrier du journal ouvert en plein écran. */
  readonly calendar = signal<CalendarSheet | null>(null);
  /** Monte à chaque changement annoncé par le serveur : l'encart se relit. */
  readonly version = signal(0);
  private chartUrl?: string;
  private loading?: string;

  constructor(
    private readonly api: ScreenApi,
    private readonly report: (message: string) => void,
  ) {}

  async load(): Promise<void> {
    try {
      this.journal.set(await this.api.json<Journal>("/api/journal"));
    } catch {
      /* hors ligne : relu au prochain changement */
    }
  }

  /** Le serveur dit que le journal a changé : la liste, et la page ouverte si elle est concernée. */
  changed(tradeId?: string): void {
    this.version.update((v) => v + 1);
    const open = this.open();
    if (open && (!tradeId || tradeId === open.page.trade.id)) void this.show(open.page.trade.id, true);
    const cal = this.calendar();
    if (cal) void this.showCalendar(cal.day?.date ?? cal.month, true);
  }

  /** Ouvre le calendrier : un mois (AAAA-MM), ou un jour (AAAA-MM-JJ) de son mois ; le mois en cours par défaut. */
  async showCalendar(key?: string, quiet = false): Promise<void> {
    const month = key?.slice(0, 7) ?? monthOf(Date.now());
    try {
      const bilan = await this.api.json<JournalBilan>(`/api/journal/bilan?period=month&date=${encodeURIComponent(month)}`);
      const day =
        key && key.length === 10
          ? { date: key, bilan: await this.api.json<JournalBilan>(`/api/journal/bilan?period=day&date=${encodeURIComponent(key)}`) }
          : undefined;
      if (!quiet) this.close();
      this.calendar.set({ month, bilan, ...(day ? { day } : {}) });
    } catch {
      if (!quiet) this.report("Calendrier du journal indisponible — réessaie dans un instant.");
    }
  }

  /** Le jour choisi dans le calendrier : ses trades et son bilan ; le même jour, une seconde fois, le referme. */
  async selectDay(date: string): Promise<void> {
    const cal = this.calendar();
    if (!cal) return;
    if (cal.day?.date === date) {
      this.calendar.set({ month: cal.month, bilan: cal.bilan });
      return;
    }
    try {
      const bilan = await this.api.json<JournalBilan>(`/api/journal/bilan?period=day&date=${encodeURIComponent(date)}`);
      if (this.calendar()?.month === cal.month) this.calendar.set({ ...cal, day: { date, bilan } });
    } catch {
      this.report("Bilan du jour indisponible — réessaie dans un instant.");
    }
  }

  closeCalendar(): void {
    this.calendar.set(null);
  }

  /** Ouvre une analyse de son trading (la dernière par défaut) ; une page de trade ouverte par-dessus se ferme. */
  async showReview(reviewId = "latest"): Promise<void> {
    try {
      const r = await this.api.json<JournalReview>(`/api/journal/reviews/${encodeURIComponent(reviewId)}`);
      this.close();
      this.review.set(r);
    } catch {
      this.report("Analyse introuvable — réessaie dans un instant.");
    }
  }

  closeReview(): void {
    this.review.set(null);
  }

  /** Ouvre la page d'un trade : sa page, puis l'image de son graphique figé. */
  async show(tradeId: string, quiet = false): Promise<void> {
    if (this.loading === tradeId) return;
    this.loading = tradeId;
    try {
      const page = await this.api.json<JournalTrade>(`/api/journal/trades/${encodeURIComponent(tradeId)}`);
      const keep = this.open()?.page.trade.id === tradeId ? this.open() : null;
      this.open.set({ page, ...(keep?.chart ? { chart: keep.chart } : {}) });
      const res = await this.api.fetch(`/api/journal/trades/${encodeURIComponent(tradeId)}/chart.svg`);
      if (this.open()?.page.trade.id !== tradeId) return;
      if (!res.ok) {
        const msg = ((await res.json().catch(() => ({}))) as { message?: string }).message;
        this.open.set({ page, chartError: msg ?? "graphique indisponible" });
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      if (this.chartUrl) URL.revokeObjectURL(this.chartUrl);
      this.chartUrl = url;
      this.open.set({ page, chart: url });
    } catch {
      if (!quiet) this.report("Trade introuvable dans le journal — réessaie dans un instant.");
    } finally {
      this.loading = undefined;
    }
  }

  close(): void {
    this.open.set(null);
    if (this.chartUrl) URL.revokeObjectURL(this.chartUrl);
    this.chartUrl = undefined;
  }
}

/** « 2026-11 » : le mois d'un instant, à l'heure locale. */
export function monthOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
