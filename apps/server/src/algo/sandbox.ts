import { Worker } from "node:worker_threads";
import { build, transform } from "esbuild";
import type { RunInput, RunOutput } from "./engine/types.js";
import type { WorkerMessage } from "./engine/worker-runtime.js";

/*
 * Le bac à sable des robots : le TypeScript écrit par Kopilia est compilé par
 * esbuild (types retirés, module CommonJS), refusé s'il cherche à sortir de
 * l'API du moteur (require, import, process, fetch…), puis joué dans un worker
 * à part avec le moteur empaqueté, un délai et une limite de mémoire. Rien
 * n'est écrit sur disque.
 */

/** Taille maximale du code d'un robot. */
const MAX_CODE = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Mémoire du worker : assez pour deux ans de minutes de plusieurs produits. */
const MEMORY_MB = 1024;

/** Ce qu'un robot n'a pas le droit d'écrire, et comment le dire. */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /^\s*import\s+(?!type\b)[^;]*from\s/m, why: "import : le robot ne charge aucun module, l'API du moteur lui suffit (les `import type` sont permis)" },
  { re: /\brequire\s*\(/, why: "require : aucun module" },
  { re: /\bimport\s*\(/, why: "import() : aucun module" },
  { re: /\bprocess\b/, why: "process : pas d'accès au processus" },
  { re: /\bglobalThis\b/, why: "globalThis : pas d'accès au global" },
  { re: /\bFunction\s*\(/, why: "Function() : pas de code dynamique" },
  { re: /\beval\s*\(/, why: "eval : pas de code dynamique" },
  { re: /\bfetch\s*\(/, why: "fetch : aucun réseau" },
  { re: /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/, why: "l'heure réelle : un backtest n'en a pas, utilise ctx.time et ctx.clock" },
  { re: /\bMath\.random\s*\(/, why: "Math.random : un backtest doit être déterministe" },
];

export type CompileResult = { js: string } | { error: string };

/** Compile le TypeScript d'un robot, ou dit pourquoi il est refusé. */
export async function compileRobot(ts: string): Promise<CompileResult> {
  if (typeof ts !== "string" || !ts.trim()) return { error: "code vide" };
  if (ts.length > MAX_CODE) return { error: `code trop long (${ts.length} caractères, ${MAX_CODE} au plus)` };
  for (const f of FORBIDDEN) if (f.re.test(ts)) return { error: `refusé : ${f.why}` };
  try {
    const out = await transform(ts, { loader: "ts", format: "cjs", target: "es2022", sourcefile: "robot.ts", logLevel: "silent" });
    return { js: out.code };
  } catch (e) {
    const errors = (e as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> }).errors;
    if (errors?.length) {
      return { error: errors.map((m) => `${m.location ? `ligne ${m.location.line} : ` : ""}${m.text}`).join(" ; ") };
    }
    return { error: (e as Error).message };
  }
}

let runtimeBundle: Promise<string> | undefined;

/** Le moteur et le chargeur du robot, empaquetés une fois pour le worker (sources en tsx, dist en production). */
function runtimeCode(): Promise<string> {
  runtimeBundle ??= (async () => {
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const entry = new URL(`./engine/worker-runtime.${ext}`, import.meta.url);
    const out = await build({
      entryPoints: [entry.pathname],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "KopiliaRuntime",
      platform: "node",
      target: "node20",
      logLevel: "silent",
    });
    return `${out.outputFiles[0].text}\nKopiliaRuntime.main(require("node:worker_threads"));`;
  })();
  return runtimeBundle;
}

export interface RunOptions {
  timeoutMs?: number;
}

/** Joue un robot compilé sur des séries, dans un worker ; rejette au-delà du délai ou sur erreur du module. */
export async function runRobot(js: string, inputs: RunInput[], opts: RunOptions = {}): Promise<RunOutput[]> {
  const code = await runtimeCode();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunOutput[]>((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { js, inputs },
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB },
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s) : le robot boucle ou en demande trop`))),
      timeoutMs,
    );
    worker.on("message", (m: WorkerMessage) => finish(() => (m.ok && m.results ? resolve(m.results) : reject(new Error(m.error ?? "erreur du robot")))));
    worker.on("error", (e) => finish(() => reject(new Error(`le robot a planté : ${e.message}`))));
    worker.on("exit", (code) => {
      if (!done)
        finish(() => reject(new Error(code === 0 ? "le worker s'est arrêté sans résultat" : `le worker s'est arrêté (code ${code}) : mémoire dépassée ?`)));
    });
  });
}
