import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JobState } from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { JobFinished, JobRow, JobService } from "../jobs/job.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { SkillService } from "../learning/skill.service.js";
import { CalendarService } from "../calendar/calendar.service.js";
import { briefTaskPrompt, veilleSystemPrompt } from "../session/prompts.js";
import { startOfDay, todayFr } from "../common/dates.js";
import { AppLogger } from "../common/logger.js";
import { newId } from "../common/ids.js";
import { ensureSystemSession } from "../session/system-session.js";

export type BriefTrigger = "manual" | "scheduled";

export interface BriefRow {
  id: string;
  job_id: string | null;
  trigger: BriefTrigger;
  title: string;
  content: string;
  spoken: string;
  created_at: number;
  announced_at: number | null;
}

/** Brief prêt : `sessionId` est la conversation qui l'a demandé (absente s'il est programmé). */
export interface BriefReady {
  brief: BriefRow;
  sessionId: string | null;
}

export interface BriefEvents {
  "brief.ready": [BriefReady];
  "brief.failed": [{ job: JobRow; sessionId: string | null }];
}

/** Session interne propriétaire des briefs programmés (aucune conversation à 7 h). */
export const VEILLE_SESSION_ID = "sess_veille";
/**
 * Un wrap programmé manqué (Mac en veille, serveur arrêté) est rattrapé dans
 * l'heure ; au-delà, le suivant couvre aussi sa période.
 */
const CATCH_UP_MS = 3_600_000;
/** Un brief fait juste avant l'heure (à la demande) tient lieu de wrap programmé. */
const RECENT_BRIEF_MS = 3_600_000;
/** Nouvel essai d'un brief programmé échoué (réseau pas encore prêt au réveil…). */
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_SCHEDULED_ATTEMPTS = 3;
/** Une veille sérieuse enchaîne beaucoup de recherches. */
const VEILLE_TIMEOUT_MS = 20 * 60_000;
/** Un brief non annoncé n'est plus « du jour » au-delà. */
const ANNOUNCE_WITHIN_MS = 18 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** Au-delà, le brief précédent est trop ancien pour servir de point de départ au wrap. */
const MAX_WRAP_SPAN_MS = 4 * DAY_MS;
/** Clôture de Wall Street, heure de Paris (point de départ d'un wrap après le week-end). */
const FRIDAY_CLOSE_HOUR = 22;

/**
 * Veille économique : un agent rédige un « session wrap » (ce qui a bougé les
 * marchés depuis le brief précédent : banques centrales, indicateurs, devises,
 * taux, actions, matières premières, rendez-vous à suivre), à la demande ou
 * aux heures prévues du lundi au vendredi (le matin, puis à midi avant
 * l'ouverture de New York). Le brief complet est conservé (base + fichier Markdown) ; son
 * « En bref » est ce que Kopilia dit à voix haute.
 *
 * Émet 'brief.ready' (BriefReady) et 'brief.failed' ({ job, sessionId }).
 */
@Injectable()
export class BriefService extends EventEmitter<BriefEvents> implements OnModuleInit, OnModuleDestroy {
  /** Veilles en cours : jobId -> déclencheur. */
  private running = new Map<string, BriefTrigger>();
  private ticker?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly jobs: JobService,
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly calendar: CalendarService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  onModuleInit() {
    // Une erreur ici ne doit pas empêcher les autres abonnés (la passerelle) d'être prévenus.
    this.jobs.on("job.finished", (e: JobFinished) => {
      try {
        this.onJobFinished(e);
      } catch (err) {
        this.logger.error(`fin de veille mal traitée (${e.job.id}) : ${(err as Error).message}`, "veille");
      }
    });
    if (this.config.briefTimes.length) {
      // Vérification à la minute plutôt qu'une minuterie unique : une minuterie
      // ne voit pas l'heure passer pendant la veille du Mac.
      this.ticker = setInterval(() => this.tick(), 60_000);
      this.ticker.unref();
      setTimeout(() => this.tick(), 5_000).unref(); // rattrapage au démarrage
    }
  }

  onModuleDestroy() {
    clearInterval(this.ticker);
  }

  get briefsDir(): string {
    const dir = resolve(this.config.dataDir, "briefs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Lance une veille. Une seule à la fois : si une veille tourne déjà, on la
   * renvoie plutôt que d'en lancer une seconde.
   */
  start(trigger: BriefTrigger, sessionId: string = VEILLE_SESSION_ID): { jobId: string; state: string; alreadyRunning?: boolean } {
    const current = [...this.running.keys()][0];
    if (current) return { jobId: current, state: JobState.Running, alreadyRunning: true };
    if (sessionId === VEILLE_SESSION_ID) ensureSystemSession(this.db, VEILLE_SESSION_ID);
    const now = new Date();
    const since = wrapSince(now, this.latest()?.created_at);
    const job = this.jobs.start({
      sessionId,
      kind: "agent",
      title: `Brief de veille du ${todayFr(now)}`,
      prompt: briefTaskPrompt(trigger, now, since, this.calendar.briefAgenda(now, since)),
      internal: {
        cwd: this.briefsDir,
        model: this.config.veilleModel,
        appendSystemPrompt: veilleSystemPrompt(
          this.memory.snapshot().profile,
          now,
          this.previousBriefFile(),
          this.calendar.snapshotFile,
          this.config.marketToolsReady,
          {
            environment: this.memory.snapshot().environment,
            // Une recette « brief » apprise des remarques de l'utilisateur passe avant les habitudes de l'agent.
            skills: this.config.agentToolsReady ? this.skills.activeFor("agents").map((s) => ({ name: s.name, description: s.description })) : [],
          },
        ),
        quiet: true,
        timeoutMs: VEILLE_TIMEOUT_MS,
      },
    });
    this.running.set(job.id, trigger);
    this.logger.log(`veille ${trigger} lancée (${job.id})`, "veille");
    return { jobId: job.id, state: job.state };
  }

  /** Dernier fichier de brief, lu par l'agent pour signaler ce qui a changé. */
  private previousBriefFile(): string | undefined {
    const files = readdirSync(this.briefsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    return files.at(-1);
  }

  private onJobFinished({ job, result }: JobFinished) {
    const trigger = this.running.get(job.id);
    if (!trigger) return;
    this.running.delete(job.id);
    const sessionId = job.session_id === VEILLE_SESSION_ID ? null : job.session_id;
    if (job.state !== JobState.Succeeded || !result.trim()) {
      this.logger.warn(`veille ${job.id} : ${job.state} (${job.summary ?? ""})`, "veille");
      this.emit("brief.failed", { job, sessionId });
      return;
    }
    const brief = this.save(job.id, trigger, result);
    this.emit("brief.ready", { brief, sessionId } satisfies BriefReady);
  }

  /** Enregistre le brief : base (affichage, rappel) + fichier Markdown lisible hors de Kopilia. */
  save(jobId: string | null, trigger: BriefTrigger, markdown: string, now = new Date()): BriefRow {
    const content = markdown.trim();
    const row: BriefRow = {
      id: newId("brief"),
      job_id: jobId,
      trigger,
      title: briefTitle(content) ?? `Brief de veille du ${todayFr(now)}`,
      content,
      spoken: spokenSummary(content),
      created_at: now.getTime(),
      announced_at: null,
    };
    this.db.db
      .prepare(
        "INSERT INTO briefs (id,job_id,trigger,title,content,spoken,created_at,announced_at) VALUES (@id,@job_id,@trigger,@title,@content,@spoken,@created_at,@announced_at)",
      )
      .run(row);
    writeFileSync(resolve(this.briefsDir, `${fileStamp(now)}.md`), content + "\n");
    this.logger.log(`brief enregistré (${row.id}) : ${row.title}`, "veille");
    return row;
  }

  get(id: string): BriefRow | undefined {
    return this.db.db.prepare("SELECT * FROM briefs WHERE id = ?").get(id) as BriefRow | undefined;
  }

  latest(): BriefRow | undefined {
    return this.db.db.prepare("SELECT * FROM briefs ORDER BY created_at DESC LIMIT 1").get() as BriefRow | undefined;
  }

  /**
   * Dernier brief, s'il est récent et jamais annoncé (p.ex. le wrap de 7 h, à
   * dire quand on décroche). Un brief plus ancien, dépassé par le suivant,
   * n'est plus annoncé.
   */
  unannounced(now = Date.now()): BriefRow | undefined {
    const last = this.latest();
    return last && last.announced_at === null && last.created_at >= now - ANNOUNCE_WITHIN_MS ? last : undefined;
  }

  markAnnounced(id: string) {
    this.db.db.prepare("UPDATE briefs SET announced_at = ? WHERE id = ? AND announced_at IS NULL").run(Date.now(), id);
  }

  /** Lance le wrap programmé s'il est dû (rattrapage compris). Renvoie vrai s'il part. */
  tick(now = new Date()): boolean {
    const times = this.config.briefTimes;
    if (!times.length || this.running.size) return false;
    const attempts = this.jobs.startedSince(VEILLE_SESSION_ID, startOfDay(now).getTime());
    if (!isScheduledBriefDue(now, times, attempts, this.latest()?.created_at)) return false;
    // Le brief part avec l'agenda Forex Factory à jour : s'il ne l'est pas
    // encore, on le demande et le brief part à la minute suivante (tout de
    // suite si Forex Factory est injoignable).
    if (this.calendar.enabled && !this.calendar.isFresh(now) && !this.calendar.refreshFailed(now)) {
      void this.calendar.ensureFresh(now);
      return false;
    }
    try {
      this.start("scheduled");
      return true;
    } catch (e) {
      this.logger.warn(`brief programmé non lancé : ${(e as Error).message}`, "veille");
      return false;
    }
  }
}

/** Veille programmée lancée aujourd'hui (la plus récente d'abord). */
export interface ScheduledAttempt {
  state: string;
  created_at: number;
  updated_at: number;
}

/**
 * Le wrap programmé est-il dû ? Pendant son créneau (voir `scheduledSlot`),
 * s'il n'a ni réussi ni n'est en cours, si aucun brief n'a été fait juste
 * avant (à la demande), et dans la limite des essais (espacés) après un échec.
 */
export function isScheduledBriefDue(
  now: Date,
  times: Array<{ hour: number; minute: number }>,
  todayAttempts: ScheduledAttempt[],
  lastBriefAt?: number,
): boolean {
  const slot = scheduledSlot(now, times);
  if (!slot) return false;
  if (lastBriefAt !== undefined && lastBriefAt >= slot.start - RECENT_BRIEF_MS) return false;
  const attempts = todayAttempts.filter((a) => a.created_at >= slot.start);
  const failed = new Set<string>([JobState.Failed, JobState.Cancelled, JobState.Unverified]);
  if (attempts.some((a) => !failed.has(a.state))) return false; // réussi ou en cours
  if (attempts.length >= MAX_SCHEDULED_ATTEMPTS) return false;
  const last = attempts[0];
  return !last || now.getTime() - last.updated_at >= RETRY_AFTER_MS;
}

/**
 * Créneau du wrap programmé en cours : l'heure qui suit son heure prévue
 * (jusqu'au wrap suivant au plus). Aucun le week-end, marchés fermés : le wrap
 * du lundi matin reprend depuis celui du vendredi.
 */
function scheduledSlot(now: Date, times: Array<{ hour: number; minute: number }>): { start: number; end: number } | undefined {
  if (now.getDay() === 0 || now.getDay() === 6) return undefined;
  const t = now.getTime();
  const starts = times.map((c) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), c.hour, c.minute).getTime()).sort((a, b) => a - b);
  const start = starts.filter((s) => s <= t).at(-1);
  if (start === undefined) return undefined;
  const end = Math.min(starts.find((s) => s > t) ?? Infinity, start + CATCH_UP_MS);
  return t < end ? { start, end } : undefined;
}

/**
 * Début de la période couverte par un wrap : le brief précédent, pour ne rien
 * redire ; à défaut (aucun, ou plus de quatre jours), les dernières 24 heures,
 * élargies à la clôture de Wall Street vendredi soir pendant le week-end.
 */
export function wrapSince(now: Date, previousAt?: number): number {
  const t = now.getTime();
  if (previousAt !== undefined && previousAt < t && t - previousAt <= MAX_WRAP_SPAN_MS) return previousAt;
  const since = new Date(t - DAY_MS);
  const back = (since.getDay() + 2) % 7; // vendredi 0, samedi 1, dimanche 2
  if (back <= 2) {
    const close = new Date(since.getFullYear(), since.getMonth(), since.getDate() - back, FRIDAY_CLOSE_HOUR);
    if (close <= since) return close.getTime();
  }
  return since.getTime();
}

/** Titre : la première ligne « # … » du brief. */
export function briefTitle(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim();
}

/**
 * Ce que Kopilia dit à voix haute : la section « En bref », débarrassée du
 * Markdown. À défaut, le premier paragraphe de texte.
 */
export function spokenSummary(markdown: string, max = 900): string {
  const section = markdown.match(/^##\s*En bref\b.*$([\s\S]*?)(?=^##?\s|(?![\s\S]))/im)?.[1];
  const source = section?.trim() || markdown.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith("#")) || "";
  const plain = source
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // liens -> texte
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[(FAIT|ANALYSE)\]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max).replace(/\s+\S*$/, "") + "…" : plain;
}

/** 2026-11-02_0700 (heure locale) : les fichiers se trient par date. */
function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
