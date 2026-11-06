import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../db/database.service.js";
import { AppLogger } from "../common/logger.js";
import { DrawingService, describeDrawing } from "../dashboard/drawing.service.js";
import { MarketService, Product } from "../market/market.service.js";
import { ChartTimeframe, TIMEFRAME_SECONDS, isChartTimeframe } from "../market/timeframes.js";
import { frenchPrice } from "../market/metaapi.js";
import { SetupError } from "./scenario.service.js";
import { when } from "./setup-texts.js";

interface ExampleRow {
  id: string;
  symbol: string;
  name: string;
  timeframe: string;
  at: number;
  positive: number;
  note: string | null;
  context: string;
  created_at: number;
}

/** Ce qu'on garde d'un exemple : le prix à cet instant, les bougies qui y mènent, les tracés de l'utilisateur. */
interface ExampleContext {
  digits?: number;
  price?: number;
  candles: Array<[number, number, number, number, number]>;
  drawings: string[];
}

/** Bougies gardées avant l'instant d'un exemple : de quoi revoir la structure qui y mène. */
const CONTEXT_BARS = 16;

/**
 * « Ça, c'est un setup » (ou « ça, ce n'en est pas un ») : un instant du
 * graphique montré par l'utilisateur, avec son contexte (bougies, prix, ses
 * tracés) et sa remarque. Les agents de la recherche d'opportunités les
 * relisent ; le relecteur en tire sa façon de trader.
 */
@Injectable()
export class ExampleService {
  /** Horloge (epoch ms) ; remplaçable en test. */
  now: () => number = () => Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly market: MarketService,
    private readonly drawings: DrawingService,
    private readonly logger: AppLogger,
  ) {}

  async add(product: Product, input: { timeframe: string; at?: number; positive: boolean; note?: string }) {
    if (!isChartTimeframe(input.timeframe)) throw new SetupError(`unité de temps inconnue (« ${input.timeframe} »)`);
    const now = this.now();
    const at = input.at ?? now;
    if (!(Number.isFinite(at) && at <= now + 60_000)) throw new SetupError("l'instant d'un exemple est passé (ou maintenant)");
    const tf = TIMEFRAME_SECONDS[input.timeframe as ChartTimeframe];
    const r = await this.market.chartCandles(product.symbol, input.timeframe as ChartTimeframe, {
      before: Math.floor(at / 1000) + tf,
      limit: CONTEXT_BARS,
    });
    const candles = "error" in r ? [] : r.candles;
    const context: ExampleContext = {
      ...(product.digits !== undefined ? { digits: product.digits } : {}),
      ...(candles.length ? { price: candles[candles.length - 1].c } : {}),
      candles: candles.map((c) => [c.t, c.o, c.h, c.l, c.c]),
      drawings: this.drawings
        .list([product.symbol])
        .filter((d) => d.createdBy === "user")
        .map((d) => describeDrawing(d, product.digits)),
    };
    const id = `ex_${randomBytes(3).toString("hex")}`;
    const note = input.note?.trim().slice(0, 400) || null;
    this.db.db
      .prepare("INSERT INTO setup_examples (id, symbol, name, timeframe, at, positive, note, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, product.symbol, product.name, input.timeframe, at, input.positive ? 1 : 0, note, JSON.stringify(context), now);
    this.logger.log(`exemple ${id} (${input.positive ? "setup" : "contre-exemple"}) : ${product.name} ${input.timeframe}`, "setups");
    return { exampleId: id, product: product.name, timeframe: input.timeframe, at: when(at, now), positive: input.positive, ...(note ? { note } : {}) };
  }

  /** Les derniers exemples, une ligne chacun, pour les agents : « + or 15m, mardi 3 novembre à 10:45 (prix 2 652,00) : « … » ; ses tracés : … ». */
  lines(limit = 10): string[] {
    const rows = this.db.db.prepare("SELECT * FROM setup_examples ORDER BY created_at DESC LIMIT ?").all(limit) as ExampleRow[];
    const now = this.now();
    return rows.map((r) => {
      let ctx: ExampleContext = { candles: [], drawings: [] };
      try {
        ctx = JSON.parse(r.context) as ExampleContext;
      } catch {
        /* contexte illisible : l'exemple garde sa remarque */
      }
      const price = ctx.price !== undefined ? ` (prix ${frenchPrice(ctx.price, ctx.digits)})` : "";
      const drawn = ctx.drawings.length ? ` ; ses tracés à ce moment : ${ctx.drawings.slice(0, 4).join(", ")}` : "";
      return `${r.positive ? "+" : "−"} ${r.name} ${r.timeframe}, ${when(r.at, now)}${price}${r.note ? ` : « ${r.note} »` : ""}${drawn}`;
    });
  }

  /** Les exemples montrés entre deux instants (relecture). */
  since(from: number, to: number): string[] {
    const count = (this.db.db.prepare("SELECT COUNT(*) AS n FROM setup_examples WHERE created_at > ? AND created_at <= ?").get(from, to) as { n: number }).n;
    return count ? this.lines(count) : [];
  }
}
