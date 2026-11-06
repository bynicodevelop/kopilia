import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  ALERT_CONDITIONS,
  ALERT_TRIGGERS,
  Alert,
  AlertCondition,
  AlertTrigger,
  Drawing,
  MAX_AI_ALERTS,
  MAX_ALERTS,
  MAX_ALERT_MESSAGE,
  alertSchema,
  alertTargetSchema,
  barPosition,
  ContactVerdict,
  contactVerdict,
  defaultCondition,
  fibLevelPrice,
  fibRatioLabel,
  fibRatios,
  trendlinePrice,
} from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { DatabaseService } from "../db/database.service.js";
import { DashboardError, DrawingService } from "../dashboard/drawing.service.js";
import { MarketService, Product } from "../market/market.service.js";
import type { MinuteRange, Quote } from "../market/quote-feed.js";
import { CHART_TIMEFRAMES, ChartTimeframe, MONTHLY, isChartTimeframe, TIMEFRAME_SECONDS } from "../market/timeframes.js";
import { Band, Direction, Side, bandCrossing, bandSide, barStart, wants } from "./crossing.js";

/** Les déclenchements que Kopilia n'a pas dits depuis plus longtemps sont oubliés. */
const NEWS_MS = 24 * 3_600_000;
/** Une alerte déclenchée ou expirée depuis plus longtemps est retirée au démarrage. */
const PURGE_MS = 30 * 86_400_000;
/** Bougies d'une unité relues au plus une fois par ce délai (nouvelle bougie, raté). */
const CLOCK_RETRY_MS = 30_000;
const CLOCK_MAX_BARS = 1000;
/** Les échéances sont vérifiées à ce rythme (une alerte échue ne part déjà plus : voir activeOn). */
const EXPIRY_TICK_MS = 30_000;
/** Une clôture que le courtier n'a pas rendue (coupure) est redemandée à la cotation suivante, au plus à ce rythme. */
const CLOSE_RETRY_MS = 15_000;
/** Bougies closes rattrapées au plus d'un coup après une longue coupure (les plus récentes). */
const CLOSE_MAX_BARS = 20;

interface RuleRow {
  id: string;
  kind: "price" | "drawing" | "band";
  symbol: string;
  drawing_id: string | null;
  spec: string;
  state: Alert["state"];
  side: number | null;
  created_by: Alert["createdBy"];
  created_at: number;
  updated_at: number;
  triggered_at: number | null;
  triggered_price: number | null;
  scenario_id: string | null;
  expires_at: number | null;
}

/** Ce que garde la colonne spec : le produit, le prix d'une alerte de prix (les bornes d'une bande), les réglages. */
interface RuleSpec {
  name: string;
  digits?: number;
  price?: number;
  top?: number;
  bottom?: number;
  /** Alerte sur une ligne : la forme de la ligne d'après laquelle elle est armée (lineKey). */
  line?: string;
  /** Alerte sur un Fibonacci : le ratio du niveau surveillé. */
  level?: number;
  condition: AlertCondition;
  trigger: AlertTrigger;
  timeframe: string;
  message?: string;
}

/** Les réglages d'une alerte, tels qu'on les demande (ce qui manque garde sa valeur). */
export interface AlertSettings {
  condition?: string;
  trigger?: string;
  timeframe?: string;
  /** null : retire la consigne. */
  message?: string | null;
}

/**
 * Ce qu'on donne pour poser une alerte : un prix (`{kind: "price", price}`), un
 * tracé (`{kind: "drawing", drawingId}`, avec `level` pour un niveau d'un
 * Fibonacci) ou une bande (`{kind: "band", top, bottom}`).
 */
export interface AlertInput extends AlertSettings {
  target: unknown;
  /** Réservés aux services internes : le scénario d'une alerte de l'IA, et son échéance (epoch ms). */
  scenarioId?: string;
  expiresAt?: number;
}

/** Ce qu'on change : réglages, prix (alerte de prix) ou bornes (bande), échéance, suspendue ou réactivée. */
export interface AlertPatch extends AlertSettings {
  price?: number;
  band?: { top: number; bottom: number };
  expiresAt?: number;
  state?: "active" | "paused";
}

/** Un déclenchement : l'alerte (à jour), et ce qui s'est passé. */
export interface AlertFired {
  alert: Alert;
  /** La ligne suivie, telle qu'elle était (alerte sur un tracé). */
  drawing?: Drawing;
  eventId: string;
  direction: Direction;
  /** Le prix qui a franchi (la clôture, pour une alerte sur clôture) et le niveau à ce moment (le bord atteint, pour une zone). */
  price: number;
  level: number;
  /** Instant (epoch ms). */
  at: number;
  /** Franchie pendant que le serveur était arrêté : constaté au premier prix de son retour. */
  whileAway?: boolean;
  /** Une mèche entre deux cotations : le plus haut ou le plus bas de la minute. */
  wick?: boolean;
  /** Une bougie close de l'autre côté. */
  close?: boolean;
  /**
   * À la clôture après contact : la bougie qui a touché, close (début en
   * epoch s, ouverture, plus haut, plus bas, clôture), et ce qu'elle montre ;
   * `touchPrice` : le prix au contact. `level` est le bord touché.
   */
  candle?: { t: number; o: number; h: number; l: number; c: number };
  verdict?: ContactVerdict;
  touchPrice?: number;
}

/** Où en est la surveillance d'une alerte active. */
interface Watch {
  /** Côté du prix par rapport au niveau ; null : pas encore connu. */
  side: Side | null;
  /** Depuis quand (epoch ms) le prix est de ce côté ; 0 : depuis avant le démarrage. */
  since: number;
  /** Côté repris de la base : un franchissement au premier prix a eu lieu pendant l'arrêt. */
  restored: boolean;
  /** Alerte sur clôture : la bougie en cours (début, epoch s). */
  bar?: number;
  /** Alerte sur clôture : début de la plus ancienne bougie close pas encore jugée (sa clôture n'a pas pu être lue). */
  due?: number;
  /** Une lecture de clôture est en cours ; une ratée n'est pas redemandée avant `retryAt` (epoch ms). */
  closing?: boolean;
  retryAt?: number;
  /**
   * À la clôture après contact : le contact a eu lieu dans la bougie qui
   * commence à `bar` (epoch s) ; l'alerte part à sa clôture. Gardé en mémoire :
   * après un redémarrage, l'alerte attend un nouveau contact.
   */
  touch?: { bar: number; dir: Direction; level: number; price: number; at: number };
}

/** Les débuts des bougies d'une unité de temps, pour calculer une oblique et reconnaître une bougie. */
interface Clock {
  times: number[];
  /** L'instant le plus ancien demandé (epoch s). */
  from: number;
  /** Dernier chargement, réussi ou non (epoch ms). */
  at: number;
  loading: boolean;
}

/**
 * Les alertes du graphique : à un prix, sur un tracé (ligne horizontale,
 * oblique, zone, niveau d'un Fibonacci) ou sur une bande de prix. Gardées en base (monitoring_rules),
 * surveillées sur les cotations du flux, même sans écran (il suit les
 * produits qui en ont). Une alerte retient de quel côté du niveau (de la zone)
 * est le prix, et part quand il le touche en venant de l'autre côté : à chaque
 * cotation, sur une mèche entre deux cotations (extrêmes de la minute), ou à
 * la clôture d'une bougie. Une oblique se calcule comme sur le graphique, en
 * position de bougie, dans l'unité où l'alerte a été posée. Chaque
 * déclenchement est noté (monitoring_events, une fois par bougie au plus)
 * jusqu'à ce que Kopilia l'ait dit. Les alertes de l'IA (rattachées à un
 * scénario) ont une échéance et leur propre plafond. Émet `changed` (le
 * symbole) et `triggered`.
 */
@Injectable()
export class AlertService extends EventEmitter<{ changed: [string]; triggered: [AlertFired] }> implements OnModuleInit {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();
  private readonly watches = new Map<string, Watch>();
  private readonly clocks = new Map<string, Clock>();
  /** Dernière bougie d'une minute reçue de chaque produit, et quand. */
  private readonly ranges = new Map<string, MinuteRange & { at: number }>();
  /** Alertes actives par produit, relues après chaque changement. */
  private active?: Map<string, Alert[]>;
  /** Lignes suivies, relues quand un tracé change. */
  private readonly lines = new Map<string, Drawing | undefined>();
  private ticker?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly market: MarketService,
    private readonly drawings: DrawingService,
    private readonly logger: AppLogger,
  ) {
    super();
    drawings.on("changed", (symbol) => this.followDrawings(symbol));
    market.feed.on("quote", (q) => this.onQuote(q));
    market.feed.on("range", (symbol, r) => this.onRange(symbol, r));
  }

  /** Au démarrage : les vieilles alertes arrêtées sont retirées, le flux suit les produits des autres ; puis les échéances. */
  onModuleInit() {
    this.db.db
      .prepare("DELETE FROM monitoring_rules WHERE state IN ('triggered', 'expired') AND COALESCE(triggered_at, updated_at) < ?")
      .run(this.now() - PURGE_MS);
    this.expireDue();
    this.followFeed();
    this.ticker = setInterval(() => this.expireDue(), EXPIRY_TICK_MS);
    this.ticker.unref();
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
  }

  /** Les alertes de ces produits (de tous sans liste), les plus anciennes d'abord. */
  list(symbols?: string[]): Alert[] {
    if (symbols && !symbols.length) return [];
    const rows = symbols
      ? (this.db.db
          .prepare(`SELECT * FROM monitoring_rules WHERE symbol IN (${symbols.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
          .all(...symbols) as RuleRow[])
      : (this.db.db.prepare("SELECT * FROM monitoring_rules ORDER BY created_at, rowid").all() as RuleRow[]);
    return this.readable(rows);
  }

  get(id: string): Alert | undefined {
    const row = this.db.db.prepare("SELECT * FROM monitoring_rules WHERE id = ?").get(id.trim()) as RuleRow | undefined;
    return row ? this.readable([row])[0] : undefined;
  }

  /**
   * L'alerte de l'utilisateur sur un tracé, ou sur ce niveau d'un Fibonacci
   * (une au plus ; l'IA peut en poser d'autres pour ses scénarios).
   */
  ofDrawing(drawingId: string, level?: number): Alert | undefined {
    const rows = this.db.db.prepare("SELECT * FROM monitoring_rules WHERE drawing_id = ? AND scenario_id IS NULL").all(drawingId) as RuleRow[];
    return this.readable(rows).find((a) => a.target.kind === "drawing" && a.target.level === level);
  }

  /** Les alertes d'un scénario (posées par l'IA), les plus anciennes d'abord. */
  ofScenario(scenarioId: string): Alert[] {
    return this.readable(this.db.db.prepare("SELECT * FROM monitoring_rules WHERE scenario_id = ? ORDER BY created_at, rowid").all(scenarioId) as RuleRow[]);
  }

  /** Retire les alertes d'un scénario (abandonné, expiré, clos). */
  removeScenario(scenarioId: string): Alert[] {
    return this.remove(this.ofScenario(scenarioId).map((a) => a.id));
  }

  /**
   * Une alerte sur ce produit. Sans condition, une alerte de prix attend la
   * hausse s'il est au-dessus du cours, la baisse sinon ; une ligne ou une
   * zone, les deux sens. Une seule fois, en 15 minutes, par défaut. Une alerte
   * de l'IA (rattachée à un scénario) a toujours une échéance, et son propre
   * plafond : elle ne prend pas la place de celles de l'utilisateur.
   */
  create(product: Product, input: AlertInput, by: Alert["createdBy"]): Alert {
    const target = this.checkTarget(product.symbol, input.target);
    const scenarioId = input.scenarioId?.trim() || undefined;
    // Un niveau de l'IA part avec son dossier : l'utilisateur le garde d'abord pour y mettre son alerte.
    if (target.kind === "drawing" && !scenarioId && target.line.createdBy === "ia")
      throw new DashboardError("c'est un niveau de l'IA, qui part avec son dossier : garde-le d'abord (il devient le tien) pour y mettre une alerte");
    if (target.kind === "drawing" && !scenarioId) {
      const existing = this.ofDrawing(target.drawingId, target.level);
      if (existing) throw new DashboardError(`${target.level !== undefined ? "ce niveau" : "ce tracé"} a déjà une alerte (${existing.id}) : modifie-la plutôt`);
    }
    const now = this.now();
    if (scenarioId && !(input.expiresAt && input.expiresAt > now)) throw new DashboardError("une alerte de l'IA a toujours une échéance, dans le futur");
    if (input.expiresAt !== undefined && !(Number.isFinite(input.expiresAt) && input.expiresAt > now)) {
      throw new DashboardError("l'échéance d'une alerte est dans le futur");
    }
    const { n } = this.db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM monitoring_rules WHERE symbol = ? AND state IN ('active', 'paused') AND scenario_id IS ${scenarioId ? "NOT NULL" : "NULL"}`,
      )
      .get(product.symbol) as { n: number };
    if (scenarioId && n >= MAX_AI_ALERTS)
      throw new DashboardError(`${MAX_AI_ALERTS} alertes de l'IA au plus sur un produit : retires-en une d'un autre scénario d'abord`);
    if (!scenarioId && n >= MAX_ALERTS) throw new DashboardError(`${MAX_ALERTS} alertes au plus sur un produit : retires-en d'abord`);
    const condition = target.kind === "price" ? defaultCondition(target.price, this.market.feed.latest(product.symbol)?.bid) : "cross";
    const spec: RuleSpec = {
      name: product.name,
      ...(product.digits !== undefined ? { digits: product.digits } : {}),
      ...(target.kind === "price"
        ? { price: target.price }
        : target.kind === "band"
          ? { top: target.top, bottom: target.bottom }
          : { line: lineKey(target.line), ...(target.level !== undefined ? { level: target.level } : {}) }),
      ...settingsOf(input, { condition, trigger: "once", timeframe: "15m" }),
    };
    const id = `a_${randomBytes(3).toString("hex")}`;
    this.db.db
      .prepare(
        `INSERT INTO monitoring_rules (id, kind, symbol, drawing_id, spec, state, side, created_by, created_at, updated_at, scenario_id, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        target.kind,
        product.symbol,
        target.kind === "drawing" ? target.drawingId : null,
        JSON.stringify(spec),
        by,
        now,
        now,
        scenarioId ?? null,
        input.expiresAt ?? null,
      );
    this.active = undefined;
    const alert = this.get(id)!;
    this.arm(alert);
    this.changed(product.symbol);
    return alert;
  }

  /**
   * Règle une alerte, la suspend ou la réactive. Une alerte arrêtée
   * (déclenchée, expirée) qu'on règle repart ; une alerte qui repart, ou dont
   * le niveau change, est réarmée depuis le prix du moment.
   */
  update(id: string, patch: AlertPatch): Alert {
    const row = this.db.db.prepare("SELECT * FROM monitoring_rules WHERE id = ?").get(id.trim()) as RuleRow | undefined;
    const current = row && this.readable([row])[0];
    if (!row || !current) throw new DashboardError(`aucune alerte « ${id} »`);
    const spec = JSON.parse(row.spec) as RuleSpec;
    if (patch.price !== undefined) {
      if (current.target.kind !== "price") throw new DashboardError("cette alerte suit un tracé ou une bande : change son tracé ou ses bornes");
      if (!(Number.isFinite(patch.price) && patch.price > 0)) throw new DashboardError("le prix d'une alerte est un nombre positif");
    }
    if (patch.band !== undefined) {
      if (current.target.kind !== "band") throw new DashboardError("seule une alerte sur une bande de prix a des bornes");
      checkBand(patch.band.top, patch.band.bottom);
    }
    if (patch.expiresAt !== undefined && !(Number.isFinite(patch.expiresAt) && patch.expiresAt > this.now())) {
      throw new DashboardError("l'échéance d'une alerte est dans le futur");
    }
    const settings = settingsOf(patch, spec);
    const next: RuleSpec = {
      name: spec.name,
      ...(spec.digits !== undefined ? { digits: spec.digits } : {}),
      ...(spec.price !== undefined ? { price: patch.price ?? spec.price } : {}),
      ...(spec.top !== undefined ? { top: patch.band?.top ?? spec.top, bottom: patch.band?.bottom ?? spec.bottom } : {}),
      ...(spec.line !== undefined ? { line: spec.line } : {}),
      ...(spec.level !== undefined ? { level: spec.level } : {}),
      ...settings,
    };
    const expiresAt = patch.expiresAt ?? row.expires_at;
    const reset = JSON.stringify(next) !== row.spec || expiresAt !== row.expires_at;
    let state = current.state;
    if (patch.state === "paused") state = "paused";
    else if (patch.state === "active" || (reset && (state === "triggered" || state === "expired"))) state = "active";
    if (state === "active" && current.target.kind === "drawing") {
      const d = this.drawings.get(current.target.drawingId);
      const problem = d ? unwatchable(d, this.now()) : "sa ligne a été effacée";
      if (problem) throw new DashboardError(problem);
    }
    const rearm = state === "active" && (state !== current.state || reset);
    if (!reset && state === current.state) return current;
    this.db.db
      .prepare("UPDATE monitoring_rules SET spec = ?, state = ?, expires_at = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?")
      .run(JSON.stringify(next), state, expiresAt, rearm ? 1 : 0, this.armedAt(current), current.id);
    this.active = undefined;
    const updated = this.get(current.id)!;
    if (rearm) this.arm(updated);
    else if (state !== "active") this.watches.delete(current.id);
    this.changed(current.symbol);
    return updated;
  }

  /** Retire ces alertes ; renvoie celles qui existaient. */
  remove(ids: string[]): Alert[] {
    const found = ids.map((id) => this.get(id)).filter((a): a is Alert => a !== undefined);
    if (!found.length) return [];
    const del = this.db.db.prepare("DELETE FROM monitoring_rules WHERE id = ?");
    this.db.tx(() => {
      for (const a of found) del.run(a.id);
    });
    for (const a of found) this.watches.delete(a.id);
    this.active = undefined;
    for (const symbol of new Set(found.map((a) => a.symbol))) this.changed(symbol);
    return found;
  }

  /** Retire toutes les alertes de l'utilisateur sur un produit (celles de l'IA partent avec leur scénario). */
  clear(symbol: string): Alert[] {
    return this.remove(
      this.list([symbol])
        .filter((a) => !a.scenarioId)
        .map((a) => a.id),
    );
  }

  /**
   * Les alertes dont l'échéance est passée expirent (surveillées ou
   * suspendues) ; renvoie celles-là.
   */
  expireDue(): Alert[] {
    const rows = this.db.db
      .prepare("SELECT * FROM monitoring_rules WHERE state IN ('active', 'paused') AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(this.now()) as RuleRow[];
    if (!rows.length) return [];
    const done = this.db.db.prepare("UPDATE monitoring_rules SET state = 'expired' WHERE id = ?");
    this.db.tx(() => {
      for (const r of rows) done.run(r.id);
    });
    for (const r of rows) this.watches.delete(r.id);
    this.active = undefined;
    for (const symbol of new Set(rows.map((r) => r.symbol))) this.changed(symbol);
    const expired = this.readable(rows);
    this.logger.log(`${rows.length} alerte(s) arrivée(s) à échéance`, "alerts");
    return expired.map((a) => ({ ...a, state: "expired" as const }));
  }

  /** Le tracé que suit une alerte (undefined : alerte de prix ou de bande, ou tracé effacé). */
  lineOf(a: Alert): Drawing | undefined {
    return a.target.kind === "drawing" ? this.drawings.get(a.target.drawingId) : undefined;
  }

  /**
   * Les déclenchements que Kopilia n'a pas encore dits, des dernières 24 h, les
   * plus anciens d'abord (dix au plus) ; les plus vieux sont oubliés.
   */
  undelivered(): AlertFired[] {
    this.db.db.prepare("UPDATE monitoring_events SET delivered = 1 WHERE delivered = 0 AND occurred_at < ?").run(this.now() - NEWS_MS);
    const rows = this.db.db
      .prepare("SELECT id, rule_id, occurred_at, payload FROM monitoring_events WHERE delivered = 0 ORDER BY occurred_at LIMIT 10")
      .all() as Array<{ id: string; rule_id: string; occurred_at: number; payload: string }>;
    const out: AlertFired[] = [];
    for (const r of rows) {
      const alert = this.get(r.rule_id);
      if (!alert) continue;
      const payload = JSON.parse(r.payload) as Omit<AlertFired, "alert" | "eventId" | "at" | "drawing">;
      const drawing = this.lineOf(alert);
      out.push({ ...payload, alert, eventId: r.id, at: r.occurred_at, ...(drawing ? { drawing } : {}) });
    }
    return out;
  }

  /** Kopilia les a dits. */
  markDelivered(eventIds: string[]): void {
    const mark = this.db.db.prepare("UPDATE monitoring_events SET delivered = 1 WHERE id = ?");
    this.db.tx(() => {
      for (const id of eventIds) mark.run(id);
    });
  }

  /* ----------------------------- Surveillance ----------------------------- */

  private onQuote(q: Quote) {
    for (const a of this.activeOn(q.symbol)) {
      try {
        this.check(a, q.bid, q.time);
      } catch (e) {
        this.logger.warn(`alerte ${a.id} : ${(e as Error).message}`, "alerts");
      }
    }
  }

  /** Une cotation : le prix a-t-il changé de côté ? */
  private check(a: Alert, price: number, at: number) {
    const w = this.watch(a);
    if (a.trigger === "close") return this.checkBar(a, w, price, at);
    if (a.trigger === "touch_close" && w.touch) return this.checkTouchClose(a, w, at);
    if (a.trigger === "bar" || a.trigger === "touch_close") this.clock(a.symbol, a.timeframe, at / 1000 - 3 * tfSeconds(a.timeframe));
    const band = this.bandOf(a, at / 1000);
    if (band === "ended") return this.expire(a);
    if (band === undefined) return;
    const away = w.restored;
    w.restored = false;
    const dir = bandCrossing(w.side, price, band);
    if (dir && wants(a.condition, dir)) this.reach(a, w, { direction: dir, price, level: edge(band, dir), at, ...(away ? { whileAway: true } : {}) });
    this.setSide(a.id, w, bandSide(price, band), at);
  }

  /**
   * Le niveau est atteint : l'alerte part, sauf à la clôture après contact,
   * où elle note la bougie du contact et attend sa clôture.
   */
  private reach(a: Alert, w: Watch, f: Omit<AlertFired, "alert" | "eventId" | "drawing">) {
    if (a.trigger !== "touch_close") return this.fire(a, f);
    if (w.touch) return;
    const tf = tfSeconds(a.timeframe);
    const bar = barStart(this.clocks.get(clockKey(a.symbol, a.timeframe))?.times ?? [], Math.floor(f.at / 1000), tf);
    w.touch = { bar, dir: f.direction, level: f.level, price: f.price, at: f.at };
    this.logger.log(`alerte ${a.id} (${a.symbol}) : contact à ${f.price}, elle attend la clôture de la bougie ${a.timeframe}`, "alerts");
  }

  /**
   * Clôture après contact : à la première cotation d'une bougie suivante, la
   * bougie du contact est relue chez le courtier (sa clôture exacte), puis
   * l'alerte part avec elle. Une lecture ratée est redemandée.
   */
  private checkTouchClose(a: Alert, w: Watch, at: number) {
    const tf = tfSeconds(a.timeframe);
    const { times } = this.clock(a.symbol, a.timeframe, at / 1000 - 3 * tf);
    const touch = w.touch!;
    if (barStart(times, Math.floor(at / 1000), tf) <= touch.bar) return;
    if (w.closing || (w.retryAt !== undefined && at < w.retryAt)) return;
    w.closing = true;
    void this.closeTouch(a.id, touch)
      .then((done) => {
        if (done) w.retryAt = undefined;
        else w.retryAt = at + CLOSE_RETRY_MS;
      })
      .catch((e: unknown) => {
        w.retryAt = at + CLOSE_RETRY_MS;
        this.logger.warn(`alerte ${a.id} : bougie du contact illisible (${(e as Error).message})`, "alerts");
      })
      .finally(() => (w.closing = false));
  }

  /** Lit la bougie du contact, close, et fait partir l'alerte avec elle ; false si le courtier ne l'a pas rendue. */
  private async closeTouch(id: string, touch: NonNullable<Watch["touch"]>): Promise<boolean> {
    const before = this.get(id);
    if (!before || before.state !== "active") return true;
    const tf = tfSeconds(before.timeframe);
    const back = Math.min(CLOSE_MAX_BARS, Math.max(1, Math.ceil((this.now() / 1000 - touch.bar) / tf)));
    const r = await this.market.chartCandles(before.symbol, before.timeframe as ChartTimeframe, { limit: back + 2 });
    if ("error" in r) {
      this.logger.warn(`alerte ${id} : bougie du contact de ${before.symbol} ${before.timeframe} pas encore lue (${r.error}) ; redemandée`, "alerts");
      return false;
    }
    const candle = r.candles.find((c) => c.t === touch.bar) ?? r.candles.filter((c) => c.t <= touch.bar).at(-1);
    if (!candle) return false;
    const a = this.get(id);
    if (!a || a.state !== "active") return true;
    const w = this.watch(a);
    const band = this.bandOf(a, candle.t + tf - 1);
    const zone = typeof band === "object" ? band : { lo: touch.level, hi: touch.level };
    const verdict = contactVerdict(candle.c, zone.lo, zone.hi, touch.dir);
    w.touch = undefined;
    this.fire(
      a,
      {
        direction: touch.dir,
        price: candle.c,
        level: touch.level,
        at: (candle.t + tf) * 1000,
        close: true,
        candle: { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c },
        verdict,
        touchPrice: touch.price,
      },
      candle.t,
    );
    return true;
  }

  /**
   * Alerte sur clôture : seule la clôture d'une bougie compte. À la première
   * cotation d'une nouvelle bougie, la précédente est relue chez le courtier
   * (clôture exacte), puis comparée au niveau à sa fin. Une clôture que le
   * courtier n'a pas rendue (coupure) reste due : redemandée aux cotations
   * suivantes, puis jugée dans l'ordre avec celles qui ont clôturé entre-temps,
   * pour qu'aucune bougie ne soit sautée.
   */
  private checkBar(a: Alert, w: Watch, price: number, at: number) {
    const tf = tfSeconds(a.timeframe);
    const { times } = this.clock(a.symbol, a.timeframe, at / 1000 - 3 * tf);
    const bar = barStart(times, Math.floor(at / 1000), tf);
    w.restored = false;
    if (w.side === null) {
      const band = this.bandOf(a, at / 1000);
      if (typeof band === "object") this.setSide(a.id, w, bandSide(price, band), at);
    }
    if (w.bar === undefined || bar < w.bar) {
      w.bar = bar;
      return;
    }
    if (bar > w.bar) {
      w.due ??= w.bar;
      w.bar = bar;
    }
    if (w.due === undefined || w.closing || (w.retryAt !== undefined && at < w.retryAt)) return;
    w.closing = true;
    void this.closeBars(a.id, w.due, bar)
      .then((done) => {
        if (done) {
          w.due = undefined;
          w.retryAt = undefined;
        } else w.retryAt = at + CLOSE_RETRY_MS;
      })
      .catch((e: unknown) => {
        w.retryAt = at + CLOSE_RETRY_MS;
        this.logger.warn(`alerte ${a.id} : clôture illisible (${(e as Error).message})`, "alerts");
      })
      .finally(() => (w.closing = false));
  }

  /**
   * Juge, dans l'ordre, les bougies closes de `from` (début de la plus
   * ancienne) jusqu'à celle qui commence à `next` (exclue) ; false si le
   * courtier ne les a pas rendues (à redemander).
   */
  private async closeBars(id: string, from: number, next: number): Promise<boolean> {
    const before = this.get(id);
    if (!before) return true;
    const tf = tfSeconds(before.timeframe);
    const missed = Math.min(CLOSE_MAX_BARS, Math.max(1, Math.ceil((next - from) / tf)));
    const r = await this.market.chartCandles(before.symbol, before.timeframe as ChartTimeframe, { limit: missed + 2 });
    if ("error" in r) {
      this.logger.warn(`alerte ${id} : clôture de ${before.symbol} ${before.timeframe} pas encore lue (${r.error}) ; redemandée`, "alerts");
      return false;
    }
    // Les bougies closes depuis la plus ancienne due, jusqu'à celle qui vient de clôturer.
    const closed = r.candles.filter((c) => c.t >= from && c.t < next).slice(-CLOSE_MAX_BARS);
    for (const candle of closed) {
      const a = this.get(id);
      if (!a || a.state !== "active") return true;
      const w = this.watch(a);
      const band = this.bandOf(a, candle.t + tf - 1);
      if (band === "ended") {
        this.expire(a);
        return true;
      }
      if (band === undefined) continue;
      const dir = bandCrossing(w.side, candle.c, band);
      if (dir && wants(a.condition, dir))
        this.fire(a, { direction: dir, price: candle.c, level: edge(band, dir), at: (candle.t + tf) * 1000, close: true }, candle.t);
      this.setSide(a.id, w, bandSide(candle.c, band), this.now());
    }
    return true;
  }

  /**
   * Les extrêmes de la minute en cours : un plus haut (ou un plus bas) qui
   * dépasse le précédent est un prix atteint entre deux cotations. Il ne
   * compte que si le prix est resté du même côté depuis le début de
   * l'intervalle qu'il couvre (sinon, les cotations ont déjà jugé).
   */
  private onRange(symbol: string, r: MinuteRange) {
    const prev = this.ranges.get(symbol);
    const now = this.now();
    this.ranges.set(symbol, { ...r, at: now });
    const same = prev?.start === r.start;
    const from = same ? prev.at : r.start;
    const high = !same || r.high > prev.high ? r.high : undefined;
    const low = !same || r.low < prev.low ? r.low : undefined;
    if (high === undefined && low === undefined) return;
    for (const a of this.activeOn(symbol)) {
      if (a.trigger === "close") continue;
      const w = this.watch(a);
      if (w.touch) continue; // contact déjà noté : la clôture est attendue
      if (w.side === null || w.restored || w.since > from) continue;
      const band = this.bandOf(a, now / 1000);
      if (typeof band !== "object") continue;
      const dir: Direction | undefined =
        w.side === -1 && high !== undefined && high >= band.lo ? "up" : w.side === 1 && low !== undefined && low <= band.hi ? "down" : undefined;
      if (!dir) continue;
      if (wants(a.condition, dir)) this.reach(a, w, { direction: dir, price: dir === "up" ? high! : low!, level: edge(band, dir), at: now, wick: true });
      // Revenu entre deux cotations : le prix est là où dit la dernière.
      const last = this.market.feed.latest(symbol)?.bid;
      this.setSide(a.id, w, last !== undefined ? bandSide(last, band) : 0, now);
    }
  }

  /** Note le déclenchement (une fois par alerte armée, ou par bougie), arrête une alerte « une seule fois », et le signale. */
  private fire(a: Alert, f: Omit<AlertFired, "alert" | "eventId" | "drawing">, bar?: number) {
    const tf = tfSeconds(a.timeframe);
    const start = bar ?? barStart(this.clocks.get(clockKey(a.symbol, a.timeframe))?.times ?? [], Math.floor(f.at / 1000), tf);
    // À la clôture après contact, comme « une seule fois » : elle part, puis s'arrête.
    const single = a.trigger === "once" || a.trigger === "touch_close";
    const occurrence = single ? `once:${a.updatedAt}` : `${a.trigger}:${start}`;
    const eventId = `ae_${randomBytes(4).toString("hex")}`;
    const { at, ...payload } = f;
    const inserted = this.db.db
      .prepare("INSERT OR IGNORE INTO monitoring_events (id, rule_id, occurrence, occurred_at, payload) VALUES (?, ?, ?, ?, ?)")
      .run(eventId, a.id, occurrence, at, JSON.stringify(payload));
    if (!inserted.changes) return;
    this.db.db
      .prepare("UPDATE monitoring_rules SET triggered_at = ?, triggered_price = ?, state = CASE WHEN ? THEN 'triggered' ELSE state END WHERE id = ?")
      .run(at, f.price, single ? 1 : 0, a.id);
    this.active = undefined;
    const alert = this.get(a.id) ?? a;
    if (alert.state !== "active") this.watches.delete(a.id);
    const drawing = this.lineOf(alert);
    this.logger.log(`alerte ${a.id} (${a.symbol}) : ${f.direction === "up" ? "hausse" : "baisse"} à ${f.price} (niveau ${f.level})`, "alerts");
    this.emit("triggered", { ...f, alert, eventId, ...(drawing ? { drawing } : {}) });
    this.changed(a.symbol);
  }

  /** Une oblique non prolongée ou une zone bornée qui s'arrête : son alerte n'a plus de niveau. */
  private expire(a: Alert) {
    this.db.db.prepare("UPDATE monitoring_rules SET state = 'expired' WHERE id = ? AND state = 'active'").run(a.id);
    this.watches.delete(a.id);
    this.active = undefined;
    this.logger.log(`alerte ${a.id} (${a.symbol}) expirée : son tracé s'arrête`, "alerts");
    this.changed(a.symbol);
  }

  /**
   * Ce que surveille une alerte à l'instant `t` (epoch s) : son prix, celui de
   * sa ligne horizontale, de son niveau de Fibonacci ou de son oblique à cette
   * position de bougie (bas et haut égaux), ou les bornes de sa zone (tracée
   * ou bande) ; « ended » quand
   * l'oblique ou la zone s'arrête avant, undefined si on ne le sait pas encore
   * (bougies en chargement) ou plus (tracé effacé).
   */
  private bandOf(a: Alert, t: number): Band | "ended" | undefined {
    const level = (v: number): Band => ({ lo: v, hi: v });
    if (a.target.kind === "price") return level(a.target.price);
    if (a.target.kind === "band") return { lo: a.target.bottom, hi: a.target.top };
    const d = this.line(a.target.drawingId);
    if (!d) return undefined;
    if (d.kind === "hline") return level(d.price);
    if (d.kind === "zone") {
      if (d.to !== undefined && t > d.to) return "ended";
      return { lo: Math.min(d.top, d.bottom), hi: Math.max(d.top, d.bottom) };
    }
    // Un niveau d'un Fibonacci : un prix, suivi même au-delà de ses points (un retracement s'arrête toujours dans le passé).
    if (d.kind === "fib" || d.kind === "fibext") {
      const v = a.target.kind === "drawing" ? fibLevelPrice(d, a.target.level) : undefined;
      return v === undefined ? undefined : level(v);
    }
    // Une boîte de trade ne porte pas d'alerte (refusée à la pose).
    if (d.kind === "position") return undefined;
    if (d.a.t === d.b.t) return undefined;
    const tf = tfSeconds(a.timeframe);
    const { times } = this.clock(a.symbol, a.timeframe, Math.min(d.a.t, d.b.t));
    if (!times.length) return undefined;
    const xa = barPosition(times, d.a.t, tf);
    const xb = barPosition(times, d.b.t, tf);
    const x = barPosition(times, t, tf);
    const v = trendlinePrice(d, xa, xb, x);
    if (v === undefined && !d.extend && x > Math.max(xa, xb)) return "ended";
    return v === undefined ? undefined : level(v);
  }

  /**
   * Les débuts des bougies d'un produit dans une unité, depuis `from` (epoch s) :
   * relus chez le courtier quand il en faut de plus anciennes ou qu'une nouvelle
   * bougie a dû commencer (au plus toutes les 30 s). En attendant, la liste connue.
   */
  private clock(symbol: string, timeframe: string, from: number): Clock {
    const key = clockKey(symbol, timeframe);
    let c = this.clocks.get(key);
    if (!c) {
      c = { times: [], from: Infinity, at: 0, loading: false };
      this.clocks.set(key, c);
    }
    const last = c.times.at(-1);
    const due = !c.times.length || from < c.from || (last !== undefined && this.now() / 1000 >= last + tfSeconds(timeframe));
    if (due && !c.loading && this.now() - c.at >= CLOCK_RETRY_MS) void this.loadClock(c, symbol, timeframe, Math.min(from, c.from));
    return c;
  }

  private async loadClock(c: Clock, symbol: string, timeframe: string, from: number) {
    c.loading = true;
    try {
      const tf = tfSeconds(timeframe);
      const bars = Math.ceil((this.now() / 1000 - from) / tf) + 10;
      const r = await this.market.chartCandles(symbol, timeframe as ChartTimeframe, { limit: Math.min(CLOCK_MAX_BARS, Math.max(50, bars)) });
      if ("error" in r) this.logger.warn(`alertes ${symbol} : bougies ${timeframe} indisponibles (${r.error})`, "alerts");
      else if (r.candles.length) c.times = r.candles.map((k) => k.t);
      c.from = Math.min(c.from, from);
    } finally {
      c.loading = false;
      c.at = this.now();
    }
  }

  /** La surveillance d'une alerte : son côté repris de la base s'il y en a un. */
  private watch(a: Alert): Watch {
    let w = this.watches.get(a.id);
    if (!w) {
      const row = this.db.db.prepare("SELECT side FROM monitoring_rules WHERE id = ?").get(a.id) as { side: number | null } | undefined;
      const side = row?.side === 1 || row?.side === -1 || row?.side === 0 ? (row.side as Side) : null;
      w = { side, since: 0, restored: side !== null };
      this.watches.set(a.id, w);
    }
    return w;
  }

  /** L'instant d'un réarmement : toujours après le précédent (il distingue ses déclenchements « une seule fois »). */
  private armedAt(a: Alert): number {
    return Math.max(this.now(), a.updatedAt + 1);
  }

  /** (Ré)arme une alerte : le côté du prix du moment, s'il est connu (sinon, à la première cotation). */
  private arm(a: Alert) {
    const q = this.market.feed.latest(a.symbol);
    const band = q && a.state === "active" ? this.bandOf(a, q.time / 1000) : undefined;
    const side = q && typeof band === "object" ? bandSide(q.bid, band) : null;
    this.watches.set(a.id, { side, since: this.now(), restored: false });
    this.db.db.prepare("UPDATE monitoring_rules SET side = ? WHERE id = ?").run(side, a.id);
  }

  private setSide(id: string, w: Watch, side: Side, at: number) {
    if (w.side === side) return;
    w.side = side;
    w.since = at;
    this.db.db.prepare("UPDATE monitoring_rules SET side = ? WHERE id = ?").run(side, id);
  }

  /**
   * Un tracé a changé : l'alerte d'une ligne effacée part avec elle ; celle
   * d'une ligne déplacée est réarmée là où est le prix (déplacer la ligne de
   * l'autre côté du prix ne la déclenche pas), et repart si elle avait expiré
   * et que l'oblique va de nouveau jusqu'à maintenant.
   */
  private followDrawings(symbol: string) {
    this.lines.clear();
    let changed = false;
    const rows = this.db.db.prepare("SELECT * FROM monitoring_rules WHERE symbol = ? AND kind = 'drawing'").all(symbol) as RuleRow[];
    for (const row of rows) {
      const d = row.drawing_id ? this.drawings.get(row.drawing_id) : undefined;
      if (!d) {
        this.db.db.prepare("DELETE FROM monitoring_rules WHERE id = ?").run(row.id);
        this.watches.delete(row.id);
        changed = true;
        continue;
      }
      let spec: RuleSpec;
      try {
        spec = JSON.parse(row.spec) as RuleSpec;
      } catch {
        continue; // ligne abîmée : retirée à la prochaine lecture
      }
      // Renommée seulement : rien ne change pour l'alerte.
      if (spec.line === lineKey(d)) continue;
      const state = row.state === "expired" && !unwatchable(d, this.now()) ? "active" : row.state;
      this.db.db
        .prepare("UPDATE monitoring_rules SET spec = ?, state = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...spec, line: lineKey(d) }), state, Math.max(this.now(), row.updated_at + 1), row.id);
      this.active = undefined;
      const a = this.get(row.id);
      if (a && state === "active") this.arm(a);
      changed = true;
    }
    if (!changed) return;
    this.active = undefined;
    this.changed(symbol);
  }

  /** Ce que vise une nouvelle alerte, vérifié : un prix positif, une bande, ou un tracé de ce produit qui a un prix maintenant. */
  private checkTarget(
    symbol: string,
    raw: unknown,
  ): { kind: "price"; price: number } | { kind: "band"; top: number; bottom: number } | { kind: "drawing"; drawingId: string; line: Drawing; level?: number } {
    const t = alertTargetSchema.safeParse(raw);
    if (!t.success)
      throw new DashboardError("dis où poser l'alerte : à un prix (positif), sur un tracé (son identifiant d_…) ou sur une bande de prix (haut et bas)");
    if (t.data.kind === "price") return t.data;
    if (t.data.kind === "band") {
      checkBand(t.data.top, t.data.bottom);
      return t.data;
    }
    const d = this.drawings.get(t.data.drawingId);
    if (!d || d.symbol !== symbol) throw new DashboardError(`aucun tracé « ${t.data.drawingId} » sur ce produit`);
    const problem = unwatchable(d, this.now());
    if (problem) throw new DashboardError(problem);
    const level = t.data.level;
    if (d.kind === "fib" || d.kind === "fibext") {
      const ratios = fibRatios(d.kind).map(fibRatioLabel).join(", ");
      if (level === undefined) throw new DashboardError(`dis quel niveau de ce Fibonacci surveiller (level) : ${ratios}`);
      if (fibLevelPrice(d, level) === undefined) throw new DashboardError(`ce Fibonacci n'a pas de niveau ${fibRatioLabel(level)} : ${ratios}`);
      return { kind: "drawing", drawingId: d.id, line: d, level: fibRatios(d.kind).find((r) => Math.abs(r - level) < 1e-9) };
    }
    if (level !== undefined) throw new DashboardError("seul un Fibonacci a des niveaux (level) : une ligne, une oblique ou une zone se surveille entière");
    return { kind: "drawing", drawingId: d.id, line: d };
  }

  private line(id: string): Drawing | undefined {
    if (!this.lines.has(id)) this.lines.set(id, this.drawings.get(id));
    return this.lines.get(id);
  }

  /** Les alertes surveillées d'un produit ; une alerte échue ne part plus, même avant le passage qui la marque expirée. */
  private activeOn(symbol: string): Alert[] {
    if (!this.active) {
      const map = new Map<string, Alert[]>();
      const rows = this.db.db.prepare("SELECT * FROM monitoring_rules WHERE state = 'active' ORDER BY created_at, rowid").all() as RuleRow[];
      for (const a of this.readable(rows)) map.set(a.symbol, [...(map.get(a.symbol) ?? []), a]);
      this.active = map;
    }
    const now = this.now();
    return (this.active.get(symbol) ?? []).filter((a) => a.expiresAt === undefined || a.expiresAt > now);
  }

  /** Le flux suit les produits des alertes actives, même sans écran. */
  private followFeed() {
    const rows = this.db.db.prepare("SELECT DISTINCT symbol FROM monitoring_rules WHERE state = 'active'").all() as Array<{ symbol: string }>;
    this.market.feed.setAlertSymbols(rows.map((r) => r.symbol));
  }

  private changed(symbol: string) {
    this.followFeed();
    this.emit("changed", symbol);
  }

  /** Les alertes lisibles ; une ligne abîmée ne peut être ni surveillée ni réparée : elle est retirée. */
  private readable(rows: RuleRow[]): Alert[] {
    const out: Alert[] = [];
    for (const r of rows) {
      const a = parseRow(r);
      if (a) out.push(a);
      else {
        this.db.db.prepare("DELETE FROM monitoring_rules WHERE id = ?").run(r.id);
        this.logger.warn(`alerte ${r.id} (${r.symbol}) illisible en base : retirée`, "alerts");
      }
    }
    return out;
  }
}

/** La forme d'une ligne, sans son nom ni ses dates : la renommer ne réarme pas son alerte, la déplacer si. */
function lineKey(d: Drawing): string {
  const { id: _id, symbol: _symbol, label: _label, createdBy: _by, createdAt: _created, updatedAt: _updated, ...shape } = d;
  return JSON.stringify(shape);
}

/** Pourquoi un tracé ne peut pas porter d'alerte (undefined : il le peut). */
function unwatchable(d: Drawing, now: number): string | undefined {
  if (d.kind === "position")
    return "une boîte de trade ne porte pas d'alerte elle-même : pose une alerte au prix de son entrée, de son stop ou de son objectif";
  if (d.kind === "zone" && d.to !== undefined && d.to * 1000 <= now)
    return "cette zone s'arrête avant maintenant : prolonge-la vers la droite pour y mettre une alerte";
  if (d.kind === "trendline" && d.a.t === d.b.t) return "une ligne verticale marque un instant, pas un prix : pas d'alerte possible";
  if (d.kind === "trendline" && !d.extend && Math.max(d.a.t, d.b.t) * 1000 <= now) {
    return "cette oblique s'arrête avant maintenant : prolonge-la vers la droite pour y mettre une alerte";
  }
  return undefined;
}

/** Les bornes d'une bande : deux prix positifs, le haut au-dessus du bas. */
function checkBand(top: number, bottom: number) {
  if (!(Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0 && top > bottom)) {
    throw new DashboardError("une bande de prix a un haut au-dessus de son bas, tous deux positifs");
  }
}

/** Le bord d'une zone qu'on atteint en y entrant dans ce sens : son bas en montant, son haut en descendant. */
function edge(b: Band, dir: Direction): number {
  return dir === "up" ? b.lo : b.hi;
}

/** Les réglages vérifiés, ce qui n'est pas donné repris de `base`. */
function settingsOf(input: AlertSettings, base: Pick<RuleSpec, "condition" | "trigger" | "timeframe" | "message">) {
  const condition = (input.condition || base.condition) as AlertCondition;
  if (!ALERT_CONDITIONS.includes(condition)) {
    throw new DashboardError(`condition inconnue (« ${condition} ») : cross (les deux sens), up (à la hausse) ou down (à la baisse)`);
  }
  const trigger = (input.trigger || base.trigger) as AlertTrigger;
  if (!ALERT_TRIGGERS.includes(trigger)) {
    throw new DashboardError(`déclenchement inconnu (« ${trigger} ») : once (une seule fois), bar (une fois par bougie) ou close (sur clôture de bougie)`);
  }
  const timeframe = input.timeframe || base.timeframe;
  if (!isChartTimeframe(timeframe)) throw new DashboardError(`unité de temps inconnue (« ${timeframe} ») : ${CHART_TIMEFRAMES.join(", ")}`);
  // Les bougies d'un mois n'ont pas de durée fixe : on ne saurait pas dire quand la bougie est close.
  if (trigger !== "once" && timeframe === MONTHLY)
    throw new DashboardError("une alerte par bougie ou à la clôture va jusqu'à la bougie de la semaine (1w), pas du mois");
  const message = (input.message === undefined ? base.message : (input.message ?? undefined))?.trim();
  if (message && message.length > MAX_ALERT_MESSAGE) throw new DashboardError(`consigne trop longue : ${MAX_ALERT_MESSAGE} caractères au plus`);
  return { condition, trigger, timeframe, ...(message ? { message } : {}) };
}

function parseRow(r: RuleRow): Alert | undefined {
  try {
    const spec = JSON.parse(r.spec) as RuleSpec;
    const a = alertSchema.safeParse({
      id: r.id,
      symbol: r.symbol,
      name: spec.name,
      ...(spec.digits !== undefined ? { digits: spec.digits } : {}),
      target:
        r.kind === "price"
          ? { kind: "price", price: spec.price }
          : r.kind === "band"
            ? { kind: "band", top: spec.top, bottom: spec.bottom }
            : { kind: "drawing", drawingId: r.drawing_id, ...(spec.level !== undefined ? { level: spec.level } : {}) },
      condition: spec.condition,
      trigger: spec.trigger,
      timeframe: spec.timeframe,
      ...(spec.message ? { message: spec.message } : {}),
      state: r.state,
      createdBy: r.created_by,
      ...(r.scenario_id ? { scenarioId: r.scenario_id } : {}),
      ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.triggered_at ? { triggeredAt: r.triggered_at } : {}),
      ...(r.triggered_price !== null ? { triggeredPrice: r.triggered_price } : {}),
    });
    return a.success ? a.data : undefined;
  } catch {
    return undefined;
  }
}

function tfSeconds(timeframe: string): number {
  return TIMEFRAME_SECONDS[timeframe as ChartTimeframe] ?? 900;
}

function clockKey(symbol: string, timeframe: string): string {
  return `${symbol}|${timeframe}`;
}
