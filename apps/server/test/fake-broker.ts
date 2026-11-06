// Un courtier en mémoire pour les tests de la prise de position et du journal :
// le compte, un indice à 1 € le point par lot, ses ordres, positions et transactions.
import type { BrokerDeal, BrokerOrder, BrokerPosition, BrokerTradeResult } from "../src/market/broker.js";

/** Un courtier en mémoire : le compte, un indice à 1 € le point par lot, ses ordres, positions et transactions. */
export class FakeBroker {
  enabled = true;
  account = { name: "Compte démo", currency: "EUR", balance: 10_000, equity: 10_000, tradeAllowed: true, demo: true, freeMargin: 10_000 };
  /** Marge demandée : l'effet de levier de 20 sur la valeur de la position (null : le courtier ne sait pas la dire). */
  marginOf: (o: { volume: number; price: number }) => number | Error | null = (o) => (o.volume * o.price) / 20;
  terms = { tickSize: 0.01, tickValue: 0.01, volumeStep: 0.1, minVolume: 0.1, maxVolume: 50, digits: 2 };
  /** Le prix du moment, tout près de l'entrée des boîtes (21 450) : un ordre au marché y correspond à la boîte. */
  quote = { bid: 21449.5, ask: 21450.5 };
  positions: BrokerPosition[] = [];
  orders: BrokerOrder[] = [];
  deals: BrokerDeal[] = [];
  sent: Array<Record<string, unknown>> = [];
  /** Réponse forcée (refus, absence de réponse). */
  reply?: (req: Record<string, unknown>) => BrokerTradeResult | Error | undefined;
  private n = 0;
  readonly feed = { snapshot: () => [] };

  async brokerAccount() {
    return { ...this.account };
  }
  async brokerTerms() {
    return { terms: { ...this.terms }, ...this.quote };
  }
  async brokerMargin(o: { symbol: string; side: string; volume: number; price: number }) {
    const m = this.marginOf(o);
    if (m instanceof Error) throw m;
    return m ?? undefined;
  }
  async brokerPositions() {
    return this.positions.map((p) => ({ ...p, currentPrice: p.side === "long" ? this.quote.bid : this.quote.ask }));
  }
  async brokerOrders() {
    return this.orders.map((o) => ({ ...o }));
  }
  async brokerDeals(from: number, to: number) {
    return this.deals.filter((d) => d.time >= from && d.time <= to);
  }
  async brokerTrade(req: Record<string, unknown>): Promise<BrokerTradeResult> {
    this.sent.push(req);
    const forced = this.reply?.(req);
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    const ok = (extra: Partial<BrokerTradeResult> = {}): BrokerTradeResult => ({
      ok: true,
      numericCode: 10009,
      stringCode: "TRADE_RETCODE_DONE",
      message: "",
      ...extra,
    });
    const type = String(req.actionType);
    const id = String(++this.n);
    if (/^ORDER_TYPE_(BUY|SELL)_(LIMIT|STOP)$/.test(type)) {
      this.orders.push({
        id,
        symbol: String(req.symbol),
        type,
        volume: Number(req.volume),
        openPrice: Number(req.openPrice),
        stopLoss: Number(req.stopLoss),
        takeProfit: req.takeProfit as number | undefined,
        clientId: String(req.clientId),
      });
      return ok({ numericCode: 10008, stringCode: "TRADE_RETCODE_PLACED", orderId: id });
    }
    if (type === "ORDER_TYPE_BUY" || type === "ORDER_TYPE_SELL") {
      const long = type === "ORDER_TYPE_BUY";
      this.open({
        id,
        clientId: String(req.clientId),
        side: long ? "long" : "short",
        volume: Number(req.volume),
        price: long ? this.quote.ask : this.quote.bid,
        stop: Number(req.stopLoss),
        target: req.takeProfit as number | undefined,
      });
      return ok({ orderId: id, positionId: id });
    }
    if (type === "POSITION_MODIFY") {
      const p = this.positions.find((x) => x.id === req.positionId);
      if (!p) return { ok: false, numericCode: 10013, stringCode: "TRADE_RETCODE_INVALID", message: "position inconnue" };
      p.stopLoss = Number(req.stopLoss);
      if (req.takeProfit !== undefined) p.takeProfit = Number(req.takeProfit);
      return ok();
    }
    if (type === "POSITION_CLOSE_ID") {
      const p = this.positions.find((x) => x.id === req.positionId)!;
      this.close(String(req.positionId), p.side === "long" ? this.quote.bid : this.quote.ask, "DEAL_REASON_EXPERT");
      return ok();
    }
    if (type === "POSITION_PARTIAL") {
      this.partial(String(req.positionId), Number(req.volume), "DEAL_REASON_EXPERT");
      return ok();
    }
    if (type === "ORDER_CANCEL") {
      this.orders = this.orders.filter((o) => o.id !== req.orderId);
      return ok();
    }
    return { ok: false, numericCode: 10013, stringCode: "TRADE_RETCODE_INVALID", message: "inconnu" };
  }

  open(p: { id: string; clientId: string; side: "long" | "short"; volume: number; price: number; stop: number; target?: number }) {
    this.positions.push({
      id: p.id,
      symbol: "NAS100",
      side: p.side,
      volume: p.volume,
      openPrice: p.price,
      stopLoss: p.stop,
      ...(p.target ? { takeProfit: p.target } : {}),
      profit: 0,
      clientId: p.clientId,
    });
    this.deals.push({
      id: `d${p.id}in`,
      symbol: "NAS100",
      entryType: "DEAL_ENTRY_IN",
      volume: p.volume,
      price: p.price,
      profit: 0,
      commission: -0.48 * p.volume,
      swap: 0,
      positionId: p.id,
      clientId: p.clientId,
      time: Date.now(),
    });
  }

  /** L'ordre en attente exécuté (le prix a touché l'entrée). */
  fill(clientId: string) {
    const o = this.orders.find((x) => x.clientId === clientId)!;
    this.orders = this.orders.filter((x) => x !== o);
    this.open({
      id: `p${o.id}`,
      clientId,
      side: o.type.includes("BUY") ? "long" : "short",
      volume: o.volume,
      price: o.openPrice!,
      stop: o.stopLoss!,
      target: o.takeProfit,
    });
  }

  /**
   * La position fermée à ce prix : sa transaction de sortie, sans clientId comme
   * chez MetaTrader ; `reason` : DEAL_REASON_TP (objectif), _SL (stop), _CLIENT ou
   * _MOBILE (à la main sur la plateforme), _EXPERT (par Kopilia).
   */
  close(positionId: string, price: number, reason?: string) {
    const p = this.positions.find((x) => x.id === positionId)!;
    this.positions = this.positions.filter((x) => x !== p);
    this.out(p, p.volume, price, reason, `d${p.id}out`);
  }

  /** Une part de la position fermée au prix du moment (sur la plateforme, ou par Kopilia). */
  partial(positionId: string, volume: number, reason = "DEAL_REASON_CLIENT") {
    const p = this.positions.find((x) => x.id === positionId)!;
    p.volume = Number((p.volume - volume).toFixed(2));
    this.out(p, volume, p.side === "long" ? this.quote.bid : this.quote.ask, reason, `d${p.id}part${++this.n}`);
  }

  private out(p: BrokerPosition, volume: number, price: number, reason: string | undefined, id: string) {
    const points = p.side === "long" ? price - p.openPrice : p.openPrice - price;
    this.deals.push({
      id,
      symbol: "NAS100",
      entryType: "DEAL_ENTRY_OUT",
      volume,
      price,
      profit: Math.round(points * volume * 100) / 100,
      commission: -0.48 * volume,
      swap: 0,
      positionId: p.id,
      ...(reason ? { reason } : {}),
      time: Date.now(),
    });
  }
}
