import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { RobotService } from "../algo/robot.service.js";
import { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  BinaryKind,
  ClaudeContentBlock,
  decodeBinaryFrame,
  PipelineState,
  PROTOCOL_VERSION,
  safeParseClientMessage,
  Scenario,
  ServerMessage,
  TurnOutcome,
} from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { SessionService } from "../session/session.service.js";
import { stepLabel } from "../session/steps.js";
import { ApprovalRow, JobError, JobFinished, JobRow, JobService } from "../jobs/job.service.js";
import {
  abandonReport,
  alertReport,
  approvalRequired,
  briefReport,
  jobReport,
  jobUpdated,
  learningReport,
  opportunityReport,
  searchReport,
  tradeReport,
  reviewReport,
  reviewFailedReport,
  eveningReport,
  Report,
  ServerBody,
} from "./messages.js";
import { BriefReady, BriefService } from "../veille/brief.service.js";
import { LearningRunRow, LearningService, parseChanges } from "../learning/learning.service.js";
import { SkillService } from "../learning/skill.service.js";
import { DocumentService } from "../documents/document.service.js";
import { DashboardService, DashboardView } from "../dashboard/dashboard.service.js";
import { MarketService } from "../market/market.service.js";
import { Quote } from "../market/quote-feed.js";
import { AlertFired, AlertService } from "../alerts/alert.service.js";
import { firedTexts } from "../alerts/alert-texts.js";
import { AwayNotifier } from "../channels/away-notifier.js";
import type { AwayNews } from "../channels/away-texts.js";
import { ScenarioService } from "../setups/scenario.service.js";
import { SetupsUpdatedView } from "../setups/setups-view.js";
import { abandonedTexts, proposedTexts, searchedTexts } from "../setups/setup-texts.js";
import { SetupAgentsService } from "../setups/setup-agents.service.js";
import { TradingService, type TradingSignal } from "../trading/trading.service.js";
import { JournalService } from "../journal/journal.service.js";
import { bilanText } from "../journal/journal-bilan.js";
import { ticketAnswer } from "../trading/ticket-answer.js";
import { SttService } from "../voice/stt.service.js";
import { TtsService } from "../voice/tts.service.js";
import { SentenceGrouper } from "../voice/sentence-grouper.js";
import { cutsReply, isLikelyHallucination, joinPhrases, looksUnfinished } from "../voice/transcript-filter.js";
import { newId } from "../common/ids.js";
import type { Conn, MicRoute } from "./conn.js";
import { SpeechPort, SpeechTurn } from "./speech-turn.js";
import { ReportQueue } from "./report-queue.js";
import { NewsBatch, NewsService } from "../news/news.service.js";
import { newsReport } from "../news/news-texts.js";

/**
 * Une phrase qui a l'air inachevée attend sa suite ce temps-là après sa
 * transcription : l'utilisateur a marqué une pause au milieu (« Envoie le… »).
 * S'il reprend, on attend aussi la transcription de la suite, sans dépasser HOLD_MAX_MS.
 */
const HOLD_MS = 2000;
const HOLD_MAX_MS = 25_000;

/** Un travail dans ces états est en cours (il ouvre l'activité en démarrant). */
const ACTIVE_JOB_STATES = new Set<string>(["queued", "running", "awaiting_approval"]);

/**
 * Ajoutée en tête du tour suivant quand l'utilisateur a coupé Kopilia : sans
 * elle, Claude croit avoir été entendu jusqu'au bout.
 */
const CUT_NOTE =
  "[Remarque : l'utilisateur a repris la parole pendant ta réponse précédente et n'en a pas entendu la fin. Ce n'est pas un refus : réponds simplement à ce qu'il dit maintenant.]";

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private wss?: WebSocketServer;
  private conns = new Set<Conn>();
  private ttsRoutes = new Map<number, SpeechTurn>();
  /** Tours en cours (y compris sans audio encore), pour annuler un filler au barge-in. */
  private activeTurns = new Set<SpeechTurn>();
  private micRoutes = new Map<number, MicRoute>();
  /** Ce que Kopilia rapporte de lui-même, dès que la conversation est au repos. */
  private readonly reports = new ReportQueue({
    busy: (conn) => this.isBusy(conn),
    alive: (conn) => this.conns.has(conn),
    run: (conn, report) => void this.reportTurn(conn, report),
  });
  /** Arrêt du serveur en cours : on ne ferme plus les sessions une à une. */
  private stopping = false;

  constructor(
    private readonly logger: AppLogger,
    private readonly sessions: SessionService,
    private readonly jobs: JobService,
    private readonly briefs: BriefService,
    private readonly learning: LearningService,
    private readonly skills: SkillService,
    private readonly documents: DocumentService,
    private readonly dashboard: DashboardService,
    private readonly market: MarketService,
    private readonly alerts: AlertService,
    private readonly scenarios: ScenarioService,
    private readonly setupAgents: SetupAgentsService,
    private readonly setupsView: SetupsUpdatedView,
    private readonly away: AwayNotifier,
    private readonly news: NewsService,
    private readonly stt: SttService,
    private readonly tts: TtsService,
    private readonly trading: TradingService,
    @Optional() private readonly journal?: JournalService,
    @Optional() private readonly robots?: RobotService,
  ) {}

  onModuleInit() {
    this.wireVoice();
    this.wireJobs();
    this.wireDashboard();
    this.wireAlerts();
    this.wireSetups();
    this.wireNews();
    this.wireTrading();
    this.wireJournal();
    this.wireRobots();
  }

  /**
   * Ferme les connexions WebSocket à l'arrêt. Nest appelle ce hook AVANT de
   * fermer le serveur HTTP ; sans lui, cette fermeture attend indéfiniment les
   * clients connectés (Ctrl+C bloqué tant qu'un navigateur est ouvert).
   */
  onModuleDestroy() {
    this.stopping = true;
    for (const turn of this.activeTurns) turn.clearFiller();
    this.reports.stop();
    for (const conn of this.conns) conn.ws.terminate();
    this.conns.clear();
    this.wss?.close();
  }

  /** Attache le serveur WebSocket au serveur HTTP (même origine, loopback). */
  attach(http: HttpServer) {
    this.wss = new WebSocketServer({ server: http, path: "/ws" });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.logger.log("WebSocket attaché sur /ws", "gateway");
  }

  /* ----------------------------- Connexion ----------------------------- */

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const token = url.searchParams.get("token") ?? "";

    // Sécurité : loopback + origine locale + jeton de session valide.
    if (!this.isLocalOrigin(req) || !this.sessions.validateToken(sessionId, token)) {
      this.logger.warn("connexion WS refusée (origine ou jeton)", "gateway");
      ws.close(4401, "unauthorized");
      return;
    }

    const conn: Conn = {
      ws,
      sessionId,
      deltaSeq: 0,
      seen: new Set(),
      latestTurn: "",
      cutNote: false,
      openUtterances: new Set(),
      inCall: false,
      muted: false,
      hidden: false,
    };
    this.conns.add(conn);
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => this.onMessage(conn, data as Buffer, isBinary));
    ws.on("close", () => this.onClose(conn));
    ws.on("error", (e) => this.logger.warn(`ws error: ${e.message}`, "gateway"));

    this.send(conn, { type: "session.ready", claudeSessionId: this.sessions.claudeSessionId(sessionId) });
    // Le tableau de bord tel qu'il est, et les dernières cotations connues ; le flux reprend s'il dormait.
    this.send(conn, { type: "dashboard.updated", ...this.dashboard.view() });
    this.send(conn, { type: "setups.updated", ...this.setupsView.build() });
    this.send(conn, { type: "trading.updated", state: this.trading.state() });
    if (this.robots) this.send(conn, { type: "robots.updated", robots: this.robots.list() });
    for (const q of this.market.feed.snapshot()) this.send(conn, { type: "market.quote", ...q });
    this.market.feed.setListening(this.conns.size);
    this.logger.log(`session ${sessionId} connectée`, "gateway");
    // Claude prêt avant la première phrase.
    try {
      this.sessions.warm(sessionId);
    } catch (e) {
      this.logger.warn(`lancement anticipé de claude impossible: ${(e as Error).message}`, "gateway");
    }
  }

  /**
   * Fin de connexion. Si c'était la dernière de la session, on ferme celle-ci
   * (arrêt de son processus claude) : une page rechargée ou reconnectée crée de
   * toute façon une nouvelle session, l'ancienne laisserait un processus orphelin.
   */
  private onClose(conn: Conn) {
    this.takeHeld(conn);
    this.conns.delete(conn);
    this.market.feed.setListening(this.conns.size);
    this.reports.forget(conn);
    for (const turn of this.activeTurns) if (turn.conn === conn) turn.stop();
    // Énoncé en cours : whisper ferme le flux (sinon il reste ouvert, et sa route retient la connexion).
    for (const [streamId, route] of this.micRoutes) {
      if (route.conn !== conn) continue;
      this.stt.cancel(streamId);
      this.micRoutes.delete(streamId);
    }
    // Réponse en cours de synthèse : personne ne l'entendra plus.
    for (const [streamId, turn] of this.ttsRoutes) {
      if (turn.conn !== conn) continue;
      turn.cancelAudio(false);
      this.ttsRoutes.delete(streamId);
    }
    if (this.stopping) return;
    if ([...this.conns].some((c) => c.sessionId === conn.sessionId)) return;
    this.reports.dropSession(conn.sessionId);
    try {
      this.sessions.close(conn.sessionId);
    } catch (e) {
      this.logger.warn(`fermeture de session impossible: ${(e as Error).message}`, "gateway");
    }
  }

  private isLocalOrigin(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").split(":")[0];
    const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    if (!localHosts.has(host)) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const oh = new URL(origin).hostname;
        if (!localHosts.has(oh)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /* ------------------------------ Messages ----------------------------- */

  private onMessage(conn: Conn, data: Buffer, isBinary: boolean) {
    if (isBinary) return this.onBinary(conn, data);

    const parsed = safeParseClientMessage(safeJson(data.toString("utf8")));
    if (!parsed.success) {
      this.send(conn, { type: "error", code: "bad_message", message: "message invalide" });
      return;
    }
    const msg = parsed.data;
    if (msg.sessionId !== conn.sessionId) return; // jeton lié à la session

    switch (msg.type) {
      case "mic.format":
        this.stt.open(msg.streamId, msg.format.sampleRate);
        this.micRoutes.set(msg.streamId, { conn, baseTurnId: msg.turnId, utter: 0, bargeIn: !!msg.bargeIn, ptt: !!msg.ptt });
        conn.openUtterances.add(msg.streamId);
        this.setState(conn, PipelineState.Listening);
        break;
      case "mic.cancel": {
        // L'utilisateur abandonne son énoncé : rien n'est transcrit ni envoyé.
        const route = this.micRoutes.get(msg.streamId);
        if (!route || route.conn !== conn) break;
        this.stt.cancel(msg.streamId);
        this.micRoutes.delete(msg.streamId);
        conn.openUtterances.delete(msg.streamId);
        if (![...this.activeTurns].some((t) => t.conn === conn)) this.setState(conn, PipelineState.Idle);
        this.reports.schedule(conn);
        break;
      }
      case "call.state": {
        const pickedUp = msg.inCall && !conn.inCall;
        conn.inCall = msg.inCall;
        conn.muted = msg.inCall && !!msg.muted;
        // L'écran peut parler (premier geste dans la page, le « décroché ») : les alertes parties en son absence passent en premier,
        // puis le wrap automatique encore jamais dit, puis les recettes que la
        // relecture propose d'adopter, jamais encore dites.
        if (pickedUp) {
          const queued = new Set(this.reports.pending(conn.sessionId).flatMap((r) => r.alertEventIds ?? []));
          const missed = this.alerts.undelivered().filter((f) => !queued.has(f.eventId));
          if (missed.length) this.reports.add(conn, alertReport(missed, true));
          const queuedSetups = new Set(this.reports.pending(conn.sessionId).flatMap((r) => r.scenarioIds ?? []));
          const untold = this.scenarios.untold().filter((s) => !queuedSetups.has(s.id));
          if (untold.length)
            this.reports.add(
              conn,
              opportunityReport(
                untold.map((s) => this.scenarios.get(s.id, true) ?? s),
                true,
              ),
            );
          const brief = this.briefs.unannounced();
          if (brief) this.reports.add(conn, briefReport(brief));
          const proposals = this.learning.unannouncedProposals();
          if (proposals.length) this.reports.add(conn, learningReport(proposals));
        }
        // Micro coupé : ce que Kopilia gardait déjà pour après part sur Telegram.
        // Micro rétabli : il peut le dire.
        this.relayPending(conn);
        if (!conn.muted) this.reports.schedule(conn);
        break;
      }
      case "page.visibility":
        // Plus aucun écran regardé : ce qui attendait d'être dit part aussi sur Telegram.
        conn.hidden = msg.hidden;
        if (msg.hidden) for (const c of this.conns) this.relayPending(c);
        break;
      case "text.input":
        if (this.once(conn, msg.eventId)) {
          this.releaseHeld(conn);
          void this.handleUserTurn(conn, msg.turnId, msg.text);
        }
        break;
      case "playback.interrupt":
        // Le client ne l'envoie que s'il coupe une réponse audible ou en préparation.
        conn.cutNote = true;
        this.interrupt(conn, msg.streamId);
        break;
      case "job.command":
        this.handleJobCommand(conn, msg.command, msg.jobId, msg.note);
        break;
      case "approval.resolve":
        // Seule la conversation qui a reçu la demande peut y répondre (un identifiant rejoué ou fuité n'y suffit pas).
        if (this.jobs.approval(msg.approvalId)?.session_id === conn.sessionId) this.jobs.resolveApproval(msg.approvalId, msg.decision);
        break;
    }
  }

  private onBinary(conn: Conn, data: Buffer) {
    let frame;
    try {
      frame = decodeBinaryFrame(data);
    } catch {
      this.send(conn, { type: "error", code: "bad_frame", message: "trame binaire invalide" });
      return;
    }
    if (frame.header.kind !== BinaryKind.Mic) return;
    const route = this.micRoutes.get(frame.header.streamId);
    if (!route || route.conn !== conn) return;
    this.stt.audio(frame.header.streamId, frame.header.seq, frame.payload);
    if (frame.header.final) this.stt.close(frame.header.streamId);
  }

  /* ------------------------- Phrases coupées ------------------------- */

  /**
   * Une phrase transcrite. Si une phrase inachevée attendait, celle-ci est sa
   * suite : les deux partent ensemble. Une phrase qui a l'air inachevée
   * (« Envoie le », « Fais-moi un… ») attend sa suite un instant au lieu de
   * partir seule : Kopilia agirait sur un morceau. Un mot d'arrêt ne s'attend jamais,
   * ni une phrase dite à la touche (`ptt`) : relâcher la touche dit qu'elle est finie.
   */
  private onPhrase(conn: Conn, turnId: string, text: string, bargeIn: boolean, lang?: string, ptt = false) {
    const held = this.takeHeld(conn);
    const phrase = held ? joinPhrases(held.text, text) : text;
    const barged = bargeIn || !!held?.bargeIn;
    if (!ptt && !cutsReply(phrase) && looksUnfinished(phrase)) {
      // À l'écran, une phrase encore en cours (comme pendant qu'il parle) : rien ne lui répond encore.
      this.send(conn, { type: "transcript.partial", turnId, text: phrase });
      this.hold(conn, turnId, phrase, barged, held?.since ?? Date.now(), lang);
      return;
    }
    if (held) this.logger.debug(`phrase coupée par une pause, rejointe : « ${phrase} »`, "gateway");
    this.sendPhrase(conn, turnId, phrase, barged, lang);
  }

  /**
   * Une phrase part : l'écran la reçoit finie, sous le même identifiant que sa
   * réponse (il attend une réponse par phrase finie), puis Claude la reçoit.
   * `cut` : l'écran coupe la voix qu'il joue encore ; sinon, il la laisse finir.
   */
  private sendPhrase(conn: Conn, turnId: string, text: string, bargeIn: boolean, lang?: string) {
    this.send(conn, { type: "transcript.final", turnId, text, lang, cut: cutsReply(text) || undefined });
    void this.handleUserTurn(conn, turnId, text, bargeIn);
  }

  private hold(conn: Conn, turnId: string, text: string, bargeIn: boolean, since: number, lang?: string) {
    const check = () => {
      const h = conn.held;
      if (!h) return;
      // Il a repris la parole : on attend la transcription de la suite.
      if (conn.openUtterances.size > 0 && Date.now() - h.since < HOLD_MAX_MS) {
        h.timer = setTimeout(check, 250);
        return;
      }
      this.releaseHeld(conn);
    };
    conn.held = { turnId, text, bargeIn, since, lang, timer: setTimeout(check, HOLD_MS) };
    // Kopilia écoute la suite, il ne réfléchit pas encore.
    if (!this.hasOngoingReply(conn)) this.setState(conn, PipelineState.Listening);
    this.logger.debug(`phrase inachevée, on attend la suite : « ${text} »`, "gateway");
  }

  /** La phrase qui attendait part telle quelle (pas de suite, ou l'utilisateur a tapé autre chose). */
  private releaseHeld(conn: Conn) {
    const held = this.takeHeld(conn);
    if (held) this.sendPhrase(conn, held.turnId, held.text, held.bargeIn, held.lang);
  }

  private takeHeld(conn: Conn) {
    const held = conn.held;
    if (held) clearTimeout(held.timer);
    conn.held = undefined;
    return held;
  }

  /* --------------------------- Tour de dialogue ------------------------ */

  /**
   * Une phrase de l'utilisateur. Pendant une réponse (encore préparée, dite,
   * ou qu'il entendait quand il a pris la parole : `heard`), elle ne la coupe
   * que si elle demande à Kopilia de se taire (« stop », « attends »…) ; sinon
   * cette réponse va à son terme, et celle de la phrase passe après elle.
   */
  private async handleUserTurn(conn: Conn, turnId: string, text: string, heard = false) {
    const replying = heard || this.hasOngoingReply(conn);
    const cut = replying && cutsReply(text);
    if (cut) {
      conn.cutNote = true;
      if (this.hasOngoingReply(conn)) this.interrupt(conn);
    }
    // Un ticket attend : « je confirme » l'envoie, « non » le retire, reconnus ici, jamais par l'IA.
    const ticketNote = await this.answerTicket(conn, text);
    // Devant la phrase : la coupure s'il y en a eu une, et les encarts affichés (Kopilia sait ce qu'il voit).
    const notes = [conn.cutNote ? CUT_NOTE : "", ticketNote, this.dashboard.describe()].filter(Boolean);
    const prompt = notes.length ? `${notes.join("\n")}\n${text}` : text;
    conn.cutNote = false;
    // Les documents déposés partent avec cette phrase : c'est elle qui dit quoi en faire.
    const docs = this.documents.take(conn.sessionId, turnId);
    if (docs.length) {
      this.send(conn, { type: "documents.attached", turnId, documents: docs.map((d) => ({ documentId: d.id, name: d.name })) });
    }
    // Derrière une réponse qui continue, une phrase d'attente ne se dirait qu'après elle : aucune.
    return this.dialogueTurn(conn, turnId, text, prompt, !replying || cut, this.documents.content(docs));
  }

  /**
   * La phrase répond-elle au ticket en attente ? La confirmation envoie les
   * ordres (le code, pas l'IA) avant le tour de Kopilia, qui reçoit le résultat
   * à dire ; un refus retire le ticket. Sinon, Kopilia sait seulement qu'un
   * ticket attend (il ne peut pas le confirmer).
   */
  private async answerTicket(conn: Conn, text: string): Promise<string> {
    const ticket = this.trading.ticket();
    if (!ticket) return "";
    const answer = ticketAnswer(text);
    if (answer === "cancel") {
      this.trading.cancelTicket(ticket.id);
      return `[Ticket ${ticket.id} retiré par l'utilisateur : rien n'est parti chez le courtier. S'il demande autre chose (un autre stop, une autre taille), prépare un nouveau ticket.]`;
    }
    if (answer !== "confirm")
      return `[Un ticket attend sa confirmation (${ticket.id}) : ${ticket.text} Tu ne peux pas le confirmer ; seul « je confirme » ou le bouton du ticket l'envoie.]`;
    this.setState(conn, PipelineState.Thinking);
    try {
      const r = await this.trading.confirm(ticket.id, "voice");
      return `[Ordre : l'utilisateur vient de confirmer à la voix le ticket ${ticket.id} ; le code l'a envoyé chez le courtier. ${r.text} Dis-lui le résultat en une phrase.]`;
    } catch (e) {
      return `[Ordre : l'utilisateur a confirmé le ticket ${ticket.id}, mais rien n'est parti : ${(e as Error).message}. Dis-le-lui en une phrase.]`;
    }
  }

  /** Kopilia rapporte de lui-même le résultat d'un agent, d'une tâche ou d'une veille. */
  private reportTurn(conn: Conn, r: Report) {
    this.send(conn, { type: "agent.report", turnId: r.turnId, jobId: r.jobId, title: r.title, briefId: r.briefId });
    if (r.briefId) this.briefs.markAnnounced(r.briefId);
    if (r.skillIds) this.skills.markAnnounced(r.skillIds);
    if (r.alertEventIds) this.alerts.markDelivered(r.alertEventIds);
    for (const id of r.scenarioIds ?? []) this.scenarios.markTold(id);
    return this.dialogueTurn(conn, r.turnId, null, r.prompt, false);
  }

  /**
   * Un tour de dialogue : génération Claude diffusée en deltas, synthèse par
   * phrases. `userText` null : tour de Kopilia seul (rapport), sans filler.
   */
  private async dialogueTurn(conn: Conn, turnId: string, userText: string | null, prompt: string, filler: boolean, attachments: ClaudeContentBlock[] = []) {
    conn.latestTurn = turnId;
    this.setState(conn, PipelineState.Thinking);
    const grouper = new SentenceGrouper();
    const turn = new SpeechTurn(conn, turnId, this.speechPort(conn));
    this.activeTurns.add(turn);
    // Couche 1 (« masking latency ») : toute vraie phrase annule le filler avant qu'il parte.
    if (filler) turn.startFiller();

    const onDelta = (delta: string) => {
      this.send(conn, { type: "assistant.delta", turnId, seq: conn.deltaSeq++, text: delta });
      for (const segment of grouper.push(delta)) turn.say(segment);
    };

    try {
      // Chaque outil appelé est une étape que l'écran montre derrière l'orbe.
      const onTool = (tool: string) => {
        const label = stepLabel(tool);
        if (label) this.send(conn, { type: "activity.step", turnId, tool, label });
      };
      const result = await this.sessions.runTurn(conn.sessionId, turnId, userText, onDelta, { prompt, attachments, onTool });
      const remainder = grouper.flush();
      if (remainder) turn.say(remainder);
      turn.finish();
      const outcome = turn.interrupted ? TurnOutcome.Interrupted : result.outcome;
      this.send(conn, { type: "assistant.done", turnId, outcome });
      // Avec de l'audio, le repos est annoncé à la fin de la synthèse.
      if (conn.latestTurn === turnId && !turn.started) this.setState(conn, PipelineState.Idle);
    } catch (err) {
      turn.fail();
      this.send(conn, {
        type: "error",
        code: "turn_failed",
        message: `échec du tour: ${(err as Error).message}`,
        recovery: "réessayer ; le texte dicté reste disponible",
      });
      this.send(conn, { type: "assistant.done", turnId, outcome: TurnOutcome.Error });
      if (conn.latestTurn === turnId) this.setState(conn, PipelineState.Idle);
    } finally {
      turn.clearFiller();
      this.activeTurns.delete(turn);
      this.reports.schedule(conn);
    }
  }

  /** La voix d'un tour : branchée sur cette connexion et sur la synthèse. */
  private speechPort(conn: Conn): SpeechPort {
    return {
      send: (body) => this.send(conn, body),
      setState: (state) => this.setState(conn, state),
      isLatest: (turnId) => conn.latestTurn === turnId,
      speaking: (turn) => this.ttsRoutes.set(turn.streamId, turn),
      silent: (turn) => {
        this.ttsRoutes.delete(turn.streamId);
        this.reports.schedule(conn);
      },
      tts: this.tts,
    };
  }

  /** Une réponse de cette connexion est encore générée ou synthétisée. */
  private hasOngoingReply(conn: Conn): boolean {
    return [...this.activeTurns].some((t) => t.conn === conn) || [...this.ttsRoutes.values()].some((t) => t.conn === conn);
  }

  private interrupt(conn: Conn, streamId?: number) {
    // Tours sans audio encore : annuler le filler en attente et taire la suite.
    let generating = false;
    for (const turn of this.activeTurns) {
      if (turn.conn !== conn) continue;
      if (streamId !== undefined && turn.streamId !== streamId) continue;
      turn.stop();
      generating = true;
    }
    // Arrête aussi la génération côté Claude : la phrase suivante n'attend pas
    // la fin d'une réponse que personne n'écoutera.
    if (generating) this.sessions.interrupt(conn.sessionId);
    for (const [sid, turn] of this.ttsRoutes) {
      if (turn.conn !== conn) continue;
      if (streamId !== undefined && sid !== streamId) continue;
      turn.cancelAudio(true);
      this.ttsRoutes.delete(sid);
    }
    this.setState(conn, PipelineState.Idle);
    this.reports.schedule(conn);
  }

  /* ----------------------- Rapports d'agents --------------------------- */

  /**
   * Kopilia ne coupe jamais la conversation pour rapporter un résultat : il
   * attend qu'aucune réponse ne soit en cours, que l'utilisateur ne parle pas,
   * et que son micro ne soit pas coupé (il parle alors à quelqu'un d'autre).
   */
  private isBusy(conn: Conn): boolean {
    return this.hasOngoingReply(conn) || conn.openUtterances.size > 0 || conn.muted || !!conn.held;
  }

  /**
   * Un rapport pour cette conversation, avec sa version pour Telegram s'il en
   * a une (`news`) : si l'utilisateur ne regarde pas (micro coupé, écrans
   * tous cachés), elle part tout de suite, car il ne veut rien manquer ;
   * Kopilia le dira quand même, à son tour.
   */
  private report(conn: Conn, report: Report, news?: AwayNews) {
    this.reports.add(conn, news ? { ...report, news } : report);
    this.relayPending(conn);
  }

  /**
   * Micro coupé ou écrans tous cachés : ce que Kopilia garde pour cette
   * conversation part sur Telegram, une seule fois.
   */
  private relayPending(conn: Conn) {
    if (!conn.muted && this.watched()) return;
    for (const r of this.reports.pending(conn.sessionId)) {
      if (!r.news || r.relayed) continue;
      r.relayed = true;
      this.away.relay(r.news);
    }
  }

  /**
   * Une nouvelle que personne ne recevra en appel : sans aucun écran, la
   * notification du Mac et Telegram ; écrans tous cachés (un autre onglet,
   * fenêtre réduite), Telegram seulement. Écran regardé : son bandeau suffit.
   */
  private outOfSight(news: AwayNews) {
    if (!this.conns.size) this.away.tell(news);
    else if (!this.watched()) this.away.relay(news);
  }

  /** Au moins un écran est visible : l'utilisateur a l'œil sur Kopilia. */
  private watched(): boolean {
    return [...this.conns].some((c) => !c.hidden);
  }

  /* ------------------------------- Voix -------------------------------- */

  private wireVoice() {
    this.stt.on("stt.partial", (e: { streamId: number; text: string }) => {
      const r = this.micRoutes.get(e.streamId);
      if (r) this.send(r.conn, { type: "transcript.partial", turnId: this.utterTurnId(r), text: e.text });
    });
    this.stt.on("stt.final", (e: { streamId: number; text: string; lang?: string }) => {
      const r = this.micRoutes.get(e.streamId);
      if (!r) return;
      const turnId = this.utterTurnId(r);
      r.conn.openUtterances.delete(e.streamId);
      // Hallucination Whisper (bruit, silence) : traitée comme un énoncé vide.
      const text = isLikelyHallucination(e.text) ? "" : e.text.trim();
      if (text) {
        // `bargeIn` : Kopilia parlait quand l'utilisateur a pris la parole, même
        // si l'envoi de l'audio était déjà fini ; s'il est coupé, il le saura.
        // La phrase n'est dite finie à l'écran (transcript.final) qu'au moment
        // où elle part : une phrase inachevée attend d'abord sa suite.
        if (this.once(r.conn, `stt:${e.streamId}:${r.utter}`)) this.onPhrase(r.conn, turnId, text, r.bargeIn, e.lang, r.ptt);
      } else {
        this.send(r.conn, { type: "transcript.final", turnId, text, lang: e.lang });
      }
      if (!text && !r.conn.held) {
        // Rien d'audible (toux, bruit) : la réponse en cours continue ; sinon
        // retour au repos, l'état resterait « transcription ». Après une phrase
        // inachevée, rien à faire : elle attend sa suite, son minuteur la libère.
        if (!this.hasOngoingReply(r.conn)) this.setState(r.conn, PipelineState.Idle);
        this.reports.schedule(r.conn);
      }
      r.utter++; // prochaine prise de parole sur le même flux
    });
    this.stt.on("stt.vad", (e: { streamId: number; speaking: boolean }) => {
      const r = this.micRoutes.get(e.streamId);
      if (r) this.setState(r.conn, e.speaking ? PipelineState.Listening : PipelineState.Transcribing);
    });

    // La synthèse d'une phrase : début (son texte part juste avant ses trames), trames, fin, erreur.
    this.tts.on("tts.start", (e) => this.ttsRoutes.get(e.streamId)?.sentenceStarted());
    this.tts.on("chunk", (c) => {
      const turn = this.ttsRoutes.get(c.streamId);
      const frame = turn?.frame(c.pcm);
      if (frame && turn!.conn.ws.readyState === WebSocket.OPEN) turn!.conn.ws.send(frame);
    });
    this.tts.on("tts.end", (e) => this.ttsRoutes.get(e.streamId)?.sentenceEnded());
    this.tts.on("tts.error", (e) => {
      const turn = e.streamId !== undefined ? this.ttsRoutes.get(e.streamId) : undefined;
      if (!turn) return;
      this.send(turn.conn, { type: "error", code: "tts_error", message: e.message, recovery: "réponse affichée à l'écran" });
      // Le worker n'enverra pas de fin pour cette phrase : sans cela, l'audio ne se terminerait jamais.
      turn.sentenceEnded();
    });
  }

  /* ------------------------------- Jobs -------------------------------- */

  private wireJobs() {
    // Un agent ou une tâche de l'utilisateur démarre : l'activité s'affiche si elle n'y est pas (une fois par travail : fermée ensuite, elle le reste).
    const announced = new Set<string>();
    this.jobs.on("job.updated", (row: JobRow) => {
      for (const conn of this.conns) {
        if (conn.sessionId === row.session_id) this.send(conn, jobUpdated(row, this.jobs.folderOf(row)));
      }
      if (this.sessions.get(row.session_id)?.state === "system") return;
      // Toutes conversations confondues : chaque écran relit son activité.
      for (const conn of this.conns) this.send(conn, { type: "activity.changed", jobId: row.id });
      if (!ACTIVE_JOB_STATES.has(row.state)) {
        announced.delete(row.id);
        return;
      }
      if (announced.has(row.id)) return;
      announced.add(row.id);
      try {
        this.dashboard.openActivity();
      } catch (e) {
        this.logger.warn(`activité non ouverte : ${(e as Error).message}`, "gateway");
      }
    });
    // Étape d'un agent ou d'une tâche : un bloc de plus autour de son nœud, à l'écran.
    this.jobs.on("job.step", ({ job, tool }: { job: JobRow; tool: string }) => {
      const label = stepLabel(tool);
      if (!label) return;
      for (const conn of this.conns) {
        if (conn.sessionId === job.session_id) this.send(conn, { type: "activity.step", jobId: job.id, tool, label });
      }
    });
    // Un travail terminé : Kopilia le rapporte de lui-même, sans couper la conversation ;
    // s'il n'est pas regardé (page fermée ou cachée, micro coupé), il part aussi sur Telegram.
    this.jobs.on("job.finished", ({ job, announce }: JobFinished) => {
      if (!announce) return;
      const conn = [...this.conns].find((c) => c.sessionId === job.session_id);
      const news: AwayNews = { kind: "agent", job };
      if (conn) this.report(conn, jobReport(job), news);
      else this.outOfSight(news);
    });
    // Brief de veille prêt : signalé à l'écran partout, dit à la conversation qui
    // l'a demandé ; un brief programmé est dit à qui est en appel, sinon au
    // prochain décroché. Page fermée ou cachée, micro coupé : son titre et son « En bref » partent sur Telegram.
    this.briefs.on("brief.ready", ({ brief, sessionId }: BriefReady) => {
      for (const conn of this.conns) {
        this.send(conn, { type: "brief.ready", briefId: brief.id, title: brief.title, createdAt: brief.created_at, trigger: brief.trigger });
      }
      const target = [...this.conns].find((c) => (sessionId ? c.sessionId === sessionId : c.inCall));
      if (target) this.report(target, briefReport(brief), { kind: "brief", brief });
      else this.outOfSight({ kind: "brief", brief });
    });
    this.briefs.on("brief.failed", ({ job, sessionId }: { job: JobRow; sessionId: string | null }) => {
      const conn = sessionId ? [...this.conns].find((c) => c.sessionId === sessionId) : undefined;
      if (conn) this.reports.add(conn, jobReport(job));
    });
    // Relecture ou rangement terminé : signalé à l'écran partout ; des recettes
    // proposées sont dites à qui est en appel, sinon au prochain décroché.
    this.learning.on("learning.finished", (run: LearningRunRow) => {
      const pending = this.skills.pending().length;
      for (const conn of this.conns) {
        this.send(conn, {
          type: "learning.updated",
          runId: run.id,
          kind: run.kind,
          summary: run.summary ?? "",
          changes: parseChanges(run.changes).length,
          pending,
        });
      }
      const proposals = this.learning.unannouncedProposals();
      const target = [...this.conns].find((c) => c.inCall);
      if (proposals.length && target) this.reports.add(target, learningReport(proposals));
    });
    this.jobs.on("approval.required", (a: ApprovalRow) => {
      for (const conn of this.conns) {
        if (conn.sessionId === a.session_id) this.send(conn, approvalRequired(a));
      }
    });
  }

  /* --------------------------- Tableau de bord ------------------------- */

  /** Encarts, tracés et cotations : tous les écrans montrent le même tableau de bord. */
  private wireDashboard() {
    this.dashboard.on("updated", (view: DashboardView) => {
      for (const conn of this.conns) this.send(conn, { type: "dashboard.updated", ...view });
    });
    // Agrandir, réduire, ramener dans sa marge, à la voix : chaque écran l'applique à sa façon.
    this.dashboard.on("display", (d) => {
      for (const conn of this.conns) this.send(conn, { type: "panel.display", ...d });
    });
    this.market.feed.on("quote", (q: Quote) => {
      // Un produit suivi pour ses seules alertes n'est pas à l'écran.
      if (!this.market.feed.shows(q.symbol)) return;
      for (const conn of this.conns) this.send(conn, { type: "market.quote", ...q });
    });
  }

  /* ----------------------- Recherche d'opportunités ----------------------- */

  /**
   * Les écrans suivent la recherche d'opportunités (au plus quatre fois par
   * seconde). Un setup proposé est signalé partout (bandeau, son) et dit en
   * appel dès que Kopilia a fini sa phrase ; sans écran, une notification du
   * Mac et un message Telegram ; sinon, au prochain décroché. Un setup déjà annoncé puis abandonné
   * est dit aussi ; un scénario qui n'avait pas été proposé se ferme en silence
   * (son fil garde la raison). Une recherche finie est signalée et résumée en
   * appel quand elle a repéré des setups en attente, ou quand l'utilisateur
   * l'avait lancée.
   */
  private wireSetups() {
    let pending: NodeJS.Timeout | undefined;
    this.scenarios.on("changed", () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        const view = this.setupsView.build();
        for (const conn of this.conns) this.send(conn, { type: "setups.updated", ...view });
      }, 250);
      pending.unref();
    });
    this.scenarios.on("proposed", (s: Scenario) => {
      const full = this.scenarios.get(s.id, true) ?? s;
      const { title, detail } = proposedTexts(full);
      for (const conn of this.conns) this.send(conn, { type: "setup.signal", scenarioId: s.id, kind: "proposed", symbol: s.symbol, title, detail });
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, opportunityReport([full]), { kind: "setup", scenario: full });
      else {
        // Page fermée, le message tient lieu d'annonce ; page cachée, il sera aussi dit au prochain décroché.
        if (!this.conns.size) this.scenarios.markTold(s.id);
        this.outOfSight({ kind: "setup", scenario: full });
      }
    });
    // Une recherche finie : dite si elle a repéré des setups en attente, ou si c'est lui qui l'a lancée (il attend la réponse).
    this.setupAgents.on("pass", (d) => {
      if (!d.byUser && !d.opened.length) return;
      // Des setups repérés : leur liste s'affiche si elle n'y est pas (il la ferme quand il veut).
      if (d.opened.length) {
        try {
          this.dashboard.openSetups();
        } catch (e) {
          this.logger.warn(`liste des setups non ouverte : ${(e as Error).message}`, "setups");
        }
      }
      const { title, detail } = searchedTexts(d);
      for (const conn of this.conns) this.send(conn, { type: "setups.searched", byUser: d.byUser, opened: d.opened.map((s) => s.id), title, detail });
      const target = [...this.conns].find((c) => c.inCall);
      const news: AwayNews | undefined = d.opened.length ? { kind: "search", pass: d } : undefined;
      if (target) this.report(target, searchReport(d), news);
      else if (news) this.outOfSight(news);
    });
    this.scenarios.on("closed", (s: Scenario) => {
      if (s.state !== "invalidated" || !s.toldAt) return;
      const { title, detail } = abandonedTexts(s);
      for (const conn of this.conns) this.send(conn, { type: "setup.signal", scenarioId: s.id, kind: "abandoned", symbol: s.symbol, title, detail });
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, abandonReport(s), { kind: "abandon", scenario: s });
      else this.outOfSight({ kind: "abandon", scenario: s });
    });
  }

  /* -------------------------- Prise de position -------------------------- */

  /**
   * Tous les écrans suivent la prise de position (compte, trades, ticket).
   * Ce qui arrive à un trade est signalé partout ; en appel, Kopilia le dit
   * (sauf ce qu'il dit déjà : un ordre confirmé à la voix) ; sinon Telegram
   * et la notification du Mac, comme une alerte.
   */
  private wireTrading() {
    let pending: NodeJS.Timeout | undefined;
    this.trading.on("changed", () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        const state = this.trading.state();
        for (const conn of this.conns) this.send(conn, { type: "trading.updated", state });
      }, 150);
      pending.unref();
    });
    this.trading.on("signal", (s: TradingSignal) => {
      for (const conn of this.conns) {
        this.send(conn, {
          type: "trading.signal",
          kind: s.kind,
          ...(s.trade ? { tradeId: s.trade.id, symbol: s.trade.symbol } : {}),
          title: s.title,
          ...(s.detail ? { detail: s.detail } : {}),
        });
      }
      if (s.quiet) return;
      const news: AwayNews = { kind: "trade", title: s.title, ...(s.detail ? { detail: s.detail } : {}) };
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, tradeReport(s), news);
      else this.outOfSight(news);
    });
  }

  /** Le journal change (un trade, une note, une fiche) : les écrans le relisent ; Kopilia ouvre la page d'un trade sur tous les écrans. */
  /** Le laboratoire de stratégies a changé (robot, backtest, fil) : la liste des robots à tous les écrans, groupée. */
  private wireRobots() {
    if (!this.robots) return;
    let pending: NodeJS.Timeout | undefined;
    this.robots.on("changed", () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        const robots = this.robots!.list();
        for (const conn of this.conns) this.send(conn, { type: "robots.updated", robots });
      }, 300);
      pending.unref();
    });
  }

  private wireJournal() {
    if (!this.journal) return;
    let pending: NodeJS.Timeout | undefined;
    let ids = new Set<string | undefined>();
    this.journal.on("changed", (tradeId) => {
      ids.add(tradeId);
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        const batch = ids;
        ids = new Set();
        const one = batch.size === 1 ? [...batch][0] : undefined;
        for (const conn of this.conns) this.send(conn, { type: "journal.changed", ...(one ? { tradeId: one } : {}) });
      }, 400);
      pending.unref();
    });
    this.journal.on("show", (tradeId) => {
      for (const conn of this.conns) this.send(conn, { type: "journal.show", tradeId });
    });
    this.journal.on("showReview", (reviewId) => {
      for (const conn of this.conns) this.send(conn, { type: "journal.show", reviewId });
    });
    this.journal.on("showCalendar", (calendar) => {
      for (const conn of this.conns) this.send(conn, { type: "journal.show", calendar });
    });
    // Le bilan du soir (réglé par lui) : dit à qui est en appel, sinon sur Telegram.
    this.journal.on("evening", (b) => {
      const first = bilanText(b)[0];
      const news: AwayNews = { kind: "trade", title: "Bilan de ta journée", detail: first };
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, eveningReport(b), news);
      else this.outOfSight(news);
    });
    // L'analyse de son trading est prête : à l'écran partout, dite à qui est en appel, sinon sur Telegram.
    this.journal.on("reviewed", (review) => {
      for (const conn of this.conns) this.send(conn, { type: "journal.show", reviewId: review.id });
      const news: AwayNews = { kind: "trade", title: "Analyse de ton trading prête", detail: review.summary };
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, reviewReport(review), news);
      else this.outOfSight(news);
    });
    this.journal.on("reviewFailed", (message) => {
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, reviewFailedReport(message));
    });
  }

  /* ------------------------------ Alertes ------------------------------ */

  /**
   * Une alerte part : tous les écrans la signalent (bandeau, son) ; en appel,
   * Kopilia la dit dès qu'il a fini sa phrase (elle passe devant les autres
   * rapports) ; sans aucun écran, une notification du Mac et un message
   * Telegram, avec le graphique ; micro coupé ou écrans tous cachés, le
   * message Telegram aussi. Hors appel, elle sera dite au prochain décroché.
   */
  private wireAlerts() {
    this.alerts.on("triggered", (f: AlertFired) => {
      const { title, detail } = firedTexts(f);
      // Une alerte de l'IA réveille l'agent de son scénario : l'écran fait seulement clignoter sa ligne, l'agent décidera s'il faut prévenir.
      if (f.alert.scenarioId) {
        this.alerts.markDelivered([f.eventId]);
        for (const conn of this.conns) {
          this.send(conn, {
            type: "alert.triggered",
            alertId: f.alert.id,
            symbol: f.alert.symbol,
            title,
            detail,
            direction: f.direction,
            price: f.price,
            at: f.at,
            scenarioId: f.alert.scenarioId,
          });
        }
        return;
      }
      for (const conn of this.conns) {
        this.send(conn, {
          type: "alert.triggered",
          alertId: f.alert.id,
          symbol: f.alert.symbol,
          title,
          detail,
          direction: f.direction,
          price: f.price,
          at: f.at,
        });
      }
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, alertReport([f]), { kind: "alert", fired: f });
      else this.outOfSight({ kind: "alert", fired: f });
    });
  }

  /* ------------------------------- News -------------------------------- */

  /**
   * Des news arrivent : tous les écrans les ajoutent à leur encart. Une forte
   * et fraîche fait aussi son bandeau et son son ; en appel, Kopilia la dit en
   * une phrase dès qu'il a fini la sienne (après les alertes, et plus du tout
   * si elle a vieilli) ; sans personne devant l'écran, elle part sur Telegram
   * (et en notification du Mac sans aucun écran).
   */
  private wireNews() {
    this.news.on("batch", (b: NewsBatch) => {
      const banners = b.announce.map((a) => ({
        id: a.item.id,
        title: a.heading,
        detail: a.detail,
        ...(a.item.symbols[0] ? { symbol: a.item.symbols[0] } : {}),
      }));
      for (const conn of this.conns) {
        this.send(conn, { type: "news.added", items: b.items, ...(b.update ? { update: true } : {}), ...(banners.length ? { banners } : {}) });
      }
      if (!b.announce.length) return;
      const items = b.announce.map((a) => a.item);
      const news: AwayNews = { kind: "news", items, names: b.names };
      const target = [...this.conns].find((c) => c.inCall);
      if (target) this.report(target, newsReport(items, b.reaction, b.announce[0].heading), news);
      else this.outOfSight(news);
    });
  }

  private handleJobCommand(conn: Conn, command: "status" | "cancel" | "instruct", jobId?: string, note?: string) {
    // Un écran n'agit que sur les travaux de sa conversation (ce sont les seuls qu'il voit).
    const target = jobId ? this.jobs.get(jobId) : this.jobs.activeFor(conn.sessionId);
    if (!target || target.session_id !== conn.sessionId) {
      this.send(conn, { type: "error", code: "no_job", message: "aucune tâche ciblée" });
      return;
    }
    if (command === "cancel" || (command === "instruct" && note)) {
      try {
        if (command === "cancel") this.jobs.cancel(target.id);
        else this.jobs.instruct(target.id, note!);
      } catch (e) {
        if (!(e instanceof JobError)) throw e;
        this.send(conn, { type: "error", code: "job", message: e.message });
      }
    } else {
      this.send(conn, jobUpdated(target, this.jobs.folderOf(target)));
    }
  }

  /* ------------------------------ Helpers ------------------------------ */

  private setState(conn: Conn, state: PipelineState) {
    this.send(conn, { type: "state.changed", state });
  }

  /** turnId par énoncé : le premier garde le turnId de base, puis suffixé. */
  private utterTurnId(r: MicRoute): string {
    return r.utter === 0 ? r.baseTurnId : `${r.baseTurnId}.${r.utter}`;
  }

  /** Idempotence : vrai si l'eventId n'a pas encore été traité. */
  private once(conn: Conn, eventId: string): boolean {
    if (conn.seen.has(eventId)) return false;
    conn.seen.add(eventId);
    if (conn.seen.size > 2000) conn.seen.delete(conn.seen.values().next().value as string);
    return true;
  }

  private send(conn: Conn, body: ServerBody) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      v: PROTOCOL_VERSION,
      eventId: newId("ev"),
      sessionId: conn.sessionId,
      ts: Date.now(),
      ...body,
    } as ServerMessage;
    conn.ws.send(JSON.stringify(msg));
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
