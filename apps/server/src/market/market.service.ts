import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Indicator, MA_NAMES, MA_SHORT, indicatorLabel, indicatorSeries, isOverlay } from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { timeZoneLabel, updatedLabel } from "../common/dates.js";
import { MarketError, ageLabel, decimals, frenchPrice, resolveSymbol } from "./metaapi.js";
import { MetaApiStream } from "./metaapi-stream.js";
import {
  BrokerAccountInfo,
  BrokerDeal,
  BrokerOrder,
  BrokerPosition,
  BrokerTerms,
  BrokerTradeResult,
  parseAccountInfo,
  parseDeals,
  parseOrders,
  parsePositions,
  parseTerms,
  parseTradeResult,
} from "./broker.js";
import { QuoteFeed, RawQuote } from "./quote-feed.js";
import { ChartTimeframe, TIMEFRAME_LABELS } from "./timeframes.js";
import {
  Candle,
  HistoryQuery,
  Session,
  Span,
  cleanCandles,
  dailyRequest,
  dayReport,
  pickDays,
  resolveSpan,
  sessionDay,
  sessionReport,
  sessionWindow,
} from "./history.js";

/** Au-delà, la cotation n'est plus en direct : marché fermé ou à l'arrêt. */
const STALE_MS = 5 * 60_000;
/** Compte et région relus toutes les 10 minutes ; la liste des symboles, toutes les heures. */
const ACCOUNT_TTL_MS = 10 * 60_000;
const SYMBOLS_TTL_MS = 60 * 60_000;
/** La première demande d'un symbole l'abonne aux cotations : quelques secondes. */
const FETCH_TIMEOUT_MS = 20_000;
const MAX_QUERIES = 6;
const MAX_HISTORY_QUERIES = 4;
/** Bougies chargées à l'ouverture d'un graphique, puis par paquets en remontant le temps (MetaApi : 1 000 au plus). */
const CHART_LIMIT = 400;
/**
 * MetaApi met un temps qui suit la durée couverte, pas le nombre de bougies :
 * environ 8 s par année (mesuré le 2026-11-05 : 400 jours en 12,6 s, 156
 * semaines en 23 s, 60 mois en 40 s). Une grande unité s'ouvre donc sur peu de
 * bougies (six mois de semaines, un an de mois), affichées vite ; le graphique
 * demande aussitôt le passé, par paquets plus gros, en arrière-plan.
 */
const CHART_LIMITS: Partial<Record<ChartTimeframe, number>> = { "1w": 30, "1mn": 12 };
const CHART_PAGE_LIMITS: Partial<Record<ChartTimeframe, number>> = { "1w": 104, "1mn": 36 };
const CHART_MAX_LIMIT = 1000;
/** Le passé des grandes unités se fait attendre (voir CHART_LIMITS) : plus de patience que pour les autres demandes. */
const CANDLES_TIMEOUT_MS: Partial<Record<ChartTimeframe, number>> = { "1d": 30_000, "1w": 60_000, "1mn": 60_000 };
/**
 * Le chargement d'un graphique de grande unité est gardé un moment : rouvrir le
 * graphique, ou l'afficher sur deux écrans, ne redemande rien à MetaApi (la
 * bougie en cours suit les cotations).
 */
const CHART_CACHE_MS: Partial<Record<ChartTimeframe, number>> = { "1d": 60_000, "1w": 5 * 60_000, "1mn": 5 * 60_000 };
/** En dessous, c'est un recalage de la bougie en cours (jamais gardé) ; au-dessus, un chargement. */
const CHART_CACHE_MIN_LIMIT = 10;
const CLIENT_DOMAIN = "agiliumtrade.ai";
const DAY_MS = 86_400_000;
const FIVE_MIN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 5_000;
/** Requêtes MetaApi simultanées au plus : au-delà, MetaApi répond « trop de requêtes » (429). */
const MAX_CONCURRENT_REQUESTS = 4;
const OUTAGE = "MetaApi momentanément indisponible (HTTP 504 : le compte se reconnecte au courtier) : réessaie dans un instant";
/** Un ordre attend la réponse du courtier au plus ce délai (jamais renvoyé). */
const TRADE_TIMEOUT_MS = 30_000;
const UNKNOWN_ORDER =
  "le courtier n'a pas répondu : l'ordre est peut-être parti. Vérifie ta plateforme avant de recommencer, Kopilia ne le renverra pas de lui-même";
const NOT_CONFIGURED = "cours en direct non configurés : il manque le jeton MetaApi (KOPILIA_METAAPI_TOKEN) dans le fichier .env de Kopilia";

interface AccountDto {
  _id?: string;
  name?: string;
  state?: string;
  connectionStatus?: string;
  region?: string;
  server?: string;
}

interface PriceDto {
  bid?: number;
  ask?: number;
  time?: string;
}

interface Account {
  id: string;
  name: string;
  server?: string;
  /** API des cours, dans la région du compte. */
  clientUrl: string;
  /** API de l'historique (bougies), dans la même région. */
  dataUrl: string;
}

interface Spec {
  description?: string;
  digits?: number;
}

/** Produit du courtier retrouvé pour une demande (encarts du tableau de bord). */
export interface Product {
  symbol: string;
  name: string;
  digits?: number;
}

/** Bougie d'un graphique : instant en secondes (epoch, UTC), comme le graphique les attend. */
export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Les bougies d'un graphique, ou pourquoi elles manquent. */
export type ChartCandlesResult = { symbol: string; timeframe: ChartTimeframe; candles: ChartCandle[]; more: boolean } | { error: string };

const enc = encodeURIComponent;

/**
 * Cours en direct du compte MetaTrader de l'utilisateur, via MetaApi (outil
 * market_price de Kopilia) : le compte est créé et déployé dans l'interface
 * MetaApi ; Kopilia n'a que le jeton d'API et, s'il y en a plusieurs,
 * l'identifiant du compte. Le symbole du courtier est retrouvé à partir du nom
 * courant (« Nasdaq » -> NAS100, US100 ou USTEC selon le courtier).
 */
@Injectable()
export class MarketService implements OnModuleInit, OnModuleDestroy {
  /** Remplaçable en test. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  /**
   * Attente avant chaque nouvel essai d'une requête ratée ; remplaçable en test.
   * Un compte qui se reconnecte au courtier répond 504 quelques secondes,
   * parfois plus de quatre : 15 s en tout, comme le début des nouveaux essais
   * du SDK MetaApi (1, 2, 4, 8 s…), en essais plus serrés pour reprendre vite.
   */
  retryDelaysMs = [1_000, 2_000, 3_000, 4_000, 5_000];
  /** Un 504 fait relire le compte (région, connexion au courtier), au plus une fois par tel délai ; remplaçable en test. */
  accountRecheckMs = 5_000;
  /** Les chargements de graphique en route ou gardés un moment (CHART_CACHE_MS), par produit, unité, fin et nombre. */
  private readonly chartLoads = new Map<string, { at: number; ttl: number; pending: boolean; value: Promise<ChartCandlesResult> }>();
  /** Cotations en direct des produits affichés à l'écran. */
  readonly feed: QuoteFeed;
  private account?: { at: number; value: Account };
  /** Lecture du compte en cours : les demandes simultanées l'attendent au lieu d'en lancer chacune une. */
  private accountRead?: Promise<Account>;
  private symbols?: { at: number; value: string[] };
  private specs = new Map<string, Spec>();
  /**
   * Compte en pause (ou en train de se rallumer) : la raison à dire, et rien
   * n'est demandé à MetaApi. Posé par BrokerPauseService.
   */
  private pauseGate?: () => string | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    const stream =
      config.metaApiToken && config.metaApiStream ? new MetaApiStream(config.metaApiToken, async () => (await this.resolveAccount()).id, logger) : undefined;
    this.feed = new QuoteFeed(
      (symbol) => this.rawQuote(symbol),
      (symbol) => this.dayOpen(symbol),
      logger,
      stream,
    );
  }

  /** Au démarrage, compte et liste des symboles chargés d'avance : la première question n'attend pas. */
  onModuleInit() {
    if (!this.enabled) return;
    setTimeout(() => void this.warmUp(), 3_000).unref();
  }

  onModuleDestroy() {
    this.feed.stop();
  }

  get enabled(): boolean {
    return !!this.config.metaApiToken;
  }

  private async warmUp() {
    try {
      const account = await this.resolveAccount();
      const symbols = await this.symbolList(account);
      this.logger.log(`MetaApi prêt : compte « ${account.name} », ${symbols.length} symboles`, "market");
    } catch (e) {
      if (isPaused(e)) this.logger.log(`MetaApi en pause au démarrage : ${describe(e)}`, "market");
      else this.logger.warn(`MetaApi pas prêt au démarrage : ${describe(e)}`, "market");
    }
  }

  /** Dernier prix de chaque produit demandé (six au plus), ou une erreur lisible. */
  async prices(queries: string[], now = new Date()) {
    if (!this.enabled) return { error: NOT_CONFIGURED };
    const wanted = distinctQueries(queries, MAX_QUERIES);
    if (!wanted.length) return { error: "aucun produit demandé" };
    try {
      const account = await this.resolveAccount();
      const symbols = await this.symbolList(account);
      return {
        source: sourceOf(account),
        timezone: timeZoneLabel(),
        prices: await Promise.all(wanted.map((q) => this.quote(account, symbols, q, now))),
        notes: ["price est le cours vendeur (bid), celui des graphiques MetaTrader ; ask est le cours acheteur."],
      };
    } catch (e) {
      const error = describe(e);
      if (!isPaused(e)) this.logger.warn(`cours MetaApi indisponibles : ${error}`, "market");
      return { error };
    }
  }

  private async quote(account: Account, symbols: string[], query: string, now: Date) {
    const found = resolveSymbol(query, symbols);
    if (!("symbol" in found)) return notFound(query, found.suggestions);
    const base = this.symbolBase(account, found.symbol);
    try {
      const [price, spec] = await Promise.all([this.get<PriceDto>(`${base}/current-price`), this.spec(account, base, found.symbol)]);
      const { bid, ask } = price;
      if (typeof bid !== "number") return { query, symbol: found.symbol, error: "pas de prix pour ce symbole" };
      const digits = spec?.digits ?? Math.max(decimals(bid), typeof ask === "number" ? decimals(ask) : 0);
      const at = Date.parse(price.time ?? "");
      const age = now.getTime() - at;
      return {
        query,
        symbol: found.symbol,
        name: found.name ?? spec?.description ?? found.symbol,
        price: frenchPrice(bid, digits),
        bid,
        ...(typeof ask === "number" ? { ask, spread: frenchPrice(ask - bid, digits) } : {}),
        ...(Number.isFinite(at) ? { at: quoteTime(at, now), age: ageLabel(age) } : {}),
        ...(age > STALE_MS ? { closed: `pas de cotation depuis ${updatedLabel(at, now)} : marché fermé ou à l'arrêt` } : {}),
      };
    } catch (e) {
      return { query, symbol: found.symbol, error: describe(e) };
    }
  }

  /**
   * Historique de chaque produit demandé (quatre au plus) : un jour, une
   * période ou une séance, d'après les bougies du courtier (outil market_history).
   */
  async history(queries: string[], q: HistoryQuery, now = new Date()) {
    if (!this.enabled) return { error: NOT_CONFIGURED };
    const wanted = distinctQueries(queries, MAX_HISTORY_QUERIES);
    if (!wanted.length) return { error: "aucun produit demandé" };
    try {
      const span = resolveSpan(q, now);
      const day = q.session ? sessionDay(span) : undefined;
      const account = await this.resolveAccount();
      const symbols = await this.symbolList(account);
      return {
        source: sourceOf(account),
        timezone: timeZoneLabel(),
        history: await Promise.all(wanted.map((w) => this.productHistory(account, symbols, w, span, q.session, day, now))),
      };
    } catch (e) {
      const error = describe(e);
      if (!isPaused(e)) this.logger.warn(`historique MetaApi indisponible : ${error}`, "market");
      return { error };
    }
  }

  private async productHistory(
    account: Account,
    symbols: string[],
    query: string,
    span: Span,
    session: Session | undefined,
    day: string | undefined,
    now: Date,
  ) {
    const found = resolveSymbol(query, symbols);
    if (!("symbol" in found)) return notFound(query, found.suggestions);
    const { symbol } = found;
    const base = this.symbolBase(account, symbol);
    const product = (spec: Spec | undefined, candles: Candle[]) => ({
      query,
      symbol,
      name: found.name ?? spec?.description ?? symbol,
      digits: spec?.digits ?? Math.max(0, ...candles.slice(-3).flatMap((c) => [decimals(c.open), decimals(c.close)])),
    });
    try {
      if (session && day) {
        const window = sessionWindow(session, day, now);
        if (window.start > now.getTime()) return { query, symbol, error: `la ${window.label} n'a pas encore commencé` };
        const until = Math.min(window.end, now.getTime());
        const [spec, candles] = await Promise.all([
          this.spec(account, base, symbol),
          this.candles(account, symbol, "5m", until, Math.ceil((until - window.start) / FIVE_MIN_MS) + 2),
        ]);
        return sessionReport(product(spec, candles), window, candles, now);
      }
      const request = dailyRequest(span);
      const [spec, daily] = await Promise.all([
        this.spec(account, base, symbol),
        this.candles(account, symbol, "1d", Date.parse(request.startTime), request.limit),
      ]);
      const picked = pickDays(daily, span, now);
      // Pour un seul jour, l'heure du plus haut et du plus bas (bougies de 5 minutes) ; facultative.
      let intraday: Candle[] = [];
      if (span.single) {
        const start = Date.parse(picked.days[0].time);
        const until = Math.min(start + DAY_MS, now.getTime());
        intraday = await this.candles(account, symbol, "5m", until, Math.ceil((until - start) / FIVE_MIN_MS) + 2)
          .then((cs) => cs.filter((c) => Date.parse(c.time) >= start && Date.parse(c.time) < start + DAY_MS))
          .catch(() => []);
      }
      return dayReport(product(spec, daily), span, picked, intraday, now);
    } catch (e) {
      return { query, symbol, error: describe(e) };
    }
  }

  /* ------------------------ Tableau de bord (graphiques) ------------------------ */

  /** Nom du compte MetaApi (« Compte démo »), affiché sous un graphique ; vide si inconnu. */
  async accountLabel(): Promise<string> {
    if (!this.enabled) return "";
    try {
      return (await this.resolveAccount()).name;
    } catch {
      return "";
    }
  }

  /** Produit du courtier pour une demande : symbole exact, nom courant, décimales. */
  async resolve(query: string): Promise<Product | { error: string; suggestions?: string[] }> {
    if (!this.enabled) return { error: NOT_CONFIGURED };
    try {
      const account = await this.resolveAccount();
      const symbols = await this.symbolList(account);
      const found = resolveSymbol(query, symbols);
      if (!("symbol" in found)) {
        return { error: `« ${query.trim()} » introuvable chez le courtier`, ...(found.suggestions.length ? { suggestions: found.suggestions } : {}) };
      }
      const spec = await this.spec(account, this.symbolBase(account, found.symbol), found.symbol);
      return { symbol: found.symbol, name: found.name ?? spec?.description ?? found.symbol, ...(spec?.digits !== undefined ? { digits: spec.digits } : {}) };
    } catch (e) {
      return { error: describe(e) };
    }
  }

  /**
   * Bougies d'un graphique pour un symbole exact, les plus anciennes d'abord,
   * jusqu'à `before` (epoch s ; maintenant par défaut). `more` : il en reste
   * probablement avant la première (un paquet plein).
   */
  async chartCandles(symbol: string, timeframe: ChartTimeframe, opts: { before?: number; limit?: number } = {}): Promise<ChartCandlesResult> {
    if (!this.enabled) return { error: NOT_CONFIGURED };
    const fallback = (opts.before ? CHART_PAGE_LIMITS[timeframe] : CHART_LIMITS[timeframe]) ?? CHART_LIMIT;
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? fallback)), CHART_MAX_LIMIT);
    // La même demande déjà en route (deux écrans, un graphique rouvert) est partagée ; un chargement de grande unité est gardé un moment.
    const key = `${symbol}|${timeframe}|${opts.before ?? "now"}|${limit}`;
    const now = Date.now();
    const known = this.chartLoads.get(key);
    if (known && (known.pending || now - known.at < known.ttl)) return known.value;
    const ttl = !opts.before && limit >= CHART_CACHE_MIN_LIMIT ? (CHART_CACHE_MS[timeframe] ?? 0) : 0;
    const entry = { at: now, ttl, pending: true, value: this.loadChartCandles(symbol, timeframe, opts.before, limit) };
    for (const [k, e] of this.chartLoads) if (!e.pending && now - e.at >= e.ttl) this.chartLoads.delete(k);
    this.chartLoads.set(key, entry);
    void entry.value.then((r) => {
      entry.pending = false;
      entry.at = Date.now();
      // Une erreur n'est jamais gardée : la demande suivante retente.
      if ("error" in r || !ttl) this.chartLoads.delete(key);
    });
    return entry.value;
  }

  private async loadChartCandles(symbol: string, timeframe: ChartTimeframe, before: number | undefined, limit: number): Promise<ChartCandlesResult> {
    try {
      const account = await this.resolveAccount();
      const until = before ? before * 1000 : Date.now();
      const raw = await this.candles(account, symbol, timeframe, until, limit);
      const candles: ChartCandle[] = raw
        .filter((c) => Date.parse(c.time) <= until)
        .map((c) => ({ t: Math.floor(Date.parse(c.time) / 1000), o: c.open, h: c.high, l: c.low, c: c.close }));
      return { symbol, timeframe, candles, more: raw.length >= limit };
    } catch (e) {
      return { error: describe(e) };
    }
  }

  /**
   * Valeurs des indicateurs d'un produit dans une unité de temps, calculées sur
   * les bougies du courtier comme à l'écran (même code) : sur la bougie en
   * cours et sur la dernière close, avec la position du prix par rapport à
   * chaque moyenne, la zone du RSI (selon ses seuils) et sa moyenne s'il en a une.
   */
  async indicators(query: string, timeframe: ChartTimeframe, list: Indicator[]) {
    if (!this.enabled) return { error: NOT_CONFIGURED };
    if (!list.length) return { error: "aucun indicateur demandé" };
    const product = await this.resolve(query);
    if ("error" in product) return product;
    // Assez de bougies pour que les moyennes exponentielles et le RSI soient stabilisés.
    const longest = Math.max(...list.map((i) => i.period + (i.kind === "rsi" && i.signal ? i.signal.period : 0)));
    const r = await this.chartCandles(product.symbol, timeframe, { limit: Math.min(CHART_MAX_LIMIT, Math.max(200, longest * 4)) });
    if ("error" in r) return { error: r.error ?? "bougies indisponibles" };
    const candles = r.candles;
    if (candles.length < 2) return { error: "pas assez de bougies pour calculer" };
    const last = candles[candles.length - 1];
    const digits = product.digits ?? Math.max(0, ...candles.slice(-3).map((c) => decimals(c.c)));
    const price = (v: number) => frenchPrice(v, digits);
    const tenth = (v: number) => v.toFixed(1).replace(".", ",");
    const tail = (series: number[]) => ({ now: series[series.length - 1], closed: series[series.length - 2] });
    const values = list.map((i) => {
      const series = indicatorSeries(i, candles);
      const { now, closed } = tail(series.main);
      if (!Number.isFinite(now)) return { name: indicatorLabel(i), error: `pas assez de bougies (${candles.length} pour une longueur de ${i.period})` };
      if (isOverlay(i)) {
        return {
          name: indicatorLabel(i),
          type: `moyenne ${MA_NAMES[i.type]}`,
          value: price(now),
          ...(Number.isFinite(closed) ? { lastClosed: price(closed) } : {}),
          position: last.c > now ? "prix au-dessus" : last.c < now ? "prix au-dessous" : "prix dessus",
        };
      }
      const zone = now >= i.overbought ? "surachat" : now <= i.oversold ? "survente" : "neutre";
      const signal = series.signal && tail(series.signal).now;
      return {
        name: indicatorLabel(i),
        value: tenth(now),
        ...(Number.isFinite(closed) ? { lastClosed: tenth(closed) } : {}),
        zone,
        levels: `${i.oversold} / ${i.overbought}`,
        ...(i.signal && signal !== undefined && Number.isFinite(signal)
          ? {
              signal: `${MA_SHORT[i.signal.type]} ${i.signal.period} du RSI : ${tenth(signal)}`,
              versusSignal: now > signal ? "RSI au-dessus" : "RSI au-dessous",
            }
          : {}),
      };
    });
    return {
      symbol: product.symbol,
      name: product.name,
      timeframe,
      timeframeLabel: TIMEFRAME_LABELS[timeframe],
      price: price(last.c),
      currentCandle: `ouverte ${updatedLabel(last.t * 1000, new Date())}`,
      indicators: values,
      note: "value : sur la bougie en cours (pas encore close), lastClosed : sur la précédente ; mêmes calculs que le graphique (RSI de Wilder).",
    };
  }

  /** Dernière cotation d'un symbole exact, pour le flux des encarts. */
  private async rawQuote(symbol: string): Promise<RawQuote> {
    const account = await this.resolveAccount();
    const base = this.symbolBase(account, symbol);
    const [price, spec] = await Promise.all([this.get<PriceDto>(`${base}/current-price`), this.spec(account, base, symbol)]);
    if (typeof price.bid !== "number") throw new MarketError("pas de prix pour ce symbole");
    const at = Date.parse(price.time ?? "");
    return {
      bid: price.bid,
      ...(typeof price.ask === "number" ? { ask: price.ask } : {}),
      time: Number.isFinite(at) ? at : Date.now(),
      ...(spec?.digits !== undefined ? { digits: spec.digits } : {}),
    };
  }

  /** Ouverture de la dernière journée du courtier (la variation du jour s'en calcule). */
  private async dayOpen(symbol: string): Promise<number | undefined> {
    const account = await this.resolveAccount();
    const daily = await this.candles(account, symbol, "1d", Date.now(), 1);
    return daily.at(-1)?.open;
  }

  private symbolBase(account: Account, symbol: string): string {
    return `${account.clientUrl}/users/current/accounts/${enc(account.id)}/symbols/${enc(symbol)}`;
  }

  /** Bougies d'un symbole, les plus récentes d'abord côté MetaApi, jusqu'à `until` (compris). */
  private async candles(account: Account, symbol: string, timeframe: string, until: number, limit: number): Promise<Candle[]> {
    const q = new URLSearchParams({ startTime: new Date(until).toISOString(), limit: String(Math.min(limit, 1000)) });
    const url = `${account.dataUrl}/users/current/accounts/${enc(account.id)}/historical-market-data/symbols/${enc(symbol)}/timeframes/${timeframe}/candles?${q}`;
    return cleanCandles(await this.get<unknown>(url, undefined, CANDLES_TIMEOUT_MS[timeframe as ChartTimeframe] ?? FETCH_TIMEOUT_MS));
  }

  /* -------------------- Compte et ordres (prise de position) -------------------- */

  /** Le compte du courtier : devise, solde, capitaux propres, ordres permis, démo ou réel. */
  async brokerAccount(): Promise<BrokerAccountInfo> {
    if (!this.enabled) throw new MarketError(NOT_CONFIGURED);
    const account = await this.resolveAccount();
    const info = parseAccountInfo(await this.get<unknown>(`${this.accountBase(account)}/account-information`), account.name, account.server);
    if (!info) throw new MarketError("informations du compte illisibles");
    return { ...info, name: account.name };
  }

  /** La fiche d'un produit pour calculer une taille (pas, valeur du tick, volumes), et son prix du moment. */
  async brokerTerms(symbol: string): Promise<{ terms: BrokerTerms; bid: number; ask: number }> {
    if (!this.enabled) throw new MarketError(NOT_CONFIGURED);
    const account = await this.resolveAccount();
    const base = this.symbolBase(account, symbol);
    const [spec, price] = await Promise.all([this.get<unknown>(`${base}/specification`), this.get<unknown>(`${base}/current-price`)]);
    const terms = parseTerms(spec, price);
    if (!terms) throw new MarketError(`le courtier ne donne pas la valeur du tick de ${symbol}`);
    const p = price as { bid?: number; ask?: number };
    if (typeof p.bid !== "number") throw new MarketError("pas de prix pour ce symbole");
    return { terms, bid: p.bid, ask: typeof p.ask === "number" ? p.ask : p.bid };
  }

  async brokerPositions(): Promise<BrokerPosition[]> {
    const account = await this.resolveAccount();
    return parsePositions(await this.get<unknown>(`${this.accountBase(account)}/positions`));
  }

  async brokerOrders(): Promise<BrokerOrder[]> {
    const account = await this.resolveAccount();
    return parseOrders(await this.get<unknown>(`${this.accountBase(account)}/orders`));
  }

  /** Les transactions entre deux instants (epoch ms). */
  async brokerDeals(from: number, to: number): Promise<BrokerDeal[]> {
    const account = await this.resolveAccount();
    const range = `${enc(new Date(from).toISOString())}/${enc(new Date(to).toISOString())}`;
    return parseDeals(await this.get<unknown>(`${this.accountBase(account)}/history-deals/time/${range}`));
  }

  /**
   * Un ordre chez le courtier, en un seul essai : un ordre n'est jamais
   * renvoyé de lui-même (il pourrait partir deux fois). Sans réponse, on ne
   * sait pas s'il est parti : l'erreur le dit.
   */
  async brokerTrade(request: Record<string, unknown>): Promise<BrokerTradeResult> {
    if (!this.enabled) throw new MarketError(NOT_CONFIGURED);
    const account = await this.resolveAccount();
    const url = `${this.accountBase(account)}/trade`;
    let res: Response;
    try {
      res = await this.slot(() =>
        this.fetchImpl(url, {
          method: "POST",
          headers: { "auth-token": this.config.metaApiToken, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(TRADE_TIMEOUT_MS),
        }),
      );
    } catch (e) {
      const err = e as Error;
      this.logger.warn(`MetaApi : ordre sans réponse (${err.name === "TimeoutError" ? "délai dépassé" : err.message})`, "trading");
      throw new MarketError(UNKNOWN_ORDER);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 500) throw new MarketError(UNKNOWN_ORDER);
    if (!res.ok) {
      const message = typeof body.message === "string" ? body.message.slice(0, 200) : "";
      if (res.status === 401) throw new MarketError("jeton MetaApi refusé : vérifie KOPILIA_METAAPI_TOKEN dans le fichier .env de Kopilia");
      return { ok: false, numericCode: res.status, stringCode: String(body.error ?? `HTTP ${res.status}`), message };
    }
    return parseTradeResult(body);
  }

  /**
   * La marge que le courtier demanderait pour ouvrir cette position (devise du
   * compte) : un calcul, rien n'est passé. Undefined s'il ne sait pas la dire.
   */
  async brokerMargin(order: { symbol: string; side: "long" | "short"; volume: number; price: number }): Promise<number | undefined> {
    if (!this.enabled) throw new MarketError(NOT_CONFIGURED);
    const account = await this.resolveAccount();
    const res = await this.slot(() =>
      this.fetchImpl(`${this.accountBase(account)}/calculate-margin`, {
        method: "POST",
        headers: { "auth-token": this.config.metaApiToken, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          symbol: order.symbol,
          type: order.side === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
          volume: order.volume,
          openPrice: order.price,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    );
    if (!res.ok) throw new MarketError(`calcul de marge refusé par MetaApi (HTTP ${res.status})`);
    const margin = ((await res.json().catch(() => ({}))) as { margin?: unknown }).margin;
    return typeof margin === "number" && Number.isFinite(margin) ? margin : undefined;
  }

  private accountBase(account: Account): string {
    return `${account.clientUrl}/users/current/accounts/${enc(account.id)}`;
  }

  /** Nom et décimales du symbole ; facultatifs (le prix suffit si la fiche manque). */
  private async spec(account: Account, base: string, symbol: string): Promise<Spec | undefined> {
    const key = `${account.id}:${symbol}`;
    const known = this.specs.get(key);
    if (known) return known;
    try {
      const dto = await this.get<Spec>(`${base}/specification`);
      const spec = { description: dto.description || undefined, digits: typeof dto.digits === "number" ? dto.digits : undefined };
      this.specs.set(key, spec);
      return spec;
    } catch {
      return undefined;
    }
  }

  /**
   * Compte MetaApi déployé et connecté au courtier, avec l'adresse de l'API des
   * cours dans sa région. Gardé 10 minutes ; un compte pas prêt est relu à
   * chaque demande (il peut être en cours de déploiement).
   */
  private async resolveAccount(): Promise<Account> {
    const paused = this.pauseGate?.();
    if (paused) throw new MarketError(paused, "paused");
    if (this.account && Date.now() - this.account.at < ACCOUNT_TTL_MS) return this.account.value;
    this.accountRead ??= this.readAccount().finally(() => (this.accountRead = undefined));
    return this.accountRead;
  }

  private async readAccount(): Promise<Account> {
    const prov = this.config.metaApiProvisioningUrl;
    const id = this.config.metaApiAccountId || (await this.onlyAccount());
    const [dto, domain] = await Promise.all([
      this.get<AccountDto>(
        `${prov}/users/current/accounts/${enc(id)}`,
        "compte MetaApi introuvable : vérifie KOPILIA_METAAPI_ACCOUNT_ID dans le fichier .env de Kopilia",
      ),
      this.config.metaApiClientUrl ? Promise.resolve(undefined) : this.clientDomain(),
    ]);
    const name = dto.name || id;
    if (dto.state !== "DEPLOYED") {
      throw new MarketError(
        dto.state === "DEPLOYING"
          ? `le compte MetaApi « ${name} » est en cours de déploiement : réessaie dans une minute`
          : `le compte MetaApi « ${name} » n'est pas déployé (état ${dto.state ?? "inconnu"}) : déploie-le dans l'interface MetaApi`,
      );
    }
    if (dto.connectionStatus && dto.connectionStatus !== "CONNECTED") {
      throw new MarketError(
        `le compte MetaApi « ${name} » n'est pas connecté au courtier (${dto.connectionStatus}) : réessaie dans une minute, sinon vérifie le login, le mot de passe et le serveur dans l'interface MetaApi`,
      );
    }
    const region = dto.region || "new-york";
    const account: Account = {
      id: dto._id || id,
      name,
      server: dto.server,
      clientUrl: this.config.metaApiClientUrl || `https://mt-client-api-v1.${region}.${domain}`,
      dataUrl: this.config.metaApiDataUrl || `https://mt-market-data-client-api-v1.${region}.${domain ?? CLIENT_DOMAIN}`,
    };
    if (this.account?.value.id !== account.id) {
      this.symbols = undefined;
      this.specs.clear();
    }
    this.account = { at: Date.now(), value: account };
    return account;
  }

  /* ------------------------ Pause du compte (économies) ------------------------ */

  /** Branche la pause du compte : tant que `gate` rend une raison, aucune demande ne part chez MetaApi. */
  setPauseGate(gate: () => string | undefined) {
    this.pauseGate = gate;
  }

  /** Le compte est en pause (ou se rallume) : les tâches de fond attendent sans rien demander. */
  get paused(): boolean {
    return !!this.pauseGate?.();
  }

  /** L'état du compte chez MetaApi (déployé ou non, connecté au courtier), même en pause. */
  async accountState(): Promise<{ id: string; name: string; state: string; connectionStatus?: string }> {
    const id = this.config.metaApiAccountId || (await this.onlyAccount());
    const dto = await this.get<AccountDto>(
      `${this.config.metaApiProvisioningUrl}/users/current/accounts/${enc(id)}`,
      "compte MetaApi introuvable : vérifie KOPILIA_METAAPI_ACCOUNT_ID dans le fichier .env de Kopilia",
    );
    return { id: dto._id || id, name: dto.name || id, state: dto.state ?? "UNKNOWN", connectionStatus: dto.connectionStatus };
  }

  /**
   * Allume (deploy) ou met en pause (undeploy) le compte chez MetaApi. Le
   * compte n'est jamais supprimé : le rajouter serait refacturé (2,10 $).
   */
  async accountPower(id: string, action: "deploy" | "undeploy"): Promise<void> {
    const res = await this.slot(() =>
      this.fetchImpl(`${this.config.metaApiProvisioningUrl}/users/current/accounts/${enc(id)}/${action}`, {
        method: "POST",
        headers: { "auth-token": this.config.metaApiToken, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    ).catch((e: Error) => {
      throw new MarketError(`MetaApi injoignable (${e.name === "TimeoutError" ? "délai dépassé" : e.message})`);
    });
    if (res.ok) return;
    const message = await res
      .json()
      .then((b) => (b as { message?: unknown })?.message)
      .then((m) => (typeof m === "string" ? m.slice(0, 200) : ""))
      .catch(() => "");
    if (res.status === 401) throw new MarketError("jeton MetaApi refusé : vérifie KOPILIA_METAAPI_TOKEN dans le fichier .env de Kopilia");
    throw new MarketError(
      `MetaApi a refusé ${action === "deploy" ? "le rallumage" : "la mise en pause"} (HTTP ${res.status}${message ? ` : ${message}` : ""})`,
    );
  }

  /** Après un rallumage : le compte est relu (région, adresses), les graphiques gardés oubliés. */
  forgetAccount() {
    this.account = undefined;
    this.chartLoads.clear();
  }

  /** Sans identifiant configuré : le seul compte de l'utilisateur (ou le seul déployé). */
  private async onlyAccount(): Promise<string> {
    const list = await this.get<AccountDto[] | { items?: AccountDto[] }>(`${this.config.metaApiProvisioningUrl}/users/current/accounts`);
    const accounts = (Array.isArray(list) ? list : (list.items ?? [])).filter((a) => a._id);
    const deployed = accounts.filter((a) => a.state === "DEPLOYED");
    const only = accounts.length === 1 ? accounts[0] : deployed.length === 1 ? deployed[0] : undefined;
    if (only) return only._id!;
    if (!accounts.length) throw new MarketError("aucun compte sur MetaApi : ajoute ton compte MetaTrader dans l'interface MetaApi");
    const names = accounts.map((a) => `« ${a.name ?? "sans nom"} » (${a._id})`).join(", ");
    throw new MarketError(`plusieurs comptes MetaApi (${names}) : indique celui à utiliser dans KOPILIA_METAAPI_ACCOUNT_ID, dans le fichier .env de Kopilia`);
  }

  /** Domaine de l'API des cours, comme le SDK MetaApi le lit. */
  private async clientDomain(): Promise<string> {
    const settings = await this.get<{ domain?: string }>(`${this.config.metaApiProvisioningUrl}/users/current/servers/mt-client-api`);
    return settings.domain || CLIENT_DOMAIN;
  }

  private async symbolList(account: Account): Promise<string[]> {
    if (this.symbols && Date.now() - this.symbols.at < SYMBOLS_TTL_MS) return this.symbols.value;
    const list = await this.get<unknown>(`${account.clientUrl}/users/current/accounts/${enc(account.id)}/symbols`);
    if (!Array.isArray(list)) throw new MarketError("liste des symboles du courtier illisible");
    const value = list.filter((s): s is string => typeof s === "string");
    this.symbols = { at: Date.now(), value };
    return value;
  }

  /**
   * GET authentifié ; toute erreur devient un message lisible, sans jamais le
   * jeton. Les ratés passagers de MetaApi (réseau, 5xx, 202 « en préparation »)
   * sont réessayés, comme le fait son SDK : un compte « haute fiabilité » répond
   * parfois 504 le temps de resynchroniser sa connexion au courtier.
   */
  /** Requêtes en cours, et celles qui attendent un créneau (chacune reçoit le créneau de celle qui finit). */
  private activeRequests = 0;
  private readonly waitingRequests: Array<() => void> = [];

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.activeRequests < MAX_CONCURRENT_REQUESTS) this.activeRequests++;
    else await new Promise<void>((resolve) => this.waitingRequests.push(resolve));
    try {
      return await run();
    } finally {
      const next = this.waitingRequests.shift();
      if (next) next();
      else this.activeRequests--;
    }
  }

  /**
   * Après un 504 (« compte pas encore connecté au courtier, ou adresse d'une
   * autre région ») : le compte est relu une fois. Une autre région, la
   * requête suit ; plus connecté du tout, son erreur lisible est gardée.
   */
  private async recheckAccount(url: string): Promise<{ url: string; error?: MarketError }> {
    const before = this.account?.value;
    if (!before || !this.onAccount(url, before) || Date.now() - this.account!.at < this.accountRecheckMs) return { url };
    // Périmé plutôt qu'effacé : même compte, la liste des symboles et les fiches restent en cache.
    this.account = { at: 0, value: before };
    try {
      const after = await this.resolveAccount();
      if (after.id !== before.id) return { url };
      if (url.startsWith(before.dataUrl)) return { url: after.dataUrl + url.slice(before.dataUrl.length) };
      return { url: after.clientUrl + url.slice(before.clientUrl.length) };
    } catch (e) {
      return { url, ...(e instanceof MarketError ? { error: e } : {}) };
    }
  }

  /** Une adresse des API du compte (cours, historique), pas celle de la gestion des comptes. */
  private onAccount(url: string, account = this.account?.value): boolean {
    return !!account && (url.startsWith(account.clientUrl) || url.startsWith(account.dataUrl));
  }

  private async get<T>(url: string, notFound?: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
    let accountError: MarketError | undefined;
    let rechecked = false;
    let failedWith = 0;
    for (let attempt = 0; ; attempt++) {
      const retry = attempt < this.retryDelaysMs.length;
      let res: Response;
      try {
        res = await this.slot(() =>
          this.fetchImpl(url, {
            headers: { "auth-token": this.config.metaApiToken, accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          }),
        );
      } catch (e) {
        const err = e as Error;
        // Un délai dépassé n'est pas réessayé : la voix attendrait deux fois.
        if (err.name === "TimeoutError") {
          this.logger.warn(`MetaApi : délai dépassé sur ${route(url)}`, "market");
          throw new MarketError("MetaApi ne répond pas (délai dépassé)");
        }
        if (retry) {
          await sleep(this.retryDelaysMs[attempt]);
          continue;
        }
        throw new MarketError(`MetaApi injoignable (${err.message})`);
      }
      if (res.ok && res.status !== 202) {
        // Dit si le nouvel essai a fini par passer : sans cette ligne, le journal ne montre que les ratés.
        if (failedWith) this.logger.log(`MetaApi ${failedWith} passé au ${attempt + 1}e essai : ${route(url)}`, "market");
        return (await res.json()) as T;
      }
      const message = await res
        .json()
        .then((b) => (b as { message?: unknown })?.message)
        .then((m) => (typeof m === "string" ? m.slice(0, 200) : ""))
        .catch(() => "");
      const transient = res.status === 202 || res.status >= 500;
      if (transient) {
        failedWith = res.status;
        const wait = retry ? (retryAfter(res) ?? this.retryDelaysMs[attempt]) : 0;
        this.logger.warn(
          `MetaApi ${res.status} sur ${route(url)} (essai ${attempt + 1}/${this.retryDelaysMs.length + 1})${retry ? `, nouvel essai dans ${Math.round(wait / 100) / 10} s` : ""} : ${message || "sans détail"}`,
          "market",
        );
        if (res.status === 504 && !rechecked) {
          rechecked = true;
          ({ url, error: accountError } = await this.recheckAccount(url));
        }
        if (retry) {
          await sleep(wait);
          continue;
        }
        if (accountError) throw accountError;
      }
      // Trop de requêtes : un seul nouvel essai, après l'attente demandée (bornée).
      if (res.status === 429 && attempt === 0 && retry) {
        failedWith = 429;
        this.logger.warn("MetaApi : trop de requêtes, nouvel essai", "market");
        await sleep(retryAfter(res) ?? this.retryDelaysMs[attempt]);
        continue;
      }
      if (res.status === 401) throw new MarketError("jeton MetaApi refusé : vérifie KOPILIA_METAAPI_TOKEN dans le fichier .env de Kopilia");
      if (res.status === 404 && notFound) throw new MarketError(notFound);
      if (res.status === 429) throw new MarketError("trop de requêtes MetaApi : réessaie dans un instant", "rate_limited");
      if (res.status === 504) throw new MarketError(OUTAGE);
      if (transient) throw new MarketError(`MetaApi momentanément indisponible (HTTP ${res.status}) : réessaie dans un instant`);
      throw new MarketError(`MetaApi a répondu ${res.status}${message ? ` (${message})` : ""}`);
    }
  }
}

/**
 * Heure d'une cotation à la seconde, pour la comparer au graphique (le prix
 * bouge d'une seconde à l'autre) : « aujourd'hui à 11:43:04 ».
 */
function quoteTime(at: number, now: Date): string {
  return `${updatedLabel(at, now)}:${String(new Date(at).getSeconds()).padStart(2, "0")}`;
}

/** Délai demandé par MetaApi (en-tête Retry-After), plafonné. */
function retryAfter(res: Response): number | undefined {
  return retryAfterMs(res.headers.get("retry-after"));
}

/**
 * Retry-After en secondes (« 2 ») ou en date HTTP (« Wed, 04 Nov 2026 13:23:40 GMT »,
 * ce que MetaApi envoie avec un 429), en millisecondes plafonnées ; undefined sinon.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header?.trim()) return undefined;
  const s = Number(header);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/** Chemin d'une requête pour le journal, sans l'hôte ni le compte : « /historical-market-data/symbols/NAS100/timeframes/1h/candles ». */
function route(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/users\/current\/accounts\/[^/]+(?=\/)/, "");
  } catch {
    return "?";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Demandes sans doublon ni vide, plafonnées. */
function distinctQueries(queries: string[], max: number): string[] {
  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, max);
}

/** « MetaApi, compte « Compte démo » (Courtier-Demo) » : d'où viennent les chiffres. */
function sourceOf(account: Account): string {
  return `MetaApi, compte « ${account.name} »${account.server ? ` (${account.server})` : ""}`;
}

/** Produit introuvable chez le courtier, avec les symboles proches s'il y en a. */
function notFound(query: string, suggestions: string[]): { query: string; symbol?: undefined; error: string; suggestions?: string[] } {
  return { query, error: "introuvable chez le courtier", ...(suggestions.length ? { suggestions } : {}) };
}

/** Compte en pause : attendu, rien à journaliser. */
function isPaused(e: unknown): boolean {
  return e instanceof MarketError && e.code === "paused";
}

function describe(e: unknown): string {
  return e instanceof MarketError ? e.message : `erreur inattendue (${(e as Error).message})`;
}
