import { Body, Controller, Get, Post } from "@nestjs/common";
import { ConfigService } from "../config/config.service.js";
import { SessionService } from "../session/session.service.js";
import { existsSync } from "node:fs";

/**
 * Amorçage HTTP même origine. Remet un jeton de session court qui protège
 * l'ouverture du WebSocket. N'expose jamais le jeton interne de contrôle.
 */
@Controller("api")
export class BootstrapController {
  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
  ) {}

  @Get("health")
  health() {
    return {
      ok: true,
      version: "0.1.0",
      coordination: this.config.coordinationReady,
      whisperModel: existsSync(this.config.whisperModel),
      projectRoots: this.config.projectRoots,
    };
  }

  @Post("session")
  createSession(@Body() body: { projectId?: string }) {
    const row = this.sessions.create(body?.projectId);
    return {
      sessionId: row.id,
      token: row.token,
      wsPath: "/ws",
      projectId: row.project_id,
    };
  }
}
