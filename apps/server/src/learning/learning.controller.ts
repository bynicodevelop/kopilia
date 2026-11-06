import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../http/session.guard.js";
import { MemoryError, MemoryService } from "../memory/memory.service.js";
import { LearningService, parseChanges } from "./learning.service.js";
import { parseFiles, SkillError, SkillService } from "./skill.service.js";

/**
 * La mémoire de Kopilia vue et pilotée depuis l'interface (même origine,
 * loopback) : carnets, recettes (proposées, actives, archivées), journal de ce
 * qu'il a retenu. La session et son jeton, ceux du WebSocket, dans
 * x-session-id et x-session-token : ce sont des données personnelles.
 */
@Controller("api/learning")
@UseGuards(SessionGuard)
export class LearningController {
  constructor(
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly learning: LearningService,
  ) {}

  @Get()
  overview() {
    const notebook = (store: "profile" | "environment" | "trading") => ({
      ...this.memory.usage(store),
      entries: this.memory.entries(store).map((r) => ({ id: r.id, content: r.content, kind: r.kind, createdAt: r.created_at, provenance: r.provenance })),
    });
    // Par recette : la proposition en attente s'il y en a une, ET la version
    // suivie (ou archivée), pour que l'écran montre les deux.
    const rows = this.skills.catalog().flatMap((c) => {
      const followed = this.skills.active(c.name) ?? this.skills.history(c.name).find((r) => r.state === "archived");
      return [this.skills.draft(c.name), followed].filter((r) => r !== undefined);
    });
    const skills = rows.map((s) => {
      const meta = this.skills.meta(s.name);
      const active = s.state === "draft" ? this.skills.active(s.name) : undefined;
      return {
        name: s.name,
        version: s.version,
        state: s.state,
        audience: s.audience,
        description: s.description,
        body: s.body,
        files: Object.keys(parseFiles(s.files)),
        reason: s.reason,
        createdAt: s.created_at,
        pinned: !!meta?.pinned,
        uses: meta?.uses ?? 0,
        lastUsedAt: meta?.last_used_at ?? null,
        // Une modification proposée se lit à côté de la version suivie.
        activeBody: active?.body ?? null,
      };
    });
    const runs = this.learning.runs().map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      summary: r.summary,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      changes: parseChanges(r.changes),
    }));
    return {
      profile: notebook("profile"),
      environment: notebook("environment"),
      trading: notebook("trading"),
      skills,
      runs,
      reviewing: this.learning.busy,
    };
  }

  /** Relire maintenant ce qui ne l'a pas encore été. */
  @Post("review")
  review() {
    const r = this.learning.requestReview();
    if (r.error) throw new BadRequestException(r.error);
    return r;
  }

  @Post("skills/:name/:action")
  skillAction(@Param("name") name: string, @Param("action") action: string) {
    try {
      switch (action) {
        case "approve":
          return { state: this.skills.approve(name).state };
        case "reject":
          return { state: this.skills.reject(name).state };
        case "archive":
          this.skills.archive(name);
          return { state: "archived" };
        case "restore":
          return { state: this.skills.restore(name).state };
        case "pin":
        case "unpin":
          this.skills.pin(name, action === "pin");
          return { pinned: action === "pin" };
        default:
          throw new NotFoundException("action inconnue");
      }
    } catch (e) {
      if (e instanceof SkillError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Oubli définitif d'une entrée d'un carnet. */
  @Delete("memories/:id")
  forget(@Param("id") id: string) {
    if (!this.memory.forget(id)) throw new NotFoundException("entrée introuvable");
    return { forgotten: true };
  }

  /** Rétablit une entrée qu'une relecture a remplacée ou retirée. */
  @Post("memories/:id/restore")
  restore(@Param("id") id: string) {
    try {
      return { restored: this.memory.restore(id).content };
    } catch (e) {
      if (e instanceof MemoryError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
