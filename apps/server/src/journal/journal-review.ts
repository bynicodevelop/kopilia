import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIDELITY_LABELS,
  OUTCOME_LABELS,
  TurnOutcome,
  journalFindingSchema,
  tradeOutcome,
  type ClaudeContentBlock,
  type JournalFinding,
  type JournalStat,
  type JournalTrade,
} from "@kopilia/contracts";
import type { AppLogger } from "../common/logger.js";
import { ClaudeProcess } from "../session/claude-process.js";
import { OWN_TOOLS_ENV } from "../session/child-env.js";
import { relativeMoment } from "../analyses/analysis-texts.js";
import { rLabel, tradeLine } from "../trading/trading-texts.js";

/*
 * L'analyse de son trading par l'IA (Sonnet), à sa demande : les chiffres
 * comptés par le serveur sur la période, puis les pages de ses trades (faits,
 * fil de la fiche, notes) et quelques graphiques figés. Un seul tour, sans
 * outils. La consigne, les chiffres et la lecture de la réponse sont purs,
 * testés à plat.
 */

export const REVIEW_PROMPT = `Tu relis le journal de trading d'un trader français (CFD, compte de démonstration). Il te demande une analyse de son trading : où il fait des erreurs, les contradictions qu'il a eues, si son analyse de départ était bonne et s'il en a changé entre-temps.

On te donne : les chiffres comptés par le serveur sur la période ; puis, trade par trade, les faits calculés par le serveur (dans le sens de sa fiche ou contre elle, objection du contradicteur avant le trade, entrée dans la zone, gestes, plan du ticket rejoué contre ce qu'il a géré, ce qu'a fait le prix après sa sortie, son idée de départ rejouée sur les cours), le fil de sa fiche (ses lectures, les objections, ses réponses) et ses notes ; puis ses idées non prises ; enfin les graphiques figés de quelques trades (ses tracés tels qu'au ticket, le stop en rouge et l'objectif en vert marche par marche, l'entrée en cercle clair, les sorties en cercle vert ou rouge).

Règles :
- Tu décris ce que les faits montrent, puis tu donnes ton avis franc de trader expérimenté, puisqu'il te le demande : ce qui lui coûte le plus, ce qui marche, ce que tu changerais à sa place (« à mon avis, ce qui te coûte le plus, c'est… »). Sans formule de précaution : il sait que la décision lui revient.
- Chaque constat s'appuie sur des trades nommés par leur identifiant (t_…) dans "trades".
- Tu n'inventes aucun chiffre : ceux que tu cites sont dans ce qu'on te donne. N'en déduis rien qu'il n'a pas dit ; ses notes sont ses mots, cite-les entre guillemets.
- Cherche d'abord : les changements d'avis et ce qu'a donné l'idée de départ ; les trades contre sa fiche ou passés malgré une objection ; la gestion (prévu contre géré, sorties avant l'objectif, stop élargi, objectif touché après sa sortie) ; ce qui revient dans ses notes ; ce qui marche quand il suit sa fiche.
- Peu de trades : dis-le, et ne fais pas d'une fois une habitude.
- Un à quatre constats, du plus important au moins important. Tutoie-le, en français simple.

Réponds uniquement par un objet JSON, sans texte autour :
{"summary": "une ou deux phrases, à lui dire à voix haute", "findings": [{"title": "quelques mots", "text": "deux ou trois phrases", "trades": ["t_…"]}], "carnet": "une règle de trading qu'il a écrite lui-même dans ses notes, avec ses mots, si elle revient ; sinon null"}`;

/** Les chiffres de la période, comptés par le serveur (sans modèle), pour la feuille et pour l'IA. */
export function reviewStats(pages: JournalTrade[], untaken: Array<{ name: string; line: string }>): JournalStat[] {
  const closed = pages.filter((p) => p.trade.state === "closed" && p.trade.r !== undefined);
  const sum = (list: JournalTrade[]) => Math.round(list.reduce((s, p) => s + (p.trade.r ?? 0), 0) * 100) / 100;
  const count = (n: number) => `${n} trade${n > 1 ? "s" : ""}`;
  const stats: JournalStat[] = [];
  const wins = closed.filter((p) => tradeOutcome(p.trade) === "win").length;
  const losses = closed.filter((p) => tradeOutcome(p.trade) === "loss").length;
  stats.push({
    key: "total",
    label: `${count(closed.length)} fermé${closed.length > 1 ? "s" : ""} : ${wins} gagnant${wins > 1 ? "s" : ""}, ${losses} perdant${losses > 1 ? "s" : ""}, ${closed.length - wins - losses} neutre${closed.length - wins - losses > 1 ? "s" : ""}`,
    value: rLabel(sum(closed)),
    tone: sum(closed) > 0 ? "ok" : sum(closed) < 0 ? "warn" : "info",
  });
  for (const f of ["with", "against", "none"] as const) {
    const list = closed.filter((p) => p.fidelity === f);
    if (!list.length) continue;
    stats.push({
      key: `fidelity-${f}`,
      label: `${capitalize(FIDELITY_LABELS[f])} : ${count(list.length)}`,
      value: rLabel(sum(list)),
      tone: f === "against" ? "warn" : f === "with" ? "ok" : "info",
    });
  }
  const has = (p: JournalTrade, key: string) => p.facts.some((x) => x.key === key);
  const changed = closed.filter((p) => has(p, "changed-mind"));
  if (changed.length)
    stats.push({ key: "changed-mind", label: `Changement d'avis avant le trade : ${count(changed.length)}`, value: rLabel(sum(changed)), tone: "warn" });
  const objection = closed.filter((p) => has(p, "objection") && p.fidelity === "against");
  if (objection.length)
    stats.push({ key: "objection", label: `Contre la fiche malgré une objection : ${count(objection.length)}`, value: rLabel(sum(objection)), tone: "warn" });
  const widened = closed.filter((p) => has(p, "stop-widened"));
  if (widened.length) stats.push({ key: "stop-widened", label: `Stop élargi : ${count(widened.length)}`, value: rLabel(sum(widened)), tone: "warn" });
  // Prévu contre géré : l'écart des trades gérés.
  const managed = closed.filter((p) => p.facts.some((x) => x.key === "plan" && /Géré/.test(x.text)));
  if (managed.length) {
    const diff = managed.reduce((s, p) => s + planGap(p), 0);
    const v = Math.round(diff * 100) / 100;
    stats.push({
      key: "plan",
      label: `Gestion contre le plan du ticket : ${count(managed.length)}`,
      value: rLabel(v),
      tone: v <= -0.1 ? "warn" : v >= 0.1 ? "ok" : "info",
    });
  }
  const left = closed.filter((p) => p.facts.some((x) => x.key === "after" && /laissés/.test(x.text)));
  if (left.length) stats.push({ key: "left", label: `Objectif touché après ta sortie : ${count(left.length)}`, value: "", tone: "warn" });
  if (untaken.length) stats.push({ key: "untaken", label: `Idées de fiche non prises : ${untaken.length}`, value: "", tone: "info" });
  return stats;
}

/** L'écart d'un trade géré au plan du ticket, lu dans son fait (« +0,95 R … −1,05 R par rapport au plan »). */
function planGap(p: JournalTrade): number {
  const plan = p.facts.find((x) => x.key === "plan")?.text ?? "";
  const m = plan.match(/([+−-]\d+(?:,\d+)?) R par rapport au plan/);
  return m ? Number(m[1].replace("−", "-").replace(",", ".")) : 0;
}

/** Le tour de l'analyse : la période, les chiffres, chaque trade, les idées non prises. */
export function reviewTurn(o: {
  days: number;
  stats: JournalStat[];
  pages: JournalTrade[];
  untaken: Array<{ name: string; line: string }>;
  now: number;
}): string {
  const lines = [
    `Période : les ${o.days} derniers jours.`,
    "",
    "Chiffres du serveur :",
    ...o.stats.map((s) => `- ${s.label}${s.value ? ` : ${s.value}` : ""}`),
    "",
  ];
  for (const p of o.pages) {
    const t = p.trade;
    lines.push(
      `## ${t.id} — ${t.name}, ${t.side === "long" ? "achat" : "vente"}, ${p.outcome ? OUTCOME_LABELS[p.outcome] : t.state}${t.r !== undefined ? ` ${rLabel(t.r)}` : ""}, ${FIDELITY_LABELS[p.fidelity]}`,
    );
    lines.push(tradeLine(t, o.now));
    for (const f of p.facts) lines.push(`fait : ${f.text}`);
    for (const i of p.thread) {
      if (i.kind === "ticket" || i.kind === "filled" || i.kind === "closed") continue;
      lines.push(`${relativeMoment(i.at, o.now)}, ${ITEM[i.kind] ?? i.kind} : ${i.text}`);
    }
    lines.push("");
  }
  if (o.untaken.length) {
    lines.push("Idées non prises :");
    for (const u of o.untaken) lines.push(`- ${u.name} : ${u.line}`);
  }
  return lines.join("\n");
}

const ITEM: Record<string, string> = {
  view: "sa lecture",
  why: "sa réponse",
  challenge: "objection du contradicteur",
  fiche: "fiche",
  gesture: "geste",
  exit: "sortie",
  cancelled: "ordre retiré",
  rejected: "refus",
  note: "sa note",
};

/** Ce que rend l'IA, vérifié : un résumé, des constats appuyés sur des trades connus, une règle éventuelle. */
export function parseReview(reply: string, known: string[]): { summary: string; findings: JournalFinding[]; carnet?: string } | undefined {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (!summary) return undefined;
  const ids = new Set(known);
  const findings: JournalFinding[] = [];
  for (const f of Array.isArray(raw.findings) ? (raw.findings as Array<Record<string, unknown>>) : []) {
    const parsed = journalFindingSchema.safeParse({
      title: typeof f?.title === "string" ? f.title.trim().slice(0, 120) : "",
      text: typeof f?.text === "string" ? f.text.replace(/\s+/g, " ").trim().slice(0, 700) : "",
      trades: Array.isArray(f?.trades)
        ? [...new Set((f.trades as unknown[]).filter((x): x is string => typeof x === "string" && ids.has(x)))].slice(0, 12)
        : [],
    });
    // Un constat sans trade connu n'en est pas un.
    if (parsed.success && parsed.data.trades.length) findings.push(parsed.data);
    if (findings.length >= 4) break;
  }
  const carnet = typeof raw.carnet === "string" && raw.carnet.trim() && raw.carnet.trim() !== "null" ? raw.carnet.trim().slice(0, 300) : undefined;
  return { summary, findings, ...(carnet ? { carnet } : {}) };
}

/** Qui fait le tour : remplaçable en test. Rend le texte de la réponse. */
export type ReviewFn = (content: ClaudeContentBlock[]) => Promise<string>;

const REVIEW_TIMEOUT_MS = 240_000;

/** Un processus Sonnet sans outils, lancé pour une analyse et arrêté après. */
export function claudeReviewer(opts: { bin: string; model?: string; dataDir: string; logger: AppLogger }): ReviewFn {
  return async (content) => {
    const cwd = resolve(opts.dataDir, "journal");
    mkdirSync(cwd, { recursive: true });
    const proc = new ClaudeProcess({
      bin: opts.bin,
      cwd,
      model: opts.model,
      effort: "medium",
      systemPrompt: REVIEW_PROMPT,
      excludeDynamicSystemPrompt: true,
      // Aucun outil, aucun serveur MCP, aucune commande : il lit ce qu'on lui donne, il ne fait rien.
      extraArgs: ["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"],
      env: OWN_TOOLS_ENV,
      logger: opts.logger,
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      proc.start();
      const result = await Promise.race([
        proc.sendTurn(content, () => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("analyse trop longue")), REVIEW_TIMEOUT_MS);
        }),
      ]);
      if (result.outcome !== TurnOutcome.Success) throw new Error(`analyse interrompue (${result.outcome})`);
      return result.final ?? result.text;
    } finally {
      clearTimeout(timer);
      proc.stop();
    }
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
