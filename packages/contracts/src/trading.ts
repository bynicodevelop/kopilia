import { z } from "zod";
import { POSITION_SIDES, riskSchema, type PositionSide, type Risk } from "./technical.js";

/*
 * Prise de position : le money management (risque par trade, plafonds), la
 * taille d'une boîte de trade calculée sur le compte du courtier, et les
 * ordres que l'utilisateur fait passer. Kopilia ne décide jamais seul : l'IA
 * prépare un ticket, l'utilisateur le confirme (au clic ou en disant « je
 * confirme », reconnu par le code), et seulement alors l'ordre part.
 */

/** Ce que le courtier dit d'un produit pour en calculer une taille, dans la devise du compte. */
export const symbolTermsSchema = z.object({
  symbol: z.string().min(1),
  /** Le plus petit écart de prix. */
  tickSize: z.number().positive(),
  /** Ce que vaut un tick pour un lot, en perte (et en gain), dans la devise du compte. */
  tickValue: z.number().positive(),
  tickValueProfit: z.number().positive().optional(),
  /** Pas, minimum et maximum du volume, en lots. */
  volumeStep: z.number().positive(),
  minVolume: z.number().positive(),
  maxVolume: z.number().positive(),
  contractSize: z.number().positive().optional(),
  digits: z.number().int().nonnegative().optional(),
  /** Commission aller-retour par lot, dans la devise du compte. */
  commission: z.number().nonnegative(),
  /** D'où vient la commission : réglée par l'utilisateur, lue sur ses dernières transactions, ou inconnue (0). */
  commissionSource: z.enum(["user", "history", "none"]),
});
export type SymbolTerms = z.infer<typeof symbolTermsSchema>;

/** Le compte du courtier, tel que Kopilia le lit. */
export const accountSnapshotSchema = z.object({
  name: z.string(),
  currency: z.string().min(1),
  balance: z.number(),
  equity: z.number(),
  /** Les ordres sont permis sur ce compte (faux avec un mot de passe « investisseur »). */
  tradeAllowed: z.boolean(),
  /** Compte de démonstration. */
  demo: z.boolean(),
  platform: z.string().optional(),
  /** Marge libre (ce qu'il reste pour de nouvelles positions) et effet de levier du compte. */
  freeMargin: z.number().optional(),
  leverage: z.number().optional(),
  at: z.number().int().positive(),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

/**
 * Un palier de risque de l'utilisateur, avec ses mots : « A+ », 3 %, « quand
 * le 4 h et le 15 min vont dans le même sens ». Kopilia le rappelle ; c'est
 * l'utilisateur qui choisit le palier d'un trade.
 */
export const riskTierSchema = z.object({
  name: z.string().trim().min(1).max(20),
  percent: z.number().positive().max(100),
  when: z.string().trim().max(200).optional(),
});
export type RiskTier = z.infer<typeof riskTierSchema>;
/** Paliers au plus. */
export const MAX_RISK_TIERS = 5;

/** Le capital sur lequel se calcule un pourcentage : le solde, ou les capitaux propres (positions ouvertes comprises). */
export const CAPITAL_BASES = ["balance", "equity"] as const;
export type CapitalBase = (typeof CAPITAL_BASES)[number];

/** Les règles de money management de l'utilisateur : Kopilia les applique, il ne les choisit pas. */
export const moneySettingsSchema = z.object({
  /** Le risque d'une boîte qui n'a pas le sien. */
  defaultRisk: riskSchema,
  /** Plafond par trade, en % du capital : au-delà, l'ordre ne part pas. */
  maxRiskPercent: z.number().positive().max(100),
  /** Risque total ouvert au plus (positions et ordres en attente ; une position à break-even ne compte plus). */
  maxOpenRiskPercent: z.number().positive().max(100).optional(),
  /** Perte au plus sur le jour, sur la semaine : atteinte, plus aucun ordre d'ouverture jusqu'à la période suivante. */
  maxDailyLossPercent: z.number().positive().max(100).optional(),
  maxWeeklyLossPercent: z.number().positive().max(100).optional(),
  capitalBase: z.enum(CAPITAL_BASES),
  /** Commission aller-retour par lot, par symbole du courtier, dans la devise du compte. */
  commissions: z.record(z.string(), z.number().nonnegative()),
  /** Rappel de passer à break-even quand une position atteint ce multiple du risque (sans : aucun rappel). */
  breakEvenAtR: z.number().positive().optional(),
  /** Ses paliers de risque (« standard » 1 %, « A+ » 3 %), du plus petit au plus grand. */
  tiers: z.array(riskTierSchema).max(MAX_RISK_TIERS).default([]),
});
export type MoneySettings = z.infer<typeof moneySettingsSchema>;

export const DEFAULT_MONEY_SETTINGS: MoneySettings = {
  defaultRisk: { mode: "percent", value: 1 },
  maxRiskPercent: 3,
  maxOpenRiskPercent: 6,
  capitalBase: "balance",
  commissions: {},
  breakEvenAtR: 1,
  tiers: [],
};

/** Le palier de ce nom (sans tenir compte des majuscules ni des accents). */
export function findTier(tiers: readonly RiskTier[], name: string): RiskTier | undefined {
  const key = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  return tiers.find((t) => key(t.name) === key(name));
}

/** Le risque qui s'applique : celui d'un palier suit le pourcentage du palier aujourd'hui (s'il existe encore). */
export function effectiveRisk(risk: Risk, settings: Pick<MoneySettings, "tiers">): Risk {
  if (!risk.tier) return risk;
  const tier = findTier(settings.tiers ?? [], risk.tier);
  return tier ? { mode: "percent", value: tier.percent, tier: tier.name } : risk;
}

/** « standard 1 % », « A+ 3 % (quand le 4 h et le 15 min vont dans le même sens) ». */
export function tierLabel(t: RiskTier, withWhen = false): string {
  return `${t.name} ${percentLabel(t.percent)}${withWhen && t.when ? ` (${t.when})` : ""}`;
}

/** La taille d'une boîte et ce qu'elle engage, calculées pour un compte. */
export interface PositionSizing {
  lots: number;
  /** Perte au stop, commission comprise (positive), dans la devise du compte. */
  loss: number;
  /** Gain à l'objectif, commission déduite. */
  gain: number;
  /** Commission aller-retour de cette taille. */
  fees: number;
  /** La perte en % du capital. */
  riskPercent: number;
  /** Ce qui empêche de la prendre (taille nulle, plafond dépassé). */
  problem?: string;
  /** Taille réduite : au plafond par trade, ou au volume maximal du courtier. */
  capped?: "max-risk" | "max-volume";
}

/** Le nombre de décimales d'un pas (0,01 → 2). */
export function stepDecimals(step: number): number {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/** Arrondi vers le bas au pas du volume (jamais plus que le risque voulu). */
export function floorToStep(v: number, step: number): number {
  return Number((Math.floor(v / step + 1e-9) * step).toFixed(stepDecimals(step)));
}

/** Ce que coûte (ou rapporte) un écart de prix pour un lot, dans la devise du compte. */
export function valueOfDistance(distance: number, terms: Pick<SymbolTerms, "tickSize" | "tickValue">, tickValue = terms.tickValue): number {
  return (Math.abs(distance) / terms.tickSize) * tickValue;
}

/**
 * La taille d'une boîte selon le risque choisi : un pourcentage du capital ou
 * un montant (la taille se calcule : risque ÷ (perte d'un lot au stop +
 * commission), arrondie vers le bas au pas du courtier), ou un nombre de lots
 * (la perte se calcule). Le plafond par trade réduit la taille ; des lots qui le
 * dépassent sont refusés.
 */
export function sizePosition(
  box: { entry: number; stop: number; target: number },
  terms: SymbolTerms,
  capital: number,
  risk: Risk,
  opts: { maxRiskPercent?: number; currency?: string } = {},
): PositionSizing {
  const money = (v: number) => moneyLabel(v, opts.currency ?? "");
  const perLotLoss = valueOfDistance(box.entry - box.stop, terms) + terms.commission;
  const perLotGain = valueOfDistance(box.target - box.entry, terms, terms.tickValueProfit ?? terms.tickValue) - terms.commission;
  const empty = (problem: string): PositionSizing => ({ lots: 0, loss: 0, gain: 0, fees: 0, riskPercent: 0, problem });
  if (!(capital > 0)) return empty("capital du compte inconnu");
  if (!(perLotLoss > 0)) return empty("le stop est sur l'entrée");
  const cap = opts.maxRiskPercent !== undefined ? (capital * opts.maxRiskPercent) / 100 : Infinity;
  let lots: number;
  let capped: PositionSizing["capped"];
  if (risk.mode === "lots") {
    lots = floorToStep(risk.value, terms.volumeStep);
  } else {
    let budget = risk.mode === "percent" ? (capital * risk.value) / 100 : risk.value;
    if (budget > cap + 1e-9) {
      budget = cap;
      capped = "max-risk";
    }
    lots = floorToStep(budget / perLotLoss, terms.volumeStep);
  }
  if (lots > terms.maxVolume) {
    lots = floorToStep(terms.maxVolume, terms.volumeStep);
    capped = "max-volume";
  }
  if (lots < terms.minVolume - 1e-9) {
    const smallest = terms.minVolume * perLotLoss;
    return empty(
      risk.mode === "lots"
        ? `le courtier demande ${lotsLabel(terms.minVolume)} au moins`
        : `le stop est trop loin pour ce risque : le plus petit lot (${lotsLabel(terms.minVolume)}) perdrait ${money(smallest)}`,
    );
  }
  const loss = lots * perLotLoss;
  const sizing: PositionSizing = {
    lots,
    loss,
    gain: lots * perLotGain,
    fees: lots * terms.commission,
    riskPercent: (loss / capital) * 100,
    ...(capped ? { capped } : {}),
  };
  if (risk.mode === "lots" && loss > cap + 1e-9) {
    sizing.problem = `${percentLabel(sizing.riskPercent)} de risque dépasse ton plafond de ${percentLabel(opts.maxRiskPercent!)} par trade`;
  }
  return sizing;
}

/**
 * Le prix de break-even d'une position : l'entrée, décalée de ce que coûte la
 * commission aller-retour d'un lot (en ticks, arrondi au tick supérieur), du
 * côté du gain. Fermée là, la position ne perd rien.
 */
export function breakEvenPrice(side: PositionSide, entry: number, terms: Pick<SymbolTerms, "tickSize" | "tickValue" | "commission" | "digits">): number {
  const ticks = terms.commission > 0 ? Math.ceil(terms.commission / terms.tickValue - 1e-9) : 0;
  const price = side === "long" ? entry + ticks * terms.tickSize : entry - ticks * terms.tickSize;
  const digits = terms.digits ?? stepDecimals(terms.tickSize);
  return Number(price.toFixed(digits));
}

/** Un prix ramené au tick du produit (arrondi au plus proche). */
export function roundToTick(price: number, terms: Pick<SymbolTerms, "tickSize" | "digits">): number {
  const digits = terms.digits ?? stepDecimals(terms.tickSize);
  return Number((Math.round(price / terms.tickSize) * terms.tickSize).toFixed(digits));
}

const MINUS = "−";

/**
 * « 98 € », « 2,30 € », « 1 160 $ » : un montant dans la devise du compte, à
 * la française (sans décimales au-delà de 10) ; `sign` : « +286 € », « −98 € ».
 */
export function moneyLabel(amount: number, currency: string, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(amount);
  const digits = abs >= 10 ? 0 : 2;
  let body: string;
  try {
    body = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(abs);
  } catch {
    body = `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(abs)}${currency ? ` ${currency}` : ""}`;
  }
  const rounded = Number(abs.toFixed(digits));
  if (!opts.sign || rounded === 0) return amount < 0 && rounded !== 0 ? `${MINUS}${body}` : body;
  return `${amount < 0 ? MINUS : "+"}${body}`;
}

/** « 0,01 lot », « 1,5 lot », « 2,4 lots ». */
export function lotsLabel(lots: number): string {
  return `${String(Number(lots.toFixed(2))).replace(".", ",")} ${lots >= 2 ? "lots" : "lot"}`;
}

/** « 0,98 % », « 1 % », « 2,5 % » : deux décimales au plus. */
export function percentLabel(p: number): string {
  return `${String(Number(p.toFixed(2))).replace(".", ",")} %`;
}

/** « 1 % du capital », « 150 € », « 2 lots » : le risque choisi, en mots. */
export function riskLabel(risk: Risk, currency = ""): string {
  if (risk.mode === "percent") return `${percentLabel(risk.value)} du capital${risk.tier ? ` (palier ${risk.tier})` : ""}`;
  if (risk.mode === "amount") return moneyLabel(risk.value, currency);
  return lotsLabel(risk.value);
}

/* ------------------------------- Les ordres ------------------------------- */

/** Comment entre un ordre d'ouverture : au marché (tout de suite), à cours limité ou stop (en attente, au prix de l'entrée). */
export const ORDER_EXECUTIONS = ["market", "limit", "stop"] as const;
export type OrderExecution = (typeof ORDER_EXECUTIONS)[number];

/**
 * Ce qu'un ticket fait chez le courtier : ouvrir (un ou plusieurs ordres, un par
 * objectif), passer le stop à break-even, déplacer le stop ou l'objectif,
 * fermer tout ou une part, retirer un ordre en attente.
 */
export const TICKET_ACTIONS = ["open", "breakeven", "modify", "close", "partial", "cancel"] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** Une jambe d'un ordre d'ouverture : sa taille et son objectif (plusieurs objectifs : une jambe par objectif, même stop). */
export const ticketLegSchema = z.object({ lots: z.number().positive(), target: z.number().optional() });
export type TicketLeg = z.infer<typeof ticketLegSchema>;

/**
 * Un ticket : ce que l'utilisateur s'apprête à envoyer chez le courtier, relu
 * par Kopilia et affiché ; rien ne part sans sa confirmation, avant `expiresAt`.
 */
export const ticketSchema = z.object({
  id: z.string().min(1),
  action: z.enum(TICKET_ACTIONS),
  symbol: z.string().min(1),
  name: z.string(),
  digits: z.number().int().nonnegative().optional(),
  side: z.enum(POSITION_SIDES),
  /** La boîte d'où il vient, le trade qu'il gère, le setup de l'IA qu'il reprend. */
  drawingId: z.string().optional(),
  tradeId: z.string().optional(),
  setupId: z.string().optional(),
  execution: z.enum(ORDER_EXECUTIONS).optional(),
  entry: z.number().optional(),
  stop: z.number().optional(),
  legs: z.array(ticketLegSchema),
  /** Nouveau stop (break-even, déplacement), nouvel objectif, part à fermer (0 à 1). */
  newStop: z.number().optional(),
  newTarget: z.number().optional(),
  fraction: z.number().positive().max(1).optional(),
  lots: z.number().nonnegative(),
  loss: z.number().nonnegative(),
  gain: z.number(),
  fees: z.number().nonnegative(),
  riskPercent: z.number().nonnegative(),
  currency: z.string(),
  /** Marge demandée par le courtier pour l'ouvrir (devise du compte), et le palier de risque choisi. */
  margin: z.number().nonnegative().optional(),
  tier: z.string().optional(),
  /** Le ticket relu, tel que Kopilia le dit et que l'écran le montre. */
  text: z.string().min(1),
  /** Ce qu'il faut savoir avant de confirmer (plafond appliqué, commission inconnue…). */
  warnings: z.array(z.string()),
  account: z.string(),
  demo: z.boolean(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
export type Ticket = z.infer<typeof ticketSchema>;

/** Où en est un trade passé par Kopilia : ordre en attente, position ouverte, fermée, ordre retiré, ou refusé par le courtier. */
export const TRADE_STATES = ["pending", "open", "closed", "cancelled", "rejected"] as const;
export type TradeState = (typeof TRADE_STATES)[number];

/**
 * Comment une part de position est sortie, d'après le courtier : son objectif,
 * son stop, une fermeture à la main sur la plateforme (ordinateur, mobile, web),
 * par Kopilia (à la demande de l'utilisateur), un arrêt de marge, ou on ne sait pas.
 */
export const EXIT_REASONS = ["target", "stop", "manual", "kopilia", "stopout", "unknown"] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** Une sortie lue sur les transactions du courtier (fermeture totale ou partielle d'une jambe). */
export const tradeExitSchema = z.object({
  /** L'identifiant de la transaction : une sortie n'est comptée qu'une fois. */
  id: z.string().min(1),
  at: z.number().int().positive(),
  price: z.number(),
  lots: z.number().nonnegative(),
  /** Résultat net de cette sortie (profit, commission et swap). */
  profit: z.number(),
  reason: z.enum(EXIT_REASONS),
});
export type TradeExit = z.infer<typeof tradeExitSchema>;

/** Une jambe chez le courtier : son ordre, puis sa position. */
export const tradeLegSchema = z.object({
  /** Notre identifiant chez le courtier (champ clientId de MetaTrader). */
  clientId: z.string().min(1),
  lots: z.number().positive(),
  target: z.number().optional(),
  orderId: z.string().optional(),
  positionId: z.string().optional(),
  state: z.enum(TRADE_STATES),
  openPrice: z.number().optional(),
  closePrice: z.number().optional(),
  /** Résultat net (profit, commission et swap), dans la devise du compte : en cours ou réalisé. */
  profit: z.number().optional(),
  /** Ses sorties, dans l'ordre (une partielle, puis la dernière). */
  exits: z.array(tradeExitSchema).optional(),
});
export type TradeLeg = z.infer<typeof tradeLegSchema>;

export const tradeSchema = z.object({
  /** Identifiant stable (t_…). */
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string(),
  digits: z.number().int().nonnegative().optional(),
  side: z.enum(POSITION_SIDES),
  drawingId: z.string().optional(),
  setupId: z.string().optional(),
  execution: z.enum(ORDER_EXECUTIONS),
  /** Les niveaux : l'entrée prévue (ou le prix d'exécution), le stop (à jour), les objectifs. */
  entry: z.number(),
  stop: z.number(),
  /** Le stop de départ : le risque se mesure dessus, même après un break-even. */
  initialStop: z.number(),
  targets: z.array(z.number()),
  lots: z.number().positive(),
  /** Le risque engagé à l'ouverture (perte au stop de départ, commission comprise) et son pourcentage. */
  risk: z.number().nonnegative(),
  riskPercent: z.number().nonnegative(),
  /** Le palier de risque choisi au ticket (« A+ »), s'il en a pris un. */
  tier: z.string().optional(),
  currency: z.string(),
  state: z.enum(TRADE_STATES),
  legs: z.array(tradeLegSchema),
  /** Le stop est à break-even (ou au-delà) : la position ne risque plus rien. */
  protected: z.boolean(),
  /** Le rappel de break-even a été fait. */
  reminded: z.boolean().optional(),
  /** Résultat net (devise du compte) et en multiples du risque. */
  profit: z.number().optional(),
  r: z.number().optional(),
  note: z.string().optional(),
  demo: z.boolean(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  openedAt: z.number().int().positive().optional(),
  closedAt: z.number().int().positive().optional(),
});
export type Trade = z.infer<typeof tradeSchema>;

/** Un trade encore en cours : ordre en attente ou position ouverte. */
export function isLiveTrade(state: TradeState): boolean {
  return state === "pending" || state === "open";
}

/** L'état de la prise de position, envoyé aux écrans. */
export const tradingStateSchema = z.object({
  /** Les ordres sont permis par la configuration de Kopilia (sinon : calculs seulement). */
  ordersEnabled: z.boolean(),
  account: accountSnapshotSchema.optional(),
  settings: moneySettingsSchema,
  /** Les conditions du courtier des produits affichés (ou qui ont une boîte). */
  terms: z.record(z.string(), symbolTermsSchema),
  /** Les trades en cours, et les derniers terminés. */
  trades: z.array(tradeSchema),
  ticket: ticketSchema.optional(),
  /** Pourquoi le compte n'a pas pu être lu. */
  error: z.string().optional(),
});
export type TradingState = z.infer<typeof tradingStateSchema>;

/** Le capital de référence d'un compte selon les réglages. */
export function capitalOf(account: Pick<AccountSnapshot, "balance" | "equity">, settings: Pick<MoneySettings, "capitalBase">): number {
  return settings.capitalBase === "equity" ? account.equity : account.balance;
}

/** La taille d'une boîte selon l'état de la prise de position (undefined : compte ou conditions du produit inconnus). */
export function sizeBox(
  box: { symbol: string; entry: number; stop: number; target: number; risk?: Risk },
  state: Pick<TradingState, "account" | "settings" | "terms">,
): PositionSizing | undefined {
  const terms = state.terms[box.symbol];
  if (!state.account || !terms) return undefined;
  return sizePosition(box, terms, capitalOf(state.account, state.settings), effectiveRisk(box.risk ?? state.settings.defaultRisk, state.settings), {
    maxRiskPercent: state.settings.maxRiskPercent,
    currency: state.account.currency,
  });
}

/** Un ordre au prix de l'entrée : à cours limité s'il attend un meilleur prix, stop s'il attend une cassure. */
export function pendingExecution(side: PositionSide, entry: number, quote: { bid: number; ask: number }): "limit" | "stop" {
  return side === "long" ? (entry <= quote.ask ? "limit" : "stop") : entry >= quote.bid ? "limit" : "stop";
}

/** Le résultat d'un trade en multiples de son risque de départ. */
export function tradeR(profit: number, risk: number): number | undefined {
  return risk > 0 ? Math.round((profit / risk) * 100) / 100 : undefined;
}
