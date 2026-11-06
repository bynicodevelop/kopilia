import type { NewsItem, NewsReaction } from "@kopilia/contracts";
import { dayLabel, startOfDay, timeLabel } from "../common/dates.js";
import type { OutboundMessage } from "../channels/channel.js";
import type { Report } from "../gateway/messages.js";

/*
 * Les news en mots : la ligne lue par Kopilia (outil du dialogue), le tour qui
 * les lui fait dire, le message Telegram et la notification du Mac. Toujours
 * très brèves : le fait, puis l'orientation probable. Pur, testé à plat.
 */

const LEVEL_LABEL: Record<NewsItem["level"], string> = { high: "forte", medium: "moyenne", low: "faible" };

/** « +0,42 % ». */
export function pct(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} %`;
}

/** « or +0,42 % en 2 min ». */
export function reactionLabel(r: NewsReaction): string {
  return `${r.name} ${pct(r.changePct)} en ${r.minutes} min`;
}

/** « 14:30 » aujourd'hui, « jeudi 5 novembre 14:30 » avant. */
export function newsTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = startOfDay(d).getTime() === startOfDay(now).getTime();
  return today ? timeLabel(d) : `${dayLabel(d)} ${timeLabel(d)}`;
}

/** Une news pour Kopilia : « 14:30 · forte · Titre — Impact · or +0,42 % en 2 min ». */
export function newsLine(n: NewsItem, now = Date.now()): string {
  const parts = [newsTime(n.at, now), LEVEL_LABEL[n.level], n.title];
  let line = parts.join(" · ");
  if (n.impact) line += ` — ${n.impact}`;
  if (n.figure?.calendar) line += ` (annonce du calendrier : ${n.figure.calendar.title}, impact ${impactFr(n.figure.calendar.impact)})`;
  if (n.reaction) line += ` · ${reactionLabel(n.reaction)}`;
  if (!n.translated) line += " (pas encore traduite)";
  return line;
}

function impactFr(i: string): string {
  return i === "high" ? "fort" : i === "medium" ? "moyen" : i === "low" ? "faible" : i;
}

/**
 * Le tour qui fait dire des news fortes, dès que la conversation est au repos :
 * une phrase en tout, le fait puis l'impact. Une réaction du marché passe en
 * tête (c'est elle qui est neuve).
 */
export function newsReportPrompt(items: NewsItem[], reaction = false): string {
  const lines = items.map((n) => {
    const r = n.reaction ? ` (${reactionLabel(n.reaction)} juste après)` : "";
    return `- ${n.title}${n.impact ? ` — ${n.impact}` : ""}${r}`;
  });
  const head = reaction
    ? `[News] Le marché vient de réagir nettement à ${items.length > 1 ? "ces news" : "cette news"} :`
    : `[News] ${items.length > 1 ? "Des news importantes viennent" : "Une news importante vient"} de tomber :`;
  const instruction = reaction
    ? "[Fin. Dis-le tout de suite en une phrase très courte : le produit, son mouvement, la news qui l'explique, puis en quelques mots ce qui pourrait suivre (la réaction peut se prolonger ou s'essouffler, et vers quel niveau). Sans lire d'heure.]"
    : `[Fin des news. Dis-${items.length > 1 ? "les" : "la"} tout de suite, très brièvement, en une ou deux phrases en tout : le fait, puis l'orientation probable sur les produits qu'elle touche (« de quoi peser sur l'or », « plutôt porteur pour le Nasdaq »), et dis-le si elle va pour ou contre un de ses trades en cours ou le produit qu'il regarde. Sans lire d'heure ni la source.]`;
  return [head, ...lines, instruction].join("\n");
}

/**
 * Le titre d'un bandeau ou d'un message : le produit qui a réagi, ou le seul
 * produit touché (« News · Or ») ; « News » quand elle en touche plusieurs (une
 * annonce de la Fed n'est pas une news de l'euro-dollar).
 */
export function newsHeading(n: NewsItem, names: Map<string, string>): string {
  const first = n.reaction?.name ?? (n.symbols.length === 1 ? names.get(n.symbols[0]) : undefined);
  return first ? `News · ${first.charAt(0).toUpperCase()}${first.slice(1)}` : "News";
}

/** Le détail d'un bandeau : le titre, l'impact, la réaction. */
export function newsDetail(n: NewsItem): string {
  return [n.title, n.impact, n.reaction ? reactionLabel(n.reaction) : ""].filter(Boolean).join(" · ");
}

/** Le message Telegram de news fortes, en quelques lignes. */
export function newsMessage(items: NewsItem[], names: Map<string, string>, now = Date.now()): OutboundMessage {
  const title = items.length === 1 ? newsHeading(items[0], names) : `News · ${items.length} importantes`;
  const text = items
    .map((n) => [`${newsTime(n.at, now)} ${n.title}`, n.impact, n.reaction ? capitalize(reactionLabel(n.reaction)) : ""].filter(Boolean).join("\n"))
    .join("\n\n");
  return { title, text };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Une news dite en retard n'a plus d'intérêt : passé ce délai, elle n'est plus dite (elle reste dans l'encart). */
export const NEWS_REPORT_TTL_MS = 5 * 60_000;

/** Le rapport qui fait dire des news fortes en appel, après les alertes, s'il n'est pas périmé. */
export function newsReport(items: NewsItem[], reaction: boolean, title: string, now = Date.now()): Report {
  const ids = items.map((i) => i.id);
  return {
    turnId: `news_${reaction ? "r_" : ""}${ids.join("_")}`.slice(0, 96),
    jobId: ids[0],
    title,
    prompt: newsReportPrompt(items, reaction),
    expiresAt: now + NEWS_REPORT_TTL_MS,
  };
}
