/**
 * La page d'attente de l'application Mac (`apps/desktop/waiting`) : la boule
 * de Kopilia et sa galaxie, les mêmes qu'à l'écran, qui « réfléchissent » le
 * temps que le serveur réponde. La page de Kopilia prend ensuite leur place,
 * boule au même endroit. Empaquetée seule par esbuild (`pnpm app`), sans
 * Angular.
 *
 * L'application dit où en est le serveur : `window.kopiliaStatus(texte, actif)`.
 * Actif (il démarre) : la boule s'agite ; arrêté : elle se calme et pâlit.
 */
import { NeuralNet } from "../neural/neural-net";
import { DotSphere } from "./dot-sphere";

interface WaitingWindow {
  kopiliaStatus?: (text: string, busy: boolean) => void;
}

const sphereCanvas = document.querySelector<HTMLCanvasElement>("canvas.sphere");
const netCanvas = document.querySelector<HTMLCanvasElement>("canvas.neural");
const orb = document.querySelector<HTMLElement>(".orb");
const status = document.querySelector<HTMLElement>(".hint");
let busy = true;

(window as WaitingWindow).kopiliaStatus = (text, active) => {
  if (status) status.textContent = text;
  busy = active;
};

if (sphereCanvas && netCanvas && orb) {
  const sphere = new DotSphere(sphereCanvas);
  const net = new NeuralNet(netCanvas);
  const frame = (now: number) => {
    sphere.frame(now, { phase: busy ? "thinking" : "ready", level: 0 });
    const r = orb.getBoundingClientRect();
    net.frame(now, { busy, steps: [], jobs: [] }, r.left + r.width / 2, r.top + r.height / 2);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
