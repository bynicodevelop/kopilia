// Fin d'un travail : chaque service abonné (veille, apprentissage, passerelle)
// est prévenu, même si l'un d'eux échoue en traitant l'événement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MemoryService } from "../src/memory/memory.service.js";
import { SkillService } from "../src/learning/skill.service.js";
import { ConversationService } from "../src/learning/conversation.service.js";
import { LearningService } from "../src/learning/learning.service.js";
import { BriefService } from "../src/veille/brief.service.js";
import { CalendarService } from "../src/calendar/calendar.service.js";
import type { JobService } from "../src/jobs/job.service.js";
import type { SessionService } from "../src/session/session.service.js";
import { tempData } from "./harness.js";

test("fin d'un travail : une erreur chez la veille ou l'apprentissage n'empêche pas les autres d'être prévenus", () => {
  const data = tempData("listen", { KOPILIA_BRIEF_TIMES: "", KOPILIA_LEARNING: "0" });
  const { db, config, logger } = data;
  const jobs = new EventEmitter();
  const memory = new MemoryService(db, config);
  const skills = new SkillService(db, config);
  const learning = new LearningService(
    db,
    config,
    jobs as unknown as JobService,
    memory,
    skills,
    new ConversationService(db),
    { dialoguePrompt: () => "" } as unknown as SessionService,
    logger,
  );
  const briefs = new BriefService(db, config, jobs as unknown as JobService, memory, skills, new CalendarService(db, config, logger), logger);
  try {
    learning.onModuleInit();
    briefs.onModuleInit();
    for (const service of [learning, briefs]) {
      (service as unknown as { onJobFinished: () => void }).onJobFinished = () => {
        throw new Error("base verrouillée");
      };
    }
    const seen: unknown[] = [];
    jobs.on("job.finished", (e) => seen.push(e)); // la passerelle, abonnée après eux
    const event = { job: { id: "job_1" }, announce: true, result: "fini" };
    assert.doesNotThrow(() => jobs.emit("job.finished", event));
    assert.deepEqual(seen, [event]);
  } finally {
    learning.onModuleDestroy();
    briefs.onModuleDestroy();
    data.cleanup();
  }
});
