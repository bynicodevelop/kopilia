import { type BacktestMetrics, type BacktestSummary, ROBOT_STATUS_NAMES, type RobotSummary, VERDICT_NAMES } from "@kopilia/contracts";
import { TIMEFRAME_LABELS, isChartTimeframe } from "../market/timeframes.js";

/*
 * Les textes du laboratoire : les chiffres d'un backtest et la ligne d'un
 * robot, en français, arrondis comme on les dit. Les outils les renvoient tels
 * quels pour que Kopilia puisse les lire à voix haute sans recalculer.
 */

export function fmtR(v: number, digits = 2): string {
  const s = Math.abs(v).toFixed(digits).replace(".", ",");
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s} R`;
}

export function pct(v: number): string {
  return `${Math.round(v * 100)} %`;
}

export function tfLabel(tf: string | undefined): string {
  return tf && isChartTimeframe(tf) ? TIMEFRAME_LABELS[tf] : (tf ?? "");
}

/** « 412 trades, 41 % gagnants, +0,18 R par trade, +74 R, drawdown −14 R, pire série 7 ». */
export function metricsLine(m: BacktestMetrics): string {
  if (!m.trades) return "aucun trade";
  const parts = [
    `${m.trades} trade${m.trades > 1 ? "s" : ""}`,
    `${pct(m.winRate)} gagnants`,
    `${fmtR(m.avgR)} par trade`,
    `${fmtR(m.totalR, 1)} au total`,
    `drawdown ${fmtR(m.maxDrawdownR, 1)}`,
    `pire série ${m.longestLosingStreak}`,
  ];
  if (m.profitFactor !== undefined) parts.push(`facteur de profit ${m.profitFactor.toFixed(2).replace(".", ",")}`);
  if (m.windows)
    parts.push(`${Math.round(m.positiveWindows * m.windows)} trimestre${m.windows > 1 ? "s" : ""} positif${m.windows > 1 ? "s" : ""} sur ${m.windows}`);
  return parts.join(", ");
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Le compte rendu d'un backtest, phase par phase, avec le verdict et ses raisons. */
export function backtestText(b: BacktestSummary): string[] {
  const lines = [
    `Backtest ${b.id} (essai ${b.trial}, version ${b.version}) : ${b.products.join(", ")} en ${tfLabel(b.timeframe)}, du ${day(b.from)} au ${day(b.to)}, source ${b.source === "broker" ? "ton courtier (MetaApi)" : b.source}.`,
    `Apprentissage : ${metricsLine(b.inSample)}.`,
  ];
  if (b.outOfSample) lines.push(`Vérification (chiffres seulement) : ${metricsLine(b.outOfSample)}.`);
  if (b.reserved) lines.push(`Mois réservés (chiffres seulement) : ${metricsLine(b.reserved)}.`);
  if (b.costs) lines.push(`Coûts appliqués : écart ${b.costs.spread}, commission ${b.costs.commission}, glissement ${b.costs.slippage} (unités de prix).`);
  lines.push(`Verdict du code : ${VERDICT_NAMES[b.verdict]} (${b.verdictReasons.join(" ; ")}).`);
  return lines;
}

/** La ligne d'un robot pour une liste : nom, statut, univers, meilleur résultat. */
export function robotLine(r: RobotSummary): string {
  const where = `${r.products.join(", ")}${r.timeframe ? ` en ${tfLabel(r.timeframe)}` : ""}`;
  const best = r.best
    ? ` ; meilleur essai (${r.best.trial}/${r.trials}) : ${metricsLine(r.best.inSample)}${r.best.outOfSample ? ` ; vérification ${fmtR(r.best.outOfSample.avgR)} par trade sur ${r.best.outOfSample.trades}` : ""}`
    : r.trials
      ? ""
      : " ; aucun backtest";
  return `${r.name} (${r.id}, ${ROBOT_STATUS_NAMES[r.status]}${r.jobId ? ", recherche en cours" : ""}) : ${where}${best}.`;
}
