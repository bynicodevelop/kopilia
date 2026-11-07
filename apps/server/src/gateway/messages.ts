/**
 * Messages de la passerelle construits à partir des lignes en base : purs,
 * testés à plat. Un message n'est construit qu'à un seul endroit.
 */
import { JobState, ServerMessage, wakeDurationLabel } from "@kopilia/contracts";
import type { ApprovalRow, JobRow } from "../jobs/job.service.js";
import type { BriefRow } from "../veille/brief.service.js";
import type { SkillRow } from "../learning/skill.service.js";
import { agentReportPrompt, alertReportPrompt, briefReportPrompt, learningReportPrompt } from "../session/prompts.js";
import type { AlertFired } from "../alerts/alert.service.js";
import { alertNewsLine } from "../alerts/alert-texts.js";
import type { JournalBilan, JournalReview, Scenario } from "@kopilia/contracts";
import { eveningPrompt } from "../journal/journal-bilan.js";
import { abandonReportPrompt, opportunityReportPrompt, searchReportPrompt } from "../setups/setup-prompts.js";
import type { PassDone } from "../setups/setup-agents.service.js";
import { levelsText, scenarioLine, when } from "../setups/setup-texts.js";
import type { AwayNews } from "../channels/away-texts.js";
import type { TradingSignal } from "../trading/trading.service.js";
import type { BrokerReady } from "../market/broker-pause.service.js";

/** Omit distributif : préserve l'union discriminée (sinon seules les clés communes survivent). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Un message pour l'écran, sans son enveloppe (ajoutée à l'envoi). */
export type ServerBody = DistributiveOmit<ServerMessage, "v" | "eventId" | "sessionId" | "ts">;

/** Ce que Kopilia rapporte de lui-même : résultat d'agent, brief de veille, recettes proposées, alertes. */
export interface Report {
  turnId: string;
  jobId: string;
  title: string;
  /** Tour injecté dans le dialogue (résultat + consigne de restitution). */
  prompt: string;
  briefId?: string;
  /** Recettes proposées annoncées par ce rapport (marquées dites quand il part). */
  skillIds?: string[];
  /** Déclenchements d'alertes annoncés par ce rapport (marqués dits quand il part). */
  alertEventIds?: string[];
  /** Setups proposés annoncés par ce rapport (l'utilisateur en est prévenu quand il part). */
  scenarioIds?: string[];
  /** Passe devant les autres rapports en attente (une alerte). */
  urgent?: boolean;
  /** Sa version pour Telegram, s'il y en a une : envoyée si le micro est coupé ou la page cachée pendant son attente. */
  news?: AwayNews;
  /** Déjà parti sur Telegram (micro coupé) : jamais deux fois. */
  relayed?: boolean;
  /** Passé cet instant, il n'est plus dit (une news ne se dit pas en retard). */
  expiresAt?: number;
}

/** État d'un travail tel que l'écran l'affiche ; `folder` : le dossier où il travaille, s'il y en a un. */
export function jobUpdated(row: JobRow, folder: string | undefined): ServerBody {
  return {
    type: "job.updated",
    jobId: row.id,
    state: row.state as JobState,
    projectId: row.project_id ?? undefined,
    folder,
    title: row.title,
    summary: row.summary ?? undefined,
    pendingInstruction: row.pending_instruction,
    kind: row.kind,
  };
}

/** Demande d'accord avant une action qui modifie un projet. */
export function approvalRequired(a: ApprovalRow): ServerBody {
  return {
    type: "approval.required",
    approvalId: a.id,
    jobId: a.job_id ?? undefined,
    action: a.action,
    projectId: a.project_id ?? undefined,
    expiresAt: a.expires_at,
  };
}

export function jobReport(job: JobRow): Report {
  return { turnId: `agent_${job.id}`, jobId: job.id, title: job.title, prompt: agentReportPrompt(job) };
}

/** Recettes proposées par la relecture : Kopilia demande l'accord de l'utilisateur. */
export function learningReport(proposals: SkillRow[]): Report {
  const ids = proposals.map((p) => p.id);
  return {
    turnId: `learning_${ids.join("_").slice(0, 80)}`,
    jobId: proposals[0].run_id ?? proposals[0].id,
    title: "Ce que Kopilia propose de retenir",
    prompt: learningReportPrompt(proposals.map((p) => ({ name: p.name, reason: p.reason, isNew: p.version === 1 }))),
    skillIds: ids,
  };
}

export function briefReport(brief: BriefRow): Report {
  return {
    turnId: `brief_${brief.id}`,
    jobId: brief.job_id ?? brief.id,
    title: brief.title,
    prompt: briefReportPrompt(brief),
    briefId: brief.id,
  };
}

/**
 * Des alertes déclenchées : à l'instant (en appel), ou `away` : pendant que
 * l'utilisateur n'était pas là (dites au décroché). Elles passent devant les
 * autres rapports.
 */
export function alertReport(news: AlertFired[], away = false, now = Date.now()): Report {
  const ids = news.map((n) => n.eventId);
  const first = news[0].alert;
  return {
    turnId: `alert_${ids.join("_").slice(0, 80)}`,
    jobId: first.id,
    title: away ? "Alertes pendant ton absence" : `Alerte · ${first.name.charAt(0).toUpperCase()}${first.name.slice(1)}`,
    prompt: alertReportPrompt(
      news.map((n) => ({ line: alertNewsLine(n, now), ...(n.alert.message ? { message: n.alert.message } : {}) })),
      away,
    ),
    alertEventIds: ids,
    urgent: true,
  };
}

/**
 * Des setups proposés par l'IA : à l'instant (en appel), ou `away` : pendant
 * que l'utilisateur n'était pas là (dits au décroché). Ils passent devant les
 * autres rapports, comme une alerte.
 */
export function opportunityReport(list: Scenario[], away = false, now = Date.now()): Report {
  const ids = list.map((s) => s.id);
  const first = list[0];
  return {
    turnId: `setup_${ids.join("_").slice(0, 80)}`,
    jobId: first.id,
    title: away ? "Setups pendant ton absence" : `Setup · ${first.name.charAt(0).toUpperCase()}${first.name.slice(1)}`,
    prompt: opportunityReportPrompt(
      list.map((s) => ({
        id: s.id,
        line: `${scenarioLine(s, now)} ; ${levelsText(s)}`,
        summary: lastProposal(s) ?? s.plan,
        at: when(s.proposedAt ?? now, now),
      })),
      away,
    ),
    scenarioIds: ids,
    urgent: true,
  };
}

/** Une recherche de setups finie : ce qu'elle a repéré (setups en attente), ou pourquoi rien. Pas urgent : après la phrase en cours. */
export function searchReport(d: PassDone, now = Date.now()): Report {
  const opened = new Set(d.opened.map((s) => s.id));
  return {
    turnId: `search_${d.jobId}`,
    jobId: d.jobId,
    title: d.opened.length ? `Setups repérés · ${d.opened.map((s) => s.name).join(", ")}` : "Recherche de setups finie",
    prompt: searchReportPrompt({
      byUser: d.byUser,
      ...(d.focus ? { focus: d.focus } : {}),
      failed: d.failed,
      opened: d.opened.map((s) => ({ line: scenarioLine(s, now), plan: s.plan })),
      closed: d.closed.map((s) => ({ line: scenarioLine(s, now), reason: s.stateReason ?? "" })),
      others: d.open.filter((s) => !opened.has(s.id)).map((s) => scenarioLine(s, now)),
      result: d.result,
    }),
  };
}

/**
 * Ce qui arrive à un trade passé par Kopilia (ordre exécuté, position fermée,
 * refus, rappel de break-even) : dit en une phrase, comme une alerte.
 */
export function tradeReport(s: TradingSignal, now = Date.now()): Report {
  const id = s.trade?.id ?? "trade";
  const instruction =
    s.kind === "reminder"
      ? "[Dis-le-lui en une phrase : le produit, le multiple de risque atteint, et le prix de break-even s'il veut y monter son stop (« passe à break-even »). Tu ne le fais pas sans qu'il le demande, et c'est lui qui confirme.]"
      : s.kind === "closed" && s.trade?.state === "closed"
        ? "[Annonce-le tout de suite en une phrase : le produit, ce qui s'est passé, le prix et le résultat, sans commentaire sur sa gestion. Puis demande-lui en quelques mots s'il a un mot pour son journal sur ce trade ; une fois seulement. S'il en dit un, journal_note avec ses mots (trade : son identifiant) ; s'il ne veut pas, n'insiste pas.]"
        : "[Annonce-le tout de suite en une phrase : le produit, ce qui s'est passé, le prix et le résultat s'il y en a un.]";
  return {
    turnId: `trade_${id}_${s.kind}_${now}`,
    jobId: id,
    title: s.title,
    prompt: `[Trade] ${s.line}\n${instruction}`,
    urgent: s.kind !== "placed",
  };
}

/** Le courtier qu'il a fait rallumer est prêt : dit tout de suite, et ce qu'il attendait reprend. */
export function brokerReadyReport(r: BrokerReady, now = Date.now()): Report {
  return {
    turnId: `broker_ready_${now}`,
    jobId: "broker",
    title: "Courtier rallumé",
    prompt: `[Courtier] Le courtier est rallumé (en ${wakeDurationLabel(r.ms)}) : prix, graphiques et ordres refonctionnent.\n[Dis-le-lui en une phrase. S'il attendait quelque chose (un prix, un graphique, un ordre), reprends-le maintenant ; les graphiques à l'écran se rechargent seuls.]`,
    urgent: true,
  };
}

/** L'analyse de son trading est prête : dite en deux ou trois phrases, telle quelle. */
export function reviewReport(r: JournalReview, now = Date.now()): Report {
  const findings = r.findings.map((f, i) => `${i + 1}) ${f.title} : ${f.text} (${f.trades.join(", ")})`).join(" ");
  const carnet = r.carnet
    ? ` Règle proposée pour son carnet : « ${r.carnet} ». Demande-lui en une phrase s'il veut que tu l'écrives dans son carnet de trader ; seulement s'il dit oui, remember avec notebook trading, avec ses mots.`
    : "";
  return {
    turnId: `journal_review_${r.id}_${now}`,
    jobId: r.id,
    title: "Analyse de ton trading",
    prompt: `[Journal] L'analyse de son trading sur ${r.days} jours est prête et à l'écran (${r.id}). En bref : ${r.summary} Constats : ${findings}\n[Dis-la-lui tout de suite en deux ou trois phrases, à partir du résumé et des constats, sans rien y ajouter.${carnet}]`,
  };
}

/** Le bilan du soir de sa journée : dit en deux phrases. */
export function eveningReport(b: JournalBilan, now = Date.now()): Report {
  return { turnId: `journal_evening_${b.from}_${now}`, jobId: "journal_evening", title: "Bilan de ta journée", prompt: eveningPrompt(b) };
}

/** L'analyse n'a pas pu se faire : dit en une phrase. */
export function reviewFailedReport(message: string, now = Date.now()): Report {
  return {
    turnId: `journal_review_failed_${now}`,
    jobId: "journal_review",
    title: "Analyse impossible",
    prompt: `[Journal] L'analyse de son trading n'a pas pu se faire : ${message}.\n[Dis-le-lui en une phrase ; il peut la redemander.]`,
  };
}

/** Un setup proposé puis abandonné : dit en une phrase. */
export function abandonReport(s: Scenario, now = Date.now()): Report {
  return {
    turnId: `setup_off_${s.id}`,
    jobId: s.id,
    title: `Setup abandonné · ${s.name}`,
    prompt: abandonReportPrompt({ id: s.id, line: scenarioLine(s, now), reason: s.stateReason ?? "" }),
  };
}

/** L'analyse écrite par l'agent en proposant le setup (le dernier « proposé » du fil). */
function lastProposal(s: Scenario): string | undefined {
  const e = [...(s.events ?? [])].reverse().find((x) => x.kind === "proposed");
  return e?.text.replace(/^Setup proposé \([^)]*\) : /, "");
}
