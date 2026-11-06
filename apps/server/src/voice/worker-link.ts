import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { AppLogger } from "../common/logger.js";

export interface WorkerLinkOptions {
  name: string;
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger: AppLogger;
  /** Nombre maximal de relances après crash. */
  maxRestarts?: number;
  /** Attente avant la n-ième relance : n × ce délai (500 ms par défaut). */
  restartDelayMs?: number;
}

/**
 * Lien stdio NDJSON vers un worker persistant (STT/TTS). Une ligne JSON par
 * message dans chaque sens. Relance bornée après crash ; émet 'event' (objet
 * JSON reçu), 'down' (le processus est mort) et 'restart'. Ne journalise jamais l'audio.
 */
export class WorkerLink extends EventEmitter<{ event: [unknown]; down: [{ code: number | null; signal: NodeJS.Signals | null }]; restart: [number] }> {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = "";
  private restarts = 0;
  private stopping = false;
  /** Le processus courant tourne et accepte des messages. */
  private alive = false;
  private restartTimer?: NodeJS.Timeout;

  constructor(private readonly opts: WorkerLinkOptions) {
    super();
  }

  start(): void {
    if (this.stopping) return;
    const [cmd, ...args] = this.opts.command;
    // Une demi-ligne laissée par le processus précédent ne doit pas se recoller à la suivante.
    this.buf = "";
    const proc = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    this.alive = true;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => this.proc === proc && this.onData(c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => this.opts.logger.debug(`[${this.opts.name}] ${c.trim()}`, "voice"));
    // Écrire vers un worker qui vient de mourir (EPIPE) ne doit pas faire tomber le serveur.
    proc.stdin.on("error", (err) => this.opts.logger.warn(`[${this.opts.name}] stdin : ${err.message}`, "voice"));
    proc.on("exit", (code, signal) => this.onExit(proc, code, signal));
    // Lancement impossible (commande absente) : « exit » ne viendra pas, et relancer n'y changerait rien.
    proc.on("error", (err) => {
      if (this.proc === proc) this.alive = false;
      this.opts.logger.error(`[${this.opts.name}] ${err.message}`, "voice");
    });
  }

  /** Envoie un message ; faux si le worker est arrêté ou en panne (le message est perdu, sans exception). */
  send(msg: unknown): boolean {
    if (!this.proc || !this.alive || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    return true;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.emit("event", JSON.parse(line));
      } catch {
        this.opts.logger.warn(`[${this.opts.name}] ligne non-JSON ignorée`, "voice");
      }
    }
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) {
    if (this.proc !== proc) return;
    this.alive = false;
    this.emit("down", { code, signal });
    if (this.stopping) return;
    const max = this.opts.maxRestarts ?? 3;
    if (this.restarts < max) {
      this.restarts++;
      this.opts.logger.warn(`[${this.opts.name}] relance ${this.restarts}/${max}`, "voice");
      this.emit("restart", this.restarts);
      this.restartTimer = setTimeout(() => this.start(), (this.opts.restartDelayMs ?? 500) * this.restarts);
      this.restartTimer.unref();
    } else {
      this.opts.logger.error(`[${this.opts.name}] relances épuisées`, "voice");
    }
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.alive = false;
    this.proc?.kill("SIGTERM");
  }
}
