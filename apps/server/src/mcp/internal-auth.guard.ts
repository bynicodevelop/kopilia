import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ConfigService } from "../config/config.service.js";
import { LearningService } from "../learning/learning.service.js";

/**
 * Qui peut appeler une route de l'API interne (/internal), par jeton Bearer :
 * - internal : le serveur MCP du dialogue (par défaut, pour toute route) ;
 * - agent : en plus, celui des agents (lectures des cours et des recettes) ;
 * - learning : le jeton du relecteur, et seulement pendant sa passe (x-learning-run) ;
 * - setups : les agents de la recherche d'opportunités (leurs dossiers, leurs alertes) ; leur
 *   jeton ouvre aussi les lectures des agents (cours, recettes) ;
 * - action : en plus du dialogue, les agents d'action (tâches de fond sur Kopilia :
 *   tracés, alertes, indicateurs) ; leur jeton ouvre aussi les lectures des agents ;
 * - algo : l'agent quant du laboratoire de stratégies (bibliothèque, réserve, versions, backtests) ;
 *   son jeton ouvre aussi les lectures des agents.
 */
export type InternalAccess = "internal" | "agent" | "learning" | "setups" | "action" | "algo";

const ACCESS = "internal-access";

/** Ouvre une route à un autre jeton que celui du dialogue. */
export const Access = (access: InternalAccess) => SetMetadata(ACCESS, access);

/**
 * Garde de l'API interne, posé sur tout le contrôleur : une route sans
 * décorateur exige le jeton du dialogue (fermée par défaut).
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly learning: LearningService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const access = this.reflector.getAllAndOverride<InternalAccess | undefined>(ACCESS, [ctx.getHandler(), ctx.getClass()]) ?? "internal";
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException();
    const { internalToken, agentToken, learningToken, setupToken, actionToken, algoToken } = this.config;
    const ok =
      access === "internal"
        ? token === internalToken
        : access === "agent"
          ? token === internalToken || token === agentToken || token === setupToken || token === actionToken || token === algoToken
          : access === "algo"
            ? token === algoToken
            : access === "setups"
              ? token === setupToken
              : access === "action"
                ? token === internalToken || token === actionToken
                : token === learningToken && this.learning.isCurrentRun(req.header("x-learning-run"));
    if (!ok) throw new UnauthorizedException();
    return true;
  }
}
