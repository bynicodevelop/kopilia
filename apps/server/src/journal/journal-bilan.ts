import {
  FIDELITY_LABELS,
  OUTCOME_LABELS,
  moneyLabel,
  tradeOutcome,
  type BilanPeriod,
  type BilanRow,
  type JournalBilan,
  type JournalLine,
  type JournalTrade,
} from "@kopilia/contracts";
import { startOfDay } from "../common/dates.js";
import { rLabel, sideWord } from "../trading/trading-texts.js";

/*
 * Les bilans du journal, comptés par le serveur sans modèle : la période
 * (jour, semaine du lundi, mois, N jours, à l'heure de Paris), le résultat,
 * les répartitions (fiche, horizon, palier, produit, séance), ce qui revient
 * d'après les faits de ses trades, les jours pour le calendrier et les séries.
 * Pur, testé à plat.
 */

/** Ce que le service sait d'un trade en plus de sa page : l'horizon de sa fiche, son palier. */
export interface BilanTrade {
  page: JournalTrade;
  line: JournalLine;
  horizon?: string;
  tier?: string;
  /** Il a au moins une note. */
  noted: boolean;
}

/** Les bornes d'une période (epoch ms, fin exclue) et son nom. */
export function bilanRange(period: BilanPeriod, ref: Date, days = 30): { from: number; to: number; label: string } {
  if (period === "day") {
    const from = startOfDay(ref);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: from.getTime(), to: to.getTime(), label: new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(from) };
  }
  if (period === "week") {
    const from = startOfDay(ref);
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { from: from.getTime(), to: to.getTime(), label: `semaine du ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(from)}` };
  }
  if (period === "month") {
    const from = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const to = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
    return { from: from.getTime(), to: to.getTime(), label: new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(from) };
  }
  const to = ref.getTime();
  return { from: to - days * 86_400_000, to: to + 1, label: `${days} derniers jours` };
}

/** La séance d'un instant, à l'heure de Paris : Asie (avant 9 h), Londres (jusqu'à 15 h 30), New York (jusqu'à 22 h), le soir. */
export function sessionOf(at: number): string {
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < 9 * 60) return "Asie (avant 9 h)";
  if (m < 15 * 60 + 30) return "Londres (9 h – 15 h 30)";
  if (m < 22 * 60) return "New York (15 h 30 – 22 h)";
  return "Le soir (après 22 h)";
}

/** « 2026-11-06 », à l'heure de Paris. */
export function dateKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function row(label: string, list: BilanTrade[]): BilanRow {
  return { label, count: list.length, wins: list.filter((t) => t.line.outcome === "win").length, r: round2(list.reduce((s, t) => s + (t.line.r ?? 0), 0)) };
}

/** Les trades groupés par `key` : les plus nombreux d'abord, ou dans l'ordre donné. */
function groupBy(list: BilanTrade[], key: (t: BilanTrade) => string, order?: string[]): BilanRow[] {
  const groups = new Map<string, BilanTrade[]>();
  for (const t of list) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  const rows = [...groups].map(([label, l]) => row(label, l));
  return order ? rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)) : rows.sort((a, b) => b.count - a.count || b.r - a.r);
}

/** Le R laissé d'un trade, lu dans son fait « après la sortie » (« 1,05 R laissés »). */
function leftR(p: JournalTrade): number {
  const m = (p.facts.find((f) => f.key === "after")?.text ?? "").match(/(\d+(?:,\d+)?) R laissés/);
  return m ? Number(m[1].replace(",", ".")) : 0;
}

/** Le bilan de ses trades fermés entre `from` et `to`. */
export function computeBilan(
  trades: BilanTrade[],
  o: { period: BilanPeriod; from: number; to: number; label: string; live: number; currency?: string },
): JournalBilan {
  const closed = trades
    .filter((t) => t.page.trade.state === "closed" && t.page.trade.closedAt !== undefined && t.page.trade.closedAt >= o.from && t.page.trade.closedAt < o.to)
    .sort((a, b) => b.page.trade.closedAt! - a.page.trade.closedAt!);
  const outcome = (t: BilanTrade) => tradeOutcome(t.page.trade);
  const wins = closed.filter((t) => outcome(t) === "win");
  const losses = closed.filter((t) => outcome(t) === "loss");
  const r = round2(closed.reduce((s, t) => s + (t.page.trade.r ?? 0), 0));
  const avg = (list: BilanTrade[]) => (list.length ? round2(list.reduce((s, t) => s + (t.page.trade.r ?? 0), 0) / list.length) : undefined);
  // Les séries, du plus ancien au plus récent ; un trade neutre ne la casse pas.
  let run = 0;
  let maxLosses = 0;
  for (const t of [...closed].reverse()) {
    const out = outcome(t);
    if (out === "win") run = run > 0 ? run + 1 : 1;
    else if (out === "loss") run = run < 0 ? run - 1 : -1;
    maxLosses = Math.max(maxLosses, -Math.min(run, 0));
  }
  const byR = [...closed].sort((a, b) => (b.page.trade.r ?? 0) - (a.page.trade.r ?? 0));
  const has = (t: BilanTrade, key: string) => t.page.facts.some((f) => f.key === key);
  const patterns = [
    { key: "against", label: "Contre la fiche", list: closed.filter((t) => t.page.fidelity === "against") },
    { key: "changed-mind", label: "Changement d'avis avant le trade", list: closed.filter((t) => has(t, "changed-mind")) },
    { key: "objection", label: "Malgré une objection du contradicteur", list: closed.filter((t) => has(t, "objection") && t.page.fidelity === "against") },
    { key: "out-of-zone", label: "Entrée hors de ta zone", list: closed.filter((t) => t.page.facts.some((f) => f.key === "zone" && f.tone === "warn")) },
    { key: "stop-widened", label: "Stop élargi", list: closed.filter((t) => has(t, "stop-widened")) },
    { key: "left", label: "Objectif touché après ta sortie (R laissés)", list: closed.filter((t) => leftR(t.page) > 0) },
  ]
    .filter((p) => p.list.length)
    // Pour l'objectif touché après la sortie, ce qui compte est ce qu'il a laissé : compté en négatif.
    .map((p) => ({ key: p.key, ...row(p.label, p.list), ...(p.key === "left" ? { r: -round2(p.list.reduce((s, t) => s + leftR(t.page), 0)) } : {}) }));
  const days = new Map<string, BilanTrade[]>();
  for (const t of closed) {
    const k = dateKey(t.page.trade.closedAt!);
    days.set(k, [...(days.get(k) ?? []), t]);
  }
  const breakdowns = [
    {
      key: "fidelity" as const,
      label: "Face à la fiche",
      rows: groupBy(closed, (t) => FIDELITY_LABELS[t.page.fidelity], [FIDELITY_LABELS.with, FIDELITY_LABELS.against, FIDELITY_LABELS.none]),
    },
    {
      key: "horizon" as const,
      label: "Par horizon",
      rows: groupBy(closed, (t) => (t.horizon === "swing" ? "swing" : t.horizon === "intraday" ? "intraday" : "horizon non dit")),
    },
    { key: "tier" as const, label: "Par palier", rows: groupBy(closed, (t) => (t.tier ? `palier ${t.tier}` : "sans palier")) },
    { key: "product" as const, label: "Par produit", rows: groupBy(closed, (t) => t.page.trade.name) },
    { key: "session" as const, label: "Par séance", rows: groupBy(closed, (t) => sessionOf(t.page.trade.openedAt ?? t.page.trade.createdAt)) },
  ].filter((b) => b.rows.length > 1 || (b.rows.length === 1 && !/non dit|sans palier/.test(b.rows[0].label)));
  return {
    period: o.period,
    from: o.from,
    to: o.to,
    label: o.label,
    totals: {
      count: closed.length,
      wins: wins.length,
      losses: losses.length,
      neutral: closed.length - wins.length - losses.length,
      r,
      avgR: avg(closed) ?? 0,
      ...(avg(wins) !== undefined ? { avgWin: avg(wins)! } : {}),
      ...(avg(losses) !== undefined ? { avgLoss: avg(losses)! } : {}),
      profit: round2(closed.reduce((s, t) => s + (t.page.trade.profit ?? 0), 0)),
      currency: closed[0]?.page.trade.currency ?? o.currency ?? "",
    },
    ...(byR.length ? { best: byR[0].line } : {}),
    ...(byR.length > 1 && (byR.at(-1)!.page.trade.r ?? 0) < 0 ? { worst: byR.at(-1)!.line } : {}),
    streak: { maxLosses, current: run },
    breakdowns,
    patterns,
    days: [...days]
      .map(([date, l]) => ({ date, count: l.length, r: round2(l.reduce((s, t) => s + (t.page.trade.r ?? 0), 0)) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    trades: closed.map((t) => t.line),
    missingNotes: closed.filter((t) => !t.noted).map((t) => t.page.trade.id),
    live: o.live,
  };
}

/** Le bilan en lignes, pour Kopilia : le résultat, le meilleur et le pire, les répartitions, ce qui revient. */
export function bilanText(b: JournalBilan): string[] {
  const t = b.totals;
  if (!t.count) return [`Bilan ${prefix(b)} : aucun trade fermé${b.live ? ` (${b.live} en cours ou en attente)` : ""}.`];
  const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;
  const lines = [
    `Bilan ${prefix(b)} : ${plural(t.count, "trade")} fermé${t.count > 1 ? "s" : ""}, ${plural(t.wins, "gagnant")}, ${plural(t.losses, "perdant")}, ${plural(t.neutral, "neutre")} ; ${rLabel(t.r)}${t.currency ? ` (${moneyLabel(t.profit, t.currency, { sign: true })})` : ""}, ${rLabel(t.avgR)} par trade${t.avgWin !== undefined ? ` ; gain moyen ${rLabel(t.avgWin)}` : ""}${t.avgLoss !== undefined ? `, perte moyenne ${rLabel(t.avgLoss)}` : ""}${b.live ? ` ; ${b.live} encore en cours ou en attente` : ""}`,
  ];
  if (b.best) lines.push(`meilleur : ${lineWords(b.best)}`);
  if (b.worst) lines.push(`pire : ${lineWords(b.worst)}`);
  if (b.streak.maxLosses >= 2) lines.push(`plus longue série de pertes : ${b.streak.maxLosses}`);
  for (const d of b.breakdowns)
    lines.push(`${d.label.toLowerCase()} : ${d.rows.map((r) => `${r.label} ${plural(r.count, "trade")} ${rLabel(r.r)}`).join(", ")}`);
  for (const p of b.patterns) lines.push(`ce qui revient : ${p.label.toLowerCase()}, ${plural(p.count, "trade")}, ${rLabel(p.r)}`);
  if (b.missingNotes.length) lines.push(`sans note : ${b.missingNotes.join(", ")}`);
  return lines;
}

function prefix(b: JournalBilan): string {
  return b.period === "day" ? `du ${b.label}` : b.period === "week" ? `de la ${b.label}` : b.period === "month" ? `de ${b.label}` : `des ${b.label}`;
}

function lineWords(l: JournalLine): string {
  return `${l.id} ${sideWord(l.side)} ${l.name}, ${l.outcome ? OUTCOME_LABELS[l.outcome] : ""} ${l.r !== undefined ? rLabel(l.r) : ""}`
    .replace(/\s+/g, " ")
    .trim();
}

/** Le bilan du soir, pour Kopilia : une ou deux phrases à dire, et les trades sans note. */
export function eveningPrompt(b: JournalBilan): string {
  const lines = bilanText(b);
  const notes = b.missingNotes.length
    ? ` ${b.missingNotes.length} trade${b.missingNotes.length > 1 ? "s" : ""} sans note (${b.missingNotes.join(", ")}) : demande-lui une fois s'il veut un mot pour son journal ; s'il en dit un, journal_note avec ses mots.`
    : "";
  return `[Journal] Bilan de sa journée, programmé à sa demande. ${lines.join(" ; ")}\n[Dis-le-lui en deux phrases au plus : le résultat, puis ce qui revient s'il y a quelque chose. Des faits.${notes}]`;
}
