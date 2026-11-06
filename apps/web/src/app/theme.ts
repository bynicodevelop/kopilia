/**
 * Le thème de l'écran (sombre ou clair, mouvement réduit) et les couleurs,
 * pour les dessins sur canvas qui ne lisent pas le CSS d'eux-mêmes : galaxie,
 * sphère, graphiques. Un seul écouteur du thème pour toute l'application.
 */

const LIGHT = "(prefers-color-scheme: light)";

/** Police du système, celle des pages (styles.css). */
export const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** Valeur d'une variable CSS de la page (--accent…), ou la valeur de repli. */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function isLight(): boolean {
  return matchMedia(LIGHT).matches;
}

export function prefersReducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const listeners = new Set<() => void>();
let watching = false;

/** Appelle `cb` à chaque passage sombre/clair ; renvoie de quoi se désabonner. */
export function onThemeChange(cb: () => void): () => void {
  if (!watching) {
    watching = true;
    matchMedia(LIGHT).addEventListener("change", () => listeners.forEach((f) => f()));
  }
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** « #5b8cff » + opacité -> « rgba(91,140,255,0.4) ». */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** Mélange de deux couleurs (k = 0 : la première ; 1 : la seconde). */
export function mix(a: string, b: string, k: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const t = Math.max(0, Math.min(1, k));
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[c(r1, r2), c(g1, g2), c(b1, b2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
