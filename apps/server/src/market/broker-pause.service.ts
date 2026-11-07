import { EventEmitter } from "node:events";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { wakeDurationLabel, type BrokerReason, type BrokerState, type BrokerStatus } from "@kopilia/contracts";
import { ConfigService } from "../config/config.service.js";
import { DatabaseService } from "../db/database.service.js";
import { AppLogger } from "../common/logger.js";
import { TradingService } from "../trading/trading.service.js";
import { MarketService } from "./market.service.js";
import { MarketError } from "./metaapi.js";
import { manualPauseEnd, nextChange, pauseWindow, whenLabel, type PauseRules } from "./broker-schedule.js";

/** Les règles et ce qui doit survivre à une relance du serveur (table trading_settings, clé « broker »). */
interface BrokerSettings {
  weekend?: boolean;
  nights?: boolean;
  /** Pause demandée à la main : jusqu'à cet instant (epoch ms), sauf rallumage. */
  manualUntil?: number;
  /** Durée du dernier rallumage mesuré (ms). */
  wakeMs?: number;
}

/** Une demande refusée (un ticket attend, une position ouverte sans confirmation) : le message est fait pour être dit. */
export class BrokerError extends Error {}

/** Le compte s'est rallumé : en combien de temps, et si l'utilisateur l'avait demandé (Kopilia le lui dit). */
export interface BrokerReady {
  ms: number;
  requested: boolean;
}

/** Vérification de routine, et pendant un changement d'état (MetaApi met une à trois minutes). */
const TICK_MS = 60_000;
const POLL_MS = 5_000;
/** Au-delà, un rallumage est dit en panne (il reste demandé, et retenté). */
const WAKE_TIMEOUT_MS = 10 * 60_000;
/** Raté de lecture du compte : nouvel essai, sans répéter le même message dans le journal. */
const RETRY_MS = 60_000;
const REASON_TEXT: Record<BrokerReason, string> = { weekend: "pour le week-end", night: "pour la nuit", manual: "à ta demande" };

/**
 * Met en pause le compte MetaApi quand il ne sert à rien, et le rallume
 * avant qu'on en ait besoin. MetaApi facture chaque heure où le compte est
 * déployé (0,0126 $ en haute fiabilité, 9,20 $ par mois en continu) ; un
 * compte en pause coûte douze fois moins, et chaque rallumage environ
 * 0,08 $ (six heures et demie allumé). Rien ne change chez le courtier :
 * stops et objectifs y restent.
 *
 * Les règles :
 * - le week-end (vendredi 17 h 05 → dimanche 16 h 30, heure de New York),
 *   même avec une position ouverte (marchés fermés), par défaut ;
 * - la nuit (23 h → 5 h à Paris) en option, sautée tant qu'un trade est en
 *   cours ou en attente ;
 * - jamais pendant qu'un ticket attend sa confirmation ;
 * - dans une fenêtre de pause, le compte attend `brokerIdleMinutes` sans
 *   usage du marché (un prix, un graphique demandés) avant de s'éteindre : il
 *   ne se coupe pas sous les yeux de l'utilisateur ;
 * - à la demande (« mets le courtier en pause ») : dans une fenêtre, jusqu'à
 *   sa fin ; ailleurs, jusqu'au prochain matin de semaine (6 h 30) au plus ;
 * - « rallume le courtier » : allumé tout de suite, puis il se rendort après
 *   le même délai sans usage, s'il est dans une fenêtre.
 *
 * Le serveur vérifie chaque minute, et à son démarrage : un Mac rallumé un
 * lundi à 8 h rallume le compte. Le compte n'est jamais supprimé (le rajouter
 * serait refacturé). Pendant la pause, MarketService répond tout de suite
 * que le courtier dort, sans rien demander à MetaApi.
 */
@Injectable()
export class BrokerPauseService extends EventEmitter<{ status: [BrokerStatus]; ready: [BrokerReady] }> implements OnModuleInit, OnModuleDestroy {
  /** Horloge et cadences ; remplaçables en test. */
  now: () => number = () => Date.now();
  tickMs = TICK_MS;
  pollMs = POLL_MS;
  private timer?: NodeJS.Timeout;
  private state: BrokerState = "off";
  private since = Date.now();
  private reason?: BrokerReason;
  private error?: string;
  /** Le compte ne sert pas à Kopilia (en pause, ou pas encore rallumé) : MarketService ne demande rien. */
  private gated = false;
  /** Dernier usage du marché par l'utilisateur, ou dernier rallumage demandé. */
  private lastUse = 0;
  /**
   * Démarrage du serveur : un compte trouvé allumé dans une fenêtre de pause
   * attend le délai sans usage (l'utilisateur vient peut-être de relancer le
   * serveur en pleine lecture) ; trouvé en pause, il y reste.
   */
  private bootAt = Date.now();
  /** Rallumage en cours : depuis quand, et demandé par l'utilisateur à la voix. */
  private wakeStart = 0;
  private requested = false;
  private running?: Promise<void>;
  private lastLogged = "";
  private lastEmitted = "";
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly market: MarketService,
    private readonly trading: TradingService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  get enabled(): boolean {
    return this.config.brokerPause && this.market.enabled;
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.bootAt = this.now();
    this.since = this.now();
    this.state = "on";
    this.market.setPauseGate(() => (this.gated ? this.gateMessage() : undefined));
    this.schedule(1_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /* ------------------------------- Demandes ------------------------------- */

  /** L'état du compte, tel que l'écran et Kopilia le montrent. */
  status(): BrokerStatus {
    const s = this.settings();
    const rules = this.rules(s);
    const now = this.now();
    const base = { state: this.state, since: this.since, weekend: rules.weekend, nights: rules.nights, ...(s.wakeMs ? { wakeMs: s.wakeMs } : {}) };
    if (!this.enabled) return { ...base, state: "off", label: "" };
    const resumeAt = this.state === "paused" || this.state === "pausing" ? this.resumeAt(now, s) : undefined;
    const sleepsAt = this.state === "on" && pauseWindow(now, rules) ? Math.max(this.lastUse, this.bootAt) + this.idleMs : undefined;
    return {
      ...base,
      ...(this.reason && this.gated ? { reason: this.reason } : {}),
      ...(resumeAt ? { resumeAt } : {}),
      ...(sleepsAt ? { sleepsAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      label: this.label(now, s, resumeAt, sleepsAt),
    };
  }

  /** Un usage du marché par l'utilisateur (un prix, un graphique) : un compte allumé pendant une fenêtre attend encore avant de dormir. */
  touch() {
    if (!this.gated) this.lastUse = this.now();
  }

  /**
   * « Rallume le courtier » : tout de suite, quelle que soit l'heure. Dans une
   * fenêtre de pause, il se rendort après le délai sans usage. `byVoice` :
   * Kopilia dira quand il est prêt.
   */
  async wake(byVoice: boolean): Promise<BrokerStatus> {
    this.requireEnabled();
    const s = this.settings();
    if (s.manualUntil !== undefined) this.save({ ...s, manualUntil: undefined });
    this.lastUse = this.now();
    if (this.gated && byVoice) this.requested = true;
    await this.check();
    return this.status();
  }

  /**
   * « Mets le courtier en pause » : dans une fenêtre, jusqu'à sa fin ; sinon
   * jusqu'au prochain matin de semaine au plus. Refusée pendant qu'un ticket
   * attend ; avec un trade en cours un jour de marché, seulement sur `force`
   * (Kopilia ne le suivrait plus : stop et objectif restent chez le courtier).
   */
  async pause(force = false): Promise<BrokerStatus> {
    this.requireEnabled();
    const now = this.now();
    const s = this.settings();
    const rules = this.rules(s);
    if (this.trading.ticket()) throw new BrokerError("un ticket attend ta confirmation : réponds-lui d'abord, la pause viendra après");
    const window = pauseWindow(now, rules);
    const live = this.trading.liveTrades();
    if (live.length && window !== "weekend" && !force) {
      const names = [...new Set(live.map((t) => t.symbol))].join(", ");
      throw new BrokerError(
        `trade en cours ou en attente (${names}) : en pause, Kopilia ne le suit plus (stop et objectif restent chez le courtier). Redemande avec force si tu le veux quand même`,
      );
    }
    this.lastUse = 0;
    this.bootAt = 0;
    this.save({ ...s, manualUntil: manualPauseEnd(now, rules) });
    await this.check();
    return this.status();
  }

  /** Les règles : pause du week-end, pause de nuit. */
  async setRules(change: { weekend?: boolean; nights?: boolean }): Promise<BrokerStatus> {
    this.requireEnabled();
    const s = this.settings();
    this.save({
      ...s,
      ...(change.weekend !== undefined ? { weekend: change.weekend } : {}),
      ...(change.nights !== undefined ? { nights: change.nights } : {}),
    });
    await this.check();
    return this.status();
  }

  /** Allumé pendant une fenêtre de pause : l'utilisateur pourrait le remettre en pause une fois fini. */
  awakeInWindow(): boolean {
    return this.enabled && this.state === "on" && pauseWindow(this.now(), this.rules(this.settings())) !== undefined;
  }

  /** Vérifie tout de suite (après celle en cours, s'il y en a une), puis reprend la cadence (plus serrée pendant un changement). */
  async check(): Promise<void> {
    while (this.running) await this.running;
    this.running = this.reconcile()
      .catch((e: Error) => this.log(`pause du compte MetaApi : ${e.message}`, true))
      .finally(() => {
        this.running = undefined;
        this.emitStatus();
      });
    await this.running;
    this.schedule();
  }

  /* ------------------------------- Le cœur ------------------------------- */

  private get idleMs(): number {
    return this.config.brokerIdleMinutes * 60_000;
  }

  /** Ce qu'il faudrait maintenant : en pause (et pourquoi) ou allumé ; `deployed` : le compte est allumé chez MetaApi. */
  private wanted(now: number, s: BrokerSettings, deployed: boolean): { pause: false } | { pause: true; reason: BrokerReason } {
    if (s.manualUntil && s.manualUntil > now) return { pause: true, reason: "manual" };
    const window = pauseWindow(now, this.rules(s));
    if (!window) return { pause: false };
    // Un ticket attend sa confirmation : on ne coupe pas sous ses yeux.
    if (this.trading.ticket()) return { pause: false };
    // La nuit, un trade en cours ou en attente garde le compte allumé (le week-end, les marchés sont fermés).
    if (window === "night" && this.trading.liveTrades().length) return { pause: false };
    if (now < this.lastUse + this.idleMs) return { pause: false };
    if (deployed && now < this.bootAt + this.idleMs) return { pause: false };
    return { pause: true, reason: window };
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    let s = this.settings();
    if (s.manualUntil !== undefined && s.manualUntil <= now) {
      s = { ...s, manualUntil: undefined };
      this.save(s);
    }
    let account: Awaited<ReturnType<MarketService["accountState"]>>;
    try {
      account = await this.market.accountState();
    } catch (e) {
      const message = e instanceof MarketError ? e.message : (e as Error).message;
      this.log(`pause du compte MetaApi : état illisible (${message})`, true);
      // Rien de sûr : un état de transition garde son erreur, l'état stable ne bouge pas.
      if (this.state === "waking" || this.state === "pausing") this.error = message;
      return;
    }
    const st = account.state;
    const want = this.wanted(now, s, st === "DEPLOYED" || st === "DEPLOYING");
    try {
      if (want.pause) {
        if (st === "DEPLOYED" || st === "DEPLOYING") {
          if (this.state !== "pausing") this.log(`pause du compte MetaApi « ${account.name} » (${REASON_TEXT[want.reason]})`);
          this.enter("pausing", want.reason);
          if (st === "DEPLOYED") await this.market.accountPower(account.id, "undeploy");
        } else if (st === "UNDEPLOYING") {
          this.enter("pausing", want.reason);
        } else if (st === "UNDEPLOYED") {
          if (this.state !== "paused") this.log(`compte MetaApi « ${account.name} » en pause (${REASON_TEXT[want.reason]})`);
          this.enter("paused", want.reason);
        } else {
          this.fail(`état inattendu du compte MetaApi : ${st}`);
        }
        return;
      }
      if (st === "UNDEPLOYED") {
        if (this.state !== "waking") this.log(`rallumage du compte MetaApi « ${account.name} »`);
        this.enter("waking");
        await this.market.accountPower(account.id, "deploy");
      } else if (st === "DEPLOYING" || st === "UNDEPLOYING") {
        this.enter("waking");
      } else if (st === "DEPLOYED") {
        if (this.state === "waking" && account.connectionStatus && account.connectionStatus !== "CONNECTED") {
          // Déployé, pas encore connecté au courtier : encore un instant.
          if (now - this.wakeStart > WAKE_TIMEOUT_MS)
            this.fail(`le compte ne se connecte pas au courtier (${account.connectionStatus}) : regarde l'interface MetaApi`, false);
          return;
        }
        this.ready(now, s);
      } else {
        this.fail(`état inattendu du compte MetaApi : ${st}`);
      }
      if (this.state === "waking" && now - this.wakeStart > WAKE_TIMEOUT_MS) this.fail("le compte ne se rallume pas : regarde l'interface MetaApi");
    } catch (e) {
      this.fail(e instanceof MarketError ? e.message : (e as Error).message);
    }
  }

  /** Passe dans un état de pause ou de rallumage : MarketService se tait, les cotations aussi. */
  private enter(state: "pausing" | "paused" | "waking", reason?: BrokerReason) {
    const changed = this.state !== state || (reason !== undefined && this.reason !== reason);
    if (state === "waking" && this.state !== "waking") this.wakeStart = this.now();
    if (this.state !== state) this.since = this.now();
    this.state = state;
    if (reason) this.reason = reason;
    this.error = undefined;
    if (!this.gated) {
      this.gated = true;
      this.market.feed.suspend();
    }
    if (changed) this.emitStatus();
  }

  /** Le compte est déployé et connecté : tout reprend. */
  private ready(now: number, s: BrokerSettings) {
    const wasGated = this.gated;
    const waking = this.state === "waking";
    if (this.state === "on" && !wasGated) return;
    const ms = waking ? now - this.wakeStart : 0;
    this.state = "on";
    this.since = now;
    this.reason = undefined;
    this.error = undefined;
    this.gated = false;
    this.lastUse = Math.max(this.lastUse, now);
    if (waking && ms > 0) this.save({ ...s, wakeMs: Math.round(ms) });
    this.market.forgetAccount();
    this.market.feed.resume();
    this.log(`compte MetaApi rallumé${waking ? ` en ${wakeDurationLabel(ms)}` : ""}`);
    this.emitStatus();
    if (waking) this.emit("ready", { ms, requested: this.requested });
    this.requested = false;
  }

  /** Une demande à MetaApi a échoué : dit, retenté au prochain tour. Sans `gate`, le compte sert quand même (il est déployé). */
  private fail(message: string, gate = this.gated) {
    this.log(`pause du compte MetaApi : ${message}`, true);
    const changed = this.state !== "error" || this.error !== message;
    if (this.state !== "error") this.since = this.now();
    this.state = "error";
    this.error = message;
    if (!gate && this.gated) {
      this.gated = false;
      this.market.feed.resume();
    }
    if (changed) this.emitStatus();
  }

  private schedule(delay?: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const transitional = this.state === "waking" || this.state === "pausing";
    this.timer = setTimeout(() => void this.check(), delay ?? (transitional ? this.pollMs : this.state === "error" ? RETRY_MS : this.tickMs));
    this.timer.unref();
  }

  /* ------------------------------- Textes ------------------------------- */

  /** Ce que MarketService répond à toute demande tant que le compte ne sert pas. */
  private gateMessage(): string {
    const now = this.now();
    if (this.state === "waking") {
      const usual = this.settings().wakeMs;
      return `le courtier se rallume (depuis ${wakeDurationLabel(now - this.wakeStart)}${usual ? `, d'habitude ${wakeDurationLabel(usual)}` : ", une à trois minutes"}) : réessaie dans un instant`;
    }
    if (this.state === "pausing") return "le courtier se met en pause : dis « rallume le courtier » pour le garder";
    const s = this.settings();
    const resumeAt = this.resumeAt(now, s);
    const why = this.reason ? REASON_TEXT[this.reason] : "";
    return `le courtier est en pause${why ? ` ${why}` : ""}${resumeAt ? ` (reprise ${whenLabel(resumeAt, now)})` : ""} : dis « rallume le courtier »`;
  }

  private label(now: number, s: BrokerSettings, resumeAt?: number, sleepsAt?: number): string {
    switch (this.state) {
      case "on":
        return sleepsAt ? `Allumé · se rendort ${whenLabel(Math.max(sleepsAt, now), now)} sans usage` : "Allumé";
      case "pausing":
        return "Mise en pause…";
      case "paused":
        return `En pause${this.reason ? ` ${REASON_TEXT[this.reason]}` : ""}${resumeAt ? ` · reprise ${whenLabel(resumeAt, now)}` : ""}`;
      case "waking":
        return `Rallumage…${s.wakeMs ? ` d'habitude ${wakeDurationLabel(s.wakeMs)}` : " une à trois minutes"}`;
      case "error":
        return `Courtier : ${this.error ?? "erreur"}`;
      default:
        return "";
    }
  }

  /** Quand la pause en cours finit d'elle-même. */
  private resumeAt(now: number, s: BrokerSettings): number | undefined {
    if (this.reason === "manual" && s.manualUntil) return s.manualUntil;
    const rules = this.rules(s);
    return pauseWindow(now, rules) ? nextChange(now, rules) : undefined;
  }

  /* ------------------------------- Rangement ------------------------------- */

  private rules(s: BrokerSettings): PauseRules {
    return { weekend: s.weekend ?? true, nights: s.nights ?? false };
  }

  settings(): BrokerSettings {
    const row = this.db.db.prepare("SELECT value FROM trading_settings WHERE key = 'broker'").get() as { value: string } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.value) as BrokerSettings;
    } catch {
      return {};
    }
  }

  private save(s: BrokerSettings) {
    const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
    this.db.db
      .prepare(
        "INSERT INTO trading_settings (key, value, updated_at) VALUES ('broker', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(clean), this.now());
  }

  private requireEnabled() {
    if (!this.market.enabled) throw new BrokerError("MetaApi n'est pas configuré : il manque le jeton dans le fichier .env de Kopilia");
    if (!this.config.brokerPause) throw new BrokerError("la pause du compte est coupée sur ce serveur (KOPILIA_BROKER_PAUSE=0)");
  }

  /** L'état aux écrans, seulement s'il a changé (ce qui est affiché compris). */
  private emitStatus() {
    const status = this.status();
    const key = JSON.stringify({ ...status, since: 0 });
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.emit("status", status);
  }

  /** Une ligne au journal ; un raté qui se répète n'y est écrit qu'une fois. */
  private log(message: string, warn = false) {
    if (warn) {
      if (message === this.lastLogged) return;
      this.lastLogged = message;
      this.logger.warn(message, "market");
      return;
    }
    this.lastLogged = "";
    this.logger.log(message, "market");
  }
}
