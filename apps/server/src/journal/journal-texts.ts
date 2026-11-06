import { FIDELITY_LABELS, OUTCOME_LABELS, moneyLabel, type Journal, type JournalLine, type JournalReview, type JournalTrade } from "@kopilia/contracts";
import { relativeMoment } from "../analyses/analysis-texts.js";
import { rLabel, sideWord, tradeLine } from "../trading/trading-texts.js";

/*
 * Le journal en lignes, pour Kopilia : des faits, sans conseil. Pur, testé à plat.
 */

/** Un trade de la liste : « t_ab12 vente Nasdaq, perdant −1 R (−98 $), au stop, contre la fiche, hier à 17 h 05 ; note : « … » ». */
export function journalLineText(l: JournalLine, now = Date.now()): string {
  const result = l.outcome
    ? `${OUTCOME_LABELS[l.outcome]} ${l.r !== undefined ? rLabel(l.r) : ""}${l.profit !== undefined ? ` (${moneyLabel(l.profit, l.currency, { sign: true })})` : ""}`.trim()
    : (l.remark ?? l.state);
  const remark = l.outcome && l.remark ? `, ${l.remark}` : "";
  return `${l.id} ${sideWord(l.side)} ${l.name}, ${result}${remark}, ${FIDELITY_LABELS[l.fidelity]}, ${relativeMoment(l.at, now)}${l.demo ? " [démo]" : ""}${l.note ? ` ; note : « ${l.note} »` : ""}`;
}

/** Le journal par fiche, en lignes. */
export function journalText(j: Journal, days: number, now = Date.now()): string[] {
  const t = j.totals;
  const lines = [
    t.count
      ? `${t.count} trade${t.count > 1 ? "s" : ""} fermé${t.count > 1 ? "s" : ""} sur ${days} jours : ${t.wins} gagnant${t.wins > 1 ? "s" : ""}, ${t.losses} perdant${t.losses > 1 ? "s" : ""}, ${t.neutral} neutre${t.neutral > 1 ? "s" : ""} ; ${rLabel(t.r)} en tout`
      : `aucun trade fermé sur ${days} jours`,
  ];
  for (const g of j.groups) {
    const head = g.analysisId
      ? `Fiche ${g.name} (${g.analysisId}, ${g.state === "open" ? "" : "fermée, "}ouverte ${relativeMoment(g.openedAt!, now)})${g.idea ? ` : ${g.idea}` : ""}${g.firstIdea ? `, idée de départ : ${g.firstIdea}` : ""}`
      : "Sans fiche";
    lines.push(`${head} — ${g.trades.length ? `${g.trades.length} trade${g.trades.length > 1 ? "s" : ""}, ${rLabel(g.r)}` : "pas encore de trade"}`);
    for (const l of g.trades) lines.push(`  ${journalLineText(l, now)}`);
    if (g.untaken) lines.push(`  ${g.untaken}`);
  }
  if (j.review)
    lines.push(
      `Dernière analyse de son trading (${j.review.id}, ${relativeMoment(j.review.createdAt, now)}, sur ${j.review.days} jours) : ${j.review.summary}`,
    );
  if (j.reviewing) lines.push("Une analyse de son trading est en cours.");
  return lines;
}

/** Une analyse de son trading, en lignes : le résumé, les chiffres, les constats, la règle proposée. */
export function reviewText(r: JournalReview, now = Date.now()): string[] {
  return [
    `Analyse ${r.id} du ${relativeMoment(r.createdAt, now)}, sur ${r.days} jours : ${r.summary}`,
    ...r.stats.map((s) => `chiffre : ${s.label}${s.value ? ` : ${s.value}` : ""}`),
    ...r.findings.map((f, i) => `constat ${i + 1} — ${f.title} : ${f.text} (${f.trades.join(", ")})`),
    ...(r.carnet ? [`règle proposée pour son carnet, à ne noter que s'il dit oui : « ${r.carnet} »`] : []),
  ];
}

const ITEM_WORDS: Record<string, string> = {
  view: "sa lecture",
  why: "sa réponse",
  challenge: "objection du contradicteur",
  fiche: "fiche",
  ticket: "ticket",
  filled: "exécution",
  gesture: "geste",
  exit: "sortie",
  closed: "fermeture",
  cancelled: "ordre retiré",
  rejected: "refus",
  note: "sa note",
};

/** La page d'un trade, en lignes : le trade, ses faits, puis son fil. */
export function journalTradeText(p: JournalTrade, now = Date.now()): string[] {
  const lines = [
    tradeLine(p.trade, now),
    `${p.outcome ? OUTCOME_LABELS[p.outcome] : "pas encore de résultat"} ; ${FIDELITY_LABELS[p.fidelity]}${p.analysisId ? ` (fiche ${p.analysisId})` : ""} ; graphique ${p.frozen ? "figé au ticket" : "non figé (trade d'avant le journal)"}`,
    ...p.facts.map((f) => `fait : ${f.text}`),
    ...p.thread.map((i) => `${relativeMoment(i.at, now)}, ${ITEM_WORDS[i.kind] ?? i.kind} : ${i.text}`),
  ];
  return lines;
}
