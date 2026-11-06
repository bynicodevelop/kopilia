/**
 * Détecteur de voix humaine Silero (v6, réseau de neurones de 2 Mo), exécuté
 * dans le navigateur par onnxruntime-web (WebAssembly, un seul fil). Toutes
 * les 32 ms, il donne la probabilité qu'une voix parle : une musique
 * instrumentale, un bruit ou un claquement restent bas, même forts. La VAD
 * (vad.ts) le combine au volume.
 *
 * Tout est servi en local par l'application (voir angular.json) : le modèle
 * dans `vad/` (fichier fourni par le paquet @ricky0123/vad-web, dont on
 * n'utilise que lui) et le moteur WebAssembly dans `ort/`.
 */
import type * as Ort from "onnxruntime-web";

type OrtModule = typeof Ort;

/** Fenêtre analysée : 512 échantillons, 32 ms à 16 kHz. */
export const SILERO_FRAME = 512;
/** Fin de la fenêtre précédente, jointe à chaque fenêtre (comme le fait silero-vad) : un début de mot à cheval n'est pas coupé. */
const CONTEXT = 64;
/** Fenêtres en attente au plus : si le calcul prend du retard, les plus anciennes sont sautées. */
const MAX_QUEUE = 8;

export const SILERO_MODEL_URL = "vad/silero_vad_v6.onnx";
export const ORT_WASM_DIR = "ort/";

/** Le modèle et sa mémoire (état récurrent). Une fenêtre à la fois, dans l'ordre. */
export class SileroModel {
  private state: Ort.Tensor;
  private context = new Float32Array(CONTEXT);
  /** Change à chaque remise à zéro : un calcul lancé avant est ignoré. */
  private generation = 0;

  private constructor(
    private readonly ort: OrtModule,
    private readonly session: Ort.InferenceSession,
    private readonly sampleRate: Ort.Tensor,
  ) {
    this.state = this.emptyState();
  }

  static async load(ort: OrtModule, model: Uint8Array): Promise<SileroModel> {
    const session = await ort.InferenceSession.create(model);
    return new SileroModel(ort, session, new ort.Tensor("int64", BigInt64Array.from([16000n]), []));
  }

  /** Probabilité de voix (0..1) d'une fenêtre de 512 échantillons (-1..1) ; rien si le modèle a été remis à zéro entre-temps. */
  async probability(frame: Float32Array): Promise<number | undefined> {
    const generation = this.generation;
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context);
    input.set(frame, CONTEXT);
    this.context = frame.slice(-CONTEXT);
    const out = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, input.length]),
      state: this.state,
      sr: this.sampleRate,
    });
    if (generation !== this.generation) return undefined;
    this.state = out["stateN"];
    return Number(out["output"].data[0]);
  }

  reset(): void {
    this.generation++;
    this.state = this.emptyState();
    this.context = new Float32Array(CONTEXT);
  }

  private emptyState(): Ort.Tensor {
    return new this.ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  }
}

/**
 * Reçoit les trames du micro (de taille quelconque), les regroupe en fenêtres
 * de 32 ms et tient à jour la dernière probabilité de voix. Le calcul est
 * asynchrone : la probabilité a au plus une ou deux fenêtres de retard, ce que
 * le pré-enregistrement de la VAD couvre.
 */
export class VoiceDetector {
  private frame = new Float32Array(SILERO_FRAME);
  private filled = 0;
  private queue: Float32Array[] = [];
  private running?: Promise<void>;
  private latest?: number;
  private broken = false;

  constructor(
    private readonly model: SileroModel,
    private readonly onError: (e: unknown) => void = () => {},
  ) {}

  /** Dernière probabilité connue ; absente au début, ou si le modèle a échoué (le volume seul décide alors). */
  get probability(): number | undefined {
    return this.broken ? undefined : this.latest;
  }

  push(pcm: Int16Array): void {
    if (this.broken) return;
    for (let i = 0; i < pcm.length; i++) {
      this.frame[this.filled++] = pcm[i] / 32768;
      if (this.filled === SILERO_FRAME) {
        this.queue.push(this.frame);
        this.frame = new Float32Array(SILERO_FRAME);
        this.filled = 0;
      }
    }
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length) this.running ??= this.drain().finally(() => (this.running = undefined));
  }

  /** Nouvel appel ou micro rétabli : rien de l'audio d'avant n'influence la suite. */
  reset(): void {
    this.model.reset();
    this.queue = [];
    this.filled = 0;
    this.latest = undefined;
  }

  /** Attend que toutes les fenêtres reçues soient analysées (tests). */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const p = await this.model.probability(this.queue.shift()!);
        if (p !== undefined) this.latest = p;
      }
    } catch (e) {
      this.broken = true;
      this.queue = [];
      this.onError(e);
    }
  }
}

let loading: Promise<SileroModel> | undefined;

/** Charge le modèle servi par l'application, une seule fois par page (un échec sera retenté au prochain appel). */
export function loadSilero(): Promise<SileroModel> {
  loading ??= (async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = new URL(ORT_WASM_DIR, document.baseURI).href;
    ort.env.wasm.numThreads = 1;
    const res = await fetch(new URL(SILERO_MODEL_URL, document.baseURI));
    if (!res.ok) throw new Error(`modèle de détection de voix introuvable (HTTP ${res.status})`);
    return SileroModel.load(ort, new Uint8Array(await res.arrayBuffer()));
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}
