// Caractérisation du flux de cotations (QuoteFeed) : cadence marché ouvert ou
// fermé, pause quand MetaApi refuse, erreurs signalées une fois, reprise
// espacée d'un produit en erreur ; cotations poussées par le flux WebSocket,
// interrogation en secours. Horloge injectée, partant d'une heure fixe : ces
// tests ne dépendent pas de l'heure du jour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppLogger } from "../src/common/logger.js";
import { QuoteFeed, type MinuteRange, type PriceStream, type Quote, type RawQuote } from "../src/market/quote-feed.js";
import { MarketError } from "../src/market/metaapi.js";

const T = Date.UTC(2026, 10, 3, 13, 0, 0);

function quietLogger(warns: string[] = []): AppLogger {
  return { warn: (m: string) => warns.push(m), log() {}, debug() {}, error() {} } as unknown as AppLogger;
}

function feedWith(quote: (symbol: string) => Promise<RawQuote>, warns?: string[]) {
  const calls: string[] = [];
  const feed = new QuoteFeed(
    (s) => {
      calls.push(s);
      return quote(s);
    },
    async () => 100,
    quietLogger(warns),
  );
  // Horloge du test : part de T et avance avec le temps réel (les reprises espacées en dépendent).
  const start = Date.now();
  feed.now = () => T + (Date.now() - start);
  feed.intervalMs = 5;
  feed.closedIntervalMs = 10_000;
  return { feed, calls };
}

test("cotations : en direct, interrogées à la cadence rapide", async () => {
  const { feed, calls } = feedWith(async () => ({ bid: 1, time: T - 1_000 }));
  feed.setSymbols(["A"]);
  feed.setListening(1);
  await sleep(120);
  feed.stop();
  assert.ok(calls.length >= 3, `appels : ${calls.length}`);
});

test("cotations : marché fermé (cotation de plus de 5 min), cadence lente", async () => {
  const { feed, calls } = feedWith(async () => ({ bid: 1, time: T - 10 * 60_000 }));
  const quotes: unknown[] = [];
  feed.on("quote", (q) => quotes.push(q));
  feed.setSymbols(["A"]);
  feed.setListening(1);
  await sleep(120);
  feed.stop();
  assert.equal(calls.length, 1, "une seule interrogation, la suivante dans closedIntervalMs");
  assert.equal(quotes.length, 1, "la dernière cotation est quand même diffusée");
});

test("cotations : MetaApi refuse (trop de requêtes), pause avant de reprendre", async () => {
  const warns: string[] = [];
  const { feed, calls } = feedWith(async () => {
    // Reconnu à son code : le texte du message peut changer sans casser la pause.
    throw new MarketError("MetaApi sature, plus tard", "rate_limited");
  }, warns);
  feed.setSymbols(["A"]);
  feed.setListening(1);
  await sleep(120);
  feed.stop();
  assert.equal(calls.length, 1, "pas de nouvel appel pendant la pause");
  assert.equal(warns.length, 1);
});

test("cotations : une erreur qui dure espace les interrogations de ce produit, les autres continuent", async () => {
  const calls: string[] = [];
  const { feed } = feedWith(async (s) => {
    calls.push(s);
    if (s === "MORT") throw new Error("symbole retiré");
    return { bid: 1, time: T };
  });
  feed.setSymbols(["MORT", "VIF"]);
  feed.setListening(1);
  await sleep(250);
  feed.stop();
  const dead = calls.filter((c) => c === "MORT").length;
  const alive = calls.filter((c) => c === "VIF").length;
  assert.ok(alive >= 10, `produit en bonne santé : ${alive} appels`);
  assert.ok(dead <= alive / 2, `produit en erreur ralenti : ${dead} appels contre ${alive}`);
});

test("cotations : un produit ajouté pendant une interrogation est interrogé tout de suite après", async () => {
  let release!: () => void;
  const calls: string[] = [];
  const { feed } = feedWith(async (s) => {
    calls.push(s);
    if (s === "LENT" && calls.length === 1) await new Promise<void>((r) => (release = r));
    return { bid: 1, time: T };
  });
  feed.intervalMs = 10_000; // cadence lente : seul un passage « tout de suite » interroge le nouveau
  feed.setSymbols(["LENT"]);
  feed.setListening(1);
  await sleep(20);
  feed.setSymbols(["LENT", "NOUVEAU"]);
  release();
  await sleep(50);
  feed.stop();
  assert.ok(calls.includes("NOUVEAU"), `appels : ${calls.join(", ")}`);
});

test("cotations : la même erreur n'est signalée qu'une fois, une nouvelle l'est", async () => {
  const warns: string[] = [];
  let n = 0;
  const { feed, calls } = feedWith(async () => {
    n++;
    throw new Error(n < 4 ? "symbole introuvable" : "délai dépassé");
  }, warns);
  feed.setSymbols(["A"]);
  feed.setListening(1);
  await sleep(120);
  feed.stop();
  assert.ok(calls.length >= 4, `appels : ${calls.length}`);
  assert.deepEqual(
    warns.map((w) => w.replace(/^cotation A indisponible : /, "")),
    ["symbole introuvable", "délai dépassé"],
  );
});

test("cotations : encart fermé pendant l'appel, rien n'est diffusé", async () => {
  let release!: () => void;
  const { feed } = feedWith(
    () =>
      new Promise<RawQuote>((resolve) => {
        release = () => resolve({ bid: 1, time: T });
      }),
  );
  const quotes: unknown[] = [];
  feed.on("quote", (q) => quotes.push(q));
  feed.setSymbols(["A"]);
  feed.setListening(1);
  await sleep(20);
  feed.setSymbols([]);
  release();
  await sleep(20);
  feed.stop();
  assert.equal(quotes.length, 0);
  assert.deepEqual(feed.snapshot(), []);
});

/** Double du flux WebSocket : les produits demandés, et des cotations poussées à la main. */
class FakeStream extends EventEmitter<{ price: [string, RawQuote]; range: [string, MinuteRange] }> implements PriceStream {
  watched: string[][] = [];
  stopped = false;
  watch(symbols: string[]) {
    this.watched.push(symbols);
  }
  stop() {
    this.stopped = true;
  }
}

function streamedFeed(quote: (symbol: string) => Promise<RawQuote>) {
  const calls: string[] = [];
  const stream = new FakeStream();
  const feed = new QuoteFeed(
    (s) => {
      calls.push(s);
      return quote(s);
    },
    async () => 100,
    quietLogger(),
    stream,
  );
  let clock = T;
  feed.now = () => clock;
  feed.intervalMs = 5;
  feed.closedIntervalMs = 10_000;
  const quotes: Quote[] = [];
  feed.on("quote", (q) => quotes.push(q));
  return { feed, stream, calls, quotes, advance: (ms: number) => (clock += ms), at: () => clock };
}

test("cotations poussées : diffusées, et le produit n'est plus interrogé tant qu'elles arrivent", async () => {
  const { feed, stream, calls, quotes, advance, at } = streamedFeed(async () => ({ bid: 1, time: T - 1_000, digits: 2 }));
  feed.setSymbols(["NAS100"]);
  assert.deepEqual(stream.watched.at(-1), [], "sans écran, rien n'est demandé au flux");
  feed.setListening(1);
  assert.deepEqual(stream.watched.at(-1), ["NAS100"]);
  await sleep(20);
  const polled = calls.length;
  assert.ok(polled >= 1, "interrogé tant que rien n'est poussé (première cotation, décimales)");
  for (let i = 1; i <= 10; i++) {
    advance(1_000);
    stream.emit("price", "NAS100", { bid: 28_000 + i, time: at() });
    await sleep(6);
  }
  assert.equal(calls.length, polled, "plus interrogé : le flux le couvre");
  const last = quotes.at(-1)!;
  assert.equal(last.bid, 28_010);
  assert.equal(last.digits, 2, "décimales reprises de l'interrogation");
  assert.equal(last.dayOpen, 100, "ouverture du jour");
  stream.emit("price", "XAUUSD", { bid: 3_900, time: at() });
  assert.notEqual(quotes.at(-1)!.symbol, "XAUUSD", "un produit qui n'est pas affiché est ignoré");

  feed.setListening(0);
  assert.deepEqual(stream.watched.at(-1), [], "plus d'écran : plus d'abonnement");
  feed.stop();
  assert.ok(stream.stopped);
});

test("cotations poussées : flux muet depuis 15 s (coupé), le produit est de nouveau interrogé", async () => {
  const { feed, stream, calls, advance, at } = streamedFeed(async () => ({ bid: 1, time: T }));
  feed.setSymbols(["NAS100"]);
  feed.setListening(1);
  await sleep(20);
  stream.emit("price", "NAS100", { bid: 2, time: at() });
  const before = calls.length;
  advance(14_000);
  await sleep(20);
  assert.equal(calls.length, before, "encore couvert par le flux");
  advance(2_000);
  await sleep(20);
  assert.ok(calls.length > before, "interrogé de nouveau");
  feed.stop();
});

test("cotations poussées : une interrogation plus ancienne ne fait pas reculer le prix", async () => {
  let release!: () => void;
  const { feed, stream, quotes } = streamedFeed(
    () =>
      new Promise<RawQuote>((resolve) => {
        release = () => resolve({ bid: 1, time: T - 5_000, digits: 2 });
      }),
  );
  feed.setSymbols(["NAS100"]);
  feed.setListening(1);
  await sleep(10);
  stream.emit("price", "NAS100", { bid: 2, time: T });
  release();
  await sleep(10);
  feed.stop();
  assert.equal(quotes.at(-1)!.bid, 2, "le prix poussé, plus récent, reste");
  assert.equal(quotes.at(-1)!.digits, 2, "l'interrogation apporte ses décimales");
});

test("cotations des alertes : suivies sans écran, sans être montrées aux écrans", async () => {
  const { feed, stream, calls, quotes, at } = streamedFeed(async () => ({ bid: 1, time: T - 1_000 }));
  feed.setSymbols(["NAS100"]);
  feed.setAlertSymbols(["XAUUSD"]);
  assert.deepEqual(stream.watched.at(-1), ["XAUUSD"], "sans écran : les produits des alertes seulement");
  await sleep(20);
  assert.ok(calls.includes("XAUUSD"), "interrogé en attendant le flux");
  assert.ok(!calls.includes("NAS100"), "l'encart sans écran ne l'est pas");
  assert.equal(quotes.find((q) => q.symbol === "XAUUSD")?.dayOpen, undefined, "pas d'ouverture du jour : aucun écran ne la montre");
  stream.emit("price", "XAUUSD", { bid: 3_950, time: at() });
  assert.equal(quotes.at(-1)!.bid, 3_950);
  assert.equal(feed.latest("XAUUSD")?.bid, 3_950);
  assert.equal(feed.shows("XAUUSD"), false, "pas à l'écran");
  assert.deepEqual(feed.snapshot(), [], "un écran qui arrive ne la reçoit pas");

  const ranges: Array<[string, MinuteRange]> = [];
  feed.on("range", (symbol, r) => ranges.push([symbol, r]));
  stream.emit("range", "XAUUSD", { start: T, high: 3_951, low: 3_949 });
  stream.emit("range", "EURUSD", { start: T, high: 1.1, low: 1.09 });
  assert.deepEqual(ranges, [["XAUUSD", { start: T, high: 3_951, low: 3_949 }]], "les extrêmes des produits suivis seulement");

  feed.setListening(1);
  assert.deepEqual(stream.watched.at(-1), ["NAS100", "XAUUSD"]);
  feed.setAlertSymbols([]);
  assert.deepEqual(stream.watched.at(-1), ["NAS100"], "alerte retirée : seul l'encart reste");
  assert.equal(feed.latest("XAUUSD"), undefined, "oublié");
  feed.stop();
});

test("cotations : compte en pause, plus aucune interrogation ; rallumé, tout de suite", async () => {
  const { feed, calls } = feedWith(async () => ({ bid: 1, time: T - 1_000 }));
  feed.setSymbols(["A"]);
  feed.setListening(1);
  await sleep(30);
  feed.suspend();
  await sleep(10);
  const paused = calls.length;
  feed.setSymbols(["A", "B"]); // un encart ouvert pendant la pause
  await sleep(40);
  assert.equal(calls.length, paused, "rien n'est demandé en pause");
  assert.ok(feed.latest("A"), "la dernière cotation reste connue");
  feed.resume();
  await sleep(20);
  feed.stop();
  assert.ok(calls.slice(paused).includes("A") && calls.slice(paused).includes("B"), `après la pause : ${calls.slice(paused).join(",")}`);
});
