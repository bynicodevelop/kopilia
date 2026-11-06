/**
 * Capture micro via Web Audio + AudioWorklet. Demande l'annulation d'écho du
 * navigateur, convertit en PCM 16 kHz mono 16 bits, et appelle `onFrame` pour
 * chaque tranche. Ouvert au premier geste dans la page, il le reste : hors
 * appui sur la touche, ses trames ne quittent pas le navigateur.
 */
export class MicCapture {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;

  constructor(private readonly onFrame: (pcm: ArrayBuffer) => void) {}

  get active(): boolean {
    return !!this.ctx;
  }

  /** Les trames arrivent : un contexte créé sans geste de l'utilisateur reste suspendu. */
  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /** À appeler pendant un geste de l'utilisateur (clic, touche) : le contexte suspendu repart. */
  resume(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // On tente 16 kHz ; si le navigateur impose un autre taux, le worklet décime.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule("pcm-worklet.js");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-downsampler");
    this.node.port.onmessage = (e) => this.onFrame(e.data as ArrayBuffer);
    this.source.connect(this.node);
    // On ne connecte pas au destination (pas de réinjection du micro).
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = undefined;
    this.stream = undefined;
    this.node = undefined;
    this.source = undefined;
  }
}
