// Heures attendues en heure de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppLogger } from "../src/common/logger.js";
import { CalendarService, refreshPoint } from "../src/calendar/calendar.service.js";
import { FeedError, formatEvent, parseFeed, periodRange } from "../src/calendar/forex-factory.js";
import { tempData } from "./harness.js";

/** Extrait du flux réel (semaine du 1er novembre 2026), heures de New York. */
const FEED = [
  { title: "Daylight Saving Time Shift", country: "USD", date: "2026-11-01T02:00:00-05:00", impact: "Holiday", forecast: "", previous: "" },
  { title: "Final Manufacturing PMI", country: "EUR", date: "2026-11-02T04:00:00-05:00", impact: "Low", forecast: "50.0", previous: "50.0" },
  { title: "ISM Manufacturing PMI", country: "USD", date: "2026-11-02T10:00:00-05:00", impact: "High", forecast: "49.5", previous: "49.1" },
  { title: "Cash Rate", country: "AUD", date: "2026-11-02T22:30:00-05:00", impact: "High", forecast: "3.60%", previous: "3.60%" },
  { title: "JOLTS Job Openings", country: "USD", date: "2026-11-03T10:00:00-05:00", impact: "Medium", forecast: "7.20M", previous: "7.23M" },
  { title: "Non-Farm Employment Change", country: "USD", date: "2026-11-06T08:30:00-05:00", impact: "High", forecast: "110K", previous: "254K" },
  { title: 42, country: "USD", date: "2026-11-03T10:00:00-05:00" }, // inexploitable
];
const BODY = JSON.stringify(FEED);
/** Lundi 2 novembre 2026, 13 h (heure de Paris). */
const NOW = new Date(2026, 10, 2, 13, 0);
const later = (min: number, from = NOW) => new Date(from.getTime() + min * 60_000);

type Reply = string | Error | { status: number; body: string };

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/** Service sur une base neuve, avec un faux Forex Factory qui compte les requêtes. */
function setup(replies: Reply[] = [BODY], opts: { url?: string; delayMs?: number } = {}) {
  const data = tempData("cal", { KOPILIA_FF_CALENDAR_URL: opts.url ?? "https://ff.test/ff_calendar_thisweek.json" });
  const { config, db } = data;
  const calendar = new CalendarService(db, config, new AppLogger());
  const counter = { calls: 0 };
  calendar.fetchImpl = async () => {
    const reply = replies[Math.min(counter.calls++, replies.length - 1)];
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (reply instanceof Error) throw reply;
    const { status, body } = typeof reply === "string" ? { status: 200, body: reply } : reply;
    return new Response(body, { status });
  };
  cleanup.push(() => data.cleanup());
  return { calendar, counter, config };
}

test("flux : annonces lues et triées, entrées inexploitables écartées, semaine couverte", () => {
  const feed = parseFeed(BODY);
  assert.equal(feed.events.length, 6);
  assert.equal(feed.skipped, 1);
  const ism = feed.events.find((e) => e.title === "ISM Manufacturing PMI")!;
  assert.deepEqual(ism, {
    at: Date.parse("2026-11-02T15:00:00Z"),
    country: "USD",
    title: "ISM Manufacturing PMI",
    impact: "high",
    forecast: "49.5",
    previous: "49.1",
  });
  assert.equal(feed.events[0].impact, "holiday");
  assert.equal(feed.events[0].forecast, null, "valeur vide -> absente");
  // Du dimanche 1er novembre 0 h à New York (5 h UTC), pour sept jours.
  assert.equal(feed.week.start, Date.parse("2026-11-01T05:00:00Z"));
  assert.equal(feed.week.end, Date.parse("2026-11-08T05:00:00Z"));
});

test("flux : page de refus (trop de requêtes) ou contenu inattendu -> erreur lisible", () => {
  assert.throws(
    () => parseFeed("<html>Request Denied</html>"),
    (e: Error) => e instanceof FeedError && /limite de requêtes/.test(e.message),
  );
  assert.throws(() => parseFeed('{"error":1}'), FeedError);
  assert.throws(() => parseFeed("[]"), /aucun événement/);
});

test("heures converties de New York vers Paris, changements d'heure compris", () => {
  const [ism] = parseFeed(JSON.stringify([FEED[2]])).events;
  assert.equal(formatEvent(ism), "16:00 · USD · ISM Manufacturing PMI · impact fort · prévision 49.5 · précédent 49.1");
  // 27 octobre : New York encore à l'heure d'été (-4), Paris déjà à l'heure d'hiver (+1) : 5 h d'écart.
  const [cpi] = parseFeed(
    JSON.stringify([{ title: "CPI m/m", country: "USD", date: "2026-10-27T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.4%" }]),
  ).events;
  assert.match(formatEvent(cpi), /^13:30 · USD · CPI m\/m/);
  const [holiday] = parseFeed(JSON.stringify([FEED[0]])).events;
  assert.equal(formatEvent(holiday), "journée · USD · Daylight Saving Time Shift · férié ou jour particulier");
});

test("périodes : jour, lendemain, semaine du lundi au dimanche, date précise", () => {
  assert.equal(periodRange(undefined, undefined, NOW).label, "lundi 2 novembre");
  const tomorrow = periodRange("tomorrow", undefined, NOW);
  assert.equal(tomorrow.start, new Date(2026, 10, 3).getTime());
  const week = periodRange("week", undefined, new Date(2026, 10, 5, 9));
  assert.equal(week.start, new Date(2026, 10, 2).getTime());
  assert.equal(week.end, new Date(2026, 10, 9).getTime());
  assert.equal(week.label, "semaine du lundi 2 novembre au dimanche 8 novembre");
  assert.equal(periodRange("today", "2026-11-06", NOW).label, "vendredi 6 novembre");
});

test("rendez-vous de mise à jour : 6 h, 12 h et 18 h", () => {
  assert.equal(refreshPoint(new Date(2026, 10, 3, 5, 59)), new Date(2026, 10, 2, 18).getTime(), "la nuit : celui de la veille à 18 h");
  assert.equal(refreshPoint(new Date(2026, 10, 3, 6, 0)), new Date(2026, 10, 3, 6).getTime());
  assert.equal(refreshPoint(new Date(2026, 10, 3, 11, 59)), new Date(2026, 10, 3, 6).getTime());
  assert.equal(refreshPoint(new Date(2026, 10, 3, 12, 0)), new Date(2026, 10, 3, 12).getTime());
  assert.equal(refreshPoint(new Date(2026, 10, 3, 23, 0)), new Date(2026, 10, 3, 18).getTime());
});

test("première question : récupère le calendrier, répond en heure de Paris ; la suivante est servie en local", async () => {
  const { calendar, counter } = setup();
  const r = (await calendar.lookup({}, NOW)) as Record<string, unknown>;
  assert.equal(counter.calls, 1);
  assert.equal(r.timezone, "heure de Paris");
  assert.equal(r.period, "lundi 2 novembre");
  assert.equal(r.updated, "aujourd'hui à 13:00");
  assert.deepEqual(r.days, [
    {
      day: "lundi 2 novembre",
      events: [
        "10:00 · EUR · Final Manufacturing PMI · impact faible · prévision 50.0 · précédent 50.0",
        "16:00 · USD · ISM Manufacturing PMI · impact fort · prévision 49.5 · précédent 49.1",
      ],
    },
  ]);
  assert.match((r.notes as string[]).join(" "), /chiffre publié n'y figure pas/);

  await calendar.lookup({ period: "tomorrow" }, later(30));
  assert.equal(counter.calls, 1, "déjà à jour aujourd'hui : aucune requête");
});

test("semaine : impact moyen et fort par défaut ; filtres d'impact et de devise", async () => {
  const { calendar } = setup();
  const week = (await calendar.lookup({ period: "week" }, NOW)) as { days: Array<{ day: string; events: string[] }> };
  assert.deepEqual(
    week.days.map((d) => d.day),
    ["lundi 2 novembre", "mardi 3 novembre", "vendredi 6 novembre"],
  );
  assert.match(week.days[1].events[0], /^04:30 · AUD · Cash Rate/, "22 h 30 à New York = 4 h 30 le lendemain à Paris");
  assert.ok(!JSON.stringify(week).includes("Final Manufacturing PMI"), "impact faible écarté");

  const usdHigh = (await calendar.lookup({ period: "week", impact: "high", currencies: ["usd"] }, NOW)) as { days: Array<{ events: string[] }> };
  assert.deepEqual(
    usdHigh.days.flatMap((d) => d.events.map((e) => e.split(" · ")[2])),
    ["ISM Manufacturing PMI", "Non-Farm Employment Change"],
  );

  const none = (await calendar.lookup({ date: "2026-11-07" }, NOW)) as Record<string, unknown>;
  assert.deepEqual(none.days, []);
  assert.match(String(none.empty), /aucune annonce/);
});

test("trois fois par jour : nouvelle requête après 18 h, puis le lendemain dès 6 h, pas entre-temps", async () => {
  const { calendar, counter } = setup();
  await calendar.lookup({}, NOW);
  await calendar.lookup({}, new Date(2026, 10, 2, 17, 59));
  assert.equal(counter.calls, 1, "la mise à jour de 13 h vaut jusqu'à 18 h");
  await calendar.lookup({}, new Date(2026, 10, 2, 18, 30));
  assert.equal(counter.calls, 2);
  await calendar.lookup({}, new Date(2026, 10, 3, 5, 30));
  assert.equal(counter.calls, 2, "avant 6 h, la mise à jour de la veille au soir suffit");
  await calendar.lookup({}, new Date(2026, 10, 3, 6, 30));
  assert.equal(counter.calls, 3);
});

test("Forex Factory refuse (trop de requêtes) : pas de nouvel essai avant 5 minutes, puis reprise", async () => {
  const { calendar, counter } = setup(["<html>Request Denied</html>", BODY]);
  const first = (await calendar.lookup({}, NOW)) as Record<string, unknown>;
  assert.match(String(first.error), /indisponible.*limite de requêtes/);
  await calendar.lookup({}, later(2));
  assert.equal(counter.calls, 1, "limite de Forex Factory respectée");
  const ok = (await calendar.lookup({}, later(6))) as Record<string, unknown>;
  assert.equal(counter.calls, 2);
  assert.equal((ok.days as unknown[]).length, 1);
});

test("mise à jour impossible : les données connues restent servies, avec une mise en garde", async () => {
  const { calendar } = setup([BODY, new Error("ECONNRESET")]);
  await calendar.lookup({}, NOW);
  const next = (await calendar.lookup({ period: "week" }, new Date(2026, 10, 3, 9))) as Record<string, unknown>;
  assert.equal(next.updated, "lundi 2 novembre à 13:00");
  assert.match((next.notes as string[])[0], /Dernière mise à jour impossible \(injoignable \(ECONNRESET\)\)/);
  assert.equal((next.days as unknown[]).length, 3);
});

test("période au-delà de la semaine publiée : nouvel essai au plus une fois par heure", async () => {
  const { calendar, counter } = setup();
  await calendar.lookup({}, NOW);
  const r = (await calendar.lookup({ date: "2026-11-10" }, later(10))) as Record<string, unknown>;
  assert.equal(counter.calls, 1);
  assert.match((r.notes as string[])[0], /semaine en cours/);
  await calendar.lookup({ date: "2026-11-10" }, later(61));
  assert.equal(counter.calls, 2, "la nouvelle semaine est peut-être publiée");
});

test("questions simultanées : une seule requête", async () => {
  const { calendar, counter } = setup([BODY], { delayMs: 50 });
  await Promise.all([calendar.lookup({}, NOW), calendar.lookup({ period: "week" }, NOW), calendar.ensureFresh(NOW)]);
  assert.equal(counter.calls, 1);
});

test("minuterie : dans l'heure qui suit le rendez-vous, nouvel essai 15 minutes après un échec ; manqué, au suivant", async () => {
  const { calendar, counter } = setup([new Error("hors ligne"), BODY]);
  const noon = new Date(2026, 10, 2, 12, 5);
  assert.equal(await calendar.tick(noon), true);
  assert.equal(calendar.refreshFailed(noon), true);
  assert.equal(await calendar.tick(later(10, noon)), false);
  assert.equal(await calendar.tick(later(16, noon)), true);
  assert.equal(calendar.isFresh(later(16, noon)), true);
  assert.equal(await calendar.tick(later(30, noon)), false, "à jour : rien à faire");
  const evening = new Date(2026, 10, 2, 19, 0);
  assert.equal(await calendar.tick(evening), false, "rendez-vous de 18 h manqué (Mac en veille) : au suivant");
  assert.equal(counter.calls, 2);
  await calendar.ensureFresh(evening);
  assert.equal(counter.calls, 3, "une question ou un wrap met quand même à jour");
  assert.equal(await calendar.tick(new Date(2026, 10, 3, 6, 5)), true, "rendez-vous de 6 h");
  assert.equal(counter.calls, 4);
});

test("copie Markdown pour les agents, et agenda du brief (impact moyen et fort)", async () => {
  const { calendar } = setup();
  assert.equal(calendar.snapshotFile, undefined);
  await calendar.ensureFresh(NOW);
  const md = readFileSync(calendar.snapshotFile!, "utf8");
  assert.match(md, /^# Calendrier économique Forex Factory — du dimanche 1 novembre au vendredi 6 novembre/);
  assert.match(md, /Heures en heure de Paris/);
  assert.match(md, /## lundi 2 novembre\n- 10:00 · EUR · Final Manufacturing PMI/);

  const agenda = calendar.briefAgenda(NOW)!;
  assert.match(agenda, /^Calendrier économique Forex Factory \(mis à jour aujourd'hui à 13:00, heure de Paris, impact moyen et fort\)/);
  assert.match(agenda, /- 16:00 · USD · ISM Manufacturing PMI/);
  assert.match(agenda, /vendredi 6 novembre :\n- 14:30 · USD · Non-Farm Employment Change/);
  assert.doesNotMatch(agenda, /Final Manufacturing PMI/);
  assert.doesNotMatch(agenda, /Publié pendant la période/, "rien d'important depuis ce matin");

  // Wrap de mardi 18 h depuis le brief de lundi 13 h : ISM, RBA et JOLTS sont sortis.
  const wrap = calendar.briefAgenda(new Date(2026, 10, 3, 18, 0), NOW.getTime())!;
  assert.match(
    wrap,
    /\nPublié pendant la période :\nlundi 2 novembre :\n- 16:00 · USD · ISM Manufacturing PMI[^\n]*\nmardi 3 novembre :\n- 04:30 · AUD · Cash Rate[^\n]*\n- 16:00 · USD · JOLTS Job Openings[^\n]*\nÀ venir :\nvendredi 6 novembre :\n- 14:30 · USD · Non-Farm/,
  );
  assert.equal(wrap.match(/JOLTS/g)?.length, 1, "une annonce publiée n'est plus « à venir »");
});

test("désactivé (URL vide) : aucune requête, réponse explicite", async () => {
  const { calendar, counter } = setup([BODY], { url: "" });
  assert.match(String(((await calendar.lookup({}, NOW)) as Record<string, unknown>).error), /désactivé/);
  assert.equal(await calendar.tick(NOW), false);
  assert.equal(calendar.briefAgenda(NOW), undefined);
  assert.equal(counter.calls, 0);
  assert.ok(!existsSync(join(process.env.KOPILIA_DATA_DIR!, "calendar", "forexfactory.md")));
});
