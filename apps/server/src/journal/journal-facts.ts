import {
  FIDELITY_LABELS,
  GESTURE_SOURCE_LABELS,
  OUTCOME_LABELS,
  exitLabel,
  moneyLabel,
  tradeOutcome,
  widensStop,
  type AnalysisEntry,
  type AnalysisView,
  type FicheFidelity,
  type JournalFact,
  type Trade,
  type TradeGesture,
} from "@kopilia/contracts";
import { frenchPrice } from "../market/metaapi.js";
import { relativeMoment, zoneLabel } from "../analyses/analysis-texts.js";
import { rLabel, sideWord } from "../trading/trading-texts.js";

/*
 * Ce que le journal constate d'un trade, sans modèle : son résultat et sa
 * sortie, le trade face à la fiche du produit telle qu'elle était au ticket
 * (son idée, ses biais, sa zone), l'objection relevée avant, un changement
 * d'avis depuis l'idée de départ, les gestes pendant le trade (un stop
 * élargi est contre le plan). Pur, testé à plat.
 */

/** La fiche telle qu'elle était au ticket : son état, et son fil jusque-là. */
export interface FicheAtTicket {
  id: string;
  createdAt: number;
  view: AnalysisView;
  /** Le fil de la fiche jusqu'au ticket (les plus anciennes d'abord). */
  entries: AnalysisEntry[];
}

/** Le sens d'un trade dans les mots d'une fiche. */
function ficheSide(side: Trade["side"]): "buy" | "sell" {
  return side === "long" ? "buy" : "sell";
}

/** Un biais contraire au sens du trade (haussier pour une vente, baissier pour un achat). */
function againstBias(side: Trade["side"], bias: string | undefined): boolean {
  return side === "long" ? bias === "down" : bias === "up";
}

const BIAS_WORDS: Record<string, string> = { up: "haussier", down: "baissier", neutral: "neutre" };

/** Le trade et sa fiche : fidèle (dans le sens de l'idée, aucun biais contre), contre, ou sans fiche. */
export function fidelityOf(trade: Pick<Trade, "side">, fiche: Pick<FicheAtTicket, "view"> | undefined): FicheFidelity {
  if (!fiche) return "none";
  const v = fiche.view;
  const idea = v.idea?.side;
  if (idea && idea !== "none" && idea !== ficheSide(trade.side)) return "against";
  if (againstBias(trade.side, v.fundamental?.bias)) return "against";
  return "with";
}

/** L'idée d'une fiche en quelques mots : « achat sur 26 600 – 26 650 », « vente », « pas d'idée de trade ». */
export function ideaWords(view: AnalysisView | undefined, digits?: number): string | undefined {
  const idea = view?.idea;
  if (!idea) return undefined;
  if (idea.side === "none") return "pas d'idée de trade";
  const zone = zoneLabel(idea.zone, digits);
  return `${idea.side === "buy" ? "achat" : "vente"}${zone ? ` sur ${zone}` : ""}`;
}

/** La première idée de trade de la fiche (sa première lecture avec un sens), et quand. */
export function firstIdea(entries: AnalysisEntry[]): { at: number; view: AnalysisView } | undefined {
  const e = entries.find((x) => x.kind === "view" && x.view?.idea && x.view.idea.side !== "none");
  return e ? { at: e.at, view: e.view! } : undefined;
}

/** « 2 h 04 », « 35 min », « 3 j 4 h ». */
export function durationLabel(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  const d = Math.floor(h / 24);
  return `${d} j${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** La durée en position : de l'exécution à la dernière sortie (ou à maintenant). */
export function durationOf(trade: Trade, now: number): number | undefined {
  if (!trade.openedAt) return undefined;
  return (trade.closedAt ?? (trade.state === "open" ? now : trade.updatedAt)) - trade.openedAt;
}

/** Les faits du journal sur un trade, du plus important au moins important. */
export function journalFacts(
  trade: Trade,
  o: { fiche?: FicheAtTicket; gestures: TradeGesture[]; frozen: boolean; ticketAt: number; now: number },
): JournalFact[] {
  const facts: JournalFact[] = [];
  const p = (v: number) => frenchPrice(v, trade.digits);
  const outcome = tradeOutcome(trade);
  if (outcome) {
    const exit = exitLabel(trade);
    const span = durationOf(trade, o.now);
    const money = trade.profit !== undefined ? `, ${moneyLabel(trade.profit, trade.currency, { sign: true })}` : "";
    facts.push({
      key: "outcome",
      tone: outcome === "loss" ? "warn" : outcome === "win" ? "ok" : "info",
      text: `${capitalize(OUTCOME_LABELS[outcome])} : ${rLabel(trade.r!)}${money}${exit ? `, ${exit}` : ""}${span !== undefined ? ` · ${durationLabel(span)} en position` : ""}.`,
    });
  } else if (trade.state === "cancelled") {
    facts.push({ key: "outcome", tone: "info", text: "Ordre retiré avant d'être exécuté : ni gagné ni perdu." });
  }

  const fiche = o.fiche;
  if (!fiche) {
    facts.push({ key: "fiche", tone: "info", text: "Aucune fiche ouverte sur ce produit au moment du ticket." });
  } else {
    const v = fiche.view;
    const idea = v.idea?.side;
    const words = ideaWords(v, trade.digits);
    if (idea && idea !== "none" && idea !== ficheSide(trade.side)) {
      facts.push({ key: "against-idea", tone: "warn", text: `Contre l'idée de ta fiche (${words}) : tu as pris ${articleSide(trade.side)}.` });
    } else if (idea && idea !== "none") {
      facts.push({ key: "with-idea", tone: "ok", text: `Dans le sens de ta fiche (${words}).` });
    }
    // Ses biais, l'un après l'autre : dans le sens du trade, ou contre lui.
    for (const [key, words, bias] of [
      ["fundamental", "ton biais fondamental", v.fundamental],
      ["technical", "ta lecture technique", v.technical],
    ] as const) {
      if (!bias || bias.bias === "neutral") continue;
      const why = bias.reason ? ` : ${trimEnd(bias.reason)}` : "";
      if (againstBias(trade.side, bias.bias)) facts.push({ key: `against-${key}`, tone: "warn", text: `Contre ${words} (${BIAS_WORDS[bias.bias]}${why}).` });
      else facts.push({ key: `with-${key}`, tone: "ok", text: `Dans le sens de ${words} (${BIAS_WORDS[bias.bias]}${why}).` });
    }
    // L'entrée face à la zone de l'idée (quand la zone a des prix et que le trade va dans son sens).
    const zone = v.idea?.zone;
    if (idea === ficheSide(trade.side) && zone && (zone.low !== undefined || zone.high !== undefined)) {
      const low = Math.min(zone.low ?? zone.high!, zone.high ?? zone.low!);
      const high = Math.max(zone.low ?? zone.high!, zone.high ?? zone.low!);
      const margin = Math.max((high - low) * 0.25, Math.abs(trade.entry - trade.initialStop) * 0.1);
      const inside = trade.entry >= low - margin && trade.entry <= high + margin;
      facts.push(
        inside
          ? { key: "zone", tone: "ok", text: `Entrée à ${p(trade.entry)}, dans ta zone (${zoneLabel(zone, trade.digits)}).` }
          : { key: "zone", tone: "warn", text: `Entrée à ${p(trade.entry)}, hors de ta zone (${zoneLabel(zone, trade.digits)}).` },
      );
    }
    // Un changement d'avis : l'idée de départ de la fiche n'allait pas dans le même sens.
    const first = firstIdea(fiche.entries);
    if (first && idea && idea !== "none" && first.view.idea!.side !== idea) {
      facts.push({
        key: "changed-mind",
        tone: "warn",
        text: `Changement d'avis : ton idée de départ (${relativeMoment(first.at, o.now)}) était ${ideaWords(first.view, trade.digits)}.`,
      });
    }
    // La dernière objection relevée avant le ticket, et sa réponse.
    const before = fiche.entries.filter((e) => e.at <= o.ticketAt);
    const objection = [...before].reverse().find((e) => e.kind === "challenge");
    if (objection) {
      const answer = before.find((e) => e.kind === "why" && e.at >= objection.at);
      facts.push({
        key: "objection",
        tone: fidelityOf(trade, fiche) === "against" ? "warn" : "info",
        text: `Objection relevée ${relativeMoment(objection.at, o.now)} : « ${trimEnd(objection.text)} »${answer ? ` ; ta réponse : « ${trimEnd(answer.text)} »` : " ; sans réponse de ta part"}.`,
      });
    }
  }

  // Les gestes pendant le trade.
  const widened = o.gestures.filter((g) => g.kind === "stop" && g.from !== undefined && g.to !== undefined && widensStop(trade.side, g.from, g.to));
  for (const g of widened) {
    facts.push({
      key: "stop-widened",
      tone: "warn",
      text: `Stop élargi de ${p(g.from!)} à ${p(g.to!)}, ${GESTURE_SOURCE_LABELS[g.source]} : plus de risque que prévu au ticket.`,
    });
  }
  const stops = o.gestures.filter((g) => g.kind === "stop").length - widened.length;
  const targets = o.gestures.filter((g) => g.kind === "target").length;
  const partials = o.gestures.filter((g) => g.kind === "partial").length;
  const parts = [
    stops ? `stop remonté ${times(stops)}` : "",
    targets ? `objectif déplacé ${times(targets)}` : "",
    partials ? `${partials} part${partials > 1 ? "s" : ""} fermée${partials > 1 ? "s" : ""} avant la fin` : "",
  ].filter(Boolean);
  if (parts.length) facts.push({ key: "gestures", tone: "info", text: `Gestion : ${parts.join(", ")}.` });
  if (!o.frozen)
    facts.push({ key: "not-frozen", tone: "info", text: "Pris avant le journal : son graphique n'a pas été figé, seuls ses niveaux y sont dessinés." });
  return facts;
}

/** « fidèle à la fiche », « contre la fiche »… */
export function fidelityLabel(f: FicheFidelity): string {
  return FIDELITY_LABELS[f];
}

function articleSide(side: Trade["side"]): string {
  return side === "long" ? "un achat" : `une ${sideWord(side)}`;
}

function times(n: number): string {
  return n === 1 ? "une fois" : `${n} fois`;
}

function trimEnd(s: string): string {
  return s.trim().replace(/[.\s]+$/, "");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
