import { Injectable, computed, signal } from "@angular/core";
import type { ActivityItem, BrokerStatus, DrawingShape, Indicator, NewsItem, RobotSummary, Scenario, ServerMessage, ViewData } from "@kopilia/contracts";
import { ScreenApi } from "./api";
import { MicCapture } from "./audio/mic-capture";
import { PcmPlayer } from "./audio/player";
import { SpeechSync } from "./audio/speech-sync";
import { loadSilero, VoiceDetector } from "./audio/silero";
import { decodeFrame, encodeFrame, KIND_MIC, KIND_TTS } from "./audio/binary";
import { BriefStore } from "./brief/brief.store";
import { canInterruptOf, Phase, phaseOf, reconnectDelay } from "./call/phase";
import { PTT, PttRecorder, PushToTalk, RECORDER, kopiliaApp, unwatched, type KeyLike, type RecordingEnd } from "./call/push-to-talk";
import { ReplyQueue } from "./call/reply-queue";
import { AlertRequest, DashboardStore } from "./dashboard/dashboard.store";
import { chartFor, PriceTracker, productOf, SPOT_MS, type ChartRef, type SpokenPrice } from "./dashboard/price-spots";
import type { CandleView, PanelView } from "./dashboard/views";
import { DocumentsStore } from "./documents/documents.store";
import { JobsStore } from "./jobs/jobs.store";
import { LearningStore } from "./memory/learning.store";
import { SetupsStore } from "./setups/setups.store";
import { TradingStore } from "./trading/trading.store";
import { JournalStore } from "./journal/journal.store";

export type { Phase } from "./call/phase";
export type { JobView } from "./jobs/jobs";

const PROTOCOL_VERSION = 1;
const MIC_FORMAT = { sampleRate: 16000, channels: 1, bitDepth: 16, encoding: "pcm_s16le" };
/** Texte en attente sans que rien n'avance (ni texte, ni voix) : il s'affiche d'un coup. */
const SYNC_STALL_MS = 5000;
/**
 * Cadence de l'affichage au rythme de la voix. Une minuterie plutôt que
 * requestAnimationFrame, que certaines fenêtres freinent à 1 image/s ; 20
 * mises à jour par seconde suffisent pour des mots de 0,2 à 0,4 s.
 */
const SYNC_TICK_MS = 50;

/**
 * Client Kopilia, à la touche comme un talkie-walkie : tant que ⌥ droite (ou
 * ⌥ Espace) est tenue, ta phrase s'enregistre ; relâchée, elle part. Appuyer
 * pendant que Kopilia répond le met en pause ; relâcher sans rien dire, « stop »,
 * « attends »… le coupent, toute autre demande le laisse finir et sa réponse suit.
 */
@Injectable({ providedIn: "root" })
export class KopiliaService {
  /* Les parties autonomes de l'écran, chacune dans son magasin ; ce service en reste la façade. */
  private readonly api = new ScreenApi(() => ({ sessionId: this.sessionId, token: this.token }));
  private readonly report = (message: string) => this.error.set(message);
  private readonly dashboard = new DashboardStore(this.api, this.report);
  private readonly learning = new LearningStore(this.api, this.report);
  private readonly setups = new SetupsStore(this.api, this.report);
  private readonly tradingStore = new TradingStore(this.api, this.report);
  private readonly journalStore = new JournalStore(this.api, this.report);
  private readonly briefs = new BriefStore(this.api, this.report);
  private readonly work = new JobsStore((body) => this.send(body));
  private readonly docs = new DocumentsStore(
    this.api,
    () => ({ sessionId: this.sessionId, token: this.token }),
    () => this.connected(),
    this.report,
  );

  readonly connected = signal(false);
  /** État envoyé par le serveur. */
  readonly state = signal<string>("idle");
  /**
   * Le son est autorisé et le micro ouvert (premier geste dans la page) :
   * Kopilia peut parler, et t'entendre quand tu tiens la touche.
   */
  readonly armed = signal(false);
  /** La touche est tenue : ta phrase s'enregistre. */
  readonly userSpeaking = signal(false);
  /** Lecture audio effective côté navigateur (Kopilia audible). */
  readonly speaking = signal(false);
  /** Lecture de Kopilia en pause : l'utilisateur a pris la parole, on attend sa phrase. */
  readonly holding = signal(false);
  readonly transcriptPartial = signal("");
  readonly transcriptFinal = signal("");
  /** La réponse affichée rapporte le résultat de cet agent (et non une phrase de l'utilisateur). */
  readonly reportTitle = signal<string | null>(null);
  /** …et ce résultat est un brief de veille, consultable en entier. */
  readonly reportBriefId = signal<string | null>(null);
  /** Dernier brief de veille disponible, et celui affiché en plein écran. */
  readonly latestBrief = this.briefs.latest;
  readonly briefOpen = this.briefs.open;
  readonly response = signal("");
  /**
   * Les prix de la réponse que Kopilia vient de dire et qui parlent d'un
   * graphique ouvert : ils s'allument sur ce graphique et dans le texte, au
   * mot près, quelques secondes (SPOT_MS).
   */
  readonly spokenPrices = signal<SpokenPrice[]>([]);
  /** Documents déposés : ils partiront avec la prochaine phrase. */
  readonly documents = this.docs.documents;
  /** Documents partis avec la phrase affichée. */
  readonly attached = signal<string[]>([]);
  /** Étapes de la réponse en cours (outils appelés par Kopilia : recherche web, agent dépêché…). */
  readonly turnSteps = signal<Array<{ id: string; label: string }>>([]);
  readonly error = signal<string | null>(null);
  readonly jobs = this.work.jobs;
  readonly approvals = this.work.approvals;
  /** Recettes proposées en attente, ce que Kopilia vient de retenir, la feuille Mémoire. */
  readonly learningPending = this.learning.pending;
  readonly learningNote = this.learning.note;
  readonly memoryOpen = this.learning.open;
  /** Les encarts du tableau de bord et les tracés de leurs produits (le serveur les garde), et les cotations. */
  readonly panels = this.dashboard.panels;
  readonly panelsKnown = this.dashboard.panelsKnown;
  readonly quotes = this.dashboard.quotes;
  readonly drawings = this.dashboard.drawings;
  /** Un affichage demandé à la voix, pas encore appliqué par le tableau de bord. */
  readonly panelDisplay = this.dashboard.display;
  readonly panelFocus = this.dashboard.focus;
  /** Les alertes de leurs produits, et celles qui viennent de partir. */
  readonly alerts = this.dashboard.alerts;
  readonly firedAlerts = this.dashboard.fired;
  /** La dernière alerte de l'IA partie (sa ligne clignote, sans bandeau). */
  readonly aiFired = this.dashboard.aiFired;
  /** La recherche d'opportunités : hypothèses, scénarios et leur fil, résultats, la feuille Opportunités. */
  readonly hypotheses = this.setups.hypotheses;
  readonly scenarios = this.setups.scenarios;
  /** Les robots du laboratoire de stratégies (robots.updated), pour l'encart Robots. */
  readonly robots = signal<RobotSummary[]>([]);
  /** Le compte MetaApi : allumé, en pause ou en train de se rallumer (l'indicateur en haut de la page). */
  readonly broker = signal<BrokerStatus | null>(null);
  /** Monte à chaque rallumage du courtier : les graphiques restés sans bougies se rechargent. */
  readonly brokerWakes = signal(0);
  readonly setupStats = this.setups.stats;
  readonly proposedSetups = this.setups.proposed;
  readonly setupsOpen = this.setups.open;
  readonly setupSearching = this.setups.searching;
  /** Les setups repérés en cours, et ceux qu'une recherche vient de repérer. */
  readonly watchlist = this.setups.watchlist;
  readonly freshSetups = this.setups.fresh;
  readonly drawingSuggestions = this.setups.suggestions;
  /** La prise de position : compte, money management, trades, ticket à confirmer. */
  readonly trading = this.tradingStore.state;
  readonly ticket = this.tradingStore.ticket;
  readonly ticketSending = this.tradingStore.sending;
  /** Le journal de trading (encart par fiche), son numéro de version, et la page d'un trade ouverte en plein écran. */
  readonly journal = this.journalStore.journal;
  readonly journalVersion = this.journalStore.version;
  readonly tradeOpen = this.journalStore.open;
  readonly reviewOpen = this.journalStore.review;
  readonly calendarOpen = this.journalStore.calendar;
  readonly micSupported = signal(typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia);

  readonly phase = computed<Phase>(() =>
    phaseOf({
      connected: this.connected(),
      armed: this.armed(),
      userSpeaking: this.userSpeaking(),
      holding: this.holding(),
      speaking: this.speaking(),
      state: this.state(),
    }),
  );

  /** Kopilia prépare ou dit une réponse : on peut lui couper la parole. */
  readonly canInterrupt = computed(() => canInterruptOf({ armed: this.armed(), speaking: this.speaking(), state: this.state() }));

  private ws?: WebSocket;
  private sessionId = "";
  /** Jeton de la session (WebSocket et dépôt de documents). */
  private token = "";
  private connecting = false;
  private wantConnected = false;
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;

  private mic?: MicCapture;
  /** Le micro a été refusé : on ne le redemande qu'à la touche, pas à chaque clic. */
  private micRefused = false;
  /** Détecteur de voix humaine (Silero), chargé avec le micro ; sans lui, Whisper décide seul. */
  private voice?: VoiceDetector;
  /** Énoncé en cours d'envoi (ouvert par la touche). */
  private utterance?: { streamId: number; seq: number };
  /** L'audio d'une prise de parole : pré-enregistrement, direct, fin. */
  private readonly recorder = new PttRecorder(
    (pcm) => this.sendMicFrame(pcm),
    (end) => this.onRecorded(end),
  );
  /** ⌥ droite (ou ⌥ Espace) maintenue : parler. */
  private readonly ptt = new PushToTalk({
    press: () => this.pttPress(),
    release: (ms) => this.pttRelease(ms),
    cancel: () => this.pttCancel(),
    tap: () => this.hush(),
  });
  /** Kopilia parlait au moment de l'appui (sa voix est en pause). */
  private pressBargeIn = false;
  /** Filet de sécurité : la fin d'un enregistrement arrive toujours. */
  private tailTimer?: ReturnType<typeof setTimeout>;
  private player = new PcmPlayer((playing) => {
    this.speaking.set(playing);
    if (!playing) this.advance(); // la réponse affichée a peut-être fini de se dire
  });
  /** Filet de sécurité : une pause sans transcription ne dure jamais. */
  private holdTimer?: ReturnType<typeof setTimeout>;

  /** Tour affiché : le texte d'un tour interrompu n'est plus ajouté. */
  private currentTurn = "";
  /** La réponse affichée a été coupée (« stop », touche relâchée sans rien dire, orbe touché) : rien ne l'attend plus. */
  private replyCut = false;
  /** Réponses demandées pendant que la réponse affichée se terminait : elles la suivent, dans l'ordre. */
  private readonly replies = new ReplyQueue();
  private advancing = false;
  private audioStream = -1;
  /** Flux audio coupés : leurs trames arrivées en retard sont ignorées. */
  private mutedStreams = new Set<number>();

  /**
   * Son autorisé, la réponse s'affiche au rythme de la voix (mot à mot) ;
   * avant le premier geste, ou sans voix, elle s'affiche dès qu'elle arrive.
   */
  private sync?: SpeechSync;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private lastProgress = 0;
  /** Le tour affiché : a de la voix, est entièrement généré, a tout son audio envoyé. */
  private turnAudio = false;
  private replyDone = false;
  private audioEnded = false;
  /** Les prix de la réponse affichée, chacun allumé une fois, quand il apparaît. */
  private readonly priceTracker = new PriceTracker();
  private spotSeq = 0;

  /* ----------------------------- Connexion ----------------------------- */

  /** Ouvre la session ; se reconnecte seul si le serveur redémarre. */
  async connect(): Promise<void> {
    if (!this.wantConnected && typeof document !== "undefined") {
      // Un autre onglet, une fenêtre réduite : le serveur fait alors suivre sur Telegram.
      document.addEventListener("visibilitychange", () => this.sendVisibility());
      if (kopiliaApp()) {
        // L'application Kopilia lit la phase (toutes les 250 ms) pour son icône de la barre des menus : verte quand il t'écoute.
        (globalThis as { __kopiliaPhase?: () => Phase }).__kopiliaPhase = () => this.phase();
        // Elle dit quand tu t'absentes ou reviens (Mac verrouillé ou inactif).
        window.addEventListener("kopilia-app", () => this.sendVisibility());
      }
    }
    this.wantConnected = true;
    if (this.connecting || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.connecting = true;
    clearTimeout(this.retryTimer);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`amorçage refusé (${res.status})`);
      const { sessionId, token } = (await res.json()) as { sessionId: string; token: string };
      this.sessionId = sessionId;
      this.token = token;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws?sessionId=${sessionId}&token=${token}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.connected.set(true);
        this.retry = 0;
        this.sendVisibility();
        // Nouvelle conversation après une coupure : Kopilia peut toujours parler.
        if (this.armed()) this.send({ type: "call.state", inCall: true });
        // Dans l'application Kopilia, son et micro sont autorisés sans geste : la page s'arme dès l'ouverture.
        else if (kopiliaApp()) this.gesture();
        void this.briefs.loadLatest();
        void this.learning.load(false);
      };
      ws.onclose = () => this.onSocketClosed(ws);
      ws.onmessage = (e) => this.onMessage(e.data);
      this.ws = ws;
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private onSocketClosed(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.connected.set(false);
    this.state.set("idle");
    // La phrase en cours est perdue avec la connexion ; le micro, lui, reste ouvert.
    this.recorder.cancel();
    this.utterance = undefined;
    this.userSpeaking.set(false);
    this.silence();
    // Les numéros de voix ne valent que pour une connexion : un serveur relancé
    // recompte, et un numéro coupé avant ferait taire une nouvelle réponse.
    this.mutedStreams.clear();
    this.audioStream = -1;
    // La reconnexion ouvre une nouvelle conversation : les documents en attente sont restés dans l'ancienne.
    if (this.docs.drop()) this.error.set("Connexion perdue — dépose à nouveau tes documents.");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.wantConnected) return;
    clearTimeout(this.retryTimer);
    const delay = reconnectDelay(this.retry++);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  /* ------------------------------ Messages ----------------------------- */

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) return this.onFrame(data);
    // Pas de validation (zod resterait dans le bundle) : les types du protocole
    // relient les deux bouts à la compilation, un test vérifie chaque message.
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data as string) as ServerMessage;
    } catch {
      return;
    }
    this.onServerMessage(msg);
  }

  /** Une tranche de voix : jouée, ou gardée si sa réponse attend son tour. */
  private onFrame(data: ArrayBuffer): void {
    const frame = decodeFrame(data);
    if (!frame || frame.kind !== KIND_TTS || this.mutedStreams.has(frame.streamId)) return;
    if (this.replies.keepFrame(frame.streamId, data)) return;
    const slot = this.player.enqueue(frame.payload);
    if (slot && this.sync && frame.streamId === this.audioStream) this.sync.audio(slot.startAt, slot.duration);
  }

  private onServerMessage(msg: ServerMessage): void {
    // Réponse qui attend son tour : gardée pour quand elle s'affichera (ses documents quittent l'attente tout de suite).
    if (this.replies.keep(msg)) {
      if (msg.type === "documents.attached") this.docs.sent(msg.documents.map((d) => d.documentId));
      return;
    }
    const turnId = msg.turnId;
    switch (msg.type) {
      case "state.changed":
        this.state.set(msg.state);
        break;
      case "transcript.partial":
        this.transcriptPartial.set(msg.text);
        break;
      case "transcript.final": {
        const text = msg.text ?? "";
        this.transcriptPartial.set("");
        if (!text.trim()) {
          // Rien d'audible dans ta phrase : comme une touche relâchée sans parler, Kopilia se tait.
          if (!this.userSpeaking()) this.hush();
          break;
        }
        if (!msg.cut && this.replyPending()) {
          // Une autre demande : Kopilia finit ce qu'il disait (la pause est
          // levée), la réponse à cette phrase se prépare et suivra.
          this.replies.add({ turnId: turnId ?? "", text });
          if (!this.userSpeaking()) this.resume();
          break;
        }
        // « Stop », « attends »… coupent la réponse en cours (le serveur arrête
        // aussi sa génération) ; sans réponse en cours, la phrase s'affiche.
        this.silence();
        if (this.userSpeaking()) {
          // L'utilisateur a déjà enchaîné une autre phrase : la réponse attendra.
          this.player.hold();
          this.holding.set(true);
        }
        this.showReply({ turnId: turnId ?? "", text });
        break;
      }
      case "documents.attached": {
        // Partis avec ta phrase : ils quittent l'attente et s'affichent avec elle.
        this.docs.sent(msg.documents.map((d) => d.documentId));
        if (turnId === this.currentTurn) this.attached.set(msg.documents.map((d) => d.name));
        break;
      }
      case "agent.report": {
        // Kopilia prend la parole de lui-même pour rapporter un résultat, une fois fini ce qu'il disait.
        const reply = { turnId: turnId ?? "", report: { title: msg.title || "Agent", briefId: msg.briefId ?? null } };
        if (this.replyPending()) this.replies.add(reply);
        else this.showReply(reply);
        break;
      }
      case "brief.ready":
        this.briefs.ready(msg);
        break;
      case "learning.updated":
        // Relecture ou rangement terminé : ce qui a été retenu, et ce qui attend.
        this.learning.updated(msg);
        break;
      case "dashboard.updated":
        this.dashboard.updated(msg.panels, msg.drawings, msg.alerts);
        break;
      case "panel.display":
        this.dashboard.displayed(msg.panelId, msg.display);
        break;
      case "alert.triggered":
        // Une alerte de l'IA : sa ligne clignote, l'agent de son scénario décidera s'il faut prévenir.
        if (msg.scenarioId) {
          this.dashboard.aiTriggered({ key: msg.eventId, alertId: msg.alertId, symbol: msg.symbol });
          break;
        }
        // Le son et le bandeau tout de suite ; en appel, Kopilia la dira après sa phrase.
        this.dashboard.triggered({
          key: msg.eventId,
          alertId: msg.alertId,
          symbol: msg.symbol,
          title: msg.title,
          detail: msg.detail,
          direction: msg.direction,
          at: msg.at,
        });
        break;
      case "robots.updated":
        this.robots.set(msg.robots);
        break;
      case "broker.status": {
        const before = this.broker()?.state;
        this.broker.set(msg.status);
        if (msg.status.state === "on" && before && before !== "on") this.brokerWakes.update((n) => n + 1);
        break;
      }
      case "setups.updated":
        this.setups.updated(msg);
        break;
      case "setup.signal":
        // Un setup proposé (ou abandonné après avoir été annoncé) : le son et le bandeau, comme une alerte ; en appel, Kopilia le dit.
        this.dashboard.triggered({
          key: msg.eventId,
          alertId: msg.scenarioId,
          symbol: msg.symbol,
          title: msg.title,
          detail: msg.detail,
          direction: "up",
          at: Date.now(),
          setup: msg.kind,
        });
        break;
      case "trading.updated":
        this.tradingStore.updated(msg.state);
        break;
      case "journal.changed":
        this.journalStore.changed(msg.tradeId);
        break;
      case "journal.show":
        if (msg.calendar) void this.journalStore.showCalendar(msg.calendar);
        else if (msg.reviewId) void this.journalStore.showReview(msg.reviewId);
        else if (msg.tradeId) void this.journalStore.show(msg.tradeId);
        break;
      case "trading.signal":
        // Un ordre envoyé, exécuté, une position fermée, un rappel de break-even : le bandeau ; le son pour ce qui n'a pas été demandé à l'instant.
        this.dashboard.triggered(
          {
            key: msg.eventId,
            alertId: msg.tradeId ?? msg.eventId,
            symbol: msg.symbol ?? "",
            title: msg.title,
            detail: msg.detail ?? "",
            direction: "up",
            at: Date.now(),
            trade: msg.kind,
          },
          msg.kind === "placed",
        );
        break;
      case "setups.searched":
        // Une recherche finie : le bandeau (avec le son si elle a repéré des setups en attente) ; en appel, Kopilia la résume.
        this.setups.searched(msg.opened);
        this.dashboard.triggered(
          { key: msg.eventId, alertId: msg.eventId, symbol: "", title: msg.title, detail: msg.detail, direction: "up", at: Date.now(), setup: "searched" },
          !msg.opened.length,
        );
        break;
      case "market.quote":
        this.dashboard.quote(msg);
        break;
      case "assistant.delta":
        if (turnId !== this.currentTurn) break;
        if (this.sync) {
          this.sync.addText(msg.text);
          this.syncProgress();
        } else {
          const text = msg.text;
          this.response.update((r) => r + text);
          this.spotPrices(this.response(), this.response(), false);
        }
        break;
      case "assistant.done":
        if (turnId === this.currentTurn) {
          this.replyDone = true;
          if (!this.sync) this.spotPrices(this.response(), this.response(), true);
          this.syncProgress();
          this.advance();
        }
        break;
      case "audio.start": {
        const streamId = msg.streamId;
        // Son pas encore autorisé (aucun geste dans la page), la réponse s'affiche sans se dire.
        if (turnId !== this.currentTurn || !this.armed()) {
          this.mutedStreams.add(streamId);
          if (turnId === this.currentTurn) this.revealReply();
          break;
        }
        this.audioStream = streamId;
        this.turnAudio = true;
        this.player.start(msg.format.sampleRate);
        break;
      }
      case "speech.segment":
        // Repère d'une phrase : son texte s'affichera quand sa voix se jouera.
        if (turnId === this.currentTurn && this.sync && !this.mutedStreams.has(msg.streamId)) {
          this.sync.mark(msg.index, msg.text, msg.silent === true);
          this.syncProgress();
        }
        break;
      case "audio.end":
        if (turnId === this.currentTurn) {
          this.audioEnded = true;
          this.syncProgress();
          this.advance();
        }
        break;
      case "job.updated":
        this.work.updated(msg);
        break;
      case "activity.changed":
        this.activityChanged.update((n) => n + 1);
        break;
      case "news.added":
        // L'encart News les ajoute ; une forte et fraîche fait aussi son bandeau et son son (en appel, Kopilia la dit).
        this.newsLive.set(msg.items);
        for (const b of msg.banners ?? []) {
          this.dashboard.triggered({
            key: `news_${b.id}`,
            alertId: b.id,
            symbol: b.symbol ?? "",
            title: b.title,
            detail: b.detail,
            direction: "up",
            at: Date.now(),
            news: true,
          });
        }
        break;
      case "activity.step": {
        // Une étape de travail : nœud du réseau derrière l'orbe (réponse en cours, ou agent / tâche).
        const label = msg.label;
        const jobId = msg.jobId;
        if (jobId) {
          this.work.step(jobId, label);
        } else if (turnId === this.currentTurn) {
          this.turnSteps.update((s) => [...s, { id: `${turnId}:${s.length}`, label }]);
        }
        break;
      }
      case "approval.required":
        this.work.approvalRequired(msg);
        break;
      case "error":
        this.error.set(`${msg.message}${msg.recovery ? " — " + msg.recovery : ""}`);
        if (msg.code === "tts_error") this.revealReply(); // la voix ne suivra pas
        break;
    }
  }

  /* ------------------------- Parler à la touche ------------------------ */

  /**
   * Un geste dans la page (clic, touche) : la première fois, le son est
   * autorisé et le micro s'ouvre, pour toute la session. Kopilia peut alors
   * parler de lui-même (alertes, brief). Hors appui sur la touche, le micro ne
   * va nulle part : seules ses 0,3 dernières secondes restent en mémoire, pour
   * ne pas couper le premier mot.
   */
  gesture(): void {
    this.player.unlock(); // geste utilisateur : autorise la lecture audio
    this.mic?.resume();
    if (!this.mic && !this.micRefused) void this.arm();
  }

  /** Un évènement clavier de la page. Vrai : le navigateur doit l'ignorer (⌥ Espace n'écrit rien). */
  pttKey(e: KeyboardEvent): boolean {
    return this.ptt.key(e);
  }

  /** La page perd le clavier : la touche relâchée ailleurs n'arriverait jamais. */
  pttBlur(): void {
    this.ptt.blur();
  }

  /** L'application Kopilia écoute le clavier de tout le Mac : ses gestes de ⌥ remplacent ceux de la page. */
  appKeys(): boolean {
    return !!kopiliaApp()?.tap;
  }

  /** Un geste de ⌥ transmis par l'application Kopilia (⌥ droite ou ⌥ Espace), même une autre application devant. */
  appKey(e: KeyLike): void {
    if (e.type === "keydown") this.gesture();
    this.ptt.key(e);
  }

  private async arm(): Promise<void> {
    if (!this.micSupported() || this.mic) return;
    const mic = new MicCapture((buf) => this.onMicFrame(new Int16Array(buf)));
    this.mic = mic; // réservé avant l'attente : deux gestes n'ouvrent pas deux micros
    try {
      await mic.start();
    } catch {
      this.mic = undefined;
      this.micRefused = true; // on ne redemande qu'à la touche, pas à chaque clic
      this.error.set("Micro refusé ou indisponible — autorise-le dans les réglages du navigateur, puis réessaie.");
      return;
    }
    mic.resume();
    this.micRefused = false;
    this.startVoiceDetector();
    this.armed.set(true);
    // Kopilia peut alors parler de lui-même (p.ex. le brief du matin, les alertes manquées).
    this.send({ type: "call.state", inCall: true });
  }

  /** La touche est tenue : Kopilia se tait aussitôt, ta phrase s'enregistre. */
  private pttPress(): void {
    if (!this.connected()) return;
    this.player.unlock();
    if (!this.mic) {
      this.micRefused = false;
      void this.arm();
    }
    // Une pause : si ta phrase demande autre chose, il finit ensuite ce qu'il
    // disait (règle A) ; relâchée sans rien dire, la touche le fait taire.
    const bargeIn = this.player.hold();
    this.pressBargeIn = bargeIn;
    this.holding.set(true);
    clearTimeout(this.holdTimer);
    this.beginUtterance(bargeIn);
    this.recorder.start();
    this.userSpeaking.set(true);
  }

  /** La touche est relâchée : la phrase part, après un dernier quart de seconde d'audio. */
  private pttRelease(heldMs: number): void {
    this.userSpeaking.set(false);
    if (heldMs < PTT.tapMs || !this.mic?.running) {
      this.pttSilent();
      return;
    }
    this.recorder.stop();
    // Filet : si le micro se tait (débranché), la fin n'arriverait jamais.
    clearTimeout(this.tailTimer);
    this.tailTimer = setTimeout(() => {
      if (this.recorder.recording) this.pttSilent();
    }, 1500);
  }

  /** Une autre touche pendant l'appui : c'était un raccourci, rien ne part, Kopilia reprend. */
  private pttCancel(): void {
    this.userSpeaking.set(false);
    this.dropUtterance();
    this.resume();
  }

  /** L'enregistrement est fini : la phrase part, sauf si rien n'y a été dit. */
  private onRecorded(end: RecordingEnd): void {
    clearTimeout(this.tailTimer);
    if (end.voicedMs !== undefined && end.voicedMs < RECORDER.minVoicedMs) {
      this.pttSilent();
      return;
    }
    const u = this.utterance;
    if (!u) return;
    this.utterance = undefined;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFrame(KIND_MIC, u.streamId, u.seq++, true, new ArrayBuffer(0)));
    }
    this.state.set("transcribing");
    // La transcription décide (couper ou reprendre) ; sans réponse, on reprend.
    this.holdTimer = setTimeout(() => this.resume(), 10_000);
  }

  /** Relâchée sans rien dire : rien n'est transcrit, et Kopilia se tait pour de bon. */
  private pttSilent(): void {
    clearTimeout(this.tailTimer);
    this.dropUtterance();
    this.hush();
  }

  /** La phrase en cours est abandonnée : rien n'est transcrit. */
  private dropUtterance(): void {
    this.recorder.cancel();
    const u = this.utterance;
    this.utterance = undefined;
    if (u) this.send({ type: "mic.cancel", streamId: u.streamId });
  }

  /**
   * « Tais-toi » sans un mot (touche tapée, ou relâchée sans parler) : coupé
   * s'il parlait (mis en pause par l'appui) ou préparait une réponse ; sinon
   * rien à couper, et le serveur ne doit pas croire qu'il l'a été.
   */
  private hush(): void {
    const paused = this.holding() && this.pressBargeIn;
    if (paused || this.canInterrupt() || this.replyPending()) this.interrupt();
    else this.resume();
  }

  /** Toucher l'orbe pendant que Kopilia réfléchit ou parle l'interrompt. */
  tapOrb(): void {
    if (this.canInterrupt()) this.interrupt();
  }

  /** Niveau sonore 0..1 pour l'orbe : la voix de Kopilia quand il parle, sinon la tienne pendant l'appui. */
  levelNow(): number {
    if (this.speaking()) return this.player.level();
    return this.recorder.recording ? this.recorder.level : 0;
  }

  /**
   * Détecteur de voix humaine (Silero), chargé une fois. Il dit si quelque
   * chose a été dit pendant l'appui ; sans lui, Whisper en décide.
   */
  private startVoiceDetector(): void {
    if (this.voice) {
      this.voice.reset();
      return;
    }
    loadSilero().then(
      (model) => {
        this.voice ??= new VoiceDetector(model, (e) => console.warn("Détection de voix humaine en panne : Whisper décidera seul.", e));
      },
      (e) => console.warn("Détection de voix humaine indisponible : Whisper décidera seul.", e),
    );
  }

  private onMicFrame(pcm: Int16Array) {
    this.voice?.push(pcm);
    this.recorder.push(pcm, this.voice?.probability);
  }

  private beginUtterance(bargeIn: boolean) {
    const streamId = Math.floor(Math.random() * 0x7ffffffe) + 1;
    this.utterance = { streamId, seq: 0 };
    this.send({ type: "mic.format", turnId: `voice_${Date.now()}`, streamId, format: MIC_FORMAT, bargeIn, ptt: true });
  }

  private sendMicFrame(pcm: Int16Array) {
    const u = this.utterance;
    if (!u || this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    this.ws.send(encodeFrame(KIND_MIC, u.streamId, u.seq++, false, payload));
  }

  /* ------------------------------ Actions ------------------------------ */

  /** Coupe le son tout de suite, puis demande au serveur d'arrêter la génération. */
  private interrupt(): void {
    this.silence();
    this.revealReply(); // coupé : le reste de la réponse reste lisible
    this.send({ type: "playback.interrupt" });
    this.state.set("idle");
  }

  /** Coupe la lecture locale et ignore les trames encore en route, y compris celles des réponses en attente. */
  private silence(): void {
    // Avant d'arrêter le son : sa fin ne doit pas faire place à une réponse en attente.
    this.replyCut = true;
    for (const streamId of this.replies.clear()) this.mutedStreams.add(streamId);
    this.player.interrupt();
    this.endHold();
    if (this.audioStream >= 0) this.mutedStreams.add(this.audioStream);
  }

  /** Reprend la lecture mise en pause quand l'utilisateur a pris la parole. */
  private resume(): void {
    this.player.release();
    this.endHold();
  }

  private endHold(): void {
    clearTimeout(this.holdTimer);
    this.holding.set(false);
  }

  /* ------------------------ Réponses à la suite ------------------------ */

  /** Affiche une nouvelle réponse : à la phrase de l'utilisateur, ou au rapport que Kopilia prend la parole pour faire. */
  private showReply(reply: { turnId: string; text?: string; report?: { title: string; briefId: string | null } }): void {
    this.beginReply(reply.turnId);
    this.reportTitle.set(reply.report?.title ?? null);
    this.reportBriefId.set(reply.report?.briefId ?? null);
    this.transcriptFinal.set(reply.text ?? "");
    this.attached.set([]);
  }

  /** La réponse affichée n'est pas finie pour l'utilisateur (encore préparée, ou encore à entendre), ou d'autres l'attendent. */
  private replyPending(): boolean {
    return this.replies.size > 0 || this.replyUnfinished();
  }

  private replyUnfinished(): boolean {
    if (!this.currentTurn || this.replyCut) return false;
    return !this.replyDone || (this.turnAudio && (!this.audioEnded || this.player.busy()));
  }

  /** La réponse affichée est finie : la suivante prend sa place, et ce qui en est déjà arrivé est rejoué. */
  private advance(): void {
    if (this.advancing) return; // un rejeu qui finit une réponse : la boucle en cours s'en charge
    this.advancing = true;
    try {
      while (this.replies.size && !this.replyUnfinished()) {
        const next = this.replies.next()!;
        this.showReply(next);
        for (const item of next.backlog) {
          if (item instanceof ArrayBuffer) this.onFrame(item);
          else this.onServerMessage(item);
        }
      }
    } finally {
      this.advancing = false;
    }
  }

  /* ------------------------ Texte au rythme de la voix ----------------- */

  /** Nouvelle réponse affichée : son autorisé, son texte suivra la voix. */
  private beginReply(turnId: string): void {
    this.revealReply();
    this.currentTurn = turnId;
    this.replyCut = false;
    this.response.set("");
    this.turnSteps.set([]);
    this.turnAudio = this.replyDone = this.audioEnded = false;
    this.sync = this.armed() ? new SpeechSync() : undefined;
    this.lastProgress = performance.now();
    this.priceTracker.reset();
    this.spokenPrices.set([]);
  }

  /**
   * L'affichage a avancé : les prix qui viennent d'apparaître (`visible`, le
   * début du texte complet `full`) et qui parlent d'un graphique ouvert
   * s'allument. Rien si aucun graphique n'est à l'écran.
   */
  private spotPrices(visible: string, full: string, final: boolean): void {
    const found = this.priceTracker.feed(visible, full, final);
    if (!found.length) return;
    const quotes = this.quotes();
    const charts: ChartRef[] = [];
    for (const p of this.panels()) {
      const last = p.kind === "chart" && p.symbol ? quotes[p.symbol]?.bid : undefined;
      if (!p.symbol || !last) continue;
      const product = productOf(p.symbol);
      charts.push({ symbol: p.symbol, last, digits: p.digits ?? quotes[p.symbol]?.digits, ...(product ? { product } : {}) });
    }
    const now = Date.now();
    const lit: SpokenPrice[] = [];
    for (const m of found) {
      const symbol = chartFor(m, charts);
      if (symbol) lit.push({ ...m, symbol, id: ++this.spotSeq, at: now });
    }
    if (lit.length) this.spokenPrices.update((all) => [...all.filter((s) => now - s.at < SPOT_MS), ...lit]);
  }

  /** Quelque chose a avancé (texte, repère, fin) : l'affichage suit. */
  private syncProgress(): void {
    this.lastProgress = performance.now();
    if (this.sync && this.syncTimer === undefined) this.syncTimer = setTimeout(() => this.syncTick(), 0);
  }

  /** Toutes les 50 ms : le texte déjà dit (horloge de lecture), jusqu'à la fin de la réponse. */
  private syncTick(): void {
    this.syncTimer = undefined;
    const sync = this.sync;
    if (!sync) return;
    const playing = this.player.busy();
    // Fin : tout a été dit, ou la réponse n'avait pas de voix.
    const finished = this.replyDone && (!this.turnAudio || (this.audioEnded && !playing));
    let text = sync.visible(this.player.clock());
    // Filet : du texte attend, rien ne se joue et plus rien n'arrive (voix en panne).
    const stalled = !playing && text.length < sync.text.length && performance.now() - this.lastProgress > SYNC_STALL_MS;
    if (finished || stalled) {
      // Ce qui s'affiche d'un coup ne s'allume pas : la voix ne l'a pas dit à ce moment-là.
      this.priceTracker.skip(sync.text);
      sync.revealAll();
      text = sync.text;
    }
    if (text !== this.response()) {
      this.spotPrices(text, sync.text, this.replyDone);
      this.response.set(text);
    }
    if (sync.revealedAll) {
      this.sync = undefined;
      return;
    }
    this.syncTimer = setTimeout(() => this.syncTick(), SYNC_TICK_MS);
  }

  /** Affiche d'un coup toute la réponse en cours (coupure, fin d'appel, pas de voix). */
  private revealReply(): void {
    const sync = this.sync;
    if (!sync) return;
    this.sync = undefined;
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    this.priceTracker.skip(sync.text);
    this.response.set(sync.text);
  }

  /* ---------------- Façade : documents, briefs, mémoire, tableau de bord, travaux ---------------- */

  /** Dépose des fichiers : ils partiront avec ta prochaine phrase, qui dira quoi en faire. */
  addFiles(files: File[]): void {
    this.docs.add(files);
  }

  /** Retire un document déposé avant de l'avoir envoyé. */
  removeDocument(localId: string): void {
    this.docs.remove(localId);
  }

  /** Affiche un brief en entier (le dernier par défaut). */
  openBrief(briefId?: string): Promise<void> {
    return this.briefs.show(briefId);
  }

  closeBrief(): void {
    this.briefs.close();
  }

  /** Relit le journal de trading (l'encart). */
  loadJournal(): Promise<void> {
    return this.journalStore.load();
  }

  /** Ouvre la page d'un trade du journal en plein écran. */
  openTrade(tradeId: string): Promise<void> {
    return this.journalStore.show(tradeId);
  }

  closeTrade(): void {
    this.journalStore.close();
  }

  /** Ouvre l'analyse de son trading (la dernière par défaut). */
  openReview(reviewId?: string): Promise<void> {
    return this.journalStore.showReview(reviewId);
  }

  closeReview(): void {
    this.journalStore.closeReview();
  }

  /** Ouvre le calendrier du journal (le mois en cours par défaut). */
  openCalendar(key?: string): Promise<void> {
    return this.journalStore.showCalendar(key);
  }

  selectCalendarDay(date: string): Promise<void> {
    return this.journalStore.selectDay(date);
  }

  closeCalendar(): void {
    this.journalStore.closeCalendar();
  }

  /** Recharge la mémoire ; `show` : l'affiche (sinon met seulement à jour le nombre de propositions). */
  loadLearning(show: boolean): Promise<void> {
    return this.learning.load(show);
  }

  openMemory(): void {
    void this.learning.load(true);
  }

  closeMemory(): void {
    this.learning.close();
  }

  /** Adopter, refuser, archiver, réactiver, épingler une recette. */
  skillAction(name: string, action: "approve" | "reject" | "archive" | "restore" | "pin" | "unpin"): Promise<void> {
    return this.learning.action(`/skills/${encodeURIComponent(name)}/${action}`, "POST");
  }

  forgetMemory(id: string): Promise<void> {
    return this.learning.action(`/memories/${encodeURIComponent(id)}`, "DELETE");
  }

  /** Défait un remplacement ou un retrait fait par la relecture. */
  restoreMemory(id: string): Promise<void> {
    return this.learning.action(`/memories/${encodeURIComponent(id)}/restore`, "POST");
  }

  /** Relire tout de suite les conversations pas encore relues. */
  reviewNow(): Promise<void> {
    return this.learning.action("/review", "POST");
  }

  /** Bougies d'un graphique ; `before` (epoch s) pour remonter le temps. */
  loadCandles(symbol: string, timeframe: string, before?: number, limit?: number): Promise<{ candles: CandleView[]; more: boolean }> {
    return this.dashboard.loadCandles(symbol, timeframe, before, limit);
  }

  closePanel(id: string): Promise<void> {
    return this.dashboard.closePanel(id);
  }

  closeAllPanels(): Promise<void> {
    return this.dashboard.closeAll();
  }

  /** Rallume le courtier en pause (un clic sur l'indicateur) ; l'état arrive par broker.status. */
  async wakeBroker(): Promise<void> {
    try {
      this.broker.set(await this.api.json<BrokerStatus>("/api/broker/wake", "POST"));
    } catch (e) {
      this.error.set(`Rallumage du courtier impossible : ${(e as Error).message}`);
    }
  }

  setTimeframe(id: string, timeframe: string): Promise<boolean> {
    return this.dashboard.setTimeframe(id, timeframe);
  }

  setIndicators(id: string, indicators: Indicator[]): Promise<boolean> {
    return this.dashboard.setIndicators(id, indicators);
  }

  draw(symbol: string, shape: DrawingShape): Promise<boolean> {
    return this.dashboard.draw(symbol, shape);
  }

  editDrawing(id: string, shape: DrawingShape): Promise<boolean> {
    return this.dashboard.editDrawing(id, shape);
  }

  eraseDrawing(id: string): Promise<boolean> {
    return this.dashboard.eraseDrawing(id);
  }

  createAlert(symbol: string, timeframe: string, r: AlertRequest): Promise<boolean> {
    return this.dashboard.createAlert(symbol, timeframe, r);
  }

  updateAlert(id: string, r: AlertRequest): Promise<boolean> {
    return this.dashboard.updateAlert(id, r);
  }

  deleteAlert(id: string): Promise<boolean> {
    return this.dashboard.deleteAlert(id);
  }

  openSetups(): void {
    this.setups.show();
  }

  closeSetups(): void {
    this.setups.close();
  }

  /** La réaction de l'utilisateur à un setup proposé, ou une remarque. */
  setupFeedback(id: string, reaction: "taken" | "declined" | "modified" | "comment", note?: string): Promise<boolean> {
    return this.setups.feedback(id, reaction, note);
  }

  abandonScenario(id: string): Promise<boolean> {
    return this.setups.abandon(id);
  }

  setHypothesisState(id: string, state: "confirmed" | "invalidated" | "active"): Promise<boolean> {
    return this.setups.hypothesis(id, state);
  }

  /** Le graphique d'un produit, dans cette unité de temps (un clic sur une courbe d'une vue). */
  openChart(symbol: string, timeframe: string): Promise<boolean> {
    return this.dashboard.openChart(symbol, timeframe);
  }

  /** Le graphique d'un produit ouvert depuis la liste des produits : l'encart, ou null. */
  openChartPanel(symbol: string): Promise<PanelView | null> {
    return this.dashboard.openChartPanel(symbol);
  }

  /** Un graphique affiché change de produit (un clic dans la liste des produits). */
  switchChart(id: string, symbol: string): Promise<boolean> {
    return this.dashboard.switchChart(id, symbol);
  }

  /** Fait passer un encart devant, avec un éclair. */
  focusPanel(id: string): void {
    this.dashboard.focusPanel(id);
  }

  /** Un agent ou une tâche a changé, dans n'importe quelle conversation : l'activité est à relire. */
  readonly activityChanged = signal(0);

  /** Les dernières news arrivées en direct (ou mises à jour), que l'encart News ajoute aux siennes. */
  readonly newsLive = signal<NewsItem[]>([]);

  /** Les news gardées sur le serveur, les plus récentes d'abord (d'un produit s'il est donné). */
  newsList(symbol?: string): Promise<NewsItem[]> {
    return this.api.json<NewsItem[]>(`/api/news${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`);
  }

  /** L'activité : les agents et tâches récents, toutes conversations confondues. */
  activity(): Promise<ActivityItem[]> {
    return this.api.json<ActivityItem[]>("/api/dashboard/activity");
  }

  /** Les données d'une vue que l'écran n'a pas déjà (calendrier, brief). */
  viewData(id: string): Promise<ViewData> {
    return this.api.json<ViewData>(`/api/views/${encodeURIComponent(id)}/data`);
  }

  /** Le graphique d'un setup repéré, dans l'unité de temps de son entrée (avec ses niveaux). */
  openSetupChart(s: Scenario): Promise<boolean> {
    this.setups.seen(s.id);
    return this.dashboard.openChart(s.symbol, s.timeframe);
  }

  /** La liste des setups dans un encart du tableau de bord ; la feuille des opportunités se ferme pour la montrer. */
  async showSetupsPanel(): Promise<void> {
    if (await this.dashboard.openSetups()) this.setups.close();
  }

  searchSetups(focus?: string): Promise<void> {
    return this.setups.search(focus);
  }

  keepLevel(id: string): Promise<boolean> {
    return this.setups.keepLevel(id);
  }

  dismissLevel(id: string): Promise<boolean> {
    return this.setups.dismissLevel(id);
  }

  dismissSuggestion(id: string): Promise<boolean> {
    return this.setups.dismissSuggestion(id);
  }

  autoMap(symbol: string, timeframe: string) {
    return this.setups.autoMap(symbol, timeframe);
  }

  dismissAlert(key: string): void {
    this.dashboard.dismiss(key);
  }

  jobCommand(command: "status" | "cancel" | "instruct", jobId?: string, note?: string): void {
    this.work.command(command, jobId, note);
  }

  resolveApproval(approvalId: string, decision: "approve" | "deny"): void {
    this.work.resolveApproval(approvalId, decision);
  }

  /** La taille d'une boîte de trade et son trade, pour le graphique. */
  boxInfo(...args: Parameters<TradingStore["boxInfo"]>) {
    return this.tradingStore.boxInfo(...args);
  }

  /** Le ticket confirmé au clic (comme « je confirme ») : ses ordres partent chez le courtier. */
  /** Le bouton du ticket fait foi : Kopilia, s'il le relisait encore, se tait tout de suite (comme « stop »). */
  confirmTicket(id: string): void {
    this.cutForTicket();
    void this.tradingStore.confirm(id);
  }

  /** La marge que le courtier demanderait pour une boîte (« Risque… »). */
  tradingMargin(...args: Parameters<TradingStore["margin"]>) {
    return this.tradingStore.margin(...args);
  }

  cancelTicket(id: string): void {
    this.cutForTicket();
    void this.tradingStore.cancel(id);
  }

  /** Une réponse au clic à un ticket coupe la phrase en cours (le son déjà arrivé compris) ; rien à couper : rien n'est envoyé. */
  private cutForTicket(): void {
    if (this.canInterrupt() || this.replyPending()) this.interrupt();
  }

  /** Dit au serveur si la page est cachée (il ne le sait que par elle). */
  /** Personne ne regarde : onglet caché dans un navigateur ; dans l'application, toi absent du Mac. */
  private sendVisibility(): void {
    this.send({ type: "page.visibility", hidden: unwatched(kopiliaApp(), document.hidden) });
  }

  private send(body: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, eventId: `c_${crypto.randomUUID()}`, sessionId: this.sessionId, ts: Date.now(), ...body }));
  }
}
