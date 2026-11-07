import { BadRequestException, Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { wakeDurationLabel, type BrokerStatus } from "@kopilia/contracts";
import { SessionGuard } from "../http/session.guard.js";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { BrokerError, BrokerPauseService } from "./broker-pause.service.js";
import { MarketError } from "./metaapi.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BrokerError || e instanceof MarketError) throw new BadRequestException(e.message);
    throw e;
  }
}

/**
 * Le compte MetaApi vu de l'écran : son état (l'indicateur en haut de la
 * page), et le rallumer d'un clic. La session et son jeton, ceux du WebSocket.
 */
@Controller("api/broker")
@UseGuards(SessionGuard)
export class BrokerScreenController {
  constructor(private readonly broker: BrokerPauseService) {}

  @Get()
  status() {
    return this.broker.status();
  }

  @Post("wake")
  wake() {
    return guard(() => this.broker.wake(false));
  }
}

/**
 * Le compte MetaApi pour le dialogue (jamais les agents) : son état, le
 * mettre en pause, le rallumer, les règles. Chaque réponse porte une `note`
 * qui dit à Kopilia quoi dire.
 */
@Controller("internal/broker")
@UseGuards(InternalAuthGuard)
export class BrokerControlController {
  constructor(private readonly broker: BrokerPauseService) {}

  @Get()
  status() {
    const s = this.broker.status();
    return { ...view(s), note: statusNote(s) };
  }

  @Post("pause")
  async pause(@Body() body: { force?: boolean }) {
    try {
      const s = await this.broker.pause(body?.force === true);
      return {
        ...view(s),
        note: "Dis-lui en une phrase que le courtier est en pause et quand il se rallumera de lui-même ; il peut le rallumer quand il veut (« rallume le courtier »).",
      };
    } catch (e) {
      if (e instanceof BrokerError || e instanceof MarketError) return { error: e.message };
      throw e;
    }
  }

  @Post("wake")
  async wake() {
    try {
      const s = await this.broker.wake(true);
      if (s.state === "on") return { ...view(s), note: "Le courtier est déjà allumé : rien à attendre." };
      const delay = s.wakeMs ? `environ ${wakeDurationLabel(s.wakeMs)}` : "une à trois minutes";
      return {
        ...view(s),
        note: `Préviens-le en une phrase que le courtier se rallume et qu'il faut compter ${delay} ; tu lui diras quand il est prêt. Ne repasse pas la demande d'avant tout de suite (prix, graphique, ordre) : elle échouerait ; reprends-la quand il sera prêt. Un ordre ne se prépare qu'une fois le courtier rallumé.`,
      };
    } catch (e) {
      if (e instanceof BrokerError || e instanceof MarketError) return { error: e.message };
      throw e;
    }
  }

  @Post("settings")
  async settings(@Body() body: { weekend?: boolean; nights?: boolean }) {
    const change = {
      ...(typeof body?.weekend === "boolean" ? { weekend: body.weekend } : {}),
      ...(typeof body?.nights === "boolean" ? { nights: body.nights } : {}),
    };
    try {
      const s = await this.broker.setRules(change);
      return { ...view(s), note: statusNote(s) };
    } catch (e) {
      if (e instanceof BrokerError || e instanceof MarketError) return { error: e.message };
      throw e;
    }
  }
}

/** Ce que le dialogue lit de l'état : sans les instants bruts. */
function view(s: BrokerStatus) {
  return {
    state: s.state,
    label: s.label,
    rules: {
      weekend: s.weekend ? "pause du vendredi 23 h 05 au dimanche 22 h 30 (heure de Paris)" : "pas de pause le week-end",
      nights: s.nights ? "pause de 23 h à 5 h, sauf trade en cours ou en attente" : "pas de pause la nuit",
    },
    ...(s.wakeMs ? { lastWake: wakeDurationLabel(s.wakeMs) } : {}),
    ...(s.error ? { error: s.error } : {}),
  };
}

function statusNote(s: BrokerStatus): string {
  if (s.state === "off") return "La pause du compte n'est pas active sur ce serveur.";
  return "Réponds en une phrase avec ses mots (allumé, en pause, rallumage). Pour les coûts : MetaApi facture environ 0,0126 $ par heure allumé (9,20 $ par mois en continu) ; la pause du week-end en économise environ 2 $ par mois, la nuit presque rien (un rallumage coûte autant que six heures et demie allumé).";
}
