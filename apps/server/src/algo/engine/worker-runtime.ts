import { runBacktest } from "./engine.js";
import type { Robot, RunInput, RunOutput } from "./types.js";

/*
 * Ce qui tourne dans le bac à sable (un worker à part) : charger le module du
 * robot compilé en JavaScript, sans `require`, `process`, `fetch` ni accès au
 * global, puis jouer le backtest sur chaque série et renvoyer les trades. Le
 * fil principal borne le temps (il tue le worker) et la mémoire (limites du
 * worker). Ce fichier est empaqueté par esbuild au premier usage.
 */

/** Les noms que le module du robot ne doit pas voir : passés en paramètres indéfinis, ils masquent les vrais. */
export const SHADOWED = ["require", "process", "globalThis", "Function", "eval", "fetch", "setTimeout", "setInterval", "queueMicrotask", "Worker"] as const;

export function loadRobot(js: string): Robot {
  const module = { exports: {} as Record<string, unknown> };
  const factory = new Function("module", "exports", ...SHADOWED, js) as (...args: unknown[]) => void;
  factory(module, module.exports, ...SHADOWED.map(() => undefined));
  const robot = (module.exports.default ?? module.exports) as Partial<Robot> | undefined;
  if (!robot || typeof robot.onBar !== "function") throw new Error("le module doit exporter par défaut un objet avec une méthode onBar(ctx)");
  return robot as Robot;
}

export interface WorkerMessage {
  ok: boolean;
  results?: RunOutput[];
  error?: string;
}

/** Point d'entrée du worker : `workerData` porte le code et les séries. */
export function main(wt: { workerData: unknown; parentPort: { postMessage(value: unknown): void } | null }): void {
  const post = (m: WorkerMessage) => wt.parentPort?.postMessage(m);
  try {
    const { js, inputs } = wt.workerData as { js: string; inputs: RunInput[] };
    const robot = loadRobot(js);
    const results = inputs.map((input) => runBacktest(robot, input));
    post({ ok: true, results });
  } catch (e) {
    post({ ok: false, error: (e as Error).message });
  }
}
