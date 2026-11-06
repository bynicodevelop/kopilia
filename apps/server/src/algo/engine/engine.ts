import { atr as atrSeries, ema as emaSeries, rsi as rsiSeries, sma as smaSeries } from "@kopilia/contracts";
import { parisClock } from "./paris.js";
import type { Bar, Ctx, EntryRequest, OpenPosition, PendingOrder, Robot, RunInput, RunOutput, Series, Side, TradeRecord } from "./types.js";

/*
 * Le moteur de backtest : bougie close par bougie close, sans regard vers le
 * futur par construction. À la bougie i, le moteur exécute d'abord ce que le
 * robot a décidé à la bougie i − 1 (entrées au marché et clôtures, à
 * l'ouverture de i), puis les ordres en attente et les sorties (stop, objectif)
 * sur les extrêmes de i, et appelle enfin le robot avec la bougie i close. Le
 * robot ne voit que des bougies closes : la série s'arrête à i.
 *
 * Les bougies sont au bid : un achat se fait au bid + écart, une vente au bid ;
 * le résultat est net de l'écart, de la commission et du glissement, en R
 * (distance au stop à l'entrée). Quand le stop et l'objectif sont touchés dans
 * la même bougie, les bougies d'une minute départagent si elles existent ;
 * sinon c'est le stop qui compte (prudence).
 */

const DEFAULT_WARMUP = 50;
const MAX_LOGS = 200;
const MAX_TRADES = 100_000;

class SeriesView implements Series {
  private cursor = 0;
  private readonly cache = new Map<string, number[]>();

  constructor(
    readonly timeframe: string,
    private readonly bars: readonly Bar[],
  ) {}

  /** La dernière bougie close visible (indice dans `bars`). */
  seek(index: number): void {
    this.cursor = index;
  }

  get length(): number {
    return this.cursor + 1;
  }

  bar(i = 0): Bar {
    const idx = this.cursor - i;
    if (!Number.isInteger(i) || i < 0) throw new Error(`bar(${i}) : i doit être un entier positif ou nul`);
    if (idx < 0) throw new Error(`bar(${i}) : seulement ${this.length} bougies closes disponibles`);
    return this.bars[idx];
  }
  open(i = 0): number {
    return this.bar(i).o;
  }
  high(i = 0): number {
    return this.bar(i).h;
  }
  low(i = 0): number {
    return this.bar(i).l;
  }
  close(i = 0): number {
    return this.bar(i).c;
  }

  private series(key: string, compute: () => number[]): number[] {
    let s = this.cache.get(key);
    if (!s) {
      s = compute();
      this.cache.set(key, s);
    }
    return s;
  }

  private at(values: number[], i: number): number {
    const idx = this.cursor - i;
    if (idx < 0) throw new Error(`seulement ${this.length} bougies closes disponibles`);
    const v = values[idx];
    return v === undefined || Number.isNaN(v) ? NaN : v;
  }

  sma(period: number, i = 0): number {
    checkPeriod(period);
    return this.at(
      this.series(`sma${period}`, () =>
        smaSeries(
          this.bars.map((b) => b.c),
          period,
        ),
      ),
      i,
    );
  }
  ema(period: number, i = 0): number {
    checkPeriod(period);
    return this.at(
      this.series(`ema${period}`, () =>
        emaSeries(
          this.bars.map((b) => b.c),
          period,
        ),
      ),
      i,
    );
  }
  rsi(period: number, i = 0): number {
    checkPeriod(period);
    return this.at(
      this.series(`rsi${period}`, () =>
        rsiSeries(
          this.bars.map((b) => b.c),
          period,
        ),
      ),
      i,
    );
  }
  atr(period: number, i = 0): number {
    checkPeriod(period);
    return this.at(
      this.series(`atr${period}`, () => atrSeries(this.bars, period)),
      i,
    );
  }
  highest(period: number, i = 0): number {
    checkPeriod(period);
    const end = this.cursor - i;
    if (end - period + 1 < 0) return NaN;
    let v = -Infinity;
    for (let k = end - period + 1; k <= end; k++) v = Math.max(v, this.bars[k].h);
    return v;
  }
  lowest(period: number, i = 0): number {
    checkPeriod(period);
    const end = this.cursor - i;
    if (end - period + 1 < 0) return NaN;
    let v = Infinity;
    for (let k = end - period + 1; k <= end; k++) v = Math.min(v, this.bars[k].l);
    return v;
  }
}

function checkPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1 || period > 5000) throw new Error(`période ${period} invalide (1 à 5000)`);
}

interface Position {
  side: Side;
  entry: number;
  stop: number;
  target?: number;
  entryIndex: number;
  entryAt: number;
  risk: number;
  tag?: string;
  /** Pire et meilleure excursion en prix (signées dans le sens du trade). */
  worst: number;
  best: number;
}

/** Joue un robot sur une série ; pur, déterministe. */
export function runBacktest(robot: Robot, input: RunInput): RunOutput {
  const { bars, costs } = input;
  const tf = input.seconds[input.timeframe];
  if (!tf) throw new Error(`durée inconnue pour l'unité ${input.timeframe}`);
  const main = new SeriesView(input.timeframe, bars);
  const contexts = new Map<string, { view: SeriesView; bars: Bar[]; seconds: number; pointer: number }>();
  for (const [name, list] of Object.entries(input.context ?? {})) {
    const seconds = input.seconds[name];
    if (!seconds) throw new Error(`durée inconnue pour l'unité de contexte ${name}`);
    contexts.set(name, { view: new SeriesView(name, list), bars: list, seconds, pointer: -1 });
  }
  const minute = input.minute ?? [];
  let minutePointer = 0;
  const params = { ...(robot.params ?? {}), ...(input.params ?? {}) };
  const warmup = Math.max(0, Math.floor(robot.warmup ?? DEFAULT_WARMUP));
  const trades: TradeRecord[] = [];
  const logs: string[] = [];
  let position: Position | undefined;
  let pending: (PendingOrder & { side: Side }) | undefined;
  /** Ce que le robot a décidé à la bougie précédente, exécuté à l'ouverture de celle-ci. */
  let marketEntry: (EntryRequest & { side: Side }) | undefined;
  let closeRequest: string | undefined;

  const askOf = (bid: number) => bid + costs.spread;

  const openTrade = (side: Side, price: number, req: EntryRequest, index: number, at: number, slip = true): void => {
    const slippage = slip ? costs.slippage : 0;
    const entry = side === "long" ? askOf(price) + slippage : price - slippage;
    const risk = side === "long" ? entry - req.stop : req.stop - entry;
    if (!(risk > 0)) {
      if (logs.length < MAX_LOGS) logs.push(`${bars[index].t} : entrée ${side} refusée, le stop ${req.stop} n'est pas du bon côté de ${entry}`);
      return;
    }
    position = { side, entry, stop: req.stop, target: req.target, entryIndex: index, entryAt: at, risk, tag: req.tag, worst: 0, best: 0 };
  };

  const closeTrade = (price: number, index: number, reason: string): void => {
    if (!position) return;
    const p = position;
    const exit = p.side === "long" ? price : askOf(price);
    const pnl = (p.side === "long" ? exit - p.entry : p.entry - exit) - costs.commission;
    trades.push({
      symbol: input.symbol,
      side: p.side,
      entryIndex: p.entryIndex,
      exitIndex: index,
      entryAt: p.entryAt,
      exitAt: bars[index].t,
      entry: p.entry,
      exit,
      stop: p.stop,
      ...(p.target !== undefined ? { target: p.target } : {}),
      r: pnl / p.risk,
      reason,
      mae: p.worst / p.risk,
      mfe: p.best / p.risk,
      bars: index - p.entryIndex,
      ...(p.tag ? { tag: p.tag } : {}),
    });
    position = undefined;
    if (trades.length >= MAX_TRADES) throw new Error(`plus de ${MAX_TRADES} trades : le robot entre à chaque bougie ?`);
  };

  /** Dans la bougie `b`, le stop puis l'objectif sont-ils touchés ? Renvoie le prix de sortie et la raison. */
  const exitWithin = (b: Bar): { price: number; reason: string } | undefined => {
    const p = position!;
    const stopHit = p.side === "long" ? b.l <= p.stop : askOf(b.h) >= p.stop;
    const targetHit = p.target !== undefined && (p.side === "long" ? b.h >= p.target : askOf(b.l) <= p.target);
    if (!stopHit && !targetHit) return undefined;
    // Le prix rendu est au bid : l'objectif d'une vente, atteint par l'ask, se traduit.
    const targetBid = p.side === "long" ? p.target! : p.target! - costs.spread;
    if (stopHit && targetHit) {
      // Les deux dans la même bougie : les minutes départagent, sinon le stop.
      const order = resolveWithMinutes(b);
      if (order === "target") return { price: targetBid, reason: "objectif" };
      return { price: stopFill(b), reason: "stop" };
    }
    if (stopHit) return { price: stopFill(b), reason: "stop" };
    return { price: targetBid, reason: "objectif" };
  };

  /** Un stop dépassé dès l'ouverture (gap) se remplit à l'ouverture, pire que le stop ; sinon au stop, moins le glissement. */
  const stopFill = (b: Bar): number => {
    const p = position!;
    if (p.side === "long") return (b.o <= p.stop ? b.o : p.stop) - costs.slippage;
    const openAsk = askOf(b.o);
    return (openAsk >= p.stop ? b.o : p.stop - costs.spread) + costs.slippage;
  };

  const resolveWithMinutes = (b: Bar): "stop" | "target" | "unknown" => {
    if (!minute.length) return "unknown";
    const p = position!;
    const end = b.t + tf;
    while (minutePointer < minute.length && minute[minutePointer].t < b.t) minutePointer++;
    for (let k = minutePointer; k < minute.length && minute[k].t < end; k++) {
      const m = minute[k];
      const stopHit = p.side === "long" ? m.l <= p.stop : askOf(m.h) >= p.stop;
      const targetHit = p.target !== undefined && (p.side === "long" ? m.h >= p.target : askOf(m.l) <= p.target);
      if (stopHit && targetHit) return "stop";
      if (stopHit) return "stop";
      if (targetHit) return "target";
    }
    return "unknown";
  };

  /** Un ordre en attente est-il rempli dans cette bougie ? Renvoie le prix d'exécution (au bid pour les deux sens). */
  const pendingFill = (b: Bar): number | undefined => {
    const o = pending!;
    if (o.limit !== undefined) {
      if (o.side === "long") {
        // Acheter au plus à `limit` : il faut que l'ask descende jusque-là.
        if (askOf(b.o) <= o.limit) return b.o;
        return askOf(b.l) <= o.limit ? o.limit - costs.spread : undefined;
      }
      if (b.o >= o.limit) return b.o;
      return b.h >= o.limit ? o.limit : undefined;
    }
    if (o.stopEntry !== undefined) {
      if (o.side === "long") {
        if (askOf(b.o) >= o.stopEntry) return b.o;
        return askOf(b.h) >= o.stopEntry ? o.stopEntry - costs.spread : undefined;
      }
      if (b.o <= o.stopEntry) return b.o;
      return b.l <= o.stopEntry ? o.stopEntry : undefined;
    }
    return undefined;
  };

  const ctxBase = {
    symbol: input.symbol,
    timeframe: input.timeframe,
    params,
    series: main,
    context(name: string): Series {
      const c = contexts.get(name);
      if (!c) throw new Error(`unité de contexte ${name} non chargée pour ce backtest (demande-la dans algo_backtest_run)`);
      return c.view;
    },
    log(message: string) {
      if (logs.length < MAX_LOGS) logs.push(String(message).slice(0, 300));
    },
  };

  let i = 0;
  try {
    for (i = 0; i < bars.length; i++) {
      const b = bars[i];
      // 1. Les décisions de la bougie précédente, à l'ouverture.
      if (closeRequest !== undefined && position) {
        closeTrade(b.o, i, closeRequest);
      }
      closeRequest = undefined;
      if (marketEntry && !position) openTrade(marketEntry.side, b.o, marketEntry, i, b.t);
      marketEntry = undefined;
      // 2. Un ordre en attente, puis les sorties sur les extrêmes de la bougie.
      if (pending && !position) {
        if (pending.expires !== undefined && i - pending.placedIndex > pending.expires) pending = undefined;
        else {
          const fill = pendingFill(b);
          if (fill !== undefined) {
            // Une limite se remplit sans glissement ; un stop d'entrée, avec.
            openTrade(pending.side, fill, pending, i, b.t, pending.limit === undefined);
            pending = undefined;
          }
        }
      }
      if (position) {
        const p = position;
        // Une position ouverte à l'ouverture de cette bougie peut déjà sortir dans celle-ci.
        const exit = exitWithin(b);
        if (exit) closeTrade(exit.price, i, exit.reason);
        else {
          const fav = p.side === "long" ? b.h - p.entry : p.entry - askOf(b.l);
          const adv = p.side === "long" ? b.l - p.entry : p.entry - askOf(b.h);
          p.best = Math.max(p.best, fav);
          p.worst = Math.min(p.worst, adv);
        }
      }
      // 3. Le robot voit la bougie close.
      main.seek(i);
      const closeTime = b.t + tf;
      for (const c of contexts.values()) {
        while (c.pointer + 1 < c.bars.length && c.bars[c.pointer + 1].t + c.seconds <= closeTime) c.pointer++;
        c.view.seek(c.pointer);
      }
      if (i < warmup) continue;
      const openPosition: OpenPosition | null = position
        ? {
            side: position.side,
            entry: position.entry,
            stop: position.stop,
            ...(position.target !== undefined ? { target: position.target } : {}),
            entryIndex: position.entryIndex,
            entryAt: position.entryAt,
            risk: position.risk,
            bars: i - position.entryIndex,
            ...(position.tag ? { tag: position.tag } : {}),
            openR: ((position.side === "long" ? b.c - position.entry : position.entry - askOf(b.c)) - costs.commission) / position.risk,
          }
        : null;
      const ctx: Ctx = {
        ...ctxBase,
        index: i,
        time: b.t,
        bar: b,
        clock: parisClock(b.t),
        position: openPosition,
        pending: pending ? { ...pending } : null,
        buy: (req) => place("long", req),
        sell: (req) => place("short", req),
        close: (reason) => {
          if (position) closeRequest = reason ?? "signal";
        },
        cancel: () => {
          pending = undefined;
          marketEntry = undefined;
        },
        setStop: (price) => {
          if (!position) throw new Error("setStop : aucune position ouverte");
          if (!Number.isFinite(price)) throw new Error("setStop : prix invalide");
          position.stop = price;
        },
        setTarget: (price) => {
          if (!position) throw new Error("setTarget : aucune position ouverte");
          if (price !== undefined && !Number.isFinite(price)) throw new Error("setTarget : prix invalide");
          position.target = price;
        },
      };
      const place = (side: Side, req: Omit<EntryRequest, "side">) => {
        if (position) throw new Error(`${side === "long" ? "buy" : "sell"} : une position est déjà ouverte (close() d'abord)`);
        if (!Number.isFinite(req.stop)) throw new Error("l'entrée exige un stop (stop) : sans lui, pas de R");
        if (req.target !== undefined && !Number.isFinite(req.target)) throw new Error("objectif (target) invalide");
        if (req.limit !== undefined && req.stopEntry !== undefined) throw new Error("limit et stopEntry sont exclusifs");
        const order = { ...req, side };
        if (req.limit !== undefined || req.stopEntry !== undefined) {
          const ref = req.limit ?? req.stopEntry!;
          if (side === "long" ? req.stop >= ref : req.stop <= ref)
            throw new Error("le stop doit être du mauvais côté du prix d'entrée… c'est-à-dire sous un achat, au-dessus d'une vente");
          pending = { ...order, placedIndex: i };
          marketEntry = undefined;
        } else {
          marketEntry = order;
          pending = undefined;
        }
      };
      robot.onBar(ctx);
    }
    // Fin de l'historique : une position ouverte se clôt à la dernière clôture.
    if (position && bars.length) closeTrade(bars[bars.length - 1].c, bars.length - 1, "fin");
    return { symbol: input.symbol, trades, logs, bars: bars.length };
  } catch (e) {
    const at = bars[i] ? ` (bougie ${i}, ${new Date(bars[i].t * 1000).toISOString().slice(0, 16)})` : "";
    return { symbol: input.symbol, trades, logs, bars: i, error: `${(e as Error).message}${at}` };
  }
}
