import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { ClaudeContentBlock, ClaudeStreamJsonEvent, isResult, isSystemInit, makeUserInput, TurnOutcome } from "@kopilia/contracts";
import { AppLogger } from "../common/logger.js";
import { buildChildEnv } from "./child-env.js";

export interface ClaudeProcessOptions {
  bin: string;
  cwd: string;
  model?: string;
  /** Effort (--effort) ; absent : celui des réglages de Claude Code. */
  effort?: string;
  /** Reprend une session existante (--resume <id>). */
  resume?: string;
  /** Arguments additionnels (MCP, permissions pour les workers). */
  extraArgs?: string[];
  /** Remplace le prompt système (persona assistant vocal pour le dialogue). */
  systemPrompt?: string;
  /** Complète le prompt système par défaut (consignes des agents et ouvriers). */
  appendSystemPrompt?: string;
  /** Retire les sections dynamiques (env, git) du prompt système. */
  excludeDynamicSystemPrompt?: boolean;
  /** Outils interdits (couper l'agentique pour une session de dialogue). */
  disallowedTools?: string[];
  /** Détache dans son propre groupe de processus (workers : kill du groupe). */
  detached?: boolean;
  /** Variables ajoutées à l'environnement assaini (réglages du CLI). */
  env?: NodeJS.ProcessEnv;
  logger: AppLogger;
}

export interface TurnResult {
  /** Tout le texte diffusé pendant le tour (préambules compris). */
  text: string;
  outcome: TurnOutcome;
  /** Dernier message seul, tel que rapporté par `result` (réponse finale d'un agent). */
  final?: string;
}

interface PendingTurn {
  content: string | ClaudeContentBlock[];
  onDelta: (text: string) => void;
  /** Un outil est appelé pendant le tour (une étape de travail). */
  onTool?: (name: string) => void;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  streamed: string;
  sawStream: boolean;
  /** Arrêté par interrupt() : le `result` qui suit est une coupure, pas une erreur. */
  interrupted?: boolean;
}

export interface ClaudeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ClaudeProcessEvents {
  /** Identifiant de la session du CLI (pour --resume). */
  session: [string];
  /** Le processus n'a pas pu être lancé. */
  fatal: [Error];
  /** Le processus est terminé (émis une fois). */
  exit: [ClaudeExit];
  "tool.use": [{ id: string; name: string; input: unknown }];
  "tool.result": [{ id: string; isError: boolean; text: string }];
}

/**
 * Enveloppe un processus `claude -p` en mode stream-json bidirectionnel.
 * stdin reste ouvert : un tour = une ligne JSON ; stdout est lu en NDJSON.
 * Les tours sont sérialisés (le CLI traite une invite à la fois).
 */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private proc?: ChildProcessWithoutNullStreams;
  private stdoutBuf = "";
  private queue: PendingTurn[] = [];
  private current?: PendingTurn;
  sessionId: string | null = null;
  /** Plus aucun tour accepté (arrêt demandé, processus terminé ou jamais lancé). */
  private closed = false;
  /** La fin du processus a été signalée (« exit » n'est émis qu'une fois). */
  private ended = false;

  constructor(private readonly opts: ClaudeProcessOptions) {
    super();
  }

  start(): void {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.effort) args.push("--effort", this.opts.effort);
    if (this.opts.resume) args.push("--resume", this.opts.resume);
    if (this.opts.systemPrompt) args.push("--system-prompt", this.opts.systemPrompt);
    if (this.opts.appendSystemPrompt) args.push("--append-system-prompt", this.opts.appendSystemPrompt);
    if (this.opts.excludeDynamicSystemPrompt) args.push("--exclude-dynamic-system-prompt-sections");
    if (this.opts.disallowedTools?.length) args.push("--disallowedTools", ...this.opts.disallowedTools);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    this.opts.logger.debug(`spawn ${this.opts.bin} ${args.join(" ")} (cwd=${this.opts.cwd})`, "claude");
    // Environnement explicite : on retire les variables de provider/billing/host
    // pour forcer le login d'abonnement stocké. On signale les noms retirés.
    const { env, stripped } = buildChildEnv(this.opts.env);
    if (stripped.length) {
      this.opts.logger.debug(`env assaini (${stripped.length} variables retirées): ${stripped.join(", ")}`, "claude");
    }
    this.proc = spawn(this.opts.bin, args, {
      cwd: this.opts.cwd,
      shell: false,
      env,
      detached: this.opts.detached ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => this.opts.logger.debug(`stderr: ${chunk.trim()}`, "claude"));
    this.proc.on("exit", (code, signal) => this.onExit(code, signal));
    // Lancement impossible (binaire absent, droits) : Node émet « error » et jamais
    // « exit ». Sans ce traitement, le tour attendrait indéfiniment.
    this.proc.on("error", (err) => {
      this.emit("fatal", err);
      this.end(new Error(`impossible de lancer claude (${this.opts.bin}) : ${err.message}`), { code: null, signal: null });
    });
    // Écrire vers un processus qui vient de mourir (EPIPE) ne doit pas faire tomber le serveur.
    this.proc.stdin.on("error", (err) => this.opts.logger.warn(`stdin de claude : ${err.message}`, "claude"));
  }

  /** Programme un tour (texte, ou blocs avec documents joints). Résout quand `result` est reçu. */
  sendTurn(content: string | ClaudeContentBlock[], onDelta: (t: string) => void, onTool?: (name: string) => void): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("claude est arrêté : tour refusé"));
    return new Promise((resolve, reject) => {
      this.queue.push({ content, onDelta, onTool, resolve, reject, streamed: "", sawStream: false });
      this.pump();
    });
  }

  private pump() {
    if (this.current || this.closed || this.queue.length === 0 || !this.proc) return;
    this.current = this.queue.shift();
    const line = JSON.stringify(makeUserInput(this.current!.content)) + "\n";
    if (this.proc.stdin.writable) this.proc.stdin.write(line);
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let evt: ClaudeStreamJsonEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        this.opts.logger.warn(`ligne stdout non-JSON ignorée: ${line.slice(0, 120)}`, "claude");
        continue;
      }
      this.handleEvent(evt);
    }
  }

  private handleEvent(evt: ClaudeStreamJsonEvent) {
    if (isSystemInit(evt)) {
      this.sessionId = evt.session_id;
      this.emit("session", evt.session_id);
      return;
    }

    const turn = this.current;

    // Détail des appels d'outils et de leurs erreurs : la trace d'un agent,
    // relue ensuite par l'apprentissage (quelle source a marché, laquelle a échoué).
    if (evt.type === "assistant" || evt.type === "user") this.emitToolDetails(evt);

    // Deltas de flux (texte partiel). Source unique pour éviter la double lecture.
    if (evt.type === "stream_event" && turn) {
      const ev = (evt as { event?: { type?: string; delta?: { text?: string }; content_block?: { type?: string; name?: string } } }).event;
      // Début d'un appel d'outil : une étape de travail (recherche web, agent dépêché…).
      if (ev?.type === "content_block_start") {
        const block = ev.content_block;
        if (block?.name && (block.type === "tool_use" || block.type === "server_tool_use")) turn.onTool?.(block.name);
        return;
      }
      // Fin d'un bloc (texte ou appel d'outil) : frontière de phrase, pour que
      // le préambule (« je regarde ça ») parte seul, sans se coller à la réponse.
      if (ev?.type === "content_block_stop") {
        if (turn.streamed && !/\s$/.test(turn.streamed)) {
          turn.streamed += "\n";
          turn.onDelta("\n");
        }
        return;
      }
      const text = ev?.delta?.text;
      if (typeof text === "string" && text.length) {
        turn.sawStream = true;
        turn.streamed += text;
        turn.onDelta(text);
      }
      return;
    }

    // Repli : messages assistant complets si le flux partiel est absent.
    if (evt.type === "assistant" && turn && !turn.sawStream) {
      const content = (evt as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          turn.streamed += block.text;
          turn.onDelta(block.text);
        }
      }
      return;
    }

    if (isResult(evt)) {
      if (!this.current) return;
      const t = this.current;
      this.current = undefined;
      const outcome = t.interrupted ? TurnOutcome.Interrupted : evt.is_error ? TurnOutcome.Error : TurnOutcome.Success;
      // evt.result n'est pas relu pour la parole : il répète les deltas déjà émis.
      t.resolve({ text: t.streamed, outcome, final: typeof evt.result === "string" ? evt.result : undefined });
      this.pump();
    }
  }

  /**
   * Émet 'tool.use' ({ id, name, input }) pour chaque appel d'outil d'un message
   * complet de l'assistant, et 'tool.result' ({ id, isError, text }) pour chaque
   * résultat renvoyé au modèle.
   */
  private emitToolDetails(evt: ClaudeStreamJsonEvent) {
    const content = (evt as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        this.emit("tool.use", { id: String(block.id ?? ""), name: block.name, input: block.input ?? {} });
      } else if (block.type === "tool_result") {
        const raw = block.content;
        const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((c) => (c as { text?: string }).text ?? "").join(" ") : "";
        this.emit("tool.result", { id: String(block.tool_use_id ?? ""), isError: block.is_error === true, text });
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    this.end(new Error(`claude a quitté (code=${code} signal=${signal})`), { code, signal });
  }

  /** Le processus n'est plus là : le tour en cours et la file sont rejetés, la fin signalée une fois. */
  private end(err: Error, exit: ClaudeExit) {
    this.closed = true;
    if (this.current) {
      this.current.reject(err);
      this.current = undefined;
    }
    for (const q of this.queue.splice(0)) q.reject(err);
    if (this.ended) return;
    this.ended = true;
    this.emit("exit", exit);
  }

  /**
   * Arrête la génération du tour en cours via le protocole de contrôle du CLI
   * (le même que le Claude Agent SDK). Le tour se termine alors par un `result`.
   * Les tours en attente derrière lui ne partent pas : on arrête tout ce qui
   * était demandé. Renvoie false s'il n'y avait rien à arrêter.
   */
  interrupt(): boolean {
    if (!this.current || !this.proc || this.closed || !this.proc.stdin.writable) return false;
    this.current.interrupted = true;
    for (const q of this.queue.splice(0)) q.resolve({ text: "", outcome: TurnOutcome.Interrupted });
    const request = {
      type: "control_request",
      request_id: `interrupt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      request: { subtype: "interrupt" },
    };
    this.proc.stdin.write(JSON.stringify(request) + "\n");
    return true;
  }

  stop() {
    this.closed = true;
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.signal("SIGTERM");
    setTimeout(() => {
      if (this.proc && !this.proc.killed) this.signal("SIGKILL");
    }, 2000).unref();
  }

  /** Envoie un signal au processus, ou au groupe entier si détaché. */
  private signal(sig: NodeJS.Signals) {
    if (!this.proc) return;
    try {
      if (this.opts.detached && this.proc.pid) {
        // kill du groupe (inclut les processus enfants : outils du worker).
        process.kill(-this.proc.pid, sig);
      } else {
        this.proc.kill(sig);
      }
    } catch {
      /* déjà mort */
    }
  }
}
