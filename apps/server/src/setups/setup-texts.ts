import {
  Alert,
  Drawing,
  Hypothesis,
  OUTCOME_NAMES,
  REACTION_NAMES,
  RsiDivergence,
  STATE_NAMES,
  Scenario,
  ScenarioEvent,
  SetupStatsRow,
  rewardRisk,
} from "@kopilia/contracts";
import { frenchPrice } from "../market/metaapi.js";
import { describeAlert } from "../alerts/alert-texts.js";
import { describeDrawing, shortMoment } from "../dashboard/drawing.service.js";
import type { ChartCandle } from "../market/market.service.js";
import type { CorrectedMap } from "./map.service.js";

/*
 * La recherche d'opportunités en mots : les hypothèses, les dossiers et leur
 * fil tels que les agents les relisent, ce que l'écran et Kopilia disent d'un
 * setup. Pur, testé à plat.
 */

const BIAS: Record<Hypothesis["bias"], string> = { up: "haussière", down: "baissière", neutral: "neutre" };
const AUTHOR: Record<Hypothesis["author"], string> = { user: "de l'utilisateur", kopilia: "de l'IA" };
const HORIZON: Record<Hypothesis["horizon"], string> = { intraday: "séance", swing: "plusieurs jours" };
const SIDE: Record<Scenario["direction"], string> = { long: "acheteur", short: "vendeur" };
const BY: Record<ScenarioEvent["by"], string> = { agent: "IA", user: "utilisateur", system: "serveur" };

/** « jeudi 5 novembre à 10:45 » ; « 10:45 » le même jour que `now`. */
export function when(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  const day = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(d);
  return `${day} à ${hm}`;
}

/** « h_1a2b3c (de l'IA, baissière, séance ; or, Nasdaq) : le dollar reprend… Invalidée si : … ». */
export function hypothesisLine(h: Hypothesis, now = Date.now()): string {
  const products = h.products.length ? ` ; ${h.products.map((p) => p.name).join(", ")}` : "";
  const state =
    h.state === "active"
      ? `, jusqu'à ${when(h.expiresAt, now)}`
      : ` — ${h.state === "confirmed" ? "CONFIRMÉE" : h.state === "invalidated" ? "INVALIDÉE" : "EXPIRÉE"}${h.stateReason ? ` : ${h.stateReason}` : ""}`;
  return [
    `${h.id} (${AUTHOR[h.author]}, ${BIAS[h.bias]}, ${HORIZON[h.horizon]}${products}${state}) : ${sentence(h.statement)}`,
    h.catalysts ? `Catalyseurs : ${sentence(h.catalysts)}` : "",
    `Invalidée si : ${sentence(h.invalidation)}`,
    h.source ? `Source : ${sentence(h.source)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Les niveaux d'un scénario : « entrée 2 652,00, stop 2 661,00, objectifs 2 630,00 et 2 615,00 (rapport 2,4) ». */
export function levelsText(s: Pick<Scenario, "direction" | "entry" | "stop" | "targets" | "digits">): string {
  const p = (v: number) => frenchPrice(v, s.digits);
  const parts = [
    s.entry !== undefined ? `entrée ${p(s.entry)}` : "",
    s.stop !== undefined ? `stop ${p(s.stop)}` : "",
    s.targets.length ? `objectif${s.targets.length > 1 ? "s" : ""} ${s.targets.map(p).join(" et ")}` : "",
  ].filter(Boolean);
  const rr = rewardRisk(s);
  return parts.length ? `${parts.join(", ")}${rr !== undefined ? ` (rapport ${rr.toFixed(1).replace(".", ",")})` : ""}` : "niveaux pas encore fixés";
}

/** Une ligne par scénario : « sc_1 — Or : rejet… (vendeur, 15m / 4h, en surveillance, échéance 14:15) ». */
export function scenarioLine(s: Scenario, now = Date.now()): string {
  const tfs = s.contextTimeframe ? `${s.timeframe} / ${s.contextTimeframe}` : s.timeframe;
  const state = s.state === "watching" || s.state === "proposed" ? `${STATE_NAMES[s.state]}, échéance ${when(s.expiresAt, now)}` : STATE_NAMES[s.state];
  const review = s.review ? ` ; À REVOIR : ${s.review}` : "";
  return `${s.id} — ${s.title} (${s.name}, ${SIDE[s.direction]}, ${tfs}, ${state})${review}`;
}

/**
 * Le dossier complet, tel que l'agent le relit au réveil : ce qu'il a écrit en
 * l'ouvrant, ses dépendances, ses niveaux, ses alertes et son rendez-vous.
 */
export function dossierText(s: Scenario, alerts: Alert[], opts: { hypotheses?: Hypothesis[]; drawings?: Drawing[]; now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const hyp = (id: string) => opts.hypotheses?.find((h) => h.id === id);
  const drawing = (id: string) => opts.drawings?.find((d) => d.id === id);
  const deps = [
    ...s.depends.hypotheses.map((id) => (hyp(id) ? `- hypothèse ${hypothesisLine(hyp(id)!, now)}` : `- hypothèse ${id} (introuvable : retirée)`)),
    ...s.depends.drawings.map((id) => {
      const d = drawing(id);
      if (!d) return `- tracé ${id} (effacé)`;
      if (d.createdBy === "ia") return `- ton niveau ${id} : ${describeDrawing(d, s.digits)}${d.reason ? ` — ${d.reason}` : ""}`;
      return `- tracé ${d.createdBy === "user" ? "de l'utilisateur" : "de Kopilia"} ${id} : ${describeDrawing(d, s.digits)}`;
    }),
    ...s.depends.events.map((e) => `- annonce ${e.country} « ${e.title} » ${when(e.at, now)}`),
  ];
  const watching = alerts.filter((a) => a.state === "active" || a.state === "paused");
  return [
    `Dossier ${s.id} — ${s.title}`,
    `Produit : ${s.name} (${s.symbol}) ; sens : ${SIDE[s.direction]} ; horizon : ${HORIZON[s.horizon]} ; entrée en ${s.timeframe}${s.contextTimeframe ? `, contexte en ${s.contextTimeframe}` : ""}.`,
    `État : ${STATE_NAMES[s.state]}${s.stateReason ? ` (${s.stateReason})` : ""} ; ouvert ${when(s.createdAt, now)} ; échéance ${when(s.expiresAt, now)}.`,
    `Pourquoi : ${s.why}`,
    `Ce que l'IA voyait en l'ouvrant : ${s.snapshot}`,
    `Plan : ${s.plan}`,
    `Invalidé si : ${s.invalidation}`,
    `Niveaux : ${levelsText(s)}.`,
    deps.length ? `Dépend de :\n${deps.join("\n")}` : "Dépend de : rien de déclaré.",
    watching.length
      ? `Alertes de l'IA en place :\n${watching.map((a) => `- ${a.id} : ${describeAlert(a, a.target.kind === "drawing" ? drawing(a.target.drawingId) : undefined)}`).join("\n")}`
      : "Aucune alerte de l'IA en place.",
    s.wakeAt ? `Rendez-vous : ${when(s.wakeAt, now)} — ${s.wakeReason ?? ""}` : "",
    s.feedback ? `Réaction de l'utilisateur : ${REACTION_NAMES[s.feedback.reaction]}${s.feedback.note ? ` (« ${s.feedback.note} »)` : ""}.` : "",
    s.outcome && s.state !== "watching"
      ? `Résultat : ${OUTCOME_NAMES[s.outcome.result]}${s.outcome.r !== undefined ? ` (${s.outcome.r.toFixed(1)} R)` : ""}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Le fil, une ligne par événement : « - 10:42 [réveil · serveur] … ». */
export function filText(events: ScenarioEvent[], now = Date.now()): string {
  if (!events.length) return "(fil vide)";
  return events.map((e) => `- ${when(e.at, now)} [${KIND[e.kind]} · ${BY[e.by]}] ${e.text}`).join("\n");
}

const KIND: Record<ScenarioEvent["kind"], string> = {
  opened: "ouvert",
  alert: "alerte",
  rendezvous: "rendez-vous",
  wake: "réveil",
  decision: "décision",
  context: "contexte",
  feedback: "utilisateur",
  update: "mise à jour",
  note: "note",
  proposed: "proposé",
  closed: "fermé",
};

/** Des bougies, une par ligne : « 10:30 O 2 650,10 H 2 655,00 B 2 648,20 C 2 653,40 », la dernière marquée en cours si elle l'est. */
export function candlesText(candles: ChartCandle[], digits: number | undefined, tfSeconds: number, now = Date.now()): string {
  const p = (v: number) => frenchPrice(v, digits);
  return candles
    .map((c, i) => {
      // Seule la dernière peut être en cours (une bougie mensuelle n'a pas de durée fixe).
      const open = i === candles.length - 1 && (c.t + tfSeconds) * 1000 > now;
      return `${when(c.t * 1000, now)} O ${p(c.o)} H ${p(c.h)} B ${p(c.l)} C ${p(c.c)}${open ? " (en cours)" : ""}`;
    })
    .join("\n");
}

/** Le bandeau et la notification d'un setup proposé : « Or : setup vendeur 15m », « Entrée 2 652,00, stop … ». */
export function proposedTexts(s: Scenario): { title: string; detail: string } {
  return { title: `${capitalize(s.name)} : setup ${SIDE[s.direction]} ${s.timeframe}`, detail: capitalize(levelsText(s)) };
}

/** Ce qu'attend un setup, sans le nom du produit en tête de son titre : « rebond sur le support 1h 4 021–4 028 ». */
export function setupLabel(s: Pick<Scenario, "title" | "name">): string {
  const prefix = `${s.name} : `;
  return s.title.toLowerCase().startsWith(prefix.toLowerCase()) ? s.title.slice(prefix.length) : s.title;
}

/** Le bandeau d'une recherche finie : ce qu'elle a repéré, sinon ce qui reste en cours. */
export function searchedTexts(d: { failed: boolean; opened: Scenario[]; open: Scenario[] }): { title: string; detail: string } {
  const n = d.opened.length;
  if (n)
    return {
      title: `Recherche finie : ${n} setup${n > 1 ? "s" : ""} en attente`,
      detail: d.opened.map((s) => `${capitalize(s.name)}, ${SIDE[s.direction]} : ${setupLabel(s)}`).join(" · "),
    };
  const m = d.open.length;
  return {
    title: d.failed ? "Recherche interrompue" : "Recherche finie : rien de nouveau",
    detail: m ? `${m} setup${m > 1 ? "s" : ""} toujours en cours` : "Aucun setup en cours",
  };
}

/** Le bandeau d'un setup proposé puis abandonné. */
export function abandonedTexts(s: Scenario): { title: string; detail: string } {
  return { title: `${capitalize(s.name)} : setup ${SIDE[s.direction]} abandonné`, detail: s.stateReason ?? "" };
}

/** Les statistiques en une ligne chacune : « En 15m : 5 proposés, 2 objectifs, 1 stop, 1 sans entrée, 1 en cours ; +3,0 R ». */
export function statsLines(rows: SetupStatsRow[]): string[] {
  return rows.map(
    (r) =>
      `${r.label} : ${r.proposed} proposé${r.proposed > 1 ? "s" : ""}, ${r.target} à l'objectif, ${r.stop} au stop, ${r.missed} sans entrée, ${r.open} en cours ; ${r.r >= 0 ? "+" : ""}${r.r.toFixed(1)} R`,
  );
}

/** Une divergence plus ancienne que ce nombre de bougies ne compte plus dans le tour d'horizon. */
const SCAN_DIVERGENCE_BARS = 20;

/** Un produit du tour d'horizon : sa carte (ou pourquoi elle manque), les tracés de l'utilisateur, ses dossiers ouverts. */
export interface ScanEntry {
  name: string;
  symbol?: string;
  digits?: number;
  map: CorrectedMap | { error: string };
  drawings: Drawing[];
  open: number;
}

/**
 * Une ligne du tour d'horizon : le prix face à la carte (zone qui le contient,
 * zones de part et d'autre, oblique la plus proche, divergence récente, tracé
 * de l'utilisateur le plus proche), et `distance`, en ATR, du niveau le plus
 * proche (0 dans une zone), pour classer.
 */
export function scanLine(e: ScanEntry, tfSeconds: number, now = Date.now()): { text: string; distance?: number } {
  const head = e.symbol ? `${capitalize(e.name)} (${e.symbol})` : capitalize(e.name);
  if ("error" in e.map) return { text: `${head} : ${e.map.error}` };
  const { price, atr } = e.map;
  if (price === undefined || atr === null || !(atr > 0)) return { text: `${head} : pas assez de bougies pour une carte` };
  const p = (v: number) => frenchPrice(v, e.digits);
  const away = (lo: number, hi = lo) => (price >= lo && price <= hi ? 0 : Math.min(Math.abs(price - lo), Math.abs(price - hi)) / atr);
  const atrs = (d: number) => `${d.toFixed(1).replace(".", ",")} ATR`;
  const near: number[] = [];
  const parts = [`${p(price)}, ATR ${p(atr)}`];

  const inside = e.map.zones.find((z) => price >= z.bottom && price <= z.top);
  if (inside) {
    near.push(0);
    parts.push(`DANS la zone ${p(inside.bottom)}–${p(inside.top)} (${inside.touches} contacts)`);
  }
  const below = e.map.zones.filter((z) => z.top < price).sort((a, b) => b.top - a.top)[0];
  const above = e.map.zones.filter((z) => z.bottom > price).sort((a, b) => a.bottom - b.bottom)[0];
  for (const [z, where] of [
    [below, "dessous"],
    [above, "dessus"],
  ] as const) {
    if (!z) continue;
    const d = away(z.bottom, z.top);
    near.push(d);
    parts.push(`zone au-${where} ${p(z.bottom)}–${p(z.top)} à ${atrs(d)} (${z.touches} contacts)`);
  }
  const line = [...e.map.trendlines].sort((a, b) => away(a.priceNow) - away(b.priceNow))[0];
  if (line) {
    const d = away(line.priceNow);
    near.push(d);
    parts.push(`oblique de ${line.kind === "support" ? "support" : "résistance"} à ${p(line.priceNow)} (${atrs(d)})`);
  }
  const div = e.map.divergences.reduce<RsiDivergence | undefined>((best, d) => (!best || d.to.t > best.to.t ? d : best), undefined);
  if (div && now / 1000 - div.to.t <= SCAN_DIVERGENCE_BARS * tfSeconds) {
    parts.push(`divergence RSI ${div.kind === "bullish" ? "haussière" : "baissière"} (${shortMoment(div.to.t)})`);
  }

  const marks = e.drawings.flatMap((d) => {
    if (d.kind === "hline") return [{ what: `ligne ${p(d.price)}`, d: away(d.price) }];
    if (d.kind === "zone" && (d.to === undefined || d.to >= now / 1000)) {
      const lo = Math.min(d.top, d.bottom);
      const hi = Math.max(d.top, d.bottom);
      return [{ what: `zone ${p(lo)}–${p(hi)}`, d: away(lo, hi) }];
    }
    return [];
  });
  const mark = marks.sort((a, b) => a.d - b.d)[0];
  const lines = e.drawings.filter((d) => d.kind === "trendline").length;
  if (mark) {
    near.push(mark.d);
    parts.push(`son tracé le plus proche : ${mark.what} (${mark.d === 0 ? "le prix y est" : atrs(mark.d)})`);
  }
  if (lines) parts.push(`${lines} oblique${lines > 1 ? "s" : ""} tracée${lines > 1 ? "s" : ""} (market_levels)`);
  if (e.open) parts.push(`${e.open} dossier${e.open > 1 ? "s" : ""} ouvert${e.open > 1 ? "s" : ""}`);
  return { text: `${head} : ${parts.join(" ; ")}`, distance: near.length ? Math.min(...near) : undefined };
}

/** Le tour d'horizon, du produit le plus près d'un niveau au plus loin ; ceux sans carte à la fin. */
export function scanText(entries: ScanEntry[], timeframe: string, tfSeconds: number, now = Date.now()): string {
  const lines = entries.map((e) => scanLine(e, tfSeconds, now)).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  return [
    `Tour d'horizon en ${timeframe}, du produit le plus près d'un niveau au plus loin (distances en ATR ${timeframe}, prix de la dernière clôture) :`,
    ...lines.map((l) => `- ${l.text}`),
  ].join("\n");
}

/** Un texte terminé par un point (sans en doubler un qui y est déjà). */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
