import { cssVar, isLight, mix, onThemeChange, prefersReducedMotion, rgba } from "../theme";
import type { Phase } from "../call/phase";
/**
 * L'orbe de Kopilia : une sphère de points dessinée sur un canvas. Au repos elle
 * tourne lentement, à peine éclairée ; dès qu'il se passe quelque chose, elle
 * s'anime : elle respire avec la voix (la tienne quand tu parles, la sienne
 * quand il répond : des vagues parcourent sa surface et elle gonfle avec le
 * son), elle s'agite et accélère quand il réfléchit, elle s'éteint micro
 * coupé. Aux couleurs du thème (vert à l'écoute, bleu quand il réfléchit ou
 * parle) ; nette sur Retina ; immobile si le système demande moins de mouvement.
 */

/** Les phases de l'appel (celles de l'écran). */
export type SpherePhase = Phase;

export interface SphereState {
  phase: SpherePhase;
  /** Niveau sonore du moment, de 0 à 1 (le micro ou la voix de Kopilia). */
  level: number;
}

/** Points de la sphère ; assez pour une surface pleine, assez peu pour 60 images par seconde. */
export const POINTS = 1400;
/** Inclinaison de l'axe de rotation (radians) : la sphère est vue un peu de haut. */
const TILT = 0.42;
/** Rayon de la sphère par rapport au côté du canvas (368 px) : à peine plus que le bouton de 168 px. */
const RADIUS_RATIO = 0.235;
const IDLE_SPIN = 0.00006;
const BUSY_SPIN = 0.00045;
/** Étendue du halo par rapport au rayon de la sphère. */
const HALO_RATIO = 1.75;

/**
 * Rayon extérieur du halo : il doit s'éteindre avant le bord du canvas (côté
 * `side`), sinon le dégradé est coupé net et le carré du canvas se voit.
 */
export function haloRadius(sphereRadius: number, side: number): number {
  return Math.max(0, Math.min(sphereRadius * HALO_RATIO, side / 2 - 1));
}

/** Énergie visée selon ce qui se passe : vitesse, lumière, agitation. */
export function energyOf(phase: SpherePhase): number {
  switch (phase) {
    case "listening":
      return 0.3;
    case "hearing":
      return 0.55;
    case "thinking":
      return 0.9;
    case "speaking":
      return 0.7;
    case "ready":
      return 0.08;
    default:
      return 0;
  }
}

/**
 * Points répartis uniformément sur la sphère unité (spirale de Fibonacci) :
 * trois nombres par point (x, y, z), plus une phase propre pour les vagues.
 */
export function fibonacciSphere(n: number): { xyz: Float32Array; seed: Float32Array } {
  const xyz = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    xyz[i * 3] = Math.cos(a) * r;
    xyz[i * 3 + 1] = y;
    xyz[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = (a % (Math.PI * 2)) * 1.7;
  }
  return { xyz, seed };
}

interface Palette {
  dot: string;
  accent: string;
  accent2: string;
  idle: string;
  light: boolean;
}

export class DotSphere {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly xyz: Float32Array;
  private readonly seed: Float32Array;
  private readonly reduced = prefersReducedMotion();
  private palette = readPalette();
  private rot = 0;
  /** Activité lissée (0 au repos, 1 quand il réfléchit) : vitesse, lumière, couleur. */
  private energy = 0;
  /** Niveau sonore lissé (attaque rapide, relâche douce). */
  private pulse = 0;
  private colorMix = 0;
  private last = 0;
  private w = 0;
  private h = 0;
  /** Fondu d'apparition. */
  private presence = 0;
  /** Taille affichée du canvas, tenue à jour par un ResizeObserver (pas de mesure à chaque image). */
  private box: { w: number; h: number };
  private lastDraw = 0;
  /** Halo de la dernière image, réutilisé tant que rien ne change (au repos). */
  private halo?: { key: string; gradient: CanvasGradient };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    const pts = fibonacciSphere(POINTS);
    this.xyz = pts.xyz;
    this.seed = pts.seed;
    onThemeChange(() => (this.palette = readPalette()));
    const rect = canvas.getBoundingClientRect();
    this.box = { w: Math.round(rect.width), h: Math.round(rect.height) };
    new ResizeObserver(([entry]) => {
      this.box = { w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) };
    }).observe(canvas);
  }

  /** Une image : l'état de Kopilia à cet instant, dessiné. */
  frame(now: number, state: SphereState): void {
    const target = energyOf(state.phase);
    // Au calme (repos, micro coupé, rien n'est dit), 20 images par seconde suffisent,
    // comme pour la galaxie : la rotation est trop lente pour qu'on voie la différence.
    const calm = target < 0.1 && this.energy < 0.1 && this.pulse < 0.01 && this.presence > 0.99 && state.level < 0.01;
    if (calm && now - this.lastDraw < 50) return;
    this.lastDraw = now;
    const dt = this.last ? Math.min(100, now - this.last) : 16;
    this.last = now;
    this.resize();
    this.energy += (target - this.energy) * Math.min(1, dt / 350);
    this.presence += (1 - this.presence) * Math.min(1, dt / 700);
    const level = Math.max(0, Math.min(1, state.level));
    this.pulse += (level - this.pulse) * (level > this.pulse ? 0.5 : 0.1);
    const spin = this.reduced ? 0 : IDLE_SPIN + BUSY_SPIN * this.energy * this.energy;
    this.rot += dt * spin;
    // Couleur : grise au repos, verte quand il t'écoute (touche tenue), bleue quand il réfléchit ou parle.
    const warm = state.phase === "hearing";
    const tint = warm ? this.palette.accent2 : this.palette.accent;
    this.colorMix += ((this.energy > 0.12 ? 1 : 0) - this.colorMix) * Math.min(1, dt / 400);
    const color = mix(this.palette.idle, tint, this.colorMix);

    const ctx = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.min(this.w, this.h) * RADIUS_RATIO * (1 + 0.09 * this.pulse);
    ctx.clearRect(0, 0, this.w, this.h);

    // Halo : plus vif quand il se passe quelque chose, et avec le son. Il
    // s'éteint avant le bord du canvas, pour que ce bord ne se voie jamais.
    const haloAlpha = (0.05 + 0.3 * this.energy + 0.3 * this.pulse) * this.presence;
    const haloR = haloRadius(R, Math.min(this.w, this.h));
    if (haloAlpha > 0.01 && haloR > R * 0.4) {
      const inner = rgba(color, haloAlpha * (this.palette.light ? 0.35 : 1));
      const key = `${cx}|${cy}|${R.toFixed(1)}|${haloR.toFixed(1)}|${inner}`;
      if (this.halo?.key !== key) {
        const g = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, haloR);
        g.addColorStop(0, inner);
        g.addColorStop(1, rgba(color, 0));
        this.halo = { key, gradient: g };
      }
      ctx.fillStyle = this.halo.gradient;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    // Vagues sur la surface : la voix (la tienne ou la sienne) les soulève ; la réflexion les agite.
    const t = now / 1000;
    const voice = state.phase === "hearing" || state.phase === "speaking" ? 0.16 * this.pulse + 0.02 * this.energy : 0;
    const think = state.phase === "thinking" ? 0.05 + 0.03 * Math.sin(t * 2.3) : 0;
    const breath = this.reduced ? 0 : 0.015 * this.energy * Math.sin(t * 1.4);
    const waves = this.reduced ? 0 : voice + think;
    const cosR = Math.cos(this.rot);
    const sinR = Math.sin(this.rot);
    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);
    const bright = (0.35 + 0.65 * this.energy + 0.25 * this.pulse) * this.presence;
    ctx.fillStyle = mix(this.palette.dot, color, 0.25 + 0.6 * this.colorMix);
    for (let i = 0; i < POINTS; i++) {
      const x0 = this.xyz[i * 3];
      const y0 = this.xyz[i * 3 + 1];
      const z0 = this.xyz[i * 3 + 2];
      // Rotation autour de l'axe vertical, puis inclinaison vers le spectateur.
      const x1 = x0 * cosR - z0 * sinR;
      const z1 = x0 * sinR + z0 * cosR;
      const y2 = y0 * cosT - z1 * sinT;
      const z2 = y0 * sinT + z1 * cosT;
      const s = this.seed[i];
      let d = 1 + breath;
      if (waves) {
        d += waves * (0.6 * Math.sin(4.5 * y2 + 2.5 * x1 + t * 5.2 + s) + 0.4 * Math.sin(7 * z2 - t * 3.7 + s * 0.5));
      }
      // Les points devant sont plus grands et plus lumineux : la sphère a du volume.
      const front = (z2 + 1) / 2;
      const scale = 0.76 + 0.3 * front;
      const px = cx + x1 * d * R * scale;
      const py = cy + y2 * d * R * scale;
      const size = (1.1 + 1.4 * front) * (1 + 0.3 * this.pulse);
      ctx.globalAlpha = Math.min(1, (0.08 + 0.92 * front * front) * bright);
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.box;
    if (w === this.w && h === this.h && this.canvas.width === Math.round(w * dpr)) return;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function readPalette(): Palette {
  const light = isLight();
  return {
    dot: light ? "#2b3345" : "#dfe6ff",
    accent: cssVar("--accent", "#5b8cff"),
    accent2: cssVar("--accent-2", "#38d39f"),
    idle: light ? "#6b7383" : "#8a94a8",
    light,
  };
}

/** Mélange de couleurs : défini avec le thème (gardé ici pour les tests de la sphère). */
export { mix };
