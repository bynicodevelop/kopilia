import { EventEmitter } from "node:events";
import { AppLogger } from "../common/logger.js";
import type { MarketError } from "./metaapi.js";

/** Cotation brute d'un symbole exact du courtier. */
export interface RawQuote {
  bid: number;
  ask?: number;
  /** Instant de la cotation (epoch ms). */
  time: number;
  digits?: number;
}

/** Cotation diffusée aux écrans, avec l'ouverture de la journée du courtier. */
export interface Quote extends RawQuote {
  symbol: string;
  dayOpen?: number;
}

/**
 * Plus haut et plus bas de la bougie d'une minute en cours (début en epoch ms) :
 * une mèche plus brève que l'intervalle des cotations y laisse sa trace.
 */
export interface MinuteRange {
  start: number;
  high: number;
  low: number;
}

/**
 * Cotations poussées en continu (MetaApi, par WebSocket). Le flux des encarts
 * n'interroge que les produits qu'elles ne couvrent pas.
 */
export interface PriceStream {
  /** Les produits dont recevoir les cotations (vide : plus aucun). */
  watch(symbols: string[]): void;
  on(event: "price", listener: (symbol: string, quote: RawQuote) => void): unknown;
  on(event: "range", listener: (symbol: string, range: MinuteRange) => void): unknown;
  stop(): void;
  /** Compte en pause : plus de connexion, plus d'essai. */
  pause?(): void;
  /** Compte rallumé : reconnexion tout de suite. */
  resume?(): void;
}

/** Au-delà, le marché est fermé ou à l'arrêt : on interroge moins souvent. */
const STALE_MS = 5 * 60_000;
/** Sans cotation poussée depuis ce délai, un produit est de nouveau interrogé (flux coupé, marché calme ou fermé). */
const STREAM_QUIET_MS = 15_000;
/** L'ouverture du jour est relue de temps en temps (la journée du courtier change à 23 h). */
const DAY_OPEN_TTL_MS = 30 * 60_000;
/** MetaApi refuse (trop de requêtes) : pause avant de reprendre. */
const RATE_LIMIT_PAUSE_MS = 30_000;
/** Ratés d'affilée d'un produit avant d'espacer ses interrogations (symbole retiré, compte en préparation…). */
const FAILURES_BEFORE_BACKOFF = 3;

/**
 * Cotations en direct : des produits affichés à l'écran (graphiques, suivi),
 * tant qu'un écran est connecté et qu'un encart les montre, et des produits
 * qui ont une alerte, toujours. Poussées par MetaApi (WebSocket) quand le flux
 * `stream` est là, sinon interrogées à cadence fixe, moins souvent marché
 * fermé. Un produit dont le flux ne dit plus rien est interrogé, le temps
 * qu'il reprenne. Émet `quote` à chaque changement, et `range` (les extrêmes
 * de la minute, poussés seulement). Les appels MetaApi sont fournis par
 * MarketService (jeton, compte, réessais) : ce module ne connaît que des symboles.
 */
export class QuoteFeed extends EventEmitter<{ quote: [Quote]; range: [string, MinuteRange] }> {
  /** Cadence d'interrogation marché ouvert ; remplaçable en test. */
  intervalMs = 2_000;
  closedIntervalMs = 15_000;
  /** Horloge (fraîcheur des cotations, pauses) ; remplaçable en test. */
  now: () => number = () => Date.now();
  /** Produits des encarts affichés, et produits qui ont une alerte. */
  private symbols: string[] = [];
  private alertSymbols: string[] = [];
  /** Écrans connectés (le nom « listeners » appartient à EventEmitter). */
  private screens = 0;
  private timer?: NodeJS.Timeout;
  private running = false;
  private pauseUntil = 0;
  private readonly last = new Map<string, Quote>();
  /** Dernière cotation poussée et dernière interrogation, par produit. */
  private readonly streamedAt = new Map<string, number>();
  private readonly polledAt = new Map<string, number>();
  /** Décimales de chaque produit (fiche relue à l'interrogation ; les cotations poussées n'en ont pas). */
  private readonly digits = new Map<string, number>();
  private readonly dayOpens = new Map<string, { at: number; value?: number }>();
  /** Ouvertures du jour en cours de lecture (une à la fois par produit). */
  private readonly dayOpenReads = new Map<string, Promise<number | undefined>>();
  /** Dernier raté signalé par symbole : le même n'est pas répété à chaque tour. */
  private readonly lastError = new Map<string, string>();
  /** Ratés d'affilée par produit, et le moment où il sera de nouveau interrogé. */
  private readonly failures = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  /** Un produit a été ajouté pendant une interrogation : la suivante part tout de suite. */
  private urgent = false;
  /** Compte MetaApi en pause : rien n'est interrogé ; les dernières cotations restent connues. */
  private suspended = false;

  constructor(
    private readonly quote: (symbol: string) => Promise<RawQuote>,
    private readonly dayOpen: (symbol: string) => Promise<number | undefined>,
    private readonly logger: AppLogger,
    private readonly stream?: PriceStream,
  ) {
    super();
    stream?.on("price", (symbol, quote) => this.onStreamed(symbol, quote));
    stream?.on("range", (symbol, range) => {
      if (this.watched.includes(symbol)) this.emit("range", symbol, range);
    });
  }

  /** Les symboles des encarts affichés. Un nouveau est interrogé tout de suite. */
  setSymbols(symbols: string[]): void {
    this.follow(() => (this.symbols = [...new Set(symbols.filter(Boolean))]));
  }

  /** Les symboles qui ont une alerte : suivis même sans écran. */
  setAlertSymbols(symbols: string[]): void {
    this.follow(() => (this.alertSymbols = [...new Set(symbols.filter(Boolean))]));
  }

  /** Écrans connectés : sans aucun, seuls les produits des alertes restent suivis. */
  setListening(count: number): void {
    this.follow(() => (this.screens = count));
  }

  /** Dernière cotation connue de chaque produit affiché (pour un écran qui arrive). */
  snapshot(): Quote[] {
    return this.symbols.map((s) => this.last.get(s)).filter((q): q is Quote => q !== undefined);
  }

  /** Dernière cotation connue d'un produit suivi. */
  latest(symbol: string): Quote | undefined {
    return this.last.get(symbol);
  }

  /** Un produit affiché, à montrer aux écrans (ceux des seules alertes ne les regardent pas). */
  shows(symbol: string): boolean {
    return this.symbols.includes(symbol);
  }

  /** Ce qui est suivi : les produits affichés tant qu'un écran les regarde, et ceux des alertes. */
  private get watched(): string[] {
    return [...new Set([...(this.screens > 0 ? this.symbols : []), ...this.alertSymbols])];
  }

  private get active(): boolean {
    return !this.suspended && this.watched.length > 0;
  }

  /** Compte en pause : plus d'interrogation ni de flux poussé, jusqu'à `resume`. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.clear();
    this.stream?.pause?.();
  }

  /** Compte rallumé : les produits suivis sont interrogés tout de suite, le flux poussé se rouvre. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.failures.clear();
    this.retryAt.clear();
    this.lastError.clear();
    this.pauseUntil = 0;
    this.stream?.resume?.();
    this.stream?.watch(this.watched);
    this.schedule(0);
  }

  /**
   * Applique un changement de ce qui est suivi : un produit qui ne l'est plus
   * oublie ce qu'on savait de lui ; un nouveau est interrogé tout de suite.
   */
  private follow(change: () => void) {
    const before = this.watched;
    change();
    const after = this.watched;
    for (const s of before) {
      if (after.includes(s)) continue;
      this.last.delete(s);
      this.streamedAt.delete(s);
      this.polledAt.delete(s);
      this.digits.delete(s);
      this.dayOpens.delete(s);
      this.lastError.delete(s);
      this.failures.delete(s);
      this.retryAt.delete(s);
    }
    const added = after.some((s) => !before.includes(s));
    // Pendant une interrogation, le prochain passage serait reprogrammé à la cadence normale à sa fin.
    if (added && this.running) this.urgent = true;
    if (!after.length) this.clear();
    else if (added || after.length !== before.length) this.schedule(added ? 0 : undefined);
    this.stream?.watch(after);
  }

  /** Affiché à un écran : son ouverture du jour sert (la variation du jour s'en calcule). */
  private displayed(symbol: string): boolean {
    return this.screens > 0 && this.symbols.includes(symbol);
  }

  stop(): void {
    this.clear();
    this.screens = 0;
    this.stream?.stop();
  }

  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay?: number) {
    this.clear();
    if (!this.active) return;
    this.timer = setTimeout(() => void this.tick(), delay ?? this.delay());
    this.timer.unref();
  }

  /** Marché fermé (toutes les cotations anciennes) ou MetaApi saturé : on attend plus. */
  private delay(): number {
    const now = this.now();
    if (now < this.pauseUntil) return this.pauseUntil - now;
    const watched = this.watched;
    const quotes = watched.map((s) => this.last.get(s)).filter((q): q is Quote => q !== undefined);
    const closed = quotes.length === watched.length && quotes.every((q) => now - q.time > STALE_MS);
    return closed ? this.closedIntervalMs : this.intervalMs;
  }

  private async tick() {
    if (this.running || !this.active) return;
    this.running = true;
    try {
      const now = this.now();
      await Promise.all(this.watched.filter((s) => this.due(s, now)).map((s) => this.poll(s)));
    } finally {
      this.running = false;
      const urgent = this.urgent;
      this.urgent = false;
      this.schedule(urgent ? 0 : undefined);
    }
  }

  /** À interroger maintenant : ni couvert par le flux poussé, ni en attente après des ratés ; marché fermé, moins souvent. */
  private due(symbol: string, now: number): boolean {
    if ((this.retryAt.get(symbol) ?? 0) > now) return false;
    if (now - (this.streamedAt.get(symbol) ?? -Infinity) < STREAM_QUIET_MS) return false;
    const last = this.last.get(symbol);
    const closed = last !== undefined && now - last.time > STALE_MS;
    return !closed || now - (this.polledAt.get(symbol) ?? -Infinity) >= this.closedIntervalMs;
  }

  /** Une cotation poussée par MetaApi : diffusée comme une interrogée. */
  private onStreamed(symbol: string, raw: RawQuote) {
    if (!this.watched.includes(symbol)) return;
    this.streamedAt.set(symbol, this.now());
    const known = this.dayOpens.get(symbol);
    if (this.displayed(symbol) && (!known || this.now() - known.at >= DAY_OPEN_TTL_MS)) void this.readDayOpen(symbol);
    this.publish(symbol, raw, known?.value);
  }

  private async poll(symbol: string) {
    this.polledAt.set(symbol, this.now());
    try {
      const known = this.dayOpens.get(symbol);
      // L'ouverture du jour ne sert qu'à l'écran : un produit des seules alertes s'en passe.
      const fresh = (known && this.now() - known.at < DAY_OPEN_TTL_MS) || !this.displayed(symbol);
      const [raw, dayOpen] = await Promise.all([this.quote(symbol), fresh ? Promise.resolve(known?.value) : this.readDayOpen(symbol)]);
      if (!this.watched.includes(symbol)) return; // encart fermé ou alerte retirée pendant l'appel
      this.lastError.delete(symbol);
      this.failures.delete(symbol);
      this.retryAt.delete(symbol);
      this.publish(symbol, raw, dayOpen);
    } catch (e) {
      const message = (e as Error).message;
      if ((e as Partial<MarketError>).code === "rate_limited") this.pauseUntil = this.now() + RATE_LIMIT_PAUSE_MS;
      // Erreur qui dure (symbole retiré, compte pas encore déployé) : ce produit est
      // interrogé de moins en moins souvent, jusqu'à la cadence « marché fermé ».
      const n = (this.failures.get(symbol) ?? 0) + 1;
      this.failures.set(symbol, n);
      if (n >= FAILURES_BEFORE_BACKOFF) {
        this.retryAt.set(symbol, this.now() + Math.min(this.intervalMs * 2 ** (n - FAILURES_BEFORE_BACKOFF + 1), this.closedIntervalMs));
      }
      if (this.lastError.get(symbol) !== message) {
        this.lastError.set(symbol, message);
        this.logger.warn(`cotation ${symbol} indisponible : ${message}`, "market");
      }
    }
  }

  /**
   * Diffuse la cotation si elle change quelque chose. Plus ancienne que la
   * dernière (une interrogation lente, dépassée par le flux poussé), elle ne
   * garde que ce qu'elle apporte de neuf : décimales, ouverture du jour.
   */
  private publish(symbol: string, raw: RawQuote, dayOpen?: number) {
    if (raw.digits !== undefined) this.digits.set(symbol, raw.digits);
    const prev = this.last.get(symbol);
    const price = prev && raw.time < prev.time ? prev : raw;
    const digits = this.digits.get(symbol);
    const open = dayOpen ?? prev?.dayOpen;
    const q: Quote = {
      symbol,
      bid: price.bid,
      ...(price.ask !== undefined ? { ask: price.ask } : {}),
      time: price.time,
      ...(digits !== undefined ? { digits } : {}),
      ...(open !== undefined ? { dayOpen: open } : {}),
    };
    if (prev && prev.bid === q.bid && prev.ask === q.ask && prev.time === q.time && prev.digits === q.digits && prev.dayOpen === q.dayOpen) return;
    this.last.set(symbol, q);
    this.emit("quote", q);
  }

  /** Ouverture de la journée du courtier, relue au plus une fois à la fois ; un raté garde la précédente. */
  private readDayOpen(symbol: string): Promise<number | undefined> {
    const pending = this.dayOpenReads.get(symbol);
    if (pending) return pending;
    const known = this.dayOpens.get(symbol);
    const read = this.dayOpen(symbol)
      .then(
        (value) => {
          if (this.watched.includes(symbol)) this.dayOpens.set(symbol, { at: this.now(), value });
          return value;
        },
        () => known?.value, // l'ouverture du jour est un plus : sans elle, le prix passe quand même
      )
      .finally(() => this.dayOpenReads.delete(symbol));
    this.dayOpenReads.set(symbol, read);
    return read;
  }
}
