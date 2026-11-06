// Heures attendues en heure de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { NewsItem } from "@kopilia/contracts";
import { AppLogger } from "../src/common/logger.js";
import { CalendarService } from "../src/calendar/calendar.service.js";
import type { MarketService } from "../src/market/market.service.js";
import { FeedError, figureCurrency, matchFigures, parseFigure, parseRss, plain, similarity } from "../src/news/financial-juice.js";
import { LIMITED_MAX_MS, LIMITED_MIN_MS, limitedBackoff, marketsOpen, nextReadAt, READ_MS, RELEASE_DELAY_MS } from "../src/news/schedule.js";
import { measureReaction, reacted, type MinuteCandle } from "../src/news/reaction.js";
import { parseTranslations, translateTurn, type TranslateInput, type Translation } from "../src/news/translator.js";
import { combineLevel, NewsBatch, NewsService, ruleLevel } from "../src/news/news.service.js";
import { newsLine, newsMessage, newsReport, newsReportPrompt, pct } from "../src/news/news-texts.js";
import { awayMessage, macTexts } from "../src/channels/away-texts.js";
import { ReportQueue } from "../src/gateway/report-queue.js";
import type { Conn } from "../src/gateway/conn.js";
import type { Report } from "../src/gateway/messages.js";
import { pick, sinceOf } from "../src/news/news.controller.js";
import { tempData } from "./harness.js";

/** Un flux au format de FinancialJuice (titres inventés), le plus récent d'abord. */
function rss(items: Array<{ guid: string; at: string; title: string; text?: string }>): string {
  const body = items
    .map(
      (i) =>
        `<item><title>FinancialJuice: ${i.title}</title><link>https://www.financialjuice.com/News/${i.guid}/x.aspx?xy=rss</link>` +
        `<description>${i.text ?? ""}</description><author>FinancialJuice</author><pubDate>${new Date(i.at).toUTCString()}</pubDate>` +
        `<guid isPermaLink="false">${i.guid}</guid></item>`,
    )
    .join("");
  return `<rss version="2.0"><channel><title>FinancialJuice</title><link>https://www.financialjuice.com</link><description />${body}</channel></rss>`;
}

/** Jeudi 5 novembre 2026, 14:30 à Paris (13:30 UTC) : les inscriptions au chômage. */
const RELEASE = Date.parse("2026-11-05T13:30:00Z");
const ITEMS = [
  { guid: "1004", at: "2026-11-05T13:40:12Z", title: "Fed's Example: Policy is roughly neutral &amp; data dependent" },
  { guid: "1003", at: "2026-11-05T13:30:03Z", title: "US Productivity Prelim Actual 3.6% (Forecast 2.7%, Previous 1.4%, Revised 2.1%)" },
  { guid: "1002", at: "2026-11-05T13:30:01Z", title: "US Continued Jobless Claims Actual 1.718M (Forecast 1.71M, Previous 1.701M)" },
  { guid: "1001", at: "2026-11-05T13:30:01Z", title: "US Initial Jobless Claims Actual 189k (Forecast 196k, Previous 194k, Revised 195K)" },
  {
    guid: "1000",
    at: "2026-11-05T13:20:00Z",
    title: "Bank X: Rotation looks positioning-driven - FJElite",
    text: "&lt;div&gt;Breadth &amp;amp; positioning&lt;/div&gt;",
  },
];
const CALENDAR = [
  { title: "Unemployment Claims", country: "USD", date: "2026-11-05T08:30:00-05:00", impact: "High", forecast: "197K", previous: "194K" },
  { title: "Prelim Nonfarm Productivity q/q", country: "USD", date: "2026-11-05T08:30:00-05:00", impact: "Low", forecast: "2.8%", previous: "1.4%" },
  { title: "Prelim Unit Labor Costs q/q", country: "USD", date: "2026-11-05T08:30:00-05:00", impact: "Low", forecast: "0.3%", previous: "1.3%" },
  { title: "Natural Gas Storage", country: "USD", date: "2026-11-05T10:30:00-05:00", impact: "Low", forecast: "81B", previous: "80B" },
];

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/* ------------------------------- Le flux ------------------------------- */

test("flux RSS : titres sans le préfixe du site, entités décodées, texte en clair, du plus récent au plus ancien", () => {
  const items = parseRss(rss(ITEMS));
  assert.equal(items.length, 5);
  assert.equal(items[0].guid, "1004");
  assert.equal(items[0].title, "Fed's Example: Policy is roughly neutral & data dependent");
  assert.equal(items[0].at, Date.parse("2026-11-05T13:40:12Z"));
  assert.equal(items.at(-1)!.text, "Breadth & positioning");
  assert.equal(items[0].text, undefined, "description vide : pas de texte");
  assert.equal(
    plain("&lt;ul&gt;&lt;li&gt;High Yield 3.890%&lt;/li&gt;&lt;li&gt;Bid-to-cover 2.46&lt;/li&gt;&lt;/ul&gt;"),
    "High Yield 3.890%\nBid-to-cover 2.46",
  );
});

test("flux RSS : la limite de débit (1015) et une page inattendue sont des erreurs distinctes", () => {
  assert.throws(
    () => parseRss("error code: 1015"),
    (e: unknown) => e instanceof FeedError && e.limited,
  );
  assert.throws(
    () => parseRss("<html><body>Just a moment...</body></html>"),
    (e: unknown) => e instanceof FeedError && !e.limited,
  );
});

test("chiffre publié : lu dans le titre, « Forecast - » ignoré, rien sur un titre ordinaire", () => {
  assert.deepEqual(parseFigure("US Initial Jobless Claims Actual 189k (Forecast 196k, Previous 194k, Revised 195K)"), {
    event: "US Initial Jobless Claims",
    actual: "189k",
    forecast: "196k",
    previous: "194k",
    revised: "195K",
  });
  assert.deepEqual(parseFigure("US 4-Week Bill High Yield Actual 3.89% (Forecast -, Previous 3.910%)"), {
    event: "US 4-Week Bill High Yield",
    actual: "3.89%",
    previous: "3.910%",
  });
  assert.equal(parseFigure("Fed's Barkin: Policy right now is somewhere around neutral."), undefined);
  assert.equal(figureCurrency("US Initial Jobless Claims"), "USD");
  assert.equal(figureCurrency("UK GDP MoM"), "GBP");
  assert.equal(figureCurrency("Fed bids for 4-week bills"), undefined);
});

test("rapprochement : chaque chiffre trouve son annonce (même devise, même minute), les inscriptions continues restent seules", () => {
  const events = CALENDAR.map((e) => ({ at: Date.parse(e.date), country: e.country, title: e.title, impact: e.impact.toLowerCase(), forecast: e.forecast }));
  const figures = [
    "US Initial Jobless Claims Actual 189k (Forecast 196k, Previous 194k)",
    "US Continued Jobless Claims Actual 1.718M (Forecast 1.71M, Previous 1.701M)",
    "US Productivity Prelim Actual 3.6% (Forecast 2.7%, Previous 1.4%)",
    "US Unit Labor Costs Prelim Actual -0.7% (Forecast 0.4%, Previous 1.2%)",
  ].map((t, i) => ({ at: RELEASE + 1000 + i * 1000, figure: parseFigure(t)! }));
  const gas = { at: Date.parse("2026-11-05T15:30:01Z"), figure: parseFigure("EIA Natural Gas Change BCF Actual 77B (Forecast 78B, Previous 80B)")! };
  const found = matchFigures([...figures, gas], events).map((e) => e?.title);
  assert.deepEqual(found, ["Unemployment Claims", undefined, "Prelim Nonfarm Productivity q/q", "Prelim Unit Labor Costs q/q", "Natural Gas Storage"]);
  // Hors de la fenêtre de quelques minutes : rien.
  assert.deepEqual(matchFigures([{ at: RELEASE + 3_600_000, figure: figures[0].figure }], events), [undefined]);
  // La période distingue deux annonces de la même minute.
  assert.ok(similarity("US CPI MoM", "CPI m/m") > similarity("US CPI MoM", "CPI y/y"));
});

/* ------------------------------ Le rythme ------------------------------ */

test("rythme : 2 min, resserré pour lire 10 s après une annonce forte, jamais plus souvent", () => {
  const last = RELEASE - 5 * 60_000;
  // Sans annonce : 2 minutes après la dernière lecture.
  assert.equal(nextReadAt({ last, now: last + 1000, interval: READ_MS, releases: [] }), last + READ_MS);
  // Une annonce dans 5 min : deux lectures de 2 min 30 s, la seconde 10 s après l'annonce.
  const next = nextReadAt({ last, now: last + 1000, interval: READ_MS, releases: [RELEASE] });
  assert.equal(next, last + (5 * 60_000 + RELEASE_DELAY_MS) / 2);
  assert.equal(nextReadAt({ last: next, now: next, interval: READ_MS, releases: [RELEASE] }), RELEASE + RELEASE_DELAY_MS);
  // Une annonce trop proche de la dernière lecture : lue à la suivante, au rythme normal.
  const close = RELEASE - 30_000;
  assert.equal(nextReadAt({ last: close, now: close, interval: READ_MS, releases: [RELEASE] }), close + READ_MS);
  // Limite de débit : 4, 8, puis 15 minutes au plus.
  assert.equal(limitedBackoff(undefined), LIMITED_MIN_MS);
  assert.equal(limitedBackoff(LIMITED_MIN_MS), 2 * LIMITED_MIN_MS);
  assert.equal(limitedBackoff(2 * LIMITED_MIN_MS), LIMITED_MAX_MS);
  assert.equal(limitedBackoff(LIMITED_MAX_MS), LIMITED_MAX_MS);
});

test("marchés ouverts du dimanche soir au vendredi soir", () => {
  assert.equal(marketsOpen(Date.parse("2026-11-05T13:30:00Z")), true);
  assert.equal(marketsOpen(Date.parse("2026-11-07T12:00:00Z")), false, "samedi");
  assert.equal(marketsOpen(Date.parse("2026-11-08T20:00:00Z")), false, "dimanche avant l'ouverture");
  assert.equal(marketsOpen(Date.parse("2026-11-08T22:30:00Z")), true, "dimanche soir");
  assert.equal(marketsOpen(Date.parse("2026-11-06T22:30:00Z")), false, "vendredi soir");
});

/* ------------------------- Réaction du marché ------------------------- */

/** Soixante minutes calmes (amplitude 1), puis ce qu'on veut à partir de la minute de la news. */
function minutes(at: number, after: Array<[number, number, number, number]>): MinuteCandle[] {
  const start = Math.floor(at / 60_000) * 60;
  const calm: MinuteCandle[] = Array.from({ length: 60 }, (_, i) => ({ t: start - (60 - i) * 60, o: 100, h: 100.5, l: 99.5, c: 100 }));
  return [...calm, ...after.map(([o, h, l, c], i) => ({ t: start + i * 60, o, h, l, c }))];
}

test("réaction : un mouvement de plusieurs fois l'amplitude habituelle compte, le bruit non", () => {
  const strong = measureReaction(
    minutes(RELEASE + 1000, [
      [100, 100.4, 99.9, 100.3],
      [100.3, 104.5, 100.2, 104],
      [104, 104.2, 103.5, 103.8],
    ]),
    RELEASE + 1000,
  );
  assert.ok(strong);
  assert.equal(Math.round(strong.changePct * 100) / 100, 4.5);
  assert.equal(strong.strength, 4.5);
  assert.ok(reacted(strong));
  const noise = measureReaction(
    minutes(RELEASE, [
      [100, 100.6, 99.6, 100.2],
      [100.2, 100.7, 99.8, 100],
    ]),
    RELEASE,
  );
  assert.ok(noise && !reacted(noise));
  const down = measureReaction(minutes(RELEASE, [[100, 100.1, 95, 95.5]]), RELEASE);
  assert.ok(down && down.changePct < 0 && reacted(down));
  // Pas d'historique avant la news : rien à mesurer.
  assert.equal(measureReaction([{ t: RELEASE / 1000, o: 1, h: 2, l: 1, c: 2 }], RELEASE), undefined);
});

/* ----------------------------- Traduction ----------------------------- */

test("traduction : le lot porte la liste et les titres ; la réponse est vérifiée titre par titre", () => {
  const turn = translateTurn(
    [{ id: "nw_1", time: "14:30", title: "US Initial Jobless Claims Actual 189k", release: "Unemployment Claims (USD), impact high" }],
    [{ symbol: "XAUUSD", name: "or" }, { symbol: "NAS100" }],
  );
  assert.match(turn, /Sa liste \(symboles à rendre tels quels\) : XAUUSD \(or\), NAS100\./);
  assert.match(turn, /"annonce":"Unemployment Claims \(USD\), impact high"/);
  const reply =
    'Voici :\n```json\n[{"id":"nw_1","fr":"Inscriptions au chômage (US) : 189 k, attendu 196 k","impact":"Emploi solide : pression sur l\'or.","symbols":["xauusd","BTCUSD"],"level":"high"},' +
    '{"id":"nw_2","fr":"  Un titre   ","impact":null,"symbols":[],"level":"urgent"},{"id":"inconnu","fr":"x","level":"low"},{"id":"nw_3","fr":""}]\n```';
  const out = parseTranslations(reply, ["nw_1", "nw_2", "nw_3"], [{ symbol: "XAUUSD" }, { symbol: "NAS100" }]);
  assert.deepEqual(out, [
    { id: "nw_1", fr: "Inscriptions au chômage (US) : 189 k, attendu 196 k", impact: "Emploi solide : pression sur l'or.", symbols: ["XAUUSD"], level: "high" },
    { id: "nw_2", fr: "Un titre", symbols: [], level: "low" },
  ]);
  assert.deepEqual(parseTranslations("pas de JSON", ["nw_1"], []), []);
});

test("niveaux : un aperçu payant reste faible, un chiffre prend l'impact de son annonce, hors calendrier moyen au plus", () => {
  assert.equal(ruleLevel(true, false, undefined), "low");
  assert.equal(ruleLevel(false, true, "high"), "high");
  assert.equal(ruleLevel(false, true, "low"), "low");
  assert.equal(ruleLevel(false, false, undefined), undefined);
  assert.equal(combineLevel(ruleLevel(false, true, "low"), true, "high"), "low");
  assert.equal(combineLevel(undefined, true, "high"), "medium");
  assert.equal(combineLevel(undefined, false, "high"), "high");
});

/* ------------------------------ Le service ------------------------------ */

type Reply = string | { status: number; body: string } | Error;

function setup(
  opts: { replies?: Reply[]; now?: number; translate?: (items: TranslateInput[]) => Translation[] | Promise<Translation[]>; candles?: MinuteCandle[] } = {},
) {
  const data = tempData("news", {
    KOPILIA_NEWS_FEED_URL: "https://fj.test/feed.ashx?xy=rss",
    KOPILIA_FF_CALENDAR_URL: "https://ff.test/ff_calendar_thisweek.json",
    KOPILIA_SETUP_PRODUCTS: "XAUUSD,NAS100,EURUSD,USOIL",
    KOPILIA_NEWS_REACTIONS: "1",
  });
  const { config, db } = data;
  const logger = new AppLogger();
  const calendar = new CalendarService(db, config, logger);
  calendar.fetchImpl = async () => new Response(JSON.stringify(CALENDAR), { status: 200 });
  const market = {
    resolve: async (q: string) =>
      q === "USOIL" ? { symbol: "USWTI", name: "pétrole WTI" } : { symbol: q, name: q === "XAUUSD" ? "or" : q === "NAS100" ? "Nasdaq 100" : q },
    chartCandles: async () => ({ error: "pas en test" }),
  } as unknown as MarketService;
  const news = new NewsService(db, config, logger, calendar, market);
  const replies = opts.replies ?? [rss(ITEMS)];
  const counter = { calls: 0, translated: [] as TranslateInput[][], products: [] as unknown[] };
  news.fetchImpl = async () => {
    const reply = replies[Math.min(counter.calls++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    const { status, body } = typeof reply === "string" ? { status: 200, body: reply } : reply;
    return new Response(body, { status });
  };
  let clock = opts.now ?? Date.parse("2026-11-05T13:42:00Z");
  news.now = () => clock;
  news.translate = async (items, products) => {
    counter.translated.push(items);
    counter.products = products;
    return opts.translate ? opts.translate(items) : items.map((i) => ({ id: i.id, fr: `FR ${i.title}`, symbols: ["XAUUSD"], level: "medium" as const }));
  };
  news.candles = async () => opts.candles;
  const batches: NewsBatch[] = [];
  news.on("batch", (b) => batches.push(b));
  cleanup.push(() => {
    news.onModuleDestroy();
    data.cleanup();
  });
  return { news, calendar, counter, batches, db, setNow: (t: number) => (clock = t) };
}

test("lecture : les news gardées une fois, traduites en un lot, les chiffres rapprochés du calendrier", async () => {
  const t = setup();
  await t.calendar.refresh(new Date("2026-11-05T13:00:00Z"));
  assert.equal(await t.news.read(), "ok");
  assert.equal(t.counter.translated.length, 1);
  assert.equal(t.counter.translated[0].length, 5);
  const claims = t.counter.translated[0].find((i) => i.id === "nw_1001")!;
  assert.match(claims.release!, /Unemployment Claims \(USD\), impact high, consensus du calendrier 197K/);
  assert.equal(claims.time, "14:30");
  // Sa liste avec les symboles du courtier : USOIL est USWTI chez lui.
  assert.deepEqual(t.counter.products, [
    { symbol: "XAUUSD", name: "or" },
    { symbol: "NAS100", name: "Nasdaq 100" },
    { symbol: "EURUSD", name: "EURUSD" },
    { symbol: "USWTI", name: "pétrole WTI" },
  ]);
  const items = t.news.list();
  assert.equal(items.length, 5);
  assert.equal(items[0].id, "nw_1004");
  const fig = items.find((n) => n.id === "nw_1001")!;
  assert.equal(fig.level, "high", "le chiffre d'une annonce forte est fort, quoi qu'en dise Haiku");
  assert.deepEqual(fig.figure?.calendar, { title: "Unemployment Claims", country: "USD", impact: "high", forecast: "197K" });
  assert.equal(items.find((n) => n.id === "nw_1002")!.figure?.calendar, undefined);
  assert.equal(items.find((n) => n.id === "nw_1000")!.level, "low", "aperçu payant");
  assert.equal(items.find((n) => n.id === "nw_1000")!.elite, true);
  // Le calendrier donne désormais le chiffre publié.
  const day = t.calendar.events(RELEASE - 1, RELEASE + 1, ["high"]);
  assert.equal(day[0].actual, "189k");
  // Une seconde lecture du même flux n'ajoute rien et ne retraduit rien.
  t.setNow(Date.parse("2026-11-05T13:44:00Z"));
  assert.equal(await t.news.read(), "ok");
  assert.equal(t.counter.translated.length, 1);
  assert.equal(t.news.list().length, 5);
});

test("annonce : seules les news fortes et fraîches sont à dire, une seule fois", async () => {
  const t = setup({ now: Date.parse("2026-11-05T13:35:00Z") });
  await t.calendar.refresh(new Date("2026-11-05T13:00:00Z"));
  await t.news.read();
  assert.equal(t.batches.length, 1);
  assert.equal(t.batches[0].items.length, 5);
  assert.deepEqual(
    t.batches[0].announce.map((a) => a.item.id),
    ["nw_1001"],
  );
  assert.equal(t.batches[0].announce[0].heading, "News · Or");
  assert.match(t.batches[0].announce[0].detail, /^FR US Initial Jobless Claims/);
  // Relue plus tard (nouvelle news), elle n'est pas redite.
  t.setNow(Date.parse("2026-11-05T13:37:00Z"));
  await t.news.read();
  assert.equal(t.batches.length, 1, "rien de nouveau : aucun envoi");
});

test("annonce : une news forte trop ancienne (démarrage tardif) va seulement dans l'encart", async () => {
  const t = setup({ now: Date.parse("2026-11-05T15:00:00Z") });
  await t.calendar.refresh(new Date("2026-11-05T13:00:00Z"));
  await t.news.read();
  assert.equal(t.batches[0].announce.length, 0);
});

test("traduction ratée : la news part en anglais (le chiffre en français simple) et la traduction est retentée", async () => {
  let fail = true;
  const t = setup({
    now: Date.parse("2026-11-05T13:35:00Z"),
    translate: (items) => {
      if (fail) throw new Error("claude absent");
      return items.map((i) => ({ id: i.id, fr: `FR ${i.title}`, symbols: [], level: "low" as const }));
    },
  });
  await t.calendar.refresh(new Date("2026-11-05T13:00:00Z"));
  await t.news.read();
  const first = t.batches[0].items.find((n) => n.id === "nw_1001")!;
  assert.equal(first.translated, false);
  assert.equal(first.title, "Unemployment Claims : 189k (attendu 196k, précédent 194k)");
  assert.equal(t.batches[0].announce.length, 1, "le chiffre fort est dit quand même");
  fail = false;
  t.setNow(Date.parse("2026-11-05T13:37:00Z"));
  await t.news.read();
  assert.equal(t.counter.translated.at(-1)!.length, 5, "les cinq retentées");
  assert.ok(t.news.list().every((n) => n.translated));
  assert.equal(t.batches.at(-1)!.announce.length, 0, "déjà dite : pas redite");
});

test("limite de débit et erreurs : rien n'est gardé, la lecture suivante s'espace", async () => {
  const t = setup({ replies: [{ status: 429, body: "error code: 1015" }, "error code: 1015", new Error("ECONNRESET"), rss(ITEMS)] });
  assert.equal(await t.news.read(), "limited");
  const now = Date.parse("2026-11-05T13:42:00Z");
  assert.equal(t.news.nextAt("limited"), now + LIMITED_MIN_MS);
  assert.equal(await t.news.read(), "limited");
  assert.equal(t.news.nextAt("limited"), now + 2 * LIMITED_MIN_MS);
  assert.equal(await t.news.read(), "error");
  assert.equal(t.news.list().length, 0);
  assert.equal(await t.news.read(), "ok");
  assert.equal(t.news.list().length, 5);
});

test("archive : par produit, par niveau, et recherche par mots dans le titre d'origine ou la traduction", async () => {
  const t = setup({
    translate: (items) =>
      items.map((i) => ({
        id: i.id,
        fr: i.title.startsWith("Fed") ? "La Fed : politique à peu près neutre" : `FR ${i.title}`,
        symbols: i.title.startsWith("Fed") ? ["NAS100", "EURUSD"] : [],
        level: "medium" as const,
      })),
  });
  await t.news.read();
  assert.deepEqual(
    t.news.list({ symbol: "NAS100" }).map((n) => n.id),
    ["nw_1004"],
  );
  assert.deepEqual(
    t.news.list({ query: "neutre" }).map((n) => n.id),
    ["nw_1004"],
  );
  assert.deepEqual(
    t.news.list({ query: "jobless" }).map((n) => n.id),
    ["nw_1002", "nw_1001"],
  );
  assert.equal(t.news.list({ minLevel: "high" }).length, 0);
  assert.equal(t.news.list({ since: Date.parse("2026-11-05T13:35:00Z") }).length, 1);
});

test("réaction du marché : nette, elle est gardée, la news passe forte et elle est dite", async () => {
  const at = Date.parse("2026-11-05T13:40:12Z");
  const t = setup({
    now: at + 60_000,
    candles: minutes(at, [
      [100, 100.3, 99.9, 100.2],
      [100.2, 104, 100.1, 103.5],
      [103.5, 103.9, 103, 103.2],
    ]),
  });
  await t.news.read();
  const r = await t.news.checkReaction("nw_1004");
  assert.ok(r);
  assert.equal(r.name, "or");
  const item = t.news.list().find((n) => n.id === "nw_1004")!;
  assert.equal(item.level, "high");
  assert.deepEqual(item.reaction, r);
  const last = t.batches.at(-1)!;
  assert.equal(last.update, true);
  assert.equal(last.reaction, true);
  assert.deepEqual(
    last.announce.map((a) => a.item.id),
    ["nw_1004"],
  );
  // Mesurée une fois : pas deux.
  assert.equal(await t.news.checkReaction("nw_1004"), undefined);
});

/* ------------------------------ Les mots ------------------------------ */

const ITEM: NewsItem = {
  id: "nw_1001",
  at: RELEASE + 1000,
  title: "Inscriptions au chômage (US) : 189 k, attendu 196 k",
  original: "US Initial Jobless Claims Actual 189k (Forecast 196k, Previous 194k)",
  translated: true,
  impact: "Emploi solide : pression sur l'or.",
  symbols: ["XAUUSD"],
  level: "high",
};

test("textes : la ligne pour Kopilia, le tour qui la fait dire, Telegram et la notification", () => {
  const now = RELEASE + 120_000;
  assert.equal(newsLine(ITEM, now), "14:30 · forte · Inscriptions au chômage (US) : 189 k, attendu 196 k — Emploi solide : pression sur l'or.");
  const reacted = { ...ITEM, reaction: { symbol: "XAUUSD", name: "or", changePct: -0.42, strength: 5.1, minutes: 2 } };
  assert.match(newsLine(reacted, now), / · or −0,42 % en 2 min$/);
  assert.equal(pct(0.5), "+0,50 %");
  const prompt = newsReportPrompt([ITEM]);
  assert.match(prompt, /^\[News\] Une news importante vient de tomber :\n- Inscriptions/);
  assert.match(prompt, /en une ou deux phrases en tout : le fait, puis l'orientation probable sur les produits qu'elle touche/);
  assert.match(prompt, /pour ou contre un de ses trades en cours/);
  assert.doesNotMatch(prompt, /conseil/);
  assert.match(newsReportPrompt([reacted], true), /Le marché vient de réagir nettement/);
  assert.match(newsReportPrompt([reacted], true), /ce qui pourrait suivre/);
  const report = newsReport([ITEM], false, "News · Or", now);
  assert.equal(report.expiresAt, now + 5 * 60_000);
  const names = { XAUUSD: "or" };
  assert.deepEqual(newsMessage([ITEM], new Map(Object.entries(names)), now), {
    title: "News · Or",
    text: "14:30 Inscriptions au chômage (US) : 189 k, attendu 196 k\nEmploi solide : pression sur l'or.",
  });
  assert.deepEqual(awayMessage({ kind: "news", items: [ITEM], names }), newsMessage([ITEM], new Map(Object.entries(names))));
  // Plusieurs produits touchés : « News », sans en choisir un.
  assert.equal(newsMessage([{ ...ITEM, symbols: ["EURUSD.i", "XAUUSD"] }], new Map([["EURUSD.i", "euro-dollar"]]), now).title, "News");
  assert.deepEqual(macTexts({ kind: "news", items: [ITEM], names }), {
    title: "News · Or",
    detail: "Inscriptions au chômage (US) : 189 k, attendu 196 k · Emploi solide : pression sur l'or.",
  });
});

test("file des rapports : une news périmée n'est plus dite, le rapport suivant part", async () => {
  const said: string[] = [];
  const queue = new ReportQueue({ busy: () => false, alive: () => true, run: (_c, r) => said.push(r.turnId) }, 1);
  const conn = { sessionId: "s1" } as Conn;
  const stale: Report = { turnId: "news_old", jobId: "nw_1", title: "News", prompt: "…", expiresAt: Date.now() - 1 };
  const brief: Report = { turnId: "brief_1", jobId: "b1", title: "Wrap", prompt: "…" };
  queue.add(conn, stale);
  queue.add(conn, brief);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(said, ["brief_1"]);
  queue.stop();
});

test("outil du dialogue : « depuis 13 h » aujourd'hui, et les fortes d'abord quand la journée est chargée", () => {
  const now = Date.parse("2026-11-05T17:30:00Z");
  assert.equal(sinceOf("13:00", now), Date.parse("2026-11-05T12:00:00Z"));
  assert.equal(sinceOf("7h", now), Date.parse("2026-11-05T06:00:00Z"));
  assert.equal(sinceOf("2026-11-04 15:30", now), Date.parse("2026-11-04T14:30:00Z"));
  assert.equal(sinceOf("25:00", now), undefined);
  assert.equal(sinceOf("hier", now), undefined);
  const day = [
    { ...ITEM, id: "a", at: 5, level: "low" as const },
    { ...ITEM, id: "b", at: 4, level: "medium" as const },
    { ...ITEM, id: "c", at: 3, level: "low" as const },
    { ...ITEM, id: "d", at: 2, level: "high" as const },
    { ...ITEM, id: "e", at: 1, level: "low" as const },
  ];
  assert.deepEqual(
    pick(day, 3).map((n) => n.id),
    ["a", "b", "d"],
  );
  assert.equal(pick(day, 10).length, 5);
});
