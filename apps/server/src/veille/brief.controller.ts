import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../http/session.guard.js";
import { BriefRow, BriefService } from "./brief.service.js";

/** Lecture des briefs de veille par l'interface (même origine, loopback), avec la session de l'écran. */
@Controller("api/briefs")
@UseGuards(SessionGuard)
export class BriefController {
  constructor(private readonly briefs: BriefService) {}

  /** Dernier brief, sans son texte (pour le bouton « Brief »). */
  @Get("latest")
  latest() {
    const b = this.briefs.latest();
    return b ? meta(b) : { none: true };
  }

  @Get(":id")
  one(@Param("id") id: string) {
    const b = this.briefs.get(id);
    if (!b) throw new NotFoundException("brief introuvable");
    return { ...meta(b), content: b.content };
  }
}

function meta(b: BriefRow) {
  return { briefId: b.id, title: b.title, createdAt: b.created_at, trigger: b.trigger };
}
