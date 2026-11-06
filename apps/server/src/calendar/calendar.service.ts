import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { newId } from "../common/ids.js";
import {
  CalendarEvent,
  FeedError,
  Impact,
  ImpactFilter,
  ParsedFeed,
  Period,
  groupByDay,
  impactsFor,
  parseFeed,
  periodRange,
  renderWeek,
} from "./forex-factory.js";
import { startOfDay, timeZoneLabel, updatedLabel } from "../common/dates.js";

const SOURCE = "forexfactory";
const SNAPSHOT_FILE = "forexfactory.md";
/**
 * Rendez-vous de mise à jour (annonces ajoutées ou déplacées, prévisions
 * révisées) : 6 h avant le wrap du matin, 12 h avant celui de midi, 18 h pour
 * la soirée.
 */
const REFRESH_HOURS = [6, 12, 18];
/** Mise à jour automatique dans l'heure qui suit le rendez-vous ; manquée, elle attend le suivant. */
const REFRESH_WINDOW_MS = 3_600_000;
const TICK_MS = 5 * 60_000;
/** Forex Factory bloque au-delà de deux requêtes par 5 minutes. */
const MIN_INTERVAL_MS = 5 * 60_000;
/** Nouvel essai d'une mise à jour après un échec. */
const RETRY_MS = 15 * 60_000;
/** Période au-delà de la semaine connue (le dimanche, la nouvelle semaine) : au plus un essai par heure. */
const BEYOND_RETRY_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const KEEP_FETCH_LOG_MS = 30 * 86_400_000;

interface FetchRow {
  at: number;
  ok: number;
  events: number | null;
  range_start: number | null;
  range_end: number | null;
  error: string | null;
}

export interface CalendarLookup {
  period?: Period;
  date?: string;
  impact?: ImpactFilter;
  currencies?: string[];
}

/**
 * Calendrier économique Forex Factory, gardé en local pour que Kopilia réponde
 * tout de suite aux questions d'agenda (« quelles annonces aujourd'hui ? »).
 *
 * Mis à jour trois fois par jour (dans l'heure qui suit 6 h, 12 h et 18 h), et
 * avant de répondre ou de lancer un wrap si ce n'est pas encore fait. Le flux
 * officiel ne couvre que la semaine en cours et
 * ne donne pas le chiffre publié (prévision et précédent seulement). Une copie
 * Markdown de la semaine est écrite pour les agents (`snapshotFile`).
 */
@Injectable()
export class CalendarService implements OnModuleInit, OnModuleDestroy {
  /** Remplaçable en test. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  private inflight?: Promise<{ ok: boolean; error?: string }>;
  private ticker?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit() {
    if (!this.enabled) return;
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.ticker.unref();
    setTimeout(() => void this.tick(), 2_000).unref(); // au démarrage, si un rendez-vous est en cours
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
  }

  get enabled(): boolean {
    return !!this.config.ffCalendarUrl;
  }

  get dir(): string {
    const dir = resolve(this.config.dataDir, "calendar");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  get snapshotFile(): string | undefined {
    return calendarSnapshot(this.config.dataDir);
  }

  /**
   * Mise à jour aux rendez-vous (minuterie), réessayée après un échec pendant
   * l'heure qui suit. Vrai si une requête est partie.
   */
  async tick(now = new Date()): Promise<boolean> {
    if (!this.enabled || this.isFresh(now) || this.inflight) return false;
    if (now.getTime() - refreshPoint(now) >= REFRESH_WINDOW_MS) return false; // manqué : au rendez-vous suivant
    const last = this.lastAttempt();
    if (last && now.getTime() - last.at < RETRY_MS) return false;
    await this.refresh(now);
    return true;
  }

  /**
   * Avant de répondre : met à jour si ce n'est pas fait depuis le dernier
   * rendez-vous (6 h, 12 h ou 18 h), ou si la
   * période demandée va au-delà de la semaine connue. Jamais plus d'une requête
   * par 5 minutes ; en cas d'échec, les données déjà connues restent servies.
   */
  async ensureFresh(now = new Date(), until?: number): Promise<void> {
    if (!this.enabled) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }
    const last = this.lastAttempt();
    const since = last ? now.getTime() - last.at : Infinity;
    if (since < MIN_INTERVAL_MS) return;
    const beyond = until !== undefined && until > this.coveredUntil() && since >= BEYOND_RETRY_MS;
    if (!this.isFresh(now) || beyond) await this.refresh(now);
  }

  /** Une seule requête à la fois ; les appels simultanés partagent son résultat. */
  refresh(now = new Date()): Promise<{ ok: boolean; error?: string }> {
    this.inflight ??= this.download(now).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** Mis à jour avec succès depuis le dernier rendez-vous (6 h, 12 h ou 18 h) ? */
  isFresh(now = new Date()): boolean {
    const row = this.db.db.prepare("SELECT 1 FROM calendar_fetches WHERE source = ? AND ok = 1 AND at >= ? LIMIT 1").get(SOURCE, refreshPoint(now));
    return !!row;
  }

  /** La dernière tentative depuis le rendez-vous a échoué : inutile d'attendre une mise à jour. */
  refreshFailed(now = new Date()): boolean {
    const last = this.lastAttempt();
    return !!last && !last.ok && last.at >= refreshPoint(now);
  }

  private lastAttempt(): FetchRow | undefined {
    return this.db.db.prepare("SELECT * FROM calendar_fetches WHERE source = ? ORDER BY at DESC, id DESC LIMIT 1").get(SOURCE) as FetchRow | undefined;
  }

  private lastSuccess(): FetchRow | undefined {
    return this.db.db.prepare("SELECT * FROM calendar_fetches WHERE source = ? AND ok = 1 ORDER BY at DESC, id DESC LIMIT 1").get(SOURCE) as
      FetchRow | undefined;
  }

  private coveredUntil(): number {
    const row = this.db.db.prepare("SELECT max(range_end) AS end FROM calendar_fetches WHERE source = ? AND ok = 1").get(SOURCE) as { end: number | null };
    return row.end ?? 0;
  }

  private async download(now: Date): Promise<{ ok: boolean; error?: string }> {
    const at = now.getTime();
    try {
      const res = await this.fetchImpl(this.config.ffCalendarUrl, {
        headers: { accept: "application/json", "user-agent": "Kopilia/0.1 (assistant vocal personnel)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const limited = res.status === 403 || res.status === 429 ? " (limite de requêtes atteinte ?)" : "";
        throw new FeedError(`HTTP ${res.status}${limited}`);
      }
      const feed = parseFeed(await res.text());
      this.store(feed, at);
      this.writeSnapshot(now);
      this.logger.log(`calendrier Forex Factory mis à jour : ${feed.events.length} annonces`, "calendar");
      return { ok: true };
    } catch (e) {
      const err = e as Error;
      const error = e instanceof FeedError ? err.message : err.name === "TimeoutError" ? "délai dépassé" : `injoignable (${err.message})`;
      this.db.db.prepare("INSERT INTO calendar_fetches (source, at, ok, error) VALUES (?, ?, 0, ?)").run(SOURCE, at, error);
      this.logger.warn(`calendrier Forex Factory non mis à jour : ${error}`, "calendar");
      return { ok: false, error };
    }
  }

  /** Remplace la semaine couverte par le flux (annonces déplacées ou retirées comprises). */
  private store(feed: ParsedFeed, at: number) {
    const insert = this.db.db.prepare(
      "INSERT INTO calendar_events (id,source,at,country,title,impact,forecast,previous,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    this.db.tx(() => {
      this.db.db.prepare("DELETE FROM calendar_events WHERE source = ? AND at >= ? AND at < ?").run(SOURCE, feed.week.start, feed.week.end);
      for (const e of feed.events) {
        insert.run(newId("cal"), SOURCE, e.at, e.country, e.title, e.impact, e.forecast, e.previous, at);
      }
      this.db.db
        .prepare("INSERT INTO calendar_fetches (source, at, ok, events, range_start, range_end) VALUES (?, ?, 1, ?, ?, ?)")
        .run(SOURCE, at, feed.events.length, feed.week.start, feed.week.end);
      this.db.db.prepare("DELETE FROM calendar_fetches WHERE at < ?").run(at - KEEP_FETCH_LOG_MS);
    });
  }

  private writeSnapshot(now: Date) {
    const last = this.lastSuccess();
    if (!last?.range_start || !last.range_end) return;
    const md = renderWeek(this.events(last.range_start, last.range_end, impactsFor("all")), last.at, now);
    writeFileSync(resolve(this.dir, SNAPSHOT_FILE), md);
  }

  events(start: number, end: number, impacts: Impact[], currencies: string[] = []): CalendarEvent[] {
    const params: unknown[] = [SOURCE, start, end, ...impacts];
    // Le chiffre publié, s'il est connu : lu dans les news, gardé à part (la mise à jour de la semaine réécrit calendar_events).
    let sql = `SELECT at, country, title, impact, forecast, previous,
      (SELECT f.actual FROM econ_figures f WHERE f.cal_at = calendar_events.at AND f.cal_country = calendar_events.country
        AND f.cal_title = calendar_events.title ORDER BY f.at DESC LIMIT 1) AS actual
      FROM calendar_events
      WHERE source = ? AND at >= ? AND at < ? AND impact IN (${impacts.map(() => "?").join(",")})`;
    const wanted = currencies.map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (wanted.length) {
      sql += ` AND country IN (${wanted.map(() => "?").join(",")})`;
      params.push(...wanted);
    }
    return this.db.db.prepare(`${sql} ORDER BY at, country, title`).all(...params) as CalendarEvent[];
  }

  /**
   * Réponse à une question d'agenda (outil economic_calendar de Kopilia) : les
   * annonces de la période, par jour, en heure du Mac. Par défaut toutes les
   * annonces pour un jour, impact moyen et fort pour la semaine.
   */
  async lookup(q: CalendarLookup, now = new Date()) {
    if (!this.enabled) return { error: "calendrier Forex Factory désactivé (KOPILIA_FF_CALENDAR_URL vide)" };
    const range = periodRange(q.period, q.date, now);
    await this.ensureFresh(now, range.end);
    const last = this.lastSuccess();
    if (!last) {
      return { error: `calendrier Forex Factory indisponible pour l'instant (${this.lastAttempt()?.error ?? "jamais récupéré"})` };
    }
    const impact = q.impact ?? (range.multiDay ? "medium" : "all");
    const events = this.events(range.start, range.end, impactsFor(impact), q.currencies);
    const covered = range.start < this.coveredUntil();
    const notes = ["Le chiffre publié n'y figure pas : pour un résultat déjà sorti, il faut chercher sur le web."];
    if (!covered) notes.unshift("Forex Factory ne publie que le calendrier de la semaine en cours : cette période n'est pas encore disponible.");
    const attempt = this.lastAttempt();
    if (attempt && !attempt.ok) notes.unshift(`Dernière mise à jour impossible (${attempt.error}) : données de la précédente.`);
    return {
      source: "calendrier économique Forex Factory",
      updated: updatedLabel(last.at, now),
      timezone: timeZoneLabel(),
      period: range.label,
      impact: impact === "all" ? "tous les impacts" : impact === "medium" ? "impact moyen et fort" : "impact fort",
      days: groupByDay(events),
      ...(events.length ? {} : { empty: "aucune annonce pour cette période et ce filtre" }),
      notes,
    };
  }

  /**
   * Agenda pour l'agent de veille : annonces d'impact moyen et fort publiées
   * depuis `since` (chiffre à chercher), puis à venir jusqu'à la fin du sixième
   * jour suivant, telles que connues (sans requête).
   */
  briefAgenda(now = new Date(), since?: number): string | undefined {
    const last = this.lastSuccess();
    if (!this.enabled || !last) return undefined;
    const start = startOfDay(now);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const impacts = impactsFor("medium");
    const sections: Array<[string, ReturnType<typeof groupByDay>]> = [
      ["Publié pendant la période", groupByDay(this.events(since ?? start.getTime(), now.getTime(), impacts))],
      ["À venir", groupByDay(this.events(now.getTime(), end.getTime(), impacts))],
    ];
    if (sections.every(([, days]) => !days.length)) return undefined;
    const lines = [`Calendrier économique Forex Factory (mis à jour ${updatedLabel(last.at, now)}, ${timeZoneLabel()}, impact moyen et fort) :`];
    for (const [label, days] of sections) {
      if (!days.length) continue;
      lines.push(`${label} :`);
      for (const d of days) lines.push(`${d.day} :`, ...d.events.map((e) => `- ${e}`));
    }
    return lines.join("\n");
  }
}

/** Calendrier de la semaine en Markdown (lu par les agents), s'il a déjà été récupéré. */
export function calendarSnapshot(dataDir: string): string | undefined {
  const file = resolve(dataDir, "calendar", SNAPSHOT_FILE);
  return existsSync(file) ? file : undefined;
}

/** Dernier rendez-vous de mise à jour passé : 6 h, 12 h ou 18 h (la veille à 18 h, avant 6 h). */
export function refreshPoint(now: Date): number {
  const hour = REFRESH_HOURS.filter((h) => h <= now.getHours()).at(-1);
  if (hour !== undefined) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).getTime();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, REFRESH_HOURS[REFRESH_HOURS.length - 1]).getTime();
}
