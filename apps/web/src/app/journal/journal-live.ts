import type { FicheFidelity, Journal, JournalGroup, JournalLine, OrderExecution, PositionSide, Trade } from "@kopilia/contracts";
import { formatPrice } from "../dashboard/candles";
import { productFamily } from "../dashboard/products";
import { decimalFormat } from "../format";

/*
 * Le journal rangé par état, comme l'encart le montre : les positions
 * ouvertes en direct, les ordres en attente, les trades fermés, puis les
 * idées non prises. Les lignes viennent du journal (relu quand il change) ;
 * l'état envoyé par la prise de position, plus frais (toutes les 4 s), les
 * met à jour : résultat flottant, stop déplacé, ordre exécuté, position
 * fermée. Pur, sans Angular.
 */

/** Une ligne du journal avec sa fiche : son nom et son idée, pour le survol. */
export interface StateLine extends JournalLine {
  fiche?: { name: string; idea?: string };
}

export interface JournalByState {
  open: StateLine[];
  pending: StateLine[];
  /** Fermés et ordres retirés, les plus récents d'abord. */
  closed: StateLine[];
  /** Les fiches ouvertes sans trade : leur idée, rejouée sur les cours. */
  ideas: JournalGroup[];
}

/** Ce que l'encart garde d'une cotation. */
export interface LiveQuote {
  bid: number;
  ask?: number;
  digits?: number;
}

export function journalByState(journal: Journal, trades: readonly Trade[] = []): JournalByState {
  const fresh = new Map(trades.map((t) => [t.id, t]));
  const lines: StateLine[] = [];
  const ideas: JournalGroup[] = [];
  for (const g of journal.groups) {
    if (!g.trades.length) {
      if (g.analysisId) ideas.push(g);
      continue;
    }
    const fiche = g.analysisId ? { name: g.name, ...(g.idea ? { idea: g.idea } : {}) } : undefined;
    for (const l of g.trades) {
      const t = fresh.get(l.id);
      lines.push({ ...(t ? withTrade(l, t) : l), ...(fiche ? { fiche } : {}) });
    }
  }
  const by = (key: (l: StateLine) => number) => (a: StateLine, b: StateLine) => key(b) - key(a);
  return {
    open: lines.filter((l) => l.state === "open").sort(by((l) => l.openedAt ?? l.at)),
    pending: lines.filter((l) => l.state === "pending").sort(by((l) => l.createdAt ?? l.at)),
    closed: lines.filter((l) => l.state === "closed" || l.state === "cancelled").sort(by((l) => l.at)),
    ideas,
  };
}

/** La ligne du journal mise à jour par le trade tel que la prise de position le voit maintenant. */
function withTrade(l: JournalLine, t: Trade): JournalLine {
  const changedState = t.state !== l.state;
  return {
    ...l,
    state: t.state,
    ...(t.r !== undefined ? { r: t.r } : {}),
    ...(t.profit !== undefined ? { profit: t.profit } : {}),
    entry: t.entry,
    stop: t.stop,
    initialStop: t.initialStop,
    ...(t.targets.length ? { target: t.targets[0] } : {}),
    lots: t.lots,
    risk: t.risk,
    ...(t.openedAt ? { openedAt: t.openedAt } : {}),
    ...(changedState ? { at: t.closedAt ?? t.openedAt ?? t.createdAt, remark: STATE_REMARKS[t.state] ?? l.remark } : {}),
  };
}

const STATE_REMARKS: Partial<Record<Trade["state"], string>> = { open: "en cours", pending: "ordre en attente", closed: "fermé", cancelled: "ordre retiré" };

/** Le résultat des positions ouvertes et le risque des ordres en attente. */
export function liveTotals(s: JournalByState): { openR: number; openProfit: number; pendingRisk: number; currency: string } {
  const sum = (list: StateLine[], v: (l: StateLine) => number | undefined) => Math.round(list.reduce((a, l) => a + (v(l) ?? 0), 0) * 100) / 100;
  return {
    openR: sum(s.open, (l) => l.r),
    openProfit: sum(s.open, (l) => l.profit),
    pendingRisk: sum(s.pending, (l) => l.risk),
    currency: s.open[0]?.currency ?? s.pending[0]?.currency ?? "",
  };
}

/** Le prix auquel la position se fermerait : un achat se revend au bid, une vente se rachète à l'ask. */
export function exitPrice(side: PositionSide, q: LiveQuote | undefined): number | undefined {
  if (!q) return undefined;
  return side === "long" ? q.bid : (q.ask ?? q.bid);
}

/** Le prix qui déclencherait l'ordre : un achat s'exécute à l'ask, une vente au bid. */
export function fillPrice(side: PositionSide, q: LiveQuote | undefined): number | undefined {
  if (!q) return undefined;
  return side === "long" ? (q.ask ?? q.bid) : q.bid;
}

/**
 * La barre d'une position, du stop (0) à l'objectif (1) : où est l'entrée,
 * où est le prix. Le rouge va du stop à l'entrée, le vert de l'entrée à
 * l'objectif ; un stop remonté au-delà de l'entrée ne laisse que du vert.
 * Sans objectif, pas de barre.
 */
export function tradeBar(
  side: PositionSide,
  stop: number,
  entry: number,
  target: number | undefined,
  price?: number,
): { entry: number; price?: number } | undefined {
  if (target === undefined) return undefined;
  const span = side === "long" ? target - stop : stop - target;
  if (!(span > 0)) return undefined;
  const at = (x: number) => Math.max(0, Math.min(1, (side === "long" ? x - stop : stop - x) / span));
  return { entry: at(entry), ...(price !== undefined ? { price: at(price) } : {}) };
}

/** « AUD/NZD » pour une paire de devises, comme la liste des produits ; sinon le symbole sans son suffixe de compte (« XAUUSD »). */
export function tickerLabel(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9].*$/, "");
  return productFamily(symbol) === "Devises" ? `${s.slice(0, 3)}/${s.slice(3, 6)}` : s;
}

/**
 * La distance du prix à l'ordre : en pips pour une paire (0,01 quand le yen
 * est la devise de cotation), sinon en prix (« à 9,1 pips », « à 32,60 »).
 */
export function distanceText(symbol: string, from: number, to: number, digits?: number): string {
  const d = Math.abs(to - from);
  if (productFamily(symbol) === "Devises") {
    const quote = symbol
      .toUpperCase()
      .replace(/[^A-Z0-9].*$/, "")
      .slice(3, 6);
    const pips = d / (quote === "JPY" ? 0.01 : 0.0001);
    const shown = Math.round(pips * (pips >= 100 ? 1 : 10)) / (pips >= 100 ? 1 : 10);
    return `à ${decimalFormat(Number.isInteger(shown) ? 0 : 1).format(shown)} pip${shown >= 2 ? "s" : ""}`;
  }
  return `à ${formatPrice(d, digits)}`;
}

/** « vente limite », « achat stop », « achat au marché ». */
export function orderText(side: PositionSide, execution: OrderExecution | undefined): string {
  const words = side === "long" ? "achat" : "vente";
  return execution === "limit" ? `${words} limite` : execution === "stop" ? `${words} stop` : execution === "market" ? `${words} au marché` : words;
}

/** L'étiquette de la fiche sur une ligne : « fiche », « contre la fiche » ; rien sans fiche (le survol le dit). */
export function ficheChip(fidelity: FicheFidelity, hasFiche: boolean): { text: string; against: boolean } | undefined {
  if (fidelity === "against") return { text: "contre la fiche", against: true };
  return hasFiche ? { text: "fiche", against: false } : undefined;
}
