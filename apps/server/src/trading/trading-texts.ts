import {
  GESTURE_SOURCE_LABELS,
  lotsLabel,
  moneyLabel,
  percentLabel,
  type OrderExecution,
  type PositionSide,
  type Ticket,
  type Trade,
  type TradeGesture,
} from "@kopilia/contracts";
import { frenchPrice } from "../market/metaapi.js";

/*
 * Ce que Kopilia dit et montre d'un ticket ou d'un trade, en français, sans
 * conseil : les faits (sens, taille, niveaux, ce qui est engagé). Pur, testé à plat.
 */

export function sideWord(side: PositionSide): string {
  return side === "long" ? "achat" : "vente";
}

/** « achat à cours limité », « vente stop », « achat au marché ». */
export function orderWords(side: PositionSide, execution: OrderExecution): string {
  return `${sideWord(side)} ${execution === "market" ? "au marché" : execution === "limit" ? "à cours limité" : "stop"}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** « objectif 21 570 », « objectifs 21 520 (1,2 lot) et 21 570 (1,2 lot) ». */
function targetsText(legs: Ticket["legs"], digits?: number): string {
  const withTarget = legs.filter((l) => l.target !== undefined);
  if (!withTarget.length) return "sans objectif";
  if (withTarget.length === 1) return `objectif ${frenchPrice(withTarget[0].target!, digits)}`;
  const parts = withTarget.map((l) => `${frenchPrice(l.target!, digits)} (${lotsLabel(l.lots)})`);
  return `objectifs ${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
}

/** Le ticket d'ouverture relu : ce qui part, et ce que ça engage. */
export function openTicketText(t: Omit<Ticket, "text">): string {
  const p = (v: number) => frenchPrice(v, t.digits);
  const where = t.execution === "market" ? `vers ${p(t.entry!)}` : `à ${p(t.entry!)}`;
  const fees = t.fees > 0 ? `, commission de ${moneyLabel(t.fees, t.currency)} comprise` : "";
  const account = t.demo ? `compte de démonstration « ${t.account} »` : `compte réel « ${t.account} »`;
  return (
    `${cap(orderWords(t.side, t.execution!))} sur ${t.name} : ${lotsLabel(t.lots)} ${where}, stop ${p(t.stop!)}, ${targetsText(t.legs, t.digits)}. ` +
    `Perte au stop ${moneyLabel(t.loss, t.currency)} (${percentLabel(t.riskPercent)} du capital${t.tier ? `, palier ${t.tier}` : ""}), gain ${t.legs.length > 1 ? "aux objectifs" : "à l'objectif"} ${moneyLabel(t.gain, t.currency)}${fees}. ` +
    `${t.margin !== undefined ? `Marge demandée ${moneyLabel(t.margin, t.currency)}. ` : ""}` +
    `Sur le ${account}.`
  );
}

/** Le ticket de gestion d'un trade relu. */
export function manageTicketText(t: Omit<Ticket, "text">, trade: Trade, extra: { price?: number; profit?: number } = {}): string {
  const p = (v: number) => frenchPrice(v, t.digits);
  const what = `ton ${sideWord(trade.side)} ${t.name} (${lotsLabel(trade.lots)})`;
  switch (t.action) {
    case "breakeven":
      return `Monter le stop de ${what} à ${p(t.newStop!)}, ton break-even commission comprise : la position ne risquera plus rien.`;
    case "modify": {
      const parts = [
        t.newStop !== undefined ? `stop de ${p(trade.stop)} à ${p(t.newStop)}` : "",
        t.newTarget !== undefined ? `objectif à ${p(t.newTarget)}` : "",
      ].filter(Boolean);
      return `Déplacer sur ${what} : ${parts.join(", ")}.`;
    }
    case "close": {
      const around = extra.price !== undefined ? `, vers ${p(extra.price)}` : "";
      const result = extra.profit !== undefined ? ` : environ ${moneyLabel(extra.profit, t.currency, { sign: true })} en ce moment` : "";
      return `Fermer ${what} au marché${around}${result}.`;
    }
    case "partial":
      return `Fermer ${lotsLabel(t.lots)} de ${what} au marché${extra.price !== undefined ? `, vers ${p(extra.price)}` : ""}.`;
    case "cancel":
      return `Retirer ton ordre ${trade.side === "long" ? "d'" : "de "}${orderWords(trade.side, trade.execution)} sur ${t.name} (${lotsLabel(trade.lots)} à ${p(trade.entry)}).`;
    default:
      return "";
  }
}

/** Une ligne d'un trade, pour Kopilia (liste, bilan). */
export function tradeLine(t: Trade, now = Date.now()): string {
  const p = (v: number) => frenchPrice(v, t.digits);
  const state =
    t.state === "pending"
      ? "ordre en attente"
      : t.state === "open"
        ? `position ouverte${t.protected ? ", stop à break-even ou au-delà" : ""}`
        : t.state === "closed"
          ? `fermée${t.closedAt ? ` (${ago(now - t.closedAt)})` : ""}`
          : t.state === "cancelled"
            ? "ordre retiré"
            : "refusé par le courtier";
  const result =
    t.profit !== undefined
      ? `, ${t.state === "open" ? "en cours" : "résultat"} ${moneyLabel(t.profit, t.currency, { sign: true })}${t.r !== undefined ? ` (${rLabel(t.r)})` : ""}`
      : "";
  const targets = t.targets.length ? `, objectif${t.targets.length > 1 ? "s" : ""} ${t.targets.map(p).join(" et ")}` : "";
  return `${t.id} : ${orderWords(t.side, t.execution)} ${t.name}, ${lotsLabel(t.lots)} à ${p(t.entry)}, stop ${p(t.stop)}${targets} ; risque ${moneyLabel(t.risk, t.currency)} (${percentLabel(t.riskPercent)}) ; ${state}${result}${t.demo ? " [démo]" : ""}`;
}

/** « +1,5 R », « −1 R ». */
export function rLabel(r: number): string {
  const v = String(Number(Math.abs(r).toFixed(2))).replace(".", ",");
  return `${r < 0 ? "−" : "+"}${v} R`;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

/** Les bandeaux de l'écran (et Telegram) pour ce qui arrive à un trade. */
export function filledTexts(t: Trade, price: number): { title: string; detail: string } {
  return {
    title: `${cap(t.name)} : ${sideWord(t.side)} exécuté`,
    detail: `${lotsLabel(t.lots)} à ${frenchPrice(price, t.digits)} · stop ${frenchPrice(t.stop, t.digits)}`,
  };
}

export function closedTexts(t: Trade): { title: string; detail: string } {
  const result =
    t.profit !== undefined ? `${moneyLabel(t.profit, t.currency, { sign: true })}${t.r !== undefined ? ` · ${rLabel(t.r)}` : ""}` : "résultat inconnu";
  return { title: `${cap(t.name)} : ${sideWord(t.side)} fermé`, detail: result };
}

export function placedTexts(t: Trade): { title: string; detail: string } {
  return {
    title: `${cap(t.name)} : ${orderWords(t.side, t.execution)} envoyé`,
    detail: `${lotsLabel(t.lots)} · risque ${moneyLabel(t.risk, t.currency)} (${percentLabel(t.riskPercent)})`,
  };
}

export function reminderTexts(t: Trade, r: number, breakEven: number): { title: string; detail: string } {
  return {
    title: `${cap(t.name)} : ${rLabel(r).replace("+", "")} atteint`,
    detail: `Break-even à ${frenchPrice(breakEven, t.digits)} : dis « passe à break-even » pour y monter le stop`,
  };
}

/**
 * Un geste pendant un trade, pour le journal : « stop 3 985 → 4 005,8, à ta
 * demande (le prix à 4 012, +0,35 R) », « moitié fermée… ».
 */
export function gestureText(g: TradeGesture, t: Pick<Trade, "digits" | "currency">): string {
  const p = (v: number) => frenchPrice(v, t.digits);
  const where = GESTURE_SOURCE_LABELS[g.source];
  const moment = g.price !== undefined ? ` (le prix à ${p(g.price)}${g.r !== undefined ? `, ${rLabel(g.r)}` : ""})` : "";
  if (g.kind === "partial") {
    const result = g.profit !== undefined ? `, ${moneyLabel(g.profit, t.currency, { sign: true })}` : "";
    return `${g.lots !== undefined ? lotsLabel(g.lots) : "Une part"} fermé${(g.lots ?? 0) >= 2 ? "s" : ""}${g.price !== undefined ? ` à ${p(g.price)}` : ""}${result}, ${where}${g.r !== undefined ? ` (${rLabel(g.r)})` : ""}`;
  }
  const what = g.kind === "stop" ? "stop" : "objectif";
  if (g.to === undefined) return `${cap(what)} ${g.from !== undefined ? `${p(g.from)} ` : ""}retiré, ${where}${moment}`;
  return `${cap(what)} ${g.from !== undefined ? `${p(g.from)} → ` : "posé à "}${p(g.to)}, ${where}${moment}`;
}
