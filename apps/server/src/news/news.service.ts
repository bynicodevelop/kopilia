import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { NEWS_LEVELS, type NewsFigure, type NewsItem, type NewsLevel, type NewsReaction } from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { ConfigService } from "../config/config.service.js";
import { DatabaseService } from "../db/database.service.js";
import { CalendarService } from "../calendar/calendar.service.js";
import { MarketService } from "../market/market.service.js";
import { newId } from "../common/ids.js";
import { sanitizeFts } from "../common/fts.js";
import { timeLabel } from "../common/dates.js";
import {
  FeedError,
  FeedItem,
  figureCurrency,
  isElite,
  matchFigures,
  MATCH_WINDOW_MS,
  parseFigure,
  parseRss,
  type CalendarCandidate,
  type ParsedFigure,
} from "./financial-juice.js";
import { ERROR_RETRY_MS, limitedBackoff, marketsOpen, nextReadAt, QUIET_READ_MS, READ_MS, RELEASE_LOOKAHEAD_MS } from "./schedule.js";
import { NewsTranslator, type ListedProduct, type TranslateFn, type TranslateInput, type Translation } from "./translator.js";
import { measureReaction, reacted, REACTION_MINUTES, type MinuteCandle } from "./reaction.js";
import { newsDetail, newsHeading } from "./news-texts.js";

const SOURCE = "financialjuice";
const FETCH_TIMEOUT_MS = 15_000;
/** Une news plus ancienne n'est plus dite (voix, bandeau, Telegram) : elle va seulement dans l'encart. */
export const FRESH_MS = 10 * 60_000;
/** Une traduction ratée est retentée aux lectures suivantes, tant que la news a moins de 6 h, trois fois au plus. */
const RETRY_WINDOW_MS = 6 * 3_600_000;
const MAX_TRIES = 3;
/** La réaction du marché se mesure quand la dernière minute regardée est close. */
const REACTION_DELAY_MS = (REACTION_MINUTES + 1) * 60_000 + 20_000;
/** Au plus ce nombre de produits regardés par news. */
const REACTION_SYMBOLS = 3;
const RANK: Record<NewsLevel, number> = { low: 0, medium: 1, high: 2 };

interface NewsRow {
  id: string;
  rowid?: number;
  at: number;
  original: string;
  text: string | null;
  link: string | null;
  title_fr: string | null;
  impact: string | null;
  symbols: string;
  level: string;
  elite: number;
  reaction: string | null;
  tries: number;
  announced_at: number | null;
  fig_event: string | null;
  fig_actual: string | null;
  fig_forecast: string | null;
  fig_previous: string | null;
  fig_revised: string | null;
  fig_cal_title: string | null;
  fig_cal_country: string | null;
  fig_cal_impact: string | null;
  fig_cal_forecast: string | null;
}

/** Ce que voient les écrans après une lecture : les news nouvelles ou changées, et celles à dire. */
export interface NewsBatch {
  items: NewsItem[];
  /** Des news déjà envoyées, mises à jour (traduction retentée, réaction du marché). */
  update: boolean;
  /** Les news à dire tout de suite (fortes, fraîches), avec le titre et le détail de leur bandeau. */
  announce: Array<{ item: NewsItem; heading: string; detail: string }>;
  /** Ce qui est annoncé, c'est la réaction du marché (elle passe en tête du message). */
  reaction: boolean;
  /** Le nom courant des produits cités (pour les messages). */
  names: Record<string, string>;
}

export interface NewsQuery {
  symbol?: string;
  since?: number;
  until?: number;
  /** Cherche dans toute l'archive (titre d'origine et traduction). */
  query?: string;
  minLevel?: NewsLevel;
  limit?: number;
}

const SELECT = `SELECT n.rowid, n.*, f.event AS fig_event, f.actual AS fig_actual, f.forecast AS fig_forecast, f.previous AS fig_previous,
  f.revised AS fig_revised, f.cal_title AS fig_cal_title, f.cal_country AS fig_cal_country, f.cal_impact AS fig_cal_impact,
  f.cal_forecast AS fig_cal_forecast
  FROM news_items n LEFT JOIN econ_figures f ON f.news_id = n.id`;

/**
 * Les news en temps réel : le flux RSS de FinancialJuice lu toutes les
 * 2 minutes (10 le week-end, plus lentement après une limite de débit, et 10 s
 * après une annonce forte du calendrier), traduit par Haiku avec une ligne
 * d'impact et un niveau, gardé pour toujours (c'est son contexte macro). Les
 * chiffres publiés sont rapprochés du calendrier ; la réaction du marché est
 * mesurée sur les produits cités, et une news qui fait bouger passe forte.
 */
@Injectable()
export class NewsService extends EventEmitter<{ batch: [NewsBatch] }> implements OnModuleInit, OnModuleDestroy {
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  now: () => number = () => Date.now();
  /** La traduction d'un lot ; remplaçable en test. */
  translate: TranslateFn;
  /** Les bougies d'une minute d'un produit, les plus récentes ; remplaçable en test. */
  candles: (symbol: string) => Promise<MinuteCandle[] | undefined>;
  private readonly translator: NewsTranslator;
  private timer?: NodeJS.Timeout;
  private reactionTimers = new Set<NodeJS.Timeout>();
  private lastRead = 0;
  private limitedWait?: number;
  private reading?: Promise<ReadOutcome>;
  private readonly names = new Map<string, string>();
  /** Sa liste résolue chez le courtier, une fois. */
  private listed?: ListedProduct[];
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly calendar: CalendarService,
    private readonly market: MarketService,
  ) {
    super();
    this.translator = new NewsTranslator({ bin: config.claudeBin, model: config.newsModel, dataDir: config.dataDir, logger });
    this.translate = this.translator.translate;
    this.candles = async (symbol) => {
      const r = await this.market.chartCandles(symbol, "1m", { limit: 70 });
      return "error" in r ? undefined : r.candles;
    };
  }

  get enabled(): boolean {
    return !!this.config.newsFeedUrl;
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.plan(this.now() + 5_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const t of this.reactionTimers) clearTimeout(t);
    this.reactionTimers.clear();
    this.translator.stop();
  }

  /* ------------------------------ Lecture ------------------------------ */

  private plan(at: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.cycle(), Math.max(0, at - this.now()));
    this.timer.unref();
  }

  private async cycle() {
    const outcome = await this.read();
    this.plan(this.nextAt(outcome));
  }

  /** L'instant de la lecture suivante, d'après l'issue de celle-ci. */
  nextAt(outcome: ReadOutcome): number {
    const now = this.now();
    if (outcome === "limited") {
      this.limitedWait = limitedBackoff(this.limitedWait);
      return now + this.limitedWait;
    }
    this.limitedWait = undefined;
    if (outcome === "error") return now + ERROR_RETRY_MS;
    const open = marketsOpen(now);
    return nextReadAt({ last: this.lastRead, now, interval: open ? READ_MS : QUIET_READ_MS, releases: open ? this.releases(now) : [] });
  }

  /** Les annonces fortes du calendrier des minutes qui viennent, sur les devises de sa liste. */
  private releases(now: number): number[] {
    try {
      return this.calendar.events(now, now + RELEASE_LOOKAHEAD_MS, ["high"], this.currencies()).map((e) => e.at);
    } catch {
      return [];
    }
  }

  /** Les devises de sa liste (paires de forex), et toujours le dollar. */
  private currencies(): string[] {
    const out = new Set(["USD"]);
    for (const p of this.config.setupProducts) if (/^[A-Z]{6}$/.test(p)) out.add(p.slice(0, 3)).add(p.slice(3));
    return [...out];
  }

  /** Une lecture du flux (une seule à la fois) : les nouvelles news gardées, traduites et envoyées. */
  read(): Promise<ReadOutcome> {
    this.reading ??= this.readOnce().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async readOnce(): Promise<ReadOutcome> {
    this.lastRead = this.now();
    let items: FeedItem[];
    try {
      const res = await this.fetchImpl(this.config.newsFeedUrl, {
        headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "Kopilia/0.1 (lecteur RSS personnel)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await res.text();
      if (res.status === 429 || /error code:\s*1015/i.test(body)) throw new FeedError(`limite de débit du site (HTTP ${res.status})`, true);
      if (!res.ok) throw new FeedError(`HTTP ${res.status}`);
      items = parseRss(body);
    } catch (e) {
      const err = e as Error;
      const limited = e instanceof FeedError && e.limited;
      const why = e instanceof FeedError ? err.message : err.name === "TimeoutError" ? "délai dépassé" : `injoignable (${err.message})`;
      this.logger.warn(`news FinancialJuice non lues : ${why}`, "news");
      return limited ? "limited" : "error";
    }
    const added = this.store(items);
    if (added.length) this.logger.log(`news FinancialJuice : ${added.length} nouvelle(s)`, "news");
    await this.digest(added);
    return "ok";
  }

  /** Garde les news pas encore connues, avec leur chiffre publié rapproché du calendrier ; renvoie leurs identifiants. */
  private store(items: FeedItem[]): string[] {
    const known = this.db.db.prepare("SELECT 1 FROM news_items WHERE source = ? AND guid = ?");
    const fresh = items.filter((i) => !known.get(SOURCE, i.guid));
    if (!fresh.length) return [];
    const figures = fresh.flatMap((i) => {
      const figure = parseFigure(i.title);
      return figure ? [{ item: i, at: i.at, figure }] : [];
    });
    const matches = figures.length ? matchFigures(figures, this.candidates(figures)) : [];
    const insert = this.db.db.prepare(
      `INSERT OR IGNORE INTO news_items (id, source, guid, at, original, text, link, level, elite, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFigure = this.db.db.prepare(
      `INSERT OR IGNORE INTO econ_figures (id, news_id, at, event, country, actual, forecast, previous, revised, cal_at, cal_country, cal_title, cal_impact, cal_forecast, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = this.now();
    const ids: string[] = [];
    this.db.tx(() => {
      // Les plus anciennes d'abord : l'ordre d'arrivée suit l'ordre de publication.
      for (const i of [...fresh].sort((a, b) => a.at - b.at)) {
        const id = `nw_${i.guid}`;
        const fi = figures.findIndex((f) => f.item === i);
        const cal = fi >= 0 ? matches[fi] : undefined;
        const elite = isElite(i.title);
        const level = ruleLevel(elite, fi >= 0, cal?.impact) ?? "low";
        const r = insert.run(id, SOURCE, i.guid, i.at, i.title, i.text ?? null, i.link ?? null, level, elite ? 1 : 0, now);
        if (!r.changes) continue;
        ids.push(id);
        if (fi < 0) continue;
        const f: ParsedFigure = figures[fi].figure;
        insertFigure.run(
          newId("fig"),
          id,
          i.at,
          f.event,
          figureCurrency(f.event) ?? null,
          f.actual,
          f.forecast ?? null,
          f.previous ?? null,
          f.revised ?? null,
          cal?.at ?? null,
          cal?.country ?? null,
          cal?.title ?? null,
          cal?.impact ?? null,
          cal?.forecast ?? null,
          now,
        );
      }
    });
    return ids;
  }

  /** Les annonces du calendrier autour de ces chiffres. */
  private candidates(figures: Array<{ at: number }>): CalendarCandidate[] {
    const from = Math.min(...figures.map((f) => f.at)) - MATCH_WINDOW_MS;
    const to = Math.max(...figures.map((f) => f.at)) + MATCH_WINDOW_MS + 1;
    try {
      return this.calendar.events(from, to, ["high", "medium", "low"]);
    } catch {
      return [];
    }
  }

  /**
   * Traduit les nouvelles news (et celles dont la traduction avait raté), fixe
   * leur niveau, les envoie aux écrans, annonce les fortes et fraîches, et
   * programme la mesure de la réaction du marché.
   */
  private async digest(added: string[]) {
    const now = this.now();
    const retry = this.db.db
      .prepare(`SELECT id FROM news_items WHERE title_fr IS NULL AND tries < ? AND at >= ? ORDER BY at DESC LIMIT 100`)
      .all(MAX_TRIES, now - RETRY_WINDOW_MS) as Array<{ id: string }>;
    const ids = [...new Set([...added, ...retry.map((r) => r.id)])];
    if (!ids.length) return;
    const rows = this.rows(ids);
    await this.translateRows(rows);
    const items = this.rows(ids).map(toItem);
    const addedSet = new Set(added);
    const announce = items.filter((n) => addedSet.has(n.id) && n.level === "high" && now - n.at <= FRESH_MS && !this.announced(n.id));
    await this.ensureNames(items.flatMap((n) => n.symbols));
    this.markAnnounced(announce.map((n) => n.id));
    this.emit("batch", this.batch(items, false, announce, false));
    for (const n of items) if (addedSet.has(n.id) && now - n.at <= FRESH_MS) this.watchReaction(n);
  }

  private async translateRows(rows: NewsRow[]) {
    const todo = rows.filter((r) => !r.title_fr);
    if (!todo.length) return;
    const inputs: TranslateInput[] = todo.map((r) => ({
      id: r.id,
      time: timeLabel(new Date(r.at)),
      title: r.original,
      ...(r.text ? { text: r.text } : {}),
      ...(r.fig_cal_title
        ? {
            release: `${r.fig_cal_title} (${r.fig_cal_country}), impact ${r.fig_cal_impact}${r.fig_cal_forecast ? `, consensus du calendrier ${r.fig_cal_forecast}` : ""}`,
          }
        : {}),
    }));
    let done: Translation[] = [];
    try {
      done = await this.translate(inputs, await this.productList());
    } catch (e) {
      this.logger.warn(`news non traduites : ${(e as Error).message}`, "news");
    }
    const byId = new Map(done.map((t) => [t.id, t]));
    const update = this.db.db.prepare("UPDATE news_items SET title_fr = ?, impact = ?, symbols = ?, level = ? WHERE id = ?");
    const failed = this.db.db.prepare("UPDATE news_items SET tries = tries + 1 WHERE id = ?");
    this.db.tx(() => {
      for (const r of todo) {
        const t = byId.get(r.id);
        if (!t) {
          failed.run(r.id);
          continue;
        }
        const level = combineLevel(ruleLevel(!!r.elite, !!r.fig_actual, r.fig_cal_impact ?? undefined), !!r.fig_actual, t.level);
        update.run(t.fr, t.impact ?? null, JSON.stringify(t.symbols), level, r.id);
      }
    });
  }

  private announced(id: string): boolean {
    return !!(this.db.db.prepare("SELECT announced_at FROM news_items WHERE id = ?").get(id) as { announced_at: number | null } | undefined)?.announced_at;
  }

  private markAnnounced(ids: string[]) {
    const mark = this.db.db.prepare("UPDATE news_items SET announced_at = ? WHERE id = ? AND announced_at IS NULL");
    const now = this.now();
    for (const id of ids) mark.run(now, id);
  }

  private batch(items: NewsItem[], update: boolean, announce: NewsItem[], reaction: boolean): NewsBatch {
    const names = Object.fromEntries(this.names);
    return {
      items,
      update,
      announce: announce.map((item) => ({ item, heading: newsHeading(item, this.names), detail: newsDetail(item) })),
      reaction,
      names,
    };
  }

  /**
   * Sa liste avec les symboles du courtier (« USOIL » de sa liste est USWTI
   * chez lui) : les news sont étiquetées comme les graphiques et les
   * questions les nomment. Résolue une fois ; un produit introuvable garde son
   * nom de la liste (réessayé à la lecture suivante).
   */
  private async productList(): Promise<ListedProduct[]> {
    if (this.listed) return this.listed;
    let complete = true;
    const out: ListedProduct[] = [];
    for (const q of this.config.setupProducts) {
      const p = await this.market.resolve(q).catch(() => undefined);
      if (p && "symbol" in p) {
        this.names.set(p.symbol, p.name);
        out.push({ symbol: p.symbol, name: p.name });
      } else {
        complete = false;
        out.push({ symbol: q });
      }
    }
    const unique = [...new Map(out.map((p) => [p.symbol, p])).values()];
    if (complete) this.listed = unique;
    return unique;
  }

  /** Le nom courant des produits (« or », « Nasdaq 100 »), demandé une fois au courtier. */
  private async ensureNames(symbols: string[]) {
    for (const s of new Set(symbols)) {
      if (this.names.has(s)) continue;
      const p = await this.market.resolve(s).catch(() => undefined);
      this.names.set(s, p && "symbol" in p ? p.name : s);
    }
  }

  /* ------------------------- Réaction du marché ------------------------- */

  /** Une news moyenne ou forte qui cite des produits : on regarde ce qu'ils font dans les minutes qui suivent. */
  private watchReaction(n: NewsItem) {
    if (!this.config.newsReactions || !n.symbols.length || RANK[n.level] < RANK.medium || n.reaction) return;
    const timer = setTimeout(
      () => {
        this.reactionTimers.delete(timer);
        void this.checkReaction(n.id).catch((e: Error) => this.logger.warn(`réaction du marché non mesurée : ${e.message}`, "news"));
      },
      Math.max(0, n.at + REACTION_DELAY_MS - this.now()),
    );
    timer.unref();
    this.reactionTimers.add(timer);
  }

  /** Mesure la réaction ; nette, elle est gardée, la news passe forte, et elle est dite si elle ne l'a pas été. */
  async checkReaction(id: string): Promise<NewsReaction | undefined> {
    const [row] = this.rows([id]);
    if (!row || row.reaction) return undefined;
    const item = toItem(row);
    let best: NewsReaction | undefined;
    for (const symbol of item.symbols.slice(0, REACTION_SYMBOLS)) {
      const candles = await this.candles(symbol);
      const r = candles ? measureReaction(candles, item.at) : undefined;
      if (!reacted(r) || (best && best.strength >= r.strength)) continue;
      await this.ensureNames([symbol]);
      best = { symbol, name: this.names.get(symbol) ?? symbol, changePct: round(r.changePct, 3), strength: round(r.strength, 1), minutes: REACTION_MINUTES };
    }
    if (!best) return undefined;
    this.db.db.prepare("UPDATE news_items SET reaction = ?, level = 'high' WHERE id = ?").run(JSON.stringify(best), id);
    const updated = toItem(this.rows([id])[0]);
    const tell = !row.announced_at && this.now() - updated.at <= FRESH_MS + REACTION_DELAY_MS;
    if (tell) this.markAnnounced([id]);
    this.emit("batch", this.batch([updated], true, tell ? [updated] : [], true));
    return best;
  }

  /* ------------------------------ Lecture ------------------------------ */

  private rows(ids: string[]): NewsRow[] {
    if (!ids.length) return [];
    return this.db.db.prepare(`${SELECT} WHERE n.id IN (${ids.map(() => "?").join(",")}) ORDER BY n.at DESC`).all(...ids) as NewsRow[];
  }

  /** Les news gardées, les plus récentes d'abord (filtrées par produit, période, niveau, mots). */
  list(q: NewsQuery = {}): NewsItem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.symbol) {
      where.push("n.symbols LIKE ?");
      params.push(`%"${q.symbol.replace(/["%_]/g, "")}"%`);
    }
    if (q.since !== undefined) {
      where.push("n.at >= ?");
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push("n.at < ?");
      params.push(q.until);
    }
    if (q.minLevel && q.minLevel !== "low") {
      const levels = NEWS_LEVELS.filter((l) => RANK[l] >= RANK[q.minLevel!]);
      where.push(`n.level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
    const fts = q.query ? sanitizeFts(q.query) : "";
    if (q.query && !fts) return [];
    if (fts) {
      where.push("n.rowid IN (SELECT rowid FROM news_fts WHERE news_fts MATCH ?)");
      params.push(fts);
    }
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 50)), 300);
    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY n.at DESC LIMIT ${limit}`;
    return (this.db.db.prepare(sql).all(...params) as NewsRow[]).map(toItem);
  }

  /** Le nom courant d'un produit déjà rencontré. */
  nameOf(symbol: string): string | undefined {
    return this.names.get(symbol);
  }
}

export type ReadOutcome = "ok" | "limited" | "error";

/**
 * Le niveau que donnent les faits, avant Haiku : un aperçu payant reste
 * faible ; un chiffre publié prend l'impact de son annonce du calendrier.
 */
export function ruleLevel(elite: boolean, figure: boolean, calendarImpact: string | undefined): NewsLevel | undefined {
  if (elite) return "low";
  if (!figure || !calendarImpact) return undefined;
  if (calendarImpact === "high") return "high";
  if (calendarImpact === "medium") return "medium";
  return "low";
}

/** Le niveau retenu : celui des faits s'il y en a un ; un chiffre hors calendrier, moyen au plus ; sinon celui de Haiku. */
export function combineLevel(rule: NewsLevel | undefined, figure: boolean, haiku: NewsLevel): NewsLevel {
  if (rule) return rule;
  if (figure && haiku === "high") return "medium";
  return haiku;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function toItem(r: NewsRow): NewsItem {
  let symbols: string[] = [];
  try {
    const parsed = JSON.parse(r.symbols) as unknown;
    if (Array.isArray(parsed)) symbols = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* liste illisible : aucun produit */
  }
  let reaction: NewsReaction | undefined;
  try {
    reaction = r.reaction ? (JSON.parse(r.reaction) as NewsReaction) : undefined;
  } catch {
    reaction = undefined;
  }
  const figure: NewsFigure | undefined = r.fig_actual
    ? {
        event: r.fig_event ?? "",
        actual: r.fig_actual,
        ...(r.fig_forecast ? { forecast: r.fig_forecast } : {}),
        ...(r.fig_previous ? { previous: r.fig_previous } : {}),
        ...(r.fig_revised ? { revised: r.fig_revised } : {}),
        ...(r.fig_cal_title
          ? {
              calendar: {
                title: r.fig_cal_title,
                country: r.fig_cal_country ?? "",
                impact: r.fig_cal_impact ?? "",
                ...(r.fig_cal_forecast ? { forecast: r.fig_cal_forecast } : {}),
              },
            }
          : {}),
      }
    : undefined;
  const level = NEWS_LEVELS.includes(r.level as NewsLevel) ? (r.level as NewsLevel) : "low";
  return {
    id: r.id,
    at: r.at,
    title: r.title_fr ?? (figure ? figureFallback(figure) : r.original),
    original: r.original,
    translated: !!r.title_fr,
    ...(r.impact ? { impact: r.impact } : {}),
    symbols,
    level,
    ...(figure ? { figure } : {}),
    ...(reaction ? { reaction } : {}),
    ...(r.elite ? { elite: true } : {}),
    ...(r.link ? { link: r.link } : {}),
  };
}

/** Un chiffre publié sans traduction : « Unemployment Claims : 189k (attendu 196k, précédent 194k) ». */
function figureFallback(f: NewsFigure): string {
  const extra = [f.forecast ? `attendu ${f.forecast}` : "", f.previous ? `précédent ${f.previous}` : ""].filter(Boolean).join(", ");
  return `${f.calendar?.title ?? f.event} : ${f.actual}${extra ? ` (${extra})` : ""}`;
}
