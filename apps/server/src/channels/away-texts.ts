import { JobState, type Scenario } from "@kopilia/contracts";
import type { AlertFired } from "../alerts/alert.service.js";
import { firedTexts } from "../alerts/alert-texts.js";
import { abandonedTexts, levelsText, proposedTexts, searchedTexts, setupLabel } from "../setups/setup-texts.js";
import type { PassDone } from "../setups/setup-agents.service.js";
import type { BriefRow } from "../veille/brief.service.js";
import type { JobRow } from "../jobs/job.service.js";
import type { OutboundMessage } from "./channel.js";
import type { NewsItem } from "@kopilia/contracts";
import { newsDetail, newsHeading, newsMessage } from "../news/news-texts.js";

/*
 * Ce que Kopilia envoie de lui-même quand aucun écran n'est ouvert, en
 * quelques lignes : les mêmes faits que le bandeau de l'écran, sans conseil ni
 * consigne de trading. Pur, testé à plat.
 */

/** Une information à faire suivre quand personne n'est devant un écran. */
export type AwayNews =
  | { kind: "alert"; fired: AlertFired }
  | { kind: "setup"; scenario: Scenario }
  | { kind: "abandon"; scenario: Scenario }
  | { kind: "search"; pass: PassDone }
  | { kind: "brief"; brief: BriefRow }
  | { kind: "agent"; job: JobRow }
  | { kind: "news"; items: NewsItem[]; names: Record<string, string> }
  /** Ce qui arrive à un trade passé par Kopilia : exécuté, fermé, refusé, rappel de break-even. */
  | { kind: "trade"; title: string; detail?: string };

/** Le résultat d'un agent est coupé à peu près là (le reste est à l'écran). */
export const AGENT_EXCERPT_MAX = 600;

/** La notification du Mac, pour ce qu'elle montrait déjà : alertes, setups, recherches qui en repèrent. */
export function macTexts(news: AwayNews): { title: string; detail: string } | undefined {
  if (news.kind === "alert") return firedTexts(news.fired);
  if (news.kind === "setup") return proposedTexts(news.scenario);
  if (news.kind === "abandon") return abandonedTexts(news.scenario);
  if (news.kind === "search") return searchedTexts(news.pass);
  if (news.kind === "news") return { title: newsHeading(news.items[0], new Map(Object.entries(news.names))), detail: newsDetail(news.items[0]) };
  if (news.kind === "trade") return { title: news.title, detail: news.detail ?? "" };
  return undefined;
}

/** Le message d'un canal extérieur (Telegram) : un titre, et quelques lignes. */
export function awayMessage(news: AwayNews): OutboundMessage {
  switch (news.kind) {
    case "alert": {
      const { title, detail } = firedTexts(news.fired);
      const note = news.fired.alert.message ? `Ta consigne : « ${news.fired.alert.message} »` : "";
      return { title, text: [detail, note].filter(Boolean).join("\n") };
    }
    case "setup": {
      const s = news.scenario;
      return { title: proposedTexts(s).title, text: [capitalize(setupLabel(s)), capitalize(levelsText(s))].join("\n") };
    }
    case "abandon": {
      const s = news.scenario;
      return { title: abandonedTexts(s).title, text: [capitalize(setupLabel(s)), s.stateReason ? capitalize(s.stateReason) : ""].filter(Boolean).join("\n") };
    }
    case "search": {
      const { title, detail } = searchedTexts(news.pass);
      return { title, text: detail.split(" · ").join("\n") };
    }
    case "brief":
      return { title: news.brief.title, text: news.brief.spoken };
    case "news":
      return newsMessage(news.items, new Map(Object.entries(news.names)));
    case "trade":
      return { title: news.title, text: news.detail ?? "" };
    case "agent": {
      const job = news.job;
      const body = excerpt(plainText(job.summary ?? ""), AGENT_EXCERPT_MAX);
      return { title: `${jobHead(job)} : ${job.title}`, text: body || "Aucun résultat." };
    }
  }
}

/** « Agent fini », « Tâche en échec »… */
function jobHead(job: Pick<JobRow, "kind" | "state">): string {
  const task = job.kind === "task";
  const what = task ? "Tâche" : "Agent";
  if (job.state === JobState.Succeeded) return `${what} ${task ? "finie" : "fini"}`;
  if (job.state === JobState.Cancelled) return `${what} ${task ? "annulée" : "annulé"}`;
  if (job.state === JobState.Unverified) return `${what} interrompu${task ? "e" : ""}`;
  return `${what} en échec`;
}

/** Le Markdown d'un résultat en texte brut : sans titres, gras, code ni adresses de liens. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Les `max` premiers caractères environ : coupés à la fin d'une phrase, sinon d'un mot, suivis de « … ». */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("\n"));
  const cut = sentence > max * 0.6 ? head.slice(0, sentence + 1) : head.replace(/\s+\S*$/, "");
  return `${cut.trimEnd()} …`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
