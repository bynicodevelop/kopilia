import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "../session/session.service.js";

/**
 * API de l'écran (/api/…, hors amorçage) : la session et son jeton, ceux du
 * WebSocket, dans x-session-id et x-session-token. Posé sur la classe d'un
 * contrôleur : aucune de ses routes ne peut l'oublier.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const id = req.header("x-session-id");
    const token = req.header("x-session-token");
    if (!id || !token || !this.sessions.validateToken(id, token)) throw new UnauthorizedException();
    return true;
  }
}
