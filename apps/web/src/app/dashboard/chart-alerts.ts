/**
 * Les alertes vues du graphique, sans écran : l'alerte qu'on règle (nouvelle,
 * à un prix ou sur une ligne, ou existante), son titre, la ligne d'une alerte
 * dans la liste et ce qui ne va pas dans ses réglages. Testées sans écran.
 */
import {
  ALERT_TRIGGER_NAMES,
  Alert,
  AlertCondition,
  AlertTrigger,
  Drawing,
  MAX_ALERT_MESSAGE,
  defaultCondition,
  fibLevelPrice,
  fibRatioLabel,
} from "@kopilia/contracts";
import { formatPrice } from "./candles";
import { dateFormat } from "../format";

/** Une alerte en cours de réglage : nouvelle (sans identifiant) ou existante. */
export interface AlertDraft {
  id?: string;
  /** Ce qu'elle surveille : un prix (qu'on peut changer), une ligne tracée, ou un niveau d'un Fibonacci (son ratio). */
  target: { kind: "price"; price: number } | { kind: "drawing"; drawingId: string; level?: number };
  condition: AlertCondition;
  trigger: AlertTrigger;
  /** Unité des bougies (une fois par bougie, sur clôture, calcul d'une oblique) : celle du graphique où on la pose. */
  timeframe: string;
  message: string;
  /** Déjà partie (ou expirée) : l'enregistrer la réarme. */
  stopped?: Alert["state"];
}

/** Sens court : « à la hausse », « à la baisse », « les deux sens ». */
export const SENSE: Record<AlertCondition, string> = { up: "à la hausse", down: "à la baisse", cross: "les deux sens" };

/** Une alerte à ce prix ; son sens d'après le cours (au-dessus : la hausse). */
/** L'unité d'une alerte prise sur un graphique : la sienne, sauf le mois (sa bougie n'a pas de durée fixe) : la semaine. */
export function alertTimeframe(chart: string): string {
  return chart === "1mn" ? "1w" : chart;
}

export function priceDraft(price: number, current: number | undefined, timeframe: string): AlertDraft {
  return { target: { kind: "price", price }, condition: defaultCondition(price, current), trigger: "once", timeframe: alertTimeframe(timeframe), message: "" };
}

/** Une alerte sur cette ligne, ou sur ce niveau d'un Fibonacci (`level`, son ratio) : franchie dans un sens ou dans l'autre. */
export function lineDraft(d: Drawing, timeframe: string, level?: number): AlertDraft {
  const target = { kind: "drawing" as const, drawingId: d.id, ...(level !== undefined ? { level } : {}) };
  return { target, condition: "cross", trigger: "once", timeframe: alertTimeframe(timeframe), message: "" };
}

/**
 * Un tracé peut porter une alerte : ligne horizontale, oblique qui n'est pas
 * verticale, zone (elle part quand le prix y entre), Fibonacci (sur un de ses niveaux).
 */
export function canWatch(d: Drawing): boolean {
  // Un niveau de l'IA part avec son dossier : l'utilisateur le garde d'abord pour y mettre une alerte.
  if (d.createdBy === "ia") return false;
  return d.kind === "hline" || d.kind === "zone" || d.kind === "fib" || d.kind === "fibext" || (d.kind === "trendline" && d.a.t !== d.b.t);
}

/** L'alerte de l'utilisateur sur ce tracé, ou sur ce niveau d'un Fibonacci. */
export function alertOn(alerts: readonly Alert[], drawingId: string, level?: number): Alert | undefined {
  return alerts.find((a) => !a.scenarioId && a.target.kind === "drawing" && a.target.drawingId === drawingId && a.target.level === level);
}

export function draftOf(a: Alert): AlertDraft {
  return {
    id: a.id,
    // Une bande n'est posée que par l'IA : réglée à l'écran, elle garde sa cible (son bas, comme prix indicatif).
    target:
      a.target.kind === "price"
        ? { kind: "price", price: a.target.price }
        : a.target.kind === "band"
          ? { kind: "price", price: a.target.bottom }
          : { kind: "drawing", drawingId: a.target.drawingId, ...(a.target.level !== undefined ? { level: a.target.level } : {}) },
    condition: a.condition,
    trigger: a.trigger,
    timeframe: a.timeframe,
    message: a.message ?? "",
    ...(a.state === "triggered" || a.state === "expired" ? { stopped: a.state } : {}),
  };
}

/**
 * « ligne « résistance » », « oblique », « zone », « niveau 0,618 (3 976,19)
 * du retracement » : le tracé d'une alerte, en quelques mots, sans article.
 */
function lineName(d: Drawing | undefined, digits: number, level?: number): string {
  const named = d?.label ? ` « ${d.label} »` : "";
  if ((d?.kind === "fib" || d?.kind === "fibext") && level !== undefined) {
    const price = fibLevelPrice(d, level);
    const at = price !== undefined ? ` (${formatPrice(price, digits)})` : "";
    return `niveau ${fibRatioLabel(level)}${at} ${d.kind === "fib" ? "du retracement" : "de l'extension"}${named}`;
  }
  const kind = d?.kind === "trendline" ? "oblique" : d?.kind === "zone" ? "zone" : "ligne";
  return `${kind}${named}`;
}

/** « Alerte à 3 960,00 », « Alerte sur la ligne « résistance » », « Nouvelle alerte sur l'oblique », « … sur le niveau 0,618 … ». */
export function draftTitle(draft: AlertDraft, drawings: Drawing[], digits: number): string {
  const head = draft.id ? "Alerte" : "Nouvelle alerte";
  if (draft.target.kind === "price") return `${head} à ${formatPrice(draft.target.price, digits)}`;
  const id = draft.target.drawingId;
  const name = lineName(
    drawings.find((d) => d.id === id),
    digits,
    draft.target.level,
  );
  return `${head} sur ${name.startsWith("oblique") ? "l'" : name.startsWith("niveau") ? "le " : "la "}${name}`;
}

/** Le sens d'une alerte sur une zone : y entrer par-dessous, par-dessus, ou d'un côté ou de l'autre. */
export const ZONE_SENSE: Record<AlertCondition, string> = { up: "entrée par-dessous", down: "entrée par-dessus", cross: "entrée d'un côté ou de l'autre" };

/** L'alerte surveille-t-elle une zone (on y entre plutôt qu'on la franchit) ? */
export function watchesZone(target: AlertDraft["target"] | Alert["target"], drawings: Drawing[]): boolean {
  return target.kind === "band" || (target.kind === "drawing" && drawings.find((d) => d.id === target.drawingId)?.kind === "zone");
}

/** Ce que surveille une alerte, dans la liste : « 3 960,00 · à la hausse », « Ligne « résistance » · les deux sens ». */
export function alertLabel(a: Alert, drawings: Drawing[], digits: number): string {
  const t = a.target;
  const what =
    t.kind === "price"
      ? formatPrice(t.price, digits)
      : t.kind === "band"
        ? `Bande ${formatPrice(t.bottom, digits)} – ${formatPrice(t.top, digits)}`
        : capitalize(
            lineName(
              drawings.find((d) => d.id === t.drawingId),
              digits,
              t.level,
            ),
          );
  return `${what} · ${watchesZone(t, drawings) ? ZONE_SENSE[a.condition] : SENSE[a.condition]}`;
}

/** Son mode et son état : « une seule fois », « sur clôture 1h · suspendue », « partie à 14:32 ». */
export function alertStatus(a: Alert, chip: (timeframe: string) => string): string {
  if (a.state === "triggered") return `partie${a.triggeredAt ? ` ${when(a.triggeredAt)}` : ""}`;
  if (a.state === "expired") return "expirée";
  const modes: Record<Alert["trigger"], string> = {
    once: ALERT_TRIGGER_NAMES.once.toLowerCase(),
    bar: `une fois par bougie ${chip(a.timeframe)}`,
    close: `sur clôture ${chip(a.timeframe)}`,
    touch_close: `clôture après contact ${chip(a.timeframe)}`,
  };
  const mode = modes[a.trigger];
  return a.state === "paused" ? `${mode} · suspendue` : mode;
}

/** Ce qui ne va pas dans les réglages (undefined : on peut enregistrer). */
export function draftError(d: AlertDraft): string | undefined {
  if (d.target.kind === "price" && !(Number.isFinite(d.target.price) && d.target.price > 0)) return "Le prix doit être un nombre positif.";
  if (d.message.trim().length > MAX_ALERT_MESSAGE) return `Consigne : ${MAX_ALERT_MESSAGE} caractères au plus.`;
  return undefined;
}

/** « à 14:32 » aujourd'hui, sinon « le 3 nov. ». */
function when(ms: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return `à ${dateFormat("clock", { hour: "2-digit", minute: "2-digit" }).format(d)}`;
  return `le ${dateFormat("day", { day: "numeric", month: "short" }).format(d)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
