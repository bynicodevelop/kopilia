import { computed, signal } from "@angular/core";
import { sizeBox, type PositionSizing, type PositionShape, type Ticket, type Trade, type TradingState } from "@kopilia/contracts";
import type { ScreenApi } from "../api";

/** Ce que la boîte de trade montre d'elle-même : sa taille et ce qu'elle engage, et le trade qui en est parti s'il y en a un. */
export interface BoxInfo {
  sizing?: PositionSizing;
  currency: string;
  /** Le trade passé depuis cette boîte (en cours, ou terminé depuis peu). */
  trade?: Trade;
}

/**
 * La prise de position vue de l'écran : l'état envoyé par le serveur (compte,
 * money management, conditions des produits, trades, ticket à confirmer), la
 * taille d'une boîte calculée en direct (pendant qu'on la tire), et la réponse
 * de l'utilisateur à un ticket.
 */
export class TradingStore {
  readonly state = signal<TradingState | undefined>(undefined);
  readonly ticket = computed<Ticket | undefined>(() => this.state()?.ticket);
  /** Une confirmation est en route : le bouton ne renvoie rien. */
  readonly sending = signal(false);

  constructor(
    private readonly api: ScreenApi,
    private readonly report: (message: string) => void,
  ) {}

  updated(state: TradingState): void {
    this.state.set(state);
  }

  /** La taille d'une boîte (sa forme, éventuellement en cours de déplacement) et son trade. */
  boxInfo(symbol: string, shape: Pick<PositionShape, "entry" | "stop" | "target" | "risk">, drawingId?: string): BoxInfo | undefined {
    const s = this.state();
    if (!s) return undefined;
    const trade = drawingId ? latestTrade(s.trades, drawingId) : undefined;
    const sizing = sizeBox({ symbol, ...shape }, s);
    if (!sizing && !trade) return undefined;
    return { ...(sizing ? { sizing } : {}), currency: s.account?.currency ?? trade?.currency ?? "", ...(trade ? { trade } : {}) };
  }

  /** Le ticket confirmé au clic : ses ordres partent chez le courtier. */
  async confirm(id: string): Promise<void> {
    if (this.sending()) return;
    this.sending.set(true);
    try {
      // Un refus du courtier arrive aussi en bandeau (trading.signal) : rien à ajouter ici.
      await this.api.json<{ ok: boolean; text: string }>(`/api/trading/tickets/${encodeURIComponent(id)}/confirm`, "POST");
    } catch (e) {
      this.report((e as Error).message);
    } finally {
      this.sending.set(false);
    }
  }

  /** La marge que le courtier demanderait pour cette taille (un calcul, rien n'est passé). */
  margin(q: { symbol: string; side: "long" | "short"; lots: number; price: number }): Promise<{ margin?: number; freeMargin?: number }> {
    const params = new URLSearchParams({ symbol: q.symbol, side: q.side, lots: String(q.lots), price: String(q.price) });
    return this.api.json(`/api/trading/margin?${params}`);
  }

  async cancel(id: string): Promise<void> {
    try {
      await this.api.json(`/api/trading/tickets/${encodeURIComponent(id)}/cancel`, "POST");
    } catch (e) {
      this.report((e as Error).message);
    }
  }
}

/**
 * Le trade le plus récent parti de cette boîte : en cours d'abord, sinon le
 * dernier fermé. Un ordre refusé ou retiré n'a rien changé : la boîte reste
 * une analyse comme avant.
 */
export function latestTrade(trades: readonly Trade[], drawingId: string): Trade | undefined {
  const mine = trades.filter((t) => t.drawingId === drawingId && t.state !== "rejected" && t.state !== "cancelled");
  return mine.find((t) => t.state === "pending" || t.state === "open") ?? mine.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
