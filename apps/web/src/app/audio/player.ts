/**
 * Lecture PCM 16 bits à la fréquence déclarée par le serveur. Les tranches sont
 * mises en file et jouées dans l'ordre ; `interrupt()` coupe immédiatement le
 * son et purge la file (barge-in, latence cible < 250 ms après détection).
 *
 * `onActivity` signale le début et la fin de la lecture effective : le serveur
 * a souvent fini d'envoyer alors que l'utilisateur entend encore la réponse.
 * `level()` mesure le volume de sortie, pour animer l'interface.
 *
 * `hold()` met la lecture en pause sans rien perdre (l'utilisateur prend la
 * parole) ; `release()` la reprend là où elle s'était arrêtée, `interrupt()`
 * l'abandonne.
 */
export class PcmPlayer {
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private scope?: Float32Array;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private sampleRate = 24000;
  private held = false;

  constructor(private readonly onActivity?: (playing: boolean) => void) {}

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
      this.scope = new Float32Array(this.analyser.fftSize);
    }
    return this.ctx;
  }

  /** À appeler depuis un geste utilisateur : autorise la lecture audio. */
  unlock() {
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
  }

  start(sampleRate: number) {
    this.sampleRate = sampleRate;
    const ctx = this.context();
    // Ne coupe pas ce qui est déjà en file : le nouveau flux s'enchaîne.
    this.nextTime = Math.max(this.nextTime, ctx.currentTime + 0.05);
  }

  /**
   * Horloge de ce qu'on entend (secondes) : gelée pendant une pause, et en
   * retard de la latence de sortie (jusqu'à 0,2 s avec un casque Bluetooth).
   */
  clock(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** Du son est en cours ou en file (même en pause). */
  busy(): boolean {
    return this.sources.size > 0;
  }

  /**
   * Ajoute une tranche PCM16LE à la file de lecture. Renvoie quand elle sera
   * jouée, sur l'horloge de lecture, et sa durée (texte calé sur la voix).
   */
  enqueue(pcm: ArrayBuffer): { startAt: number; duration: number } | null {
    const ctx = this.context();
    if (ctx.state === "suspended" && !this.held) void ctx.resume();
    const i16 = new Int16Array(pcm);
    if (!i16.length) return null;
    const buf = ctx.createBuffer(1, i16.length, this.sampleRate);
    const f32 = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser!);
    const startAt = Math.max(this.nextTime, ctx.currentTime);
    src.start(startAt);
    this.nextTime = startAt + buf.duration;
    this.sources.add(src);
    if (this.sources.size === 1 && !this.held) this.onActivity?.(true);
    src.onended = () => {
      if (this.sources.delete(src) && this.sources.size === 0) this.onActivity?.(false);
    };
    return { startAt, duration: buf.duration };
  }

  /** Volume de sortie 0..1 (0 si rien ne joue). */
  level(): number {
    if (!this.analyser || !this.scope || this.sources.size === 0) return 0;
    this.analyser.getFloatTimeDomainData(this.scope);
    let sum = 0;
    for (let i = 0; i < this.scope.length; i++) sum += this.scope[i] * this.scope[i];
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / this.scope.length), 1e-6));
    return Math.min(1, Math.max(0, (db + 50) / 40));
  }

  /**
   * Met la lecture en pause, y compris ce qui arrivera pendant la pause.
   * Renvoie vrai si Kopilia était en train de parler à cet instant.
   */
  hold(): boolean {
    if (this.held) return false;
    const audible = this.sources.size > 0;
    this.held = true;
    void this.context().suspend();
    if (audible) this.onActivity?.(false);
    return audible;
  }

  /** Reprend la lecture là où elle s'était arrêtée. */
  release() {
    if (!this.held) return;
    this.held = false;
    void this.ctx?.resume();
    if (this.sources.size > 0) this.onActivity?.(true);
  }

  /** Coupe tout le son en attente et en cours (et lève une éventuelle pause). */
  interrupt() {
    const wasPlaying = this.sources.size > 0 && !this.held;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* déjà arrêté */
      }
    }
    this.sources.clear();
    if (this.ctx) this.nextTime = this.ctx.currentTime;
    if (this.held) {
      this.held = false;
      void this.ctx?.resume();
    }
    if (wasPlaying) this.onActivity?.(false);
  }
}
