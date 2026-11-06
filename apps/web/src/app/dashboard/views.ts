import type { Panel, ServerMessage } from "@kopilia/contracts";

/** Tableau de bord : les encarts autour de l'orbe, et les cotations en direct de leurs produits. */
export interface ProductView {
  symbol: string;
  name: string;
  digits?: number;
}
/** Un encart du tableau de bord, tel que le serveur le décrit. */
export type PanelView = Panel;
/** Message du serveur d'un type donné. */
type Msg<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** Dernière cotation d'un produit (bid ; ask ; instant epoch ms ; décimales ; ouverture de la journée du courtier). */
export type QuoteView = Pick<Msg<"market.quote">, "symbol" | "bid" | "ask" | "time" | "digits" | "dayOpen">;
export interface CandleView {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Une alerte qui vient de partir, telle que l'écran la signale ; `key` : ce
 * déclenchement (une alerte peut repartir). `setup` : un setup proposé ou
 * abandonné par l'IA (son scénario dans `alertId`), ou une recherche de setups
 * finie, signalés de la même façon ; `trade`, ce qui arrive à un trade.
 */
export type FiredAlertView = Pick<Msg<"alert.triggered">, "alertId" | "symbol" | "title" | "detail" | "direction" | "at"> & {
  key: string;
  setup?: "proposed" | "abandoned" | "searched";
  /** Une news forte : son bandeau, sans « Voir » (l'encart News la garde). */
  news?: boolean;
  /** Ce qui arrive à un trade passé par Kopilia (ordre envoyé, exécuté, fermé, refusé, rappel de break-even). */
  trade?: Msg<"trading.signal">["kind"];
};
