import type { Analysis, AnalysisBias, AnalysisEntry, AnalysisEntryKind, AnalysisIdea, AnalysisSide, AnalysisView, AnalysisZone } from "@kopilia/contracts";
import { clock, dayLabel, startOfDay } from "../common/dates.js";
import { frenchPrice } from "../market/metaapi.js";

/** Les textes des fiches d'analyse, tels que le dialogue les lit (et les redit). */

export const SIDE: Record<AnalysisSide, string> = { buy: "achat", sell: "vente", none: "pas d'idée de trade" };
export const BIAS: Record<AnalysisBias, string> = { up: "haussier", down: "baissier", neutral: "neutre" };
const HORIZON = { intraday: "intraday", swing: "swing" } as const;
const KIND: Record<AnalysisEntryKind, string> = {
  view: "sa lecture",
  why: "sa réponse",
  challenge: "objection",
  setup: "setup du système",
  zone: "zone",
  invalidated: "invalidation",
  close_proposed: "fermeture proposée",
  closed: "fermée",
};
const BY = { user: "lui", kopilia: "Kopilia", system: "le système" } as const;

/** « aujourd'hui à 9 h 12 », « hier à 9 h 12 », « lundi 2 novembre à 9 h 12 ». */
export function relativeMoment(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(at).getTime()) / 86_400_000);
  const day = days === 0 ? "aujourd'hui" : days === 1 ? "hier" : dayLabel(new Date(at));
  return `${day} à ${clock(at)}`;
}

/** « la zone des 2 600 (2 600,00 – 2 610,00) », « 2 600,00 », ou undefined. */
export function zoneLabel(zone: AnalysisZone | undefined, digits?: number): string | undefined {
  if (!zone) return undefined;
  const p = (v: number) => frenchPrice(v, digits);
  const { low, high } = zone;
  const prices =
    low !== undefined && high !== undefined
      ? low === high
        ? p(low)
        : `${p(low)} – ${p(high)}`
      : low !== undefined
        ? p(low)
        : high !== undefined
          ? p(high)
          : "";
  const text = zone.text ? inline(zone.text) : "";
  if (text && prices) return saysPrices(text, zone) ? text : `${text} (${prices})`;
  return text || prices || undefined;
}

/** Le texte dit déjà les prix de la zone (« la zone des 4 020 – 4 030 ») : inutile de les répéter. */
function saysPrices(text: string, zone: AnalysisZone): boolean {
  const digits = text.replace(/\D/g, "");
  return [zone.low, zone.high].every((v) => v === undefined || digits.includes(String(Math.trunc(v))));
}

/** « achat sur la zone des 2 600 (2 600,00 – 2 610,00) », « vente sous 4 100 » ; « vente » ; undefined sans idée. */
export function ideaLabel(view: AnalysisView, digits?: number): string | undefined {
  const idea = view.idea;
  if (!idea) return undefined;
  if (idea.side === "none") return SIDE.none;
  return sideAt(idea.side, zoneLabel(idea.zone, digits));
}

/** « vente sous 4 100 », « achat sur la zone des 2 600 », « vente » : la préposition dite (« sous », « dans »…) n'est pas doublée. */
function sideAt(side: "buy" | "sell", zone: string | undefined): string {
  if (!zone) return SIDE[side];
  return /^(sous|sur|au-dessus|au-dessous|en dessous|en dessus|dans|vers|autour|près|entre|à|au|aux|depuis|après|avant)\b/i.test(zone)
    ? `${SIDE[side]} ${zone}`
    : `${SIDE[side]} sur ${zone}`;
}

/**
 * Ce qu'il a dit, à glisser dans une phrase : sans point final, et en
 * minuscule au début (« Les taux baissent. » -> « les taux baissent »), sauf
 * un sigle (« BCE »).
 */
export function inline(s: string): string {
  const t = s.trim().replace(/[.\s]+$/, "");
  return /^\p{Lu}\p{Ll}/u.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}
const sentence = inline;

/** Ce qu'il vient de dire, seulement : une raison sans sens, une zone sans sens de trade sont possibles. */
export interface SaidView {
  summary?: string;
  fundamental?: { bias?: AnalysisBias; reason?: string };
  technical?: { bias?: AnalysisBias; reason?: string };
  idea?: Partial<AnalysisIdea>;
  invalidation?: string;
  catalysts?: string;
}

/** Ce qu'il vient de dire, en une ligne (l'entrée du fil). */
export function saidText(said: SaidView, digits?: number): string {
  const parts: string[] = [];
  if (said.summary) parts.push(`lecture : ${sentence(said.summary)}`);
  for (const [key, label] of [
    ["fundamental", "fondamental"],
    ["technical", "technique"],
  ] as const) {
    const b = said[key];
    if (!b) continue;
    parts.push(
      b.bias
        ? `${label} ${BIAS[b.bias]}${b.reason ? ` (${sentence(b.reason)})` : ""}`
        : `raison ${label === "fondamental" ? "fondamentale" : "technique"} : ${sentence(b.reason ?? "")}`,
    );
  }
  const i = said.idea;
  if (i) {
    const zone = zoneLabel(i.zone, digits);
    const head = i.side ? (i.side === "none" ? SIDE.none : sideAt(i.side, zone)) : zone ? `zone : ${zone}` : "";
    const extra = [i.trigger ? `déclencheur : ${sentence(i.trigger)}` : "", i.horizon ? HORIZON[i.horizon] : "", i.timeframe ? `en ${i.timeframe}` : ""].filter(
      Boolean,
    );
    const idea = [head, ...extra].filter(Boolean).join(", ");
    if (idea) parts.push(`idée : ${idea}`);
  }
  if (said.invalidation) parts.push(`invalidée si : ${sentence(said.invalidation)}`);
  if (said.catalysts) parts.push(`catalyseurs : ${sentence(said.catalysts)}`);
  return parts.join(" ; ");
}

/** L'état d'une fiche, en une ligne : lecture, biais, idée, invalidation. */
export function viewText(view: AnalysisView, digits?: number): string {
  const parts: string[] = [];
  if (view.summary) parts.push(`lecture : ${sentence(view.summary)}`);
  if (view.fundamental) parts.push(`fondamental ${BIAS[view.fundamental.bias]}${view.fundamental.reason ? ` (${sentence(view.fundamental.reason)})` : ""}`);
  if (view.technical) parts.push(`technique ${BIAS[view.technical.bias]}${view.technical.reason ? ` (${sentence(view.technical.reason)})` : ""}`);
  const idea = ideaLabel(view, digits);
  if (idea) {
    const i = view.idea!;
    const extra = [
      i.trigger ? `déclencheur : ${sentence(i.trigger)}` : "",
      i.horizon || i.timeframe ? [i.horizon ? HORIZON[i.horizon] : "", i.timeframe ? `en ${i.timeframe}` : ""].filter(Boolean).join(" ") : "",
    ].filter(Boolean);
    parts.push(`idée : ${idea}${extra.length ? `, ${extra.join(", ")}` : ""}`);
  }
  if (view.invalidation) parts.push(`invalidée si : ${sentence(view.invalidation)}`);
  if (view.catalysts) parts.push(`catalyseurs : ${sentence(view.catalysts)}`);
  return parts.length ? parts.join(" ; ") : "rien de noté";
}

/** « or (an_1a2b3c4d, ouverte hier à 8 h 40, mise à jour aujourd'hui à 9 h 12) : fondamental haussier… ». */
export function analysisLine(a: Analysis, now = Date.now()): string {
  const by = a.author === "kopilia" ? ", ouverte par Kopilia" : "";
  const life =
    a.state === "open"
      ? `ouverte ${relativeMoment(a.createdAt, now)}${a.updatedAt !== a.createdAt ? `, mise à jour ${relativeMoment(a.updatedAt, now)}` : ""}`
      : `FERMÉE ${relativeMoment(a.closedAt ?? a.updatedAt, now)}${a.closeReason ? ` : ${sentence(a.closeReason)}` : ""}`;
  const proposed = a.closeProposedAt ? " ; fermeture proposée, en attente de sa réponse" : "";
  return `${a.name} (${a.id}${by}, ${life}${proposed}) : ${viewText(a.view, a.digits)}`;
}

/** Une entrée du fil : « hier à 9 h 12, sa lecture : vente sur 2 640… ». */
export function entryLine(e: AnalysisEntry, now = Date.now()): string {
  const who = e.kind === "view" || e.kind === "why" || e.kind === "challenge" ? "" : ` (${BY[e.by]})`;
  return `${relativeMoment(e.at, now)}, ${KIND[e.kind]}${who} : ${e.text}`;
}
