import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JobState } from "@kopilia/contracts";
import { DatabaseService } from "../src/db/database.service.js";
import { ProjectService } from "../src/session/project.service.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { SkillService } from "../src/learning/skill.service.js";
import { JobService } from "../src/jobs/job.service.js";
import { BriefReady, BriefService, VEILLE_SESSION_ID, briefTitle, isScheduledBriefDue, spokenSummary, wrapSince } from "../src/veille/brief.service.js";
import { insertSession, tempData, type TempData } from "./harness.js";
import { CalendarService } from "../src/calendar/calendar.service.js";
import { momentFr } from "../src/common/dates.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
let db: DatabaseService;
let jobs: JobService;
let briefs: BriefService;
let calendar: CalendarService;
/** Invites reçues par les agents lancés (pour vérifier l'agenda transmis). */
const prompts: string[] = [];

/** Prochain jour de semaine à 7 h 30 : le wrap du matin y est dû, quel que soit le jour du test. */
const MORNING = new Date();
MORNING.setHours(7, 30, 0, 0);
do MORNING.setDate(MORNING.getDate() + 1);
while (MORNING.getDay() === 0 || MORNING.getDay() === 6);
/** Annonce forte une heure plus tard : « à venir » quand le wrap du matin part. */
const CPI_AT = new Date(MORNING.getTime() + 3_600_000);
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Faux flux Forex Factory : l'annonce forte ci-dessus, une faible une demi-heure avant. */
function todayFeed(): string {
  return JSON.stringify([
    { title: "CPI y/y", country: "USD", date: CPI_AT.toISOString(), impact: "High", forecast: "2.9%", previous: "3.0%" },
    { title: "Retail Sales m/m", country: "CHF", date: new Date(CPI_AT.getTime() - 1_800_000).toISOString(), impact: "Low", forecast: "", previous: "0.1%" },
  ]);
}

let data: TempData;

before(() => {
  data = tempData("brief", (dir) => ({
    KOPILIA_PROJECT_ROOTS: dir,
    KOPILIA_CLAUDE_BIN: resolve(REPO, "workers/_doubles/mock-claude.mjs"),
    KOPILIA_BRIEF_TIMES: "07:00,12:30",
    KOPILIA_FF_CALENDAR_URL: "https://ff.test/ff_calendar_thisweek.json",
  }));
  const { config, logger } = data;
  db = data.db;
  const memory = new MemoryService(db, config);
  const skills = new SkillService(db, config);
  jobs = new JobService(db, config, new ProjectService(db, config), memory, skills, logger);
  const start = jobs.start.bind(jobs);
  jobs.start = (input) => {
    prompts.push(input.prompt);
    return start(input);
  };
  calendar = new CalendarService(db, config, logger);
  calendar.fetchImpl = async () => new Response(todayFeed());
  briefs = new BriefService(db, config, jobs, memory, skills, calendar, logger);
  // Pas d'onModuleInit ici : la minuterie n'est pas armée, tick() est appelé à la main.
  jobs.on("job.finished", (e) => (briefs as unknown as { onJobFinished(x: unknown): void }).onJobFinished(e));
  insertSession(db, "s1");
});

after(() => {
  jobs?.onModuleDestroy();
  data?.cleanup();
});

function nextBrief(): Promise<BriefReady> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("brief non reçu")), 8000);
    briefs.once("brief.ready", (e: BriefReady) => {
      clearTimeout(t);
      res(e);
    });
  });
}

const times = [
  { hour: 7, minute: 0 },
  { hour: 12, minute: 30 },
];
/** Lundi 2 novembre 2026. */
const day = (h: number, m = 0) => new Date(2026, 10, 2, h, m);
const attempt = (state: string, created_at: number, updated_at = created_at) => ({ state, created_at, updated_at });

test("échéance : le matin de 7 h à 8 h, puis de 12 h 30 à 13 h 30, du lundi au vendredi", () => {
  assert.equal(isScheduledBriefDue(day(6, 59), times, []), false);
  assert.equal(isScheduledBriefDue(day(7, 0), times, []), true);
  assert.equal(isScheduledBriefDue(day(7, 45), times, []), true, "rattrapage après la veille du Mac");
  assert.equal(isScheduledBriefDue(day(8, 0), times, []), false, "manqué : le wrap de midi couvrira aussi la matinée");
  assert.equal(isScheduledBriefDue(day(12, 30), times, []), true);
  assert.equal(isScheduledBriefDue(day(13, 29), times, []), true);
  assert.equal(isScheduledBriefDue(day(13, 30), times, []), false, "rattrapé une heure au plus");
  assert.equal(isScheduledBriefDue(new Date(2026, 9, 31, 7, 30), times, []), false, "samedi : marchés fermés");
  assert.equal(isScheduledBriefDue(new Date(2026, 10, 1, 12, 45), times, []), false, "dimanche");
  assert.equal(isScheduledBriefDue(day(7, 0), [], []), false, "désactivé");
});

test("échéance : un wrap réussi ou en cours n'est pas relancé ; un échec est retenté, espacé et borné", () => {
  const now = day(7, 40);
  const t = now.getTime();
  assert.equal(isScheduledBriefDue(now, times, [attempt("succeeded", t - 40 * 60_000)]), false);
  assert.equal(isScheduledBriefDue(now, times, [attempt("running", t - 60_000, t)]), false);
  assert.equal(isScheduledBriefDue(now, times, [attempt("failed", t - 120_000, t - 60_000)]), false, "trop tôt pour réessayer");
  assert.equal(isScheduledBriefDue(now, times, [attempt("failed", t - 12 * 60_000, t - 11 * 60_000)]), true);
  const three = [1, 2, 3].map(() => attempt("failed", t - 30 * 60_000));
  assert.equal(isScheduledBriefDue(now, times, three), false, "trois échecs : on n'insiste plus");
  assert.equal(isScheduledBriefDue(day(12, 30), times, three), true, "le wrap de midi a ses propres essais");
});

test("échéance : un brief fait juste avant tient lieu de wrap programmé", () => {
  assert.equal(isScheduledBriefDue(day(12, 30), times, [], day(11, 45).getTime()), false, "demandé à 11 h 45");
  assert.equal(isScheduledBriefDue(day(12, 30), times, [], day(7, 5).getTime()), true, "le wrap du matin ne compte pas pour midi");
  assert.equal(isScheduledBriefDue(day(7, 0), times, [], day(5, 30).getTime()), true);
});

test("wrap : depuis le brief précédent, sinon 24 heures (depuis vendredi soir pendant le week-end)", () => {
  const monday7 = new Date(2026, 10, 2, 7, 0);
  const friday7 = new Date(2026, 9, 30, 7, 0).getTime();
  const fridayClose = new Date(2026, 9, 30, 22, 0).getTime();
  assert.equal(wrapSince(monday7, friday7), friday7, "depuis le brief de vendredi matin");
  const mondayNoon = new Date(2026, 10, 2, 12, 30).getTime();
  assert.equal(wrapSince(new Date(2026, 10, 3, 12, 30), mondayNoon), mondayNoon, "wrap du matin manqué : celui de midi couvre depuis la veille midi");
  assert.equal(wrapSince(monday7), fridayClose, "sans brief : depuis la clôture de Wall Street vendredi");
  assert.equal(wrapSince(monday7, new Date(2026, 9, 27, 7, 0).getTime()), fridayClose, "brief de plus de quatre jours : ignoré");
  assert.equal(wrapSince(new Date(2026, 10, 4, 7, 0)), new Date(2026, 10, 3, 7, 0).getTime(), "en semaine : 24 heures");
  assert.equal(wrapSince(new Date(2026, 9, 31, 10, 0)), new Date(2026, 9, 30, 10, 0).getTime(), "samedi matin : 24 heures, vendredi compris");
  assert.equal(wrapSince(new Date(2026, 10, 1, 20, 0)), fridayClose, "dimanche soir : depuis vendredi soir");
  assert.equal(wrapSince(new Date(2026, 9, 30, 23, 0)), new Date(2026, 9, 29, 23, 0).getTime(), "vendredi soir : 24 heures");
});

test("résumé oral : la section « En bref », sans Markdown ni lien", () => {
  const md =
    "# Brief de veille — lundi\n\n## En bref\n- La **Fed** reste prudente ([source](https://x.y/z)).\n- [FAIT] Le pétrole recule. https://a.b/c\n\n## Banques centrales\n- détail";
  assert.equal(briefTitle(md), "Brief de veille — lundi");
  assert.equal(spokenSummary(md), "La Fed reste prudente (source). Le pétrole recule.");
});

test("résumé oral : sans « En bref », le premier paragraphe", () => {
  assert.equal(spokenSummary("# Titre\n\nPremier paragraphe utile.\n\n## Suite\nx"), "Premier paragraphe utile.");
});

test("veille à la demande : brief enregistré (base + fichier), à annoncer, pour la bonne conversation", async () => {
  const ready = nextBrief();
  const r = briefs.start("manual", "s1");
  assert.equal(r.state, JobState.Running);
  assert.equal(briefs.start("manual", "s1").alreadyRunning, true, "une seule veille à la fois");
  const { brief, sessionId } = await ready;
  assert.equal(sessionId, "s1");
  assert.equal(brief.title, "Wrap de test : la BCE maintient ses taux");
  assert.equal(brief.spoken, "La BCE a maintenu ses taux. L'inflation américaine ralentit.");
  assert.match(brief.content, /## Titres/);
  assert.match(prompts.at(-1)!, /le wrap de ce qui s'est passé depuis/);
  const files = readdirSync(briefs.briefsDir);
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(briefs.briefsDir, files[0]), "utf8"), /# Wrap de test/);

  assert.equal(briefs.unannounced()?.id, brief.id);
  briefs.markAnnounced(brief.id);
  assert.equal(briefs.unannounced(), undefined, "annoncé une seule fois");
});

test("wraps programmés : le matin puis à midi, chacun avec le calendrier à jour et depuis le précédent", async (t) => {
  // Horloge figée au prochain matin de semaine (les lignes en base suivent la même horloge).
  t.mock.timers.enable({ apis: ["Date"], now: MORNING });
  const ready = nextBrief();
  assert.equal(briefs.tick(MORNING), false, "calendrier Forex Factory pas encore mis à jour ce matin");
  await calendar.ensureFresh(MORNING); // la mise à jour demandée par tick()
  assert.equal(calendar.isFresh(MORNING), true);
  const previous = briefs.latest()!;
  assert.equal(briefs.tick(MORNING), true);
  assert.ok(prompts.at(-1)!.includes(`depuis ${momentFr(previous.created_at)} jusqu'à maintenant`), "le wrap part du brief précédent");
  assert.match(prompts.at(-1)!, /La rubrique À suivre s'appuie sur les annonces à venir/);
  assert.ok(prompts.at(-1)!.includes(`À venir :\n`), prompts.at(-1));
  assert.ok(prompts.at(-1)!.includes(`${hhmm(CPI_AT)} · USD · CPI y/y · impact fort · prévision 2.9%`), prompts.at(-1));
  assert.doesNotMatch(prompts.at(-1)!, /Retail Sales/, "impact faible écarté de l'agenda");
  assert.equal(briefs.tick(MORNING), false, "déjà en cours");
  const { brief, sessionId } = await ready;
  assert.equal(sessionId, null, "aucune conversation : annoncé au prochain décroché");
  assert.equal(brief.trigger, "scheduled");
  assert.equal(briefs.tick(MORNING), false, "déjà fait ce matin");
  const owner = db.db.prepare("SELECT session_id FROM jobs WHERE id = ?").get(brief.job_id) as { session_id: string };
  assert.equal(owner.session_id, VEILLE_SESSION_ID);

  // Midi : le calendrier est remis à jour, puis le wrap de Londres part depuis celui du matin.
  const noon = new Date(MORNING);
  noon.setHours(12, 30);
  t.mock.timers.setTime(noon.getTime());
  const second = nextBrief();
  assert.equal(briefs.tick(noon), false, "calendrier pas encore remis à jour à midi");
  await calendar.ensureFresh(noon);
  assert.equal(briefs.tick(noon), true);
  assert.ok(prompts.at(-1)!.includes(`depuis ${momentFr(brief.created_at)} jusqu'à maintenant`), "depuis le wrap du matin");
  assert.ok(prompts.at(-1)!.includes(`Publié pendant la période :\n`), "le CPI de 8 h 30 est sorti depuis");
  const midday = (await second).brief;
  assert.equal(briefs.tick(noon), false, "déjà fait à midi");

  // On décroche : seul le dernier wrap est annoncé, celui du matin est dépassé.
  assert.equal(briefs.unannounced(noon.getTime())?.id, midday.id);
  briefs.markAnnounced(midday.id);
  assert.equal(briefs.unannounced(noon.getTime()), undefined);
});

test("agent bloqué : arrêté au bout du délai, échec signalé", async () => {
  const job = jobs.start({ sessionId: "s1", kind: "agent", title: "Lent", prompt: "[lent] x", internal: { timeoutMs: 200 } });
  await new Promise((r) => setTimeout(r, 500));
  const row = jobs.get(job.id)!;
  assert.equal(row.state, JobState.Failed);
  assert.match(row.summary ?? "", /délai dépassé/);
});
