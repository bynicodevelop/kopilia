import type { ExitReason } from "@kopilia/contracts";

/*
 * Ce que MetaApi (API REST du compte MetaTrader) renvoie pour la prise de
 * position, lu prudemment : le compte, la fiche et la valeur du tick d'un
 * produit, les positions, les ordres en attente, les transactions passées, et
 * le résultat d'un ordre.
 */

export interface BrokerAccountInfo {
  name: string;
  currency: string;
  balance: number;
  equity: number;
  tradeAllowed: boolean;
  demo: boolean;
  platform?: string;
  freeMargin?: number;
  leverage?: number;
}

/** Fiche d'un produit pour le calcul d'une taille : pas de prix, valeur du tick (devise du compte) et volumes. */
export interface BrokerTerms {
  tickSize: number;
  tickValue: number;
  tickValueProfit?: number;
  volumeStep: number;
  minVolume: number;
  maxVolume: number;
  contractSize?: number;
  digits?: number;
}

export interface BrokerPosition {
  id: string;
  symbol: string;
  side: "long" | "short";
  volume: number;
  openPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Résultat en cours, commission et swap compris. */
  profit: number;
  clientId?: string;
  time?: number;
}

export interface BrokerOrder {
  id: string;
  symbol: string;
  /** ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_STOP… */
  type: string;
  volume: number;
  openPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  clientId?: string;
  positionId?: string;
}

export interface BrokerDeal {
  id: string;
  symbol: string;
  /** DEAL_ENTRY_IN (ouverture), DEAL_ENTRY_OUT (fermeture)… */
  entryType: string;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  positionId?: string;
  orderId?: string;
  clientId?: string;
  /** D'où vient la transaction : DEAL_REASON_SL, _TP, _CLIENT, _MOBILE, _WEB, _EXPERT (une API, Kopilia), _SO… */
  reason?: string;
  time: number;
}

/** Réponse de MetaApi à un ordre : le code de MetaTrader, et les identifiants de l'ordre ou de la position. */
export interface BrokerTradeResult {
  ok: boolean;
  numericCode: number;
  stringCode: string;
  message: string;
  orderId?: string;
  positionId?: string;
}

/** Les codes de MetaTrader qui disent que l'ordre est passé (placé, exécuté, en partie, rien à changer). */
const SUCCESS_CODES = new Set([0, 10008, 10009, 10010, 10025]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : undefined;
  return t !== undefined && Number.isFinite(t) ? t : undefined;
};

export function parseAccountInfo(raw: unknown, fallbackName: string, server?: string): BrokerAccountInfo | undefined {
  const a = (raw ?? {}) as Record<string, unknown>;
  const balance = num(a.balance);
  const currency = str(a.currency);
  if (balance === undefined || !currency) return undefined;
  const type = str(a.type) ?? "";
  return {
    name: str(a.name) ?? fallbackName,
    currency,
    balance,
    equity: num(a.equity) ?? balance,
    // Un mot de passe « investisseur » : MetaApi le dit dans investorMode, ou tradeAllowed est faux.
    tradeAllowed: a.tradeAllowed !== false && a.investorMode !== true,
    demo: type ? type.includes("DEMO") || type.includes("CONTEST") : /demo/i.test(server ?? ""),
    ...(str(a.platform) ? { platform: str(a.platform) } : {}),
    ...(num(a.freeMargin) !== undefined ? { freeMargin: num(a.freeMargin) } : {}),
    ...(num(a.leverage) !== undefined ? { leverage: num(a.leverage) } : {}),
  };
}

export function parseTerms(spec: unknown, price: unknown): BrokerTerms | undefined {
  const s = (spec ?? {}) as Record<string, unknown>;
  const p = (price ?? {}) as Record<string, unknown>;
  const tickSize = num(s.tickSize);
  const tickValue = num(p.lossTickValue) ?? num(p.profitTickValue);
  const volumeStep = num(s.volumeStep);
  const minVolume = num(s.minVolume);
  const maxVolume = num(s.maxVolume);
  if (!(tickSize! > 0) || !(tickValue! > 0) || !(volumeStep! > 0) || !(minVolume! > 0) || !(maxVolume! > 0)) return undefined;
  const profit = num(p.profitTickValue);
  return {
    tickSize: tickSize!,
    tickValue: tickValue!,
    ...(profit && profit > 0 && profit !== tickValue ? { tickValueProfit: profit } : {}),
    volumeStep: volumeStep!,
    minVolume: minVolume!,
    maxVolume: maxVolume!,
    ...(num(s.contractSize) ? { contractSize: num(s.contractSize) } : {}),
    ...(num(s.digits) !== undefined ? { digits: num(s.digits) } : {}),
  };
}

export function parsePositions(raw: unknown): BrokerPosition[] {
  if (!Array.isArray(raw)) return [];
  const out: BrokerPosition[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const id = str(r.id);
    const symbol = str(r.symbol);
    const volume = num(r.volume);
    const openPrice = num(r.openPrice);
    if (!id || !symbol || volume === undefined || openPrice === undefined) continue;
    const profit = (num(r.profit) ?? 0) + (num(r.swap) ?? 0) + (num(r.commission) ?? 0);
    out.push({
      id,
      symbol,
      side: String(r.type).includes("SELL") ? "short" : "long",
      volume,
      openPrice,
      ...(num(r.currentPrice) !== undefined ? { currentPrice: num(r.currentPrice) } : {}),
      ...(num(r.stopLoss) ? { stopLoss: num(r.stopLoss) } : {}),
      ...(num(r.takeProfit) ? { takeProfit: num(r.takeProfit) } : {}),
      profit,
      ...(str(r.clientId) ? { clientId: str(r.clientId) } : {}),
      ...(time(r.time) ? { time: time(r.time) } : {}),
    });
  }
  return out;
}

export function parseOrders(raw: unknown): BrokerOrder[] {
  if (!Array.isArray(raw)) return [];
  const out: BrokerOrder[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const id = str(r.id);
    const symbol = str(r.symbol);
    const volume = num(r.currentVolume) ?? num(r.volume);
    if (!id || !symbol || volume === undefined) continue;
    out.push({
      id,
      symbol,
      type: str(r.type) ?? "",
      volume,
      ...(num(r.openPrice) !== undefined ? { openPrice: num(r.openPrice) } : {}),
      ...(num(r.stopLoss) ? { stopLoss: num(r.stopLoss) } : {}),
      ...(num(r.takeProfit) ? { takeProfit: num(r.takeProfit) } : {}),
      ...(str(r.clientId) ? { clientId: str(r.clientId) } : {}),
      ...(str(r.positionId) ? { positionId: str(r.positionId) } : {}),
    });
  }
  return out;
}

export function parseDeals(raw: unknown): BrokerDeal[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { deals?: unknown })?.deals) ? (raw as { deals: unknown[] }).deals : [];
  const out: BrokerDeal[] = [];
  for (const r of list as Array<Record<string, unknown>>) {
    const id = str(r.id);
    const symbol = str(r.symbol);
    const t = time(r.time);
    if (!id || !symbol || t === undefined) continue;
    out.push({
      id,
      symbol,
      entryType: str(r.entryType) ?? "",
      volume: num(r.volume) ?? 0,
      price: num(r.price) ?? 0,
      profit: num(r.profit) ?? 0,
      commission: num(r.commission) ?? 0,
      swap: num(r.swap) ?? 0,
      ...(str(r.positionId) ? { positionId: str(r.positionId) } : {}),
      ...(str(r.orderId) ? { orderId: str(r.orderId) } : {}),
      ...(str(r.clientId) ? { clientId: str(r.clientId) } : {}),
      ...(str(r.reason) ? { reason: str(r.reason) } : {}),
      time: t,
    });
  }
  return out;
}

export function parseTradeResult(raw: unknown): BrokerTradeResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const numericCode = num(r.numericCode) ?? -1;
  return {
    ok: SUCCESS_CODES.has(numericCode),
    numericCode,
    stringCode: str(r.stringCode) ?? "",
    message: str(r.message) ?? "",
    ...(str(r.orderId) ? { orderId: str(r.orderId) } : {}),
    ...(str(r.positionId) ? { positionId: str(r.positionId) } : {}),
  };
}

/** Comment une transaction de sortie s'est faite, d'après sa raison chez MetaTrader. */
export function exitReasonOf(reason: string | undefined): ExitReason {
  switch (reason) {
    case "DEAL_REASON_TP":
      return "target";
    case "DEAL_REASON_SL":
      return "stop";
    case "DEAL_REASON_SO":
      return "stopout";
    case "DEAL_REASON_EXPERT":
      return "kopilia";
    case "DEAL_REASON_CLIENT":
    case "DEAL_REASON_MOBILE":
    case "DEAL_REASON_WEB":
      return "manual";
    default:
      return "unknown";
  }
}

/**
 * La commission aller-retour d'un lot, lue sur les positions fermées : leurs
 * commissions (ouverture et fermeture) rapportées au volume ouvert, en
 * moyenne. Undefined : aucune position fermée sur ce produit.
 */
export function commissionFromDeals(deals: BrokerDeal[], symbol: string): number | undefined {
  const byPosition = new Map<string, { volume: number; commission: number; closed: boolean }>();
  for (const d of deals) {
    if (d.symbol !== symbol || !d.positionId) continue;
    const p = byPosition.get(d.positionId) ?? { volume: 0, commission: 0, closed: false };
    if (d.entryType === "DEAL_ENTRY_IN") p.volume += d.volume;
    if (d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY") p.closed = true;
    p.commission += d.commission;
    byPosition.set(d.positionId, p);
  }
  const perLot = [...byPosition.values()].filter((p) => p.closed && p.volume > 0).map((p) => Math.abs(p.commission) / p.volume);
  if (!perLot.length) return undefined;
  return Math.round((perLot.reduce((a, b) => a + b, 0) / perLot.length) * 100) / 100;
}
