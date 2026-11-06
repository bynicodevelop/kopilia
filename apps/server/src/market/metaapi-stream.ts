import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { AppLogger } from "../common/logger.js";
import type { MinuteRange, PriceStream, RawQuote } from "./quote-feed.js";

/** Cadence demandée à MetaApi pour les cotations d'un produit, et pour sa bougie d'une minute (ms). */
const QUOTE_INTERVAL_MS = 500;
/** Attente de la synchronisation du compte à l'ouverture (s) ; mesurée à 5 s sur un compte démo. */
const SYNC_TIMEOUT_S = 60;

/* Ce que le flux utilise du SDK MetaApi, chargé à la première utilisation (une demi-seconde). */

interface SdkPrice {
  symbol: string;
  bid?: number;
  ask?: number;
  time?: Date | string;
}

interface SdkCandle {
  symbol: string;
  timeframe: string;
  time?: Date | string;
  high?: number;
  low?: number;
}

interface StreamingConnection {
  addSynchronizationListener(listener: object): void;
  connect(): Promise<void>;
  waitSynchronized(opts: { timeoutInSeconds: number }): Promise<void>;
  subscribeToMarketData(symbol: string, subscriptions: object[], timeoutInSeconds?: number, waitForQuote?: boolean): Promise<unknown>;
  unsubscribeFromMarketData(symbol: string, unsubscriptions: object[]): Promise<unknown>;
  close(): Promise<void>;
}

interface MetaApiClient {
  metatraderAccountApi: {
    getAccount(id: string): Promise<{ getStreamingConnection(historyStorage?: unknown, historyStartTime?: Date): StreamingConnection }>;
  };
  close(): void;
}

export interface MetaApiSdk {
  MetaApi: new (token: string) => MetaApiClient;
  SynchronizationListener: new () => object;
}

/**
 * Cotations poussées par MetaApi sur sa connexion WebSocket, par son SDK
 * officiel : une connexion au compte, ouverte à la première demande puis
 * gardée, et un abonnement par produit suivi (ses cotations, et sa bougie d'une
 * minute, dont le plus haut et le plus bas gardent les mèches plus brèves que
 * l'intervalle des cotations : les alertes s'en servent). Le SDK se reconnecte
 * et renouvelle les abonnements de lui-même ; une connexion ratée est retentée
 * de plus en plus tard. Le flux des encarts (QuoteFeed) interroge en attendant.
 */
export class MetaApiStream extends EventEmitter<{ price: [string, RawQuote]; range: [string, MinuteRange] }> implements PriceStream {
  /** Attente avant de retenter une connexion ratée, de plus en plus longue (ms) ; remplaçable en test. */
  retryMs = [15_000, 30_000, 60_000, 120_000, 300_000];
  private wanted: string[] = [];
  private readonly subscribed = new Set<string>();
  /** Produits refusés par MetaApi (pas de fiche) : pas redemandés tant qu'ils restent suivis. */
  private readonly refused = new Set<string>();
  /** Instances du compte connectées (deux en « haute fiabilité ») : aucune, le flux est coupé. */
  private readonly links = new Set<string>();
  private api?: MetaApiClient;
  private conn?: StreamingConnection;
  private running = false;
  private again = false;
  private failures = 0;
  private lastError = "";
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly token: string,
    /** Le compte MetaApi, déployé et connecté au courtier (sinon une erreur lisible). */
    private readonly accountId: () => Promise<string>,
    private readonly logger: AppLogger,
    /** Remplaçable en test. */
    private readonly load: () => MetaApiSdk = loadSdk,
  ) {
    super();
  }

  /** Les produits dont recevoir les cotations ; la connexion s'ouvre à la première demande. */
  watch(symbols: string[]): void {
    this.wanted = [...new Set(symbols)];
    for (const s of this.refused) if (!this.wanted.includes(s)) this.refused.delete(s);
    void this.sync();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.reset();
  }

  /** Met les abonnements d'accord avec les produits suivis ; une demande arrivée en route est traitée à la suite. */
  private async sync(): Promise<void> {
    if (this.stopped || this.retryTimer) return; // en attente d'un nouvel essai : il reprendra la liste du moment
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        if (!this.wanted.length && !this.subscribed.size) break;
        const conn = await this.connection();
        for (const s of [...this.subscribed]) {
          if (this.wanted.includes(s)) continue;
          this.subscribed.delete(s);
          // Raté : au pire, des cotations d'un produit qui n'est plus suivi, ignorées par QuoteFeed.
          await conn.unsubscribeFromMarketData(s, [{ type: "quotes" }, { type: "candles" }]).catch(() => {});
        }
        for (const s of this.wanted) {
          if (this.subscribed.has(s) || this.refused.has(s)) continue;
          try {
            // Sans attendre la première cotation : marché fermé, elle ne viendrait pas.
            await conn.subscribeToMarketData(s, [{ type: "quotes", intervalInMilliseconds: QUOTE_INTERVAL_MS }], undefined, false);
            this.subscribed.add(s);
          } catch (e) {
            if ((e as Error).name !== "ValidationError") throw e;
            this.refused.add(s);
            this.logger.warn(`MetaApi : pas de flux pour ${s} (${this.describe(e)}) ; ses cotations sont demandées une à une`, "market");
            continue;
          }
          // La bougie d'une minute est un plus : refusée, les cotations suffisent.
          await conn
            .subscribeToMarketData(s, [{ type: "candles", timeframe: "1m", intervalInMilliseconds: QUOTE_INTERVAL_MS }], undefined, false)
            .catch((e: unknown) => this.logger.warn(`MetaApi : pas de bougie minute pour ${s} (${this.describe(e)})`, "market"));
        }
      } while (this.again && !this.stopped);
      this.failures = 0;
      this.lastError = "";
    } catch (e) {
      this.fail(e);
    } finally {
      this.running = false;
    }
  }

  /** La connexion au compte, synchronisée ; ouverte au premier appel. */
  private async connection(): Promise<StreamingConnection> {
    if (this.conn) return this.conn;
    const sdk = this.load();
    const id = await this.accountId();
    const api = new sdk.MetaApi(this.token);
    let conn: StreamingConnection | undefined;
    try {
      const account = await api.metatraderAccountApi.getAccount(id);
      // Historique des ordres et des transactions à partir de maintenant : seuls les prix servent.
      conn = account.getStreamingConnection(undefined, new Date());
      conn.addSynchronizationListener(this.listener(sdk));
      await conn.connect();
      await conn.waitSynchronized({ timeoutInSeconds: SYNC_TIMEOUT_S });
      if (this.stopped) throw new Error("arrêt du serveur");
    } catch (e) {
      void closeQuietly(conn, api);
      throw e;
    }
    this.api = api;
    this.conn = conn;
    this.logger.log("MetaApi : flux de cotations ouvert (WebSocket)", "market");
    return conn;
  }

  /** Ce que le SDK signale au flux : chaque cotation, et les coupures de la connexion. */
  private listener(sdk: MetaApiSdk): object {
    const onPrice = (p: SdkPrice) => this.onPrice(p);
    const onCandles = (candles: SdkCandle[]) => this.onCandles(candles);
    const onLink = (instance: string, up: boolean) => this.onLink(instance, up);
    const logger = this.logger;
    return new (class extends sdk.SynchronizationListener {
      async onSymbolPriceUpdated(_instance: string, price: SdkPrice) {
        onPrice(price);
      }
      async onCandlesUpdated(_instance: string, candles: SdkCandle[]) {
        onCandles(candles);
      }
      async onConnected(instance: string) {
        onLink(instance, true);
      }
      async onDisconnected(instance: string) {
        onLink(instance, false);
      }
      async onSubscriptionDowngraded(_instance: string, symbol: string) {
        logger.warn(`MetaApi : flux de ${symbol} ralenti (trop de données pour le compte)`, "market");
      }
    })();
  }

  private onPrice(p: SdkPrice) {
    // Suivi, même si son abonnement n'a pas encore répondu : la première cotation peut le devancer.
    if (!this.wanted.includes(p.symbol) || typeof p.bid !== "number") return;
    const at = p.time instanceof Date ? p.time.getTime() : Date.parse(p.time ?? "");
    this.emit("price", p.symbol, {
      bid: p.bid,
      ...(typeof p.ask === "number" ? { ask: p.ask } : {}),
      time: Number.isFinite(at) ? at : Date.now(),
    });
  }

  /** La bougie d'une minute en cours : ses extrêmes. */
  private onCandles(candles: SdkCandle[]) {
    for (const c of candles ?? []) {
      if (c.timeframe !== "1m" || !this.wanted.includes(c.symbol) || typeof c.high !== "number" || typeof c.low !== "number") continue;
      const start = c.time instanceof Date ? c.time.getTime() : Date.parse(c.time ?? "");
      if (Number.isFinite(start)) this.emit("range", c.symbol, { start, high: c.high, low: c.low });
    }
  }

  private onLink(instance: string, up: boolean) {
    const had = this.links.size > 0;
    if (up) this.links.add(instance);
    else this.links.delete(instance);
    if (!this.conn) return; // ouverture en cours : elle se signale elle-même
    if (had && !this.links.size) this.logger.warn("MetaApi : flux de cotations coupé, reconnexion…", "market");
    else if (!had && this.links.size) this.logger.log("MetaApi : flux de cotations rétabli", "market");
  }

  /** Connexion ou abonnement ratés : tout est refermé, et retenté plus tard. */
  private fail(e: unknown) {
    const message = this.describe(e);
    const delay = this.retryMs[Math.min(this.failures, this.retryMs.length - 1)];
    this.failures++;
    if (message !== this.lastError) {
      this.lastError = message;
      this.logger.warn(`MetaApi : flux de cotations indisponible (${message}) ; cotations demandées une à une, nouvel essai dans ${delay / 1000} s`, "market");
    }
    this.reset();
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync();
    }, delay);
    this.retryTimer.unref();
  }

  private reset() {
    const { conn, api } = this;
    this.conn = undefined;
    this.api = undefined;
    this.subscribed.clear();
    this.links.clear();
    void closeQuietly(conn, api);
  }

  /** Le message d'une erreur, sans jamais le jeton. */
  private describe(e: unknown): string {
    const message = e instanceof Error ? e.message || e.name : String(e);
    return message.split(this.token).join("…");
  }
}

async function closeQuietly(conn?: StreamingConnection, api?: MetaApiClient) {
  try {
    await conn?.close();
  } catch {
    /* déjà fermée */
  }
  try {
    api?.close();
  } catch {
    /* déjà fermé */
  }
}

/** Le SDK MetaApi (version Node), silencieux : le flux journalise lui-même ce qui compte. */
function loadSdk(): MetaApiSdk {
  const require = createRequire(import.meta.url);
  const sdk = require("metaapi.cloud-sdk") as { default: MetaApiSdk["MetaApi"]; SynchronizationListener: MetaApiSdk["SynchronizationListener"] };
  // Sans log4js installé, ses journaux ne vont nulle part (sinon, sur la console, hors du format de Kopilia).
  (require("metaapi.cloud-sdk/dist/logger") as { default: { useLog4js(): void } }).default.useLog4js();
  return { MetaApi: sdk.default, SynchronizationListener: sdk.SynchronizationListener };
}
