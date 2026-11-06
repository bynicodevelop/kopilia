// Heures attendues en heure de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigService } from "../src/config/config.service.js";
import { AppLogger } from "../src/common/logger.js";
import { completeIndicator } from "@kopilia/contracts";
import { MarketService, retryAfterMs } from "../src/market/market.service.js";
import { ageLabel, frenchPrice, normalize, resolveSymbol } from "../src/market/metaapi.js";

const PROV = "https://prov.test";
const CLIENT = "https://mt-client-api-v1.london.agiliumtrade.ai";
const TOKEN = "jeton-metaapi-de-test";
/** Symboles d'un courtier aux suffixes typiques (.m, .cash, #). */
const BROKER = ["EURUSD.m", "USDJPY.m", "XAUUSD.m", "USTEC", "US30.cash", "#AAPL", "CLX", "GER40", "BTCUSD"];
/** Mardi 3 novembre 2026, 14 h 32 min 10 s (heure de Paris). */
const NOW = new Date(2026, 10, 3, 14, 32, 10);
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

/** Bougies quotidiennes (courtier à GMT+3 puis GMT+2) et de 5 minutes du vendredi 30 octobre. */
const DAILY = [
  { time: "2026-10-28T21:00:00.000Z", brokerTime: "2026-10-29 00:00:00.000", open: 29616.11, high: 29634.03, low: 28956.34, close: 29060.82 },
  { time: "2026-10-29T21:00:00.000Z", brokerTime: "2026-10-30 00:00:00.000", open: 28995.55, high: 29019.59, low: 28077.01, close: 28388.86 },
  { time: "2026-11-01T22:00:00.000Z", brokerTime: "2026-11-02 00:00:00.000", open: 28501.9, high: 28746.93, low: 27958.7, close: 28081.15 },
];
const INTRADAY = [
  { time: "2026-10-30T13:30:00.000Z", brokerTime: "2026-10-30 16:30:00.000", open: 28700, high: 29019.59, low: 28690, close: 28800 },
  { time: "2026-10-30T18:50:00.000Z", brokerTime: "2026-10-30 21:50:00.000", open: 28100, high: 28120, low: 28077.01, close: 28110 },
];

const ACCOUNT = { _id: "acc-1", name: "Démo IC", state: "DEPLOYED", connectionStatus: "CONNECTED", region: "london", server: "ICMarketsSC-Demo" };

interface Fake {
  accountId?: string;
  account?: Record<string, unknown>;
  accounts?: unknown;
  prices?: Record<string, { bid: number; ask?: number; time: string }>;
  /** Bougies renvoyées pour toute unité de temps autre que le jour. */
  candles?: unknown[];
  /** Réponse forcée pour une adresse contenant ce texte. */
  fail?: { match: string; status?: number; error?: Error; times?: number; headers?: Record<string, string> };
}

/** Service branché sur un faux MetaApi qui note chaque adresse demandée. */
function setup(fake: Fake = {}) {
  process.env.KOPILIA_METAAPI_TOKEN = TOKEN;
  process.env.KOPILIA_METAAPI_ACCOUNT_ID = fake.accountId ?? "acc-1";
  process.env.KOPILIA_METAAPI_PROVISIONING_URL = PROV;
  process.env.KOPILIA_METAAPI_CLIENT_URL = "";
  // Le flux WebSocket irait chez le vrai MetaApi : ici, les cotations sont interrogées (le flux a ses propres tests).
  process.env.KOPILIA_METAAPI_STREAM = "0";
  const market = new MarketService(new ConfigService(), new AppLogger());
  market.retryDelaysMs = [0, 0];
  let failures = 0;
  const calls: string[] = [];
  const prices = fake.prices ?? {
    USTEC: { bid: 21540.25, ask: 21541.5, time: ago(2) },
    "EURUSD.m": { bid: 1.08345, ask: 1.08351, time: ago(1) },
  };
  market.fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)["auth-token"], TOKEN, "jeton envoyé dans l'en-tête");
    if (fake.fail && url.includes(fake.fail.match) && failures < (fake.fail.times ?? Infinity)) {
      failures++;
      if (fake.fail.error) throw fake.fail.error;
      return Response.json({ message: "refusé" }, { status: fake.fail.status ?? 500, headers: fake.fail.headers });
    }
    const history = url.match(
      /^https:\/\/mt-market-data-client-api-v1\.london\.agiliumtrade\.ai\/users\/current\/accounts\/acc-1\/historical-market-data\/symbols\/([^/]+)\/timeframes\/(\w+)\/candles\?/,
    );
    if (history) return Response.json(history[2] === "1d" ? DAILY : (fake.candles ?? INTRADAY));
    const symbolPath = `${CLIENT}/users/current/accounts/acc-1/symbols`;
    if (url === `${PROV}/users/current/servers/mt-client-api`) return Response.json({ hostname: "mt-client-api-v1", domain: "agiliumtrade.ai" });
    if (url === `${PROV}/users/current/accounts`) return Response.json(fake.accounts ?? [ACCOUNT]);
    if (url === `${PROV}/users/current/accounts/acc-1`) return Response.json({ ...ACCOUNT, ...fake.account });
    if (url === symbolPath) return Response.json(BROKER);
    const m = url.slice(symbolPath.length).match(/^\/([^/]+)\/(current-price|specification)$/);
    if (url.startsWith(symbolPath) && m) {
      const symbol = decodeURIComponent(m[1]);
      if (m[2] === "specification") {
        const description = { USTEC: "US Tech 100 Index", "EURUSD.m": "Euro vs US Dollar" }[symbol];
        return Response.json({ symbol, description: description ?? symbol, digits: symbol === "USTEC" ? 2 : 5 });
      }
      const p = prices[symbol];
      return p ? Response.json({ symbol, ...p }) : Response.json({ message: "symbole inconnu" }, { status: 404 });
    }
    return Response.json({ message: `inattendu : ${url}` }, { status: 404 });
  };
  return { market, calls };
}

test("symbole du courtier : nom courant, article, suffixes", () => {
  const cases: Array<[string, string, string?]> = [
    ["Nasdaq", "USTEC", "Nasdaq 100"],
    ["le Nasdaq", "USTEC", "Nasdaq 100"],
    ["MNQ", "USTEC", "Nasdaq 100"],
    ["l'or", "XAUUSD.m", "or"],
    ["Gold", "XAUUSD.m", "or"],
    ["Dow Jones", "US30.cash", "Dow Jones"],
    ["DAX", "GER40", "DAX"],
    ["bitcoin", "BTCUSD", "bitcoin"],
    ["EUR/USD", "EURUSD.m", "euro-dollar"],
    ["eurusd", "EURUSD.m", "euro-dollar"],
    ["l'euro-dollar", "EURUSD.m", "euro-dollar"],
    ["dollar yen", "USDJPY.m", "dollar-yen"],
    ["AAPL", "#AAPL"],
    ["US30.cash", "US30.cash"],
  ];
  for (const [query, symbol, name] of cases) {
    assert.deepEqual(resolveSymbol(query, BROKER), name ? { symbol, name } : { symbol }, query);
  }
});

test("symbole du courtier : suffixes collés, et l'exact passe avant", () => {
  const exness = ["EURUSDm", "USTECm", "US30m", "XAUUSDm"];
  assert.deepEqual(resolveSymbol("Nasdaq", exness), { symbol: "USTECm", name: "Nasdaq 100" });
  assert.deepEqual(resolveSymbol("US30", exness), { symbol: "US30m", name: "Dow Jones" });
  assert.deepEqual(resolveSymbol("EURUSD", exness), { symbol: "EURUSDm", name: "euro-dollar" });
  assert.deepEqual(resolveSymbol("EURUSD", ["EURUSD.raw", "EURUSD"]), { symbol: "EURUSD", name: "euro-dollar" });
  // Préférence du courant au plus rare : NAS100 avant USTEC quand les deux existent.
  assert.deepEqual(resolveSymbol("Nasdaq", ["USTEC", "NAS100"]), { symbol: "NAS100", name: "Nasdaq 100" });
});

test("symbole du courtier : un ticker court n'en attrape pas un autre ; introuvable -> symboles proches", () => {
  assert.deepEqual(resolveSymbol("pétrole", BROKER), { suggestions: [] }, "pas Clorox (CLX) pour le pétrole");
  assert.deepEqual(resolveSymbol("CL", BROKER), { suggestions: ["CLX"] });
  assert.deepEqual(resolveSymbol("USDJ", BROKER), { suggestions: ["USDJPY.m"] });
  assert.deepEqual(resolveSymbol("Toto", BROKER), { suggestions: [] });
});

test("symbole du courtier : jamais une action pour un indice ou une matière première", () => {
  // Extrait de la vraie liste d'un courtier (compte de démo), actions comprises.
  const brokerSymbols = [
    "CL.NYS",
    "NG.LSE",
    "GAS",
    "USWTI",
    "UKBRENT",
    "VIXIndex",
    "USDIndex",
    "XAUUSD",
    "XAUUSD.i",
    "SP500",
    "DJ30",
    "NAS100",
    "GER40",
    "FR40",
    "COPPER",
    "SWISS20",
    "AAPL.NAS",
    "AMD.NAS",
    "EURUSD.i",
    "EURCAD.i",
    "AUDNZD.i",
  ];
  const cases: Array<[string, string, string?]> = [
    ["pétrole", "USWTI", "pétrole WTI"],
    ["CL", "USWTI", "pétrole WTI"],
    ["Brent", "UKBRENT", "pétrole Brent"],
    ["gaz", "GAS", "gaz naturel"],
    ["VIX", "VIXIndex", "VIX"],
    ["DXY", "USDIndex", "indice dollar"],
    ["l'or", "XAUUSD", "or"],
    ["cuivre", "COPPER", "cuivre"],
    ["SMI", "SWISS20", "SMI"],
    ["AAPL", "AAPL.NAS"],
    ["AMD", "AMD.NAS"],
    ["EURUSD", "EURUSD.i", "euro-dollar"],
    // Une paire croisée sans nom d'usage : nommée par ses devises, pas « Euro / Canadian Dollar ».
    ["EURCAD", "EURCAD.i", "euro contre dollar canadien"],
    ["AUD/NZD", "AUDNZD.i", "dollar australien contre dollar néo-zélandais"],
  ];
  for (const [query, symbol, name] of cases) {
    assert.deepEqual(resolveSymbol(query, brokerSymbols), name ? { symbol, name } : { symbol }, query);
  }
  // Sans le vrai produit chez le courtier : rien plutôt qu'une action homonyme.
  assert.ok("suggestions" in resolveSymbol("or", ["GOLD.NYS"]), "pas Barrick Gold");
  assert.ok("suggestions" in resolveSymbol("pétrole", ["CL.NYS"]), "pas Colgate");
  assert.ok("suggestions" in resolveSymbol("gaz", ["NG.LSE", "GAS.NYS"]), "pas National Grid");
});

test("normalisation : majuscules, sans accent, sans article ni séparateur", () => {
  assert.equal(normalize("l'or"), "OR");
  assert.equal(normalize("le pétrole"), "PETROLE");
  assert.equal(normalize("S&P 500"), "SP500");
  assert.equal(normalize("Lazard"), "LAZARD", "« La » d'un nom n'est pas un article");
  assert.equal(normalize("Leonardo"), "LEONARDO");
});

test("prix en français et âge de la cotation", () => {
  assert.equal(frenchPrice(21540.25, 2), "21 540,25");
  assert.equal(frenchPrice(1.08345), "1,08345");
  assert.equal(frenchPrice(1.0834, 5), "1,08340");
  assert.equal(ageLabel(1500), "à l'instant");
  assert.equal(ageLabel(42_000), "il y a 42 s");
  assert.equal(ageLabel(3 * 3_600_000), "il y a 3 h");
});

test("prix : le bon symbole, dans la région du compte, en français, sans jamais le jeton", async () => {
  const { market, calls } = setup();
  const r = await market.prices(["Nasdaq", "EURUSD"], NOW);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.source, "MetaApi, compte « Démo IC » (ICMarketsSC-Demo)");
  assert.deepEqual(r.prices[0], {
    query: "Nasdaq",
    symbol: "USTEC",
    name: "Nasdaq 100",
    price: "21 540,25",
    bid: 21540.25,
    ask: 21541.5,
    spread: "1,25",
    at: "aujourd'hui à 14:32:08",
    age: "à l'instant",
  });
  const euro = r.prices[1] as { name?: string; price?: string; spread?: string };
  assert.equal(euro.name, "euro-dollar", "une paire se dit par son nom courant");
  assert.equal(euro.price, "1,08345");
  const japan = await market.prices(["USDJPY"], NOW);
  assert.ok(!("error" in japan));
  assert.equal(japan.prices[0].symbol, "USDJPY.m");
  assert.equal(euro.spread, "0,00006");
  assert.ok(calls.includes(`${CLIENT}/users/current/accounts/acc-1/symbols/USTEC/current-price`));
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("prix : compte, région et symboles gardés en cache ; seul le prix est redemandé", async () => {
  const { market, calls } = setup();
  await market.prices(["Nasdaq"], NOW);
  const first = calls.length;
  await market.prices(["Nasdaq"], NOW);
  assert.deepEqual(calls.slice(first), [`${CLIENT}/users/current/accounts/acc-1/symbols/USTEC/current-price`]);
});

test("prix : marché fermé signalé avec l'heure de la dernière cotation", async () => {
  // Vendredi 30 octobre, 22 h 59 (heure de Paris).
  const { market } = setup({ prices: { "XAUUSD.m": { bid: 2650.4, ask: 2650.7, time: new Date(2026, 9, 30, 22, 59).toISOString() } } });
  const r = await market.prices(["or"], NOW);
  assert.ok(!("error" in r));
  const gold = r.prices[0] as Record<string, unknown>;
  assert.equal(gold.closed, "pas de cotation depuis vendredi 30 octobre à 22:59 : marché fermé ou à l'arrêt");
  assert.equal(gold.age, "il y a 4 jours");
});

test("prix : produit introuvable -> erreur pour lui seul, avec les symboles proches", async () => {
  const { market } = setup();
  const r = await market.prices(["USDJ", "Nasdaq"], NOW);
  assert.ok(!("error" in r));
  assert.deepEqual(r.prices[0], { query: "USDJ", error: "introuvable chez le courtier", suggestions: ["USDJPY.m"] });
  assert.equal((r.prices[1] as Record<string, unknown>).symbol, "USTEC");
});

test("compte pas prêt : message clair, et relu à la demande suivante", async () => {
  const { market, calls } = setup({ account: { state: "UNDEPLOYED" } });
  const r = await market.prices(["Nasdaq"], NOW);
  assert.deepEqual(r, { error: "le compte MetaApi « Démo IC » n'est pas déployé (état UNDEPLOYED) : déploie-le dans l'interface MetaApi" });
  await market.prices(["Nasdaq"], NOW);
  assert.equal(calls.filter((u) => u === `${PROV}/users/current/accounts/acc-1`).length, 2, "pas mis en cache");

  const off = setup({ account: { connectionStatus: "DISCONNECTED_FROM_BROKER" } });
  assert.match(String((await off.market.prices(["Nasdaq"], NOW)).error), /pas connecté au courtier \(DISCONNECTED_FROM_BROKER\)/);
});

test("jeton refusé, compte inconnu, réseau coupé : erreurs lisibles, sans le jeton", async () => {
  const denied = await setup({ fail: { match: "/accounts/acc-1", status: 401 } }).market.prices(["Nasdaq"], NOW);
  assert.deepEqual(denied, { error: "jeton MetaApi refusé : vérifie KOPILIA_METAAPI_TOKEN dans le fichier .env de Kopilia" });
  const unknown = await setup({ fail: { match: "/accounts/acc-1", status: 404 } }).market.prices(["Nasdaq"], NOW);
  assert.match(String(unknown.error), /compte MetaApi introuvable : vérifie KOPILIA_METAAPI_ACCOUNT_ID/);
  const down = await setup({ fail: { match: "prov.test", error: new TypeError("fetch failed") } }).market.prices(["Nasdaq"], NOW);
  assert.deepEqual(down, { error: "MetaApi injoignable (fetch failed)" });
  const busy = await setup({ fail: { match: "current-price", status: 503 } }).market.prices(["Nasdaq"], NOW);
  assert.deepEqual((busy as { prices: unknown[] }).prices[0], {
    query: "Nasdaq",
    symbol: "USTEC",
    error: "MetaApi momentanément indisponible (HTTP 503) : réessaie dans un instant",
  });
  const refused = await setup({ fail: { match: "current-price", status: 400 } }).market.prices(["Nasdaq"], NOW);
  assert.deepEqual((refused as { prices: unknown[] }).prices[0], { query: "Nasdaq", symbol: "USTEC", error: "MetaApi a répondu 400 (refusé)" });
});

test("ratés passagers de MetaApi (504, 202, réseau) : réessayés, comme le fait son SDK", async () => {
  // Le 504 réel du 3 novembre : « account is not connected to broker yet », puis tout va bien.
  const once = setup({ fail: { match: "/timeframes/1d/", status: 504, times: 1 } });
  const r = await once.market.history(["Nasdaq"], { date: "2026-10-30" }, NOW);
  assert.ok(!("error" in r));
  assert.equal((r.history[0] as Record<string, unknown>).close, "28 388,86");
  assert.equal(once.calls.filter((u) => u.includes("/timeframes/1d/")).length, 2, "un seul nouvel essai suffit");

  const preparing = setup({ fail: { match: "current-price", status: 202, times: 2, headers: { "retry-after": "0" } } });
  const p = await preparing.market.prices(["Nasdaq"], NOW);
  assert.ok(!("error" in p));
  assert.equal((p.prices[0] as Record<string, unknown>).price, "21 540,25", "202 « en préparation » : on attend la vraie réponse");

  const flaky = setup({ fail: { match: "prov.test", error: new TypeError("fetch failed"), times: 1 } });
  assert.ok(!("error" in (await flaky.market.prices(["Nasdaq"], NOW))), "coupure réseau d'un instant");

  const lost = setup({ fail: { match: "/accounts/acc-1", status: 404 } });
  await lost.market.prices(["Nasdaq"], NOW);
  assert.equal(lost.calls.filter((u) => u.endsWith("/accounts/acc-1")).length, 1, "une erreur définitive n'est pas réessayée");
});

/** Le message réel du 504 de MetaApi (4 novembre). */
const NOT_CONNECTED =
  "It seems like the account acc-1 is not connected to broker yet or request URL you use does not match the account region. Please make sure account is connected to broker";

test("504 qui dure (compte qui se reconnecte au courtier) : réessayé pendant 15 s, puis une erreur dite", async () => {
  const slow = setup({ fail: { match: "/timeframes/1d/", status: 504, times: 5 } });
  slow.market.retryDelaysMs = [0, 0, 0, 0, 0];
  const r = await slow.market.history(["Nasdaq"], { date: "2026-10-30" }, NOW);
  assert.ok(!("error" in r));
  assert.equal((r.history[0] as Record<string, unknown>).close, "28 388,86", "passé au sixième essai");
  assert.equal(slow.calls.filter((u) => u.includes("/timeframes/1d/")).length, 6);

  const down = setup({ fail: { match: "/timeframes/", status: 504 } });
  down.market.retryDelaysMs = [0, 0, 0, 0, 0];
  const d = await down.market.history(["Nasdaq"], { date: "2026-10-30" }, NOW);
  assert.ok(!("error" in d));
  assert.match(String((d.history[0] as { error?: string }).error), /504.*reconnecte au courtier/);
  assert.equal(down.calls.filter((u) => u.includes("/timeframes/1d/")).length, 6, "six essais, pas de rafale");
});

test("504 : le compte est relu ; changé de région, la requête suit ; plus connecté, son erreur lisible", async () => {
  const { market } = setup();
  market.retryDelaysMs = [0, 0, 0, 0, 0];
  market.accountRecheckMs = 0;
  const fake = market.fetchImpl;
  const seen: string[] = [];
  let account: Record<string, unknown> = { region: "london" };
  market.fetchImpl = async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (url === `${PROV}/users/current/accounts/acc-1`) return Response.json({ ...ACCOUNT, ...account });
    // L'ancienne région ne connaît plus le compte ; la nouvelle répond comme le faux MetaApi.
    if (account.region !== "london" && url.includes(".london.")) return Response.json({ message: NOT_CONNECTED }, { status: 504 });
    return fake(url.replace(".new-york.", ".london."), init);
  };
  assert.ok(!("error" in (await market.resolve("Nasdaq"))));
  account = { region: "new-york" };
  const moved = await market.chartCandles("USTEC", "1h");
  assert.ok(!("error" in moved), JSON.stringify(moved));
  assert.ok(seen.some((u) => u.startsWith("https://mt-market-data-client-api-v1.new-york.agiliumtrade.ai/")));
  assert.ok(!("error" in (await market.resolve("Nasdaq"))));
  assert.equal(seen.filter((u) => u.endsWith("/accounts/acc-1/symbols")).length, 1, "même compte : la liste des symboles reste en cache");

  account = { region: "london", connectionStatus: "DISCONNECTED" };
  market.fetchImpl = async (input, init) => {
    const url = String(input);
    if (url === `${PROV}/users/current/accounts/acc-1`) return Response.json({ ...ACCOUNT, ...account });
    if (url.includes("/timeframes/")) return Response.json({ message: NOT_CONNECTED }, { status: 504 });
    return fake(url.replace(".new-york.", ".london."), init);
  };
  const lost = await market.chartCandles("USTEC", "1h");
  assert.match(String((lost as { error?: string }).error), /n'est pas connecté au courtier \(DISCONNECTED\)/);
});

test("demandes simultanées au démarrage : le compte et le domaine ne sont lus qu'une fois", async () => {
  const { market, calls } = setup();
  await Promise.all([market.prices(["Nasdaq"], NOW), market.chartCandles("USTEC", "1h"), market.resolve("EURUSD")]);
  assert.equal(calls.filter((u) => u === `${PROV}/users/current/accounts/acc-1`).length, 1);
  assert.equal(calls.filter((u) => u.endsWith("/servers/mt-client-api")).length, 1);
});

test("Retry-After de MetaApi : en secondes ou en date HTTP (celle de ses 429), plafonné", () => {
  const now = Date.parse("2026-11-04T13:23:30.449Z");
  assert.equal(retryAfterMs("Wed, 04 Nov 2026 13:23:33 GMT", now), 2551);
  assert.equal(retryAfterMs("Wed, 04 Nov 2026 13:23:40 GMT", now), 5000, "plafonné");
  assert.equal(retryAfterMs("2", now), 2000);
  assert.equal(retryAfterMs("0", now), undefined);
  assert.equal(retryAfterMs("Wed, 04 Nov 2026 13:23:00 GMT", now), undefined, "date passée");
  assert.equal(retryAfterMs(null, now), undefined);
});

test("MetaApi refuse (429, trop de requêtes) : un seul nouvel essai, puis une erreur reconnaissable", async () => {
  const once = setup({ fail: { match: "current-price", status: 429, times: 1, headers: { "retry-after": "0" } } });
  const r = await once.market.prices(["Nasdaq"], NOW);
  assert.ok(!("error" in r), "un refus passager : réessayé");
  assert.equal(once.calls.filter((u) => u.includes("USTEC/current-price")).length, 2);

  const always = setup({ fail: { match: "current-price", status: 429, headers: { "retry-after": "0" } } });
  const refused = await always.market.prices(["Nasdaq"], NOW);
  assert.ok(!("error" in refused));
  assert.match(String((refused.prices[0] as { error?: string }).error), /trop de requêtes/);
  assert.ok(always.calls.filter((u) => u.includes("USTEC/current-price")).length <= 3, "pas de rafale contre un refus");
  // Le flux de cotations reconnaît ce refus à son code, pas à son texte.
  await assert.rejects(always.market.feed["quote"]("USTEC"), (e: unknown) => (e as { code?: string }).code === "rate_limited");
});

test("plusieurs produits : quatre requêtes MetaApi à la fois au plus (au-delà, MetaApi refuse)", async () => {
  const { market } = setup();
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = market.fetchImpl;
  market.fetchImpl = async (input, init) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await fetchImpl(input, init);
    } finally {
      inFlight--;
    }
  };
  const r = await market.prices(["Nasdaq", "EURUSD", "USDJPY", "or", "Dow", "DAX"], NOW);
  assert.ok(!("error" in r));
  assert.equal(r.prices.length, 6);
  assert.ok(peak <= 4, `requêtes simultanées : ${peak}`);
  assert.ok(peak >= 2, "les requêtes restent parallèles");
});

test("sans identifiant de compte : le seul compte, ou le seul déployé ; sinon, il faut choisir", async () => {
  const one = setup({ accountId: "" });
  assert.ok(!("error" in (await one.market.prices(["Nasdaq"], NOW))));
  assert.ok(one.calls.includes(`${PROV}/users/current/accounts`));

  const paged = setup({ accountId: "", accounts: { count: 2, items: [{ _id: "old", name: "Ancien", state: "UNDEPLOYED" }, ACCOUNT] } });
  assert.ok(!("error" in (await paged.market.prices(["Nasdaq"], NOW))), "le seul déployé");

  const two = setup({ accountId: "", accounts: [ACCOUNT, { ...ACCOUNT, _id: "acc-2", name: "Réel" }] });
  assert.deepEqual(await two.market.prices(["Nasdaq"], NOW), {
    error:
      "plusieurs comptes MetaApi (« Démo IC » (acc-1), « Réel » (acc-2)) : indique celui à utiliser dans KOPILIA_METAAPI_ACCOUNT_ID, dans le fichier .env de Kopilia",
  });
});

test("sans jeton : désactivé, aucune requête", async () => {
  const { market, calls } = setup();
  process.env.KOPILIA_METAAPI_TOKEN = "";
  const off = new MarketService(new ConfigService(), new AppLogger());
  off.fetchImpl = market.fetchImpl;
  assert.match(String((await off.prices(["Nasdaq"], NOW)).error), /il manque le jeton MetaApi \(KOPILIA_METAAPI_TOKEN\)/);
  assert.equal(calls.length, 0);
});

test("historique : la journée du courtier, dans la région du compte, sans jamais le jeton", async () => {
  const { market, calls } = setup();
  const r = await market.history(["Nasdaq"], { date: "2026-10-30" }, NOW);
  assert.ok(!("error" in r), JSON.stringify(r));
  const friday = r.history[0] as Record<string, unknown>;
  assert.equal(friday.symbol, "USTEC");
  assert.equal(friday.name, "Nasdaq 100");
  assert.equal(friday.period, "vendredi 30 octobre");
  assert.equal(friday.open, "28 995,55");
  assert.equal(friday.close, "28 388,86");
  assert.equal(friday.change, "-671,96 (-2,31 %)");
  assert.equal(friday.highAt, "14 h 30");
  assert.equal(friday.lowAt, "19 h 50");
  const daily = calls.find((u) => u.includes("/timeframes/1d/candles"))!;
  assert.match(
    daily,
    /^https:\/\/mt-market-data-client-api-v1\.london\.agiliumtrade\.ai\/.*\/symbols\/USTEC\/timeframes\/1d\/candles\?startTime=2026-10-30T12%3A00%3A00\.000Z&limit=8$/,
  );
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("historique : séance sur une plage refusée, séance pas encore ouverte, produit introuvable", async () => {
  const { market } = setup();
  assert.deepEqual(await market.history(["Nasdaq"], { period: "week", session: "new_york" }, NOW), {
    error: "une séance se demande pour un seul jour (période ou date, pas une plage)",
  });
  // Mardi 3 novembre à 14 h 32 : Wall Street ouvre à 15 h 30.
  const early = await market.history(["Nasdaq", "Toto"], { session: "new_york" }, NOW);
  assert.ok(!("error" in early));
  assert.deepEqual(early.history[0], {
    query: "Nasdaq",
    symbol: "USTEC",
    error: "la séance de New York du mardi 3 novembre (15 h 30 – 22 h, heure de Paris) n'a pas encore commencé",
  });
  assert.deepEqual(early.history[1], { query: "Toto", error: "introuvable chez le courtier" });
});

test("historique : sans jeton, désactivé", async () => {
  process.env.KOPILIA_METAAPI_TOKEN = "";
  const off = new MarketService(new ConfigService(), new AppLogger());
  assert.match(String((await off.history(["Nasdaq"], {}, NOW)).error), /il manque le jeton MetaApi/);
});

/* ------------------------------ Tableau de bord ------------------------------ */

test("produit d'un encart : symbole exact, nom courant, décimales ; introuvable avec les symboles proches", async () => {
  const { market } = setup();
  assert.deepEqual(await market.resolve("l'euro-dollar"), { symbol: "EURUSD.m", name: "euro-dollar", digits: 5 });
  assert.deepEqual(await market.resolve("Nasdaq"), { symbol: "USTEC", name: "Nasdaq 100", digits: 2 });
  assert.deepEqual(await market.resolve("USDJ"), { error: "« USDJ » introuvable chez le courtier", suggestions: ["USDJPY.m"] });
});

test("bougies d'un graphique : en secondes, les plus anciennes d'abord, jusqu'à l'instant demandé", async () => {
  const { market, calls } = setup();
  const r = await market.chartCandles("USTEC", "5m", { limit: 50 });
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.timeframe, "5m");
  assert.deepEqual(
    r.candles.map((c) => c.t),
    [Date.parse(INTRADAY[0].time) / 1000, Date.parse(INTRADAY[1].time) / 1000],
  );
  assert.deepEqual(r.candles[0], { t: Date.parse("2026-10-30T13:30:00.000Z") / 1000, o: 28700, h: 29019.59, l: 28690, c: 28800 });
  assert.equal(r.more, false, "paquet incomplet : plus rien avant");
  assert.match(
    calls.find((u) => u.includes("/timeframes/5m/"))!,
    /limit=50$/,
  );
  // Remonter le temps : les bougies après `before` sont écartées.
  const before = Date.parse(INTRADAY[0].time) / 1000;
  const older = await market.chartCandles("USTEC", "5m", { before });
  assert.ok(!("error" in older));
  assert.deepEqual(
    older.candles.map((c) => c.t),
    [before],
  );
  assert.match(calls.at(-1)!, /startTime=2026-10-30T13%3A30%3A00\.000Z&limit=400$/);
});

test("bougies d'un graphique : la même demande en route est partagée ; une grande unité est gardée un moment, jamais une erreur", async () => {
  const { market, calls } = setup();
  const weekly = () => calls.filter((u) => u.includes("/timeframes/1w/")).length;
  // Deux écrans ouvrent l'or en hebdo en même temps : une seule demande, sur six mois (MetaApi est lent à couvrir des années).
  const [a, b] = await Promise.all([market.chartCandles("USTEC", "1w"), market.chartCandles("USTEC", "1w")]);
  assert.equal(weekly(), 1);
  assert.deepEqual(a, b);
  assert.match(
    calls.find((u) => u.includes("/timeframes/1w/"))!,
    /limit=30$/,
  );
  // Rouvert peu après : gardé, MetaApi n'est pas redemandé ; le recalage de la bougie en cours, si.
  await market.chartCandles("USTEC", "1w");
  assert.equal(weekly(), 1);
  await market.chartCandles("USTEC", "1w", { limit: 3 });
  await market.chartCandles("USTEC", "1w", { limit: 3 });
  assert.equal(weekly(), 3, "un recalage n'est jamais gardé");
  // Le passé, demandé ensuite par le graphique : par paquets de deux ans.
  await market.chartCandles("USTEC", "1w", { before: Date.parse(INTRADAY[0].time) / 1000 });
  assert.match(calls.filter((u) => u.includes("/timeframes/1w/")).at(-1)!, /limit=104$/);
  // Une petite unité n'est pas gardée : chaque ouverture relit le courtier.
  await market.chartCandles("USTEC", "15m");
  await market.chartCandles("USTEC", "15m");
  assert.equal(calls.filter((u) => u.includes("/timeframes/15m/")).length, 2);

  // Une erreur n'est pas gardée : la demande suivante retente.
  const failing = setup({ fail: { match: "/timeframes/1mn/", status: 404, times: 1 } });
  assert.ok("error" in (await failing.market.chartCandles("USTEC", "1mn")));
  assert.ok(!("error" in (await failing.market.chartCandles("USTEC", "1mn"))));
  assert.match(failing.calls.filter((u) => u.includes("/timeframes/1mn/")).at(-1)!, /limit=12$/);
});

test("flux de cotations : interrogé tant qu'un écran regarde un encart, émis au changement seulement", async () => {
  const { market, calls } = setup();
  const feed = market.feed;
  feed.intervalMs = 5;
  // Horloge du double : la cotation (2 s avant NOW) est en direct, quelle que soit l'heure réelle.
  feed.now = () => NOW.getTime();
  const quotes: Array<{ symbol: string; bid: number; dayOpen?: number }> = [];
  feed.on("quote", (q) => quotes.push(q));
  feed.setSymbols(["USTEC"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quotes.length, 0, "sans écran, rien n'est interrogé");
  assert.ok(!calls.some((u) => u.includes("current-price")));

  feed.setListening(1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(quotes.length, 1, "le même prix n'est pas répété");
  assert.equal(quotes[0].bid, 21540.25);
  assert.equal(quotes[0].dayOpen, 28501.9, "ouverture de la journée du courtier (bougie quotidienne)");
  assert.ok(calls.filter((u) => u.includes("USTEC/current-price")).length >= 2, "interrogé en boucle");
  assert.deepEqual(
    feed.snapshot().map((q) => q.symbol),
    ["USTEC"],
  );

  feed.setListening(0);
  const idle = calls.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, idle, "plus d'écran : plus d'appel");
  feed.setSymbols([]);
  assert.deepEqual(feed.snapshot(), []);
  feed.stop();
});

test("indicateurs : calculés sur les bougies du courtier comme à l'écran, valeur en cours et dernière close", async () => {
  // Vingt bougies de 15 minutes en hausse continue (les plus récentes d'abord, comme MetaApi) : le RSI est à 100.
  const start = Date.UTC(2026, 10, 3, 8, 0);
  const candles = Array.from({ length: 20 }, (_, i) => {
    const close = 100 + i;
    const time = new Date(start + i * 900_000).toISOString();
    return { time, brokerTime: time.replace("T", " ").replace("Z", ""), open: close - 0.5, high: close + 0.2, low: close - 0.7, close };
  }).reverse();
  const { market, calls } = setup({ candles });
  const r = (await market.indicators("Nasdaq", "15m", [
    completeIndicator({ kind: "sma", period: 5 }, "a"),
    completeIndicator({ kind: "rsi", signal: { type: "sma", period: 3 } }, "b"),
    completeIndicator({ kind: "ema", period: 50 }, "c"),
  ])) as { name: string; price: string; timeframeLabel: string; indicators: Array<Record<string, string>> };
  assert.equal(r.name, "Nasdaq 100");
  assert.equal(r.timeframeLabel, "15 minutes");
  assert.equal(r.price, "119,00");
  assert.deepEqual(r.indicators[0], { name: "MM 5", type: "moyenne simple", value: "117,00", lastClosed: "116,00", position: "prix au-dessus" });
  assert.deepEqual(r.indicators[1], {
    name: "RSI 14",
    value: "100,0",
    lastClosed: "100,0",
    zone: "surachat",
    levels: "30 / 70",
    signal: "MM 3 du RSI : 100,0",
    versusSignal: "RSI au-dessous",
  });
  assert.match(r.indicators[2].error, /pas assez de bougies \(20 pour une longueur de 50\)/);
  assert.match(
    calls.find((u) => u.includes("/timeframes/15m/"))!,
    /limit=200$/,
    "de quoi stabiliser les moyennes",
  );
});
