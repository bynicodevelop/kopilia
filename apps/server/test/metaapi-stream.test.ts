// Flux de cotations poussé par MetaApi (WebSocket) : connexion ouverte à la
// première demande, abonnements au fil des encarts (cotations et bougie d'une
// minute), connexion ratée retentée, produit refusé. Le SDK est remplacé par un
// double qui note chaque appel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppLogger } from "../src/common/logger.js";
import { MetaApiStream, type MetaApiSdk } from "../src/market/metaapi-stream.js";
import type { MinuteRange, RawQuote } from "../src/market/quote-feed.js";

const TOKEN = "jeton-secret-de-test";

function logger(lines: string[]): AppLogger {
  return { warn: (m: string) => lines.push(`warn ${m}`), log: (m: string) => lines.push(`log ${m}`), debug() {}, error() {} } as unknown as AppLogger;
}

interface Listener {
  onSymbolPriceUpdated(instance: string, price: { symbol: string; bid?: number; ask?: number; time?: Date }): Promise<void>;
  onCandlesUpdated(instance: string, candles: Array<{ symbol: string; timeframe: string; time?: Date; high?: number; low?: number }>): Promise<void>;
}

/**
 * Double du SDK : chaque appel noté ; `getAccount` peut échouer (`failAccount`
 * fois), un symbole être refusé, ou seulement sa bougie d'une minute.
 */
function fakeSdk(opts: { failAccount?: number; refuse?: string[]; refuseCandles?: string[] } = {}) {
  const calls: string[] = [];
  const listeners: Listener[] = [];
  let failures = opts.failAccount ?? 0;
  class SynchronizationListener {}
  class MetaApi {
    constructor(token: string) {
      assert.equal(token, TOKEN);
      calls.push("api");
    }
    metatraderAccountApi = {
      getAccount: async (id: string) => {
        calls.push(`account ${id}`);
        if (failures-- > 0) throw new Error(`compte injoignable (jeton ${TOKEN})`);
        return {
          getStreamingConnection: () => ({
            addSynchronizationListener: (l: Listener) => void listeners.push(l),
            connect: async () => void calls.push("connect"),
            waitSynchronized: async () => void calls.push("synchronized"),
            subscribeToMarketData: async (symbol: string, subs: Array<{ type: string; timeframe?: string }>, _timeout?: number, waitForQuote?: boolean) => {
              if (opts.refuse?.includes(symbol)) throw Object.assign(new Error(`symbole ${symbol} inconnu`), { name: "ValidationError" });
              if (opts.refuseCandles?.includes(symbol) && subs.some((s) => s.type === "candles")) throw new Error("bougies indisponibles");
              assert.equal(waitForQuote, false, "sans attendre une cotation (marché fermé)");
              calls.push(`subscribe ${symbol} ${subs.map((s) => s.type + (s.timeframe ? ` ${s.timeframe}` : "")).join(",")}`);
            },
            unsubscribeFromMarketData: async (symbol: string) => void calls.push(`unsubscribe ${symbol}`),
            close: async () => void calls.push("close"),
          }),
        };
      },
    };
    close() {
      calls.push("api close");
    }
  }
  const sdk: MetaApiSdk = { MetaApi, SynchronizationListener } as unknown as MetaApiSdk;
  return { sdk, calls, listeners };
}

test("flux WebSocket : ouvert à la première demande, abonnements au fil des encarts", async () => {
  const { sdk, calls, listeners } = fakeSdk();
  const lines: string[] = [];
  const stream = new MetaApiStream(
    TOKEN,
    async () => "acc-1",
    logger(lines),
    () => sdk,
  );
  const prices: Array<[string, RawQuote]> = [];
  stream.on("price", (s, q) => prices.push([s, q]));

  stream.watch([]);
  await sleep(5);
  assert.deepEqual(calls, [], "rien d'affiché : aucune connexion");

  stream.watch(["NAS100"]);
  await sleep(5);
  assert.deepEqual(calls, ["api", "account acc-1", "connect", "synchronized", "subscribe NAS100 quotes", "subscribe NAS100 candles 1m"]);
  assert.ok(lines.some((l) => l.includes("flux de cotations ouvert")));

  stream.watch(["NAS100", "XAUUSD"]);
  stream.watch(["XAUUSD"]); // deux changements de suite : seule la dernière liste compte
  await sleep(5);
  assert.deepEqual(calls.slice(6), ["unsubscribe NAS100", "subscribe XAUUSD quotes", "subscribe XAUUSD candles 1m"]);

  const at = new Date(Date.UTC(2026, 10, 3, 19, 34, 7));
  await listeners[0].onSymbolPriceUpdated("0", { symbol: "XAUUSD", bid: 3924.67, ask: 3924.9, time: at });
  await listeners[0].onSymbolPriceUpdated("0", { symbol: "NAS100", bid: 28173.49, time: at });
  assert.deepEqual(prices, [["XAUUSD", { bid: 3924.67, ask: 3924.9, time: at.getTime() }]], "seuls les produits suivis");

  // La bougie d'une minute : ses extrêmes, pour les mèches entre deux cotations.
  const ranges: Array<[string, MinuteRange]> = [];
  stream.on("range", (s, r) => ranges.push([s, r]));
  const minute = new Date(Date.UTC(2026, 10, 3, 19, 34, 0));
  await listeners[0].onCandlesUpdated("0", [
    { symbol: "XAUUSD", timeframe: "1m", time: minute, high: 3926.1, low: 3923.8 },
    { symbol: "XAUUSD", timeframe: "1h", time: minute, high: 3930, low: 3900 },
    { symbol: "NAS100", timeframe: "1m", time: minute, high: 28180, low: 28170 },
  ]);
  assert.deepEqual(ranges, [["XAUUSD", { start: minute.getTime(), high: 3926.1, low: 3923.8 }]], "la minute des produits suivis seulement");

  stream.stop();
  await sleep(5);
  assert.deepEqual(calls.slice(-2), ["close", "api close"]);
});

test("flux WebSocket : connexion ratée, retentée plus tard, sans jamais le jeton dans le journal", async () => {
  const { sdk, calls } = fakeSdk({ failAccount: 2 });
  const lines: string[] = [];
  const stream = new MetaApiStream(
    TOKEN,
    async () => "acc-1",
    logger(lines),
    () => sdk,
  );
  stream.retryMs = [20, 40];
  stream.watch(["NAS100"]);
  await sleep(10);
  assert.equal(calls.filter((c) => c === "connect").length, 0);
  assert.equal(calls.filter((c) => c.startsWith("account")).length, 1, "pas de nouvel essai avant le délai");
  await sleep(120);
  assert.equal(calls.filter((c) => c.startsWith("account")).length, 3, "deux ratés, puis la connexion");
  assert.ok(calls.includes("subscribe NAS100 quotes"));
  const warns = lines.filter((l) => l.startsWith("warn"));
  assert.equal(warns.length, 1, "la même erreur n'est signalée qu'une fois");
  assert.match(warns[0], /compte injoignable/);
  assert.ok(!lines.some((l) => l.includes(TOKEN)), "jeton absent du journal");
  stream.stop();
});

test("flux WebSocket : un produit refusé par MetaApi n'est pas redemandé, les autres passent", async () => {
  const { sdk, calls } = fakeSdk({ refuse: ["CL.NYS"] });
  const lines: string[] = [];
  const stream = new MetaApiStream(
    TOKEN,
    async () => "acc-1",
    logger(lines),
    () => sdk,
  );
  stream.watch(["CL.NYS", "XAUUSD"]);
  await sleep(5);
  stream.watch(["CL.NYS", "XAUUSD", "NAS100"]);
  await sleep(5);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("subscribe")),
    ["subscribe XAUUSD quotes", "subscribe XAUUSD candles 1m", "subscribe NAS100 quotes", "subscribe NAS100 candles 1m"],
  );
  assert.equal(calls.filter((c) => c === "connect").length, 1, "la connexion est gardée");
  assert.equal(lines.filter((l) => l.includes("pas de flux pour CL.NYS")).length, 1);
  stream.stop();
});

test("flux WebSocket : sans bougie d'une minute, les cotations passent quand même", async () => {
  const { sdk, calls } = fakeSdk({ refuseCandles: ["XAUUSD"] });
  const lines: string[] = [];
  const stream = new MetaApiStream(
    TOKEN,
    async () => "acc-1",
    logger(lines),
    () => sdk,
  );
  stream.watch(["XAUUSD"]);
  await sleep(5);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("subscribe")),
    ["subscribe XAUUSD quotes"],
  );
  assert.equal(lines.filter((l) => l.includes("pas de bougie minute pour XAUUSD")).length, 1);
  assert.ok(!lines.some((l) => l.includes("pas de flux")), "le produit n'est pas refusé");
  stream.stop();
});
