import { Injectable } from "@nestjs/common";
import { AppLogger } from "../common/logger.js";
import { MarketService } from "../market/market.service.js";
import { CandleLoader } from "./candle-loader.js";
import { CandleStore } from "./candle-store.js";

/** Le chargeur de la réserve branché sur les bougies du courtier (MetaApi), pour l'injection Nest. */
@Injectable()
export class CandleLoaderService extends CandleLoader {
  constructor(market: MarketService, store: CandleStore, logger: AppLogger) {
    super((symbol, timeframe, opts) => market.chartCandles(symbol, timeframe, opts), store, logger);
  }
}
