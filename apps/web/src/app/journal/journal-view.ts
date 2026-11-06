import { OUTCOME_LABELS, type JournalItem, type JournalLine, type TradeOutcome } from "@kopilia/contracts";
import { dateFormat } from "../format";

/*
 * Ce que l'écran écrit du journal : les R, les dates courtes, les mots du fil.
 * Pur, sans Angular.
 */

/** « +2 R », « −1,03 R », « 0 R ». */
export function rText(r: number): string {
  const v = String(Number(Math.abs(r).toFixed(2))).replace(".", ",");
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${v} R`;
}

/** La couleur d'un résultat : gagné, perdu, ou rien (neutre, en cours). */
export function tone(outcome: TradeOutcome | undefined): "up" | "down" | "flat" {
  return outcome === "win" ? "up" : outcome === "loss" ? "down" : "flat";
}

export function outcomeText(outcome: TradeOutcome | undefined): string {
  return outcome ? OUTCOME_LABELS[outcome] : "";
}

/** « jeu. 5 nov. 17:05 » ; l'heure seule aujourd'hui. */
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return dateFormat("journalClock", { hour: "2-digit", minute: "2-digit" }).format(ms);
  return dateFormat("journalDay", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

/** Ce qui suit le sens sur une ligne : la sortie, l'état, sa note. */
export function lineDetail(l: JournalLine): string {
  return [l.remark, l.note ? `« ${l.note} »` : ""].filter(Boolean).join(" · ");
}

/** L'étiquette d'une entrée du fil. */
export function itemLabel(i: JournalItem): string {
  return ITEM_LABELS[i.kind] ?? i.kind;
}

const ITEM_LABELS: Record<JournalItem["kind"], string> = {
  view: "Ta lecture",
  why: "Ta réponse",
  challenge: "Contradicteur",
  fiche: "Fiche",
  ticket: "Ticket",
  filled: "Exécuté",
  gesture: "Geste",
  exit: "Sortie",
  closed: "Fermé",
  cancelled: "Retiré",
  rejected: "Refusé",
  note: "Ta note",
};

/** « 2 h 04 », « 35 min », « 3 j 4 h ». */
export function durationText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  const d = Math.floor(h / 24);
  return `${d} j${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** Une case du calendrier : un jour de bourse (lundi à vendredi) et ses trades fermés. */
export interface CalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
  count: number;
  r: number;
}

/** Une semaine du calendrier : ses cinq jours de bourse et son total (week-end compris). */
export interface CalendarWeek {
  cells: CalendarCell[];
  count: number;
  r: number;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Les semaines d'un mois (AAAA-MM), du lundi au vendredi, chaque jour avec
 * ses trades fermés ; un trade fermé le week-end compte dans sa semaine.
 */
export function monthGrid(month: string, days: Array<{ date: string; count: number; r: number }>): CalendarWeek[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const last = new Date(y, m, 0, 12);
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const weeks: CalendarWeek[] = [];
  for (const d = new Date(start); d <= last; d.setDate(d.getDate() + 7)) {
    const cells: CalendarCell[] = [];
    let count = 0;
    let r = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(d);
      day.setDate(day.getDate() + i);
      const key = iso(day);
      const hit = byDate.get(key);
      if (hit) {
        count += hit.count;
        r += hit.r;
      }
      if (i < 5) cells.push({ date: key, day: day.getDate(), inMonth: day.getMonth() === m - 1, count: hit?.count ?? 0, r: hit?.r ?? 0 });
    }
    // Une semaine sans jour de bourse dans le mois n'est gardée que si un trade y a été fermé (un dimanche du mois).
    if (cells.some((c) => c.inMonth) || count) weeks.push({ cells, count, r: Math.round(r * 100) / 100 });
  }
  return weeks;
}

/** Le fond pâle d'un jour selon son R : vert pour un gain, rouge pour une perte, plus franc quand l'écart est grand (3 à 16 %). */
export function dayTint(r: number, count: number): string | null {
  if (!count || Math.abs(r) < 0.1) return null;
  const pct = Math.round(Math.min(16, 5 + Math.abs(r) * 5));
  return `color-mix(in srgb, var(${r > 0 ? "--accent-2" : "--danger"}) ${pct}%, transparent)`;
}
