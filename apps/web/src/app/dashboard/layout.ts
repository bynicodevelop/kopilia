/**
 * Placement des encarts du tableau de bord : par défaut dans les marges, de
 * part et d'autre de l'orbe ; un encart glissé par son en-tête en sort et se
 * pose où on le lâche (position gardée sur cet écran). Fonctions pures,
 * testées sans navigateur.
 */

/** Coin haut-gauche d'un encart sorti de sa marge, en pixels de la fenêtre ; `z` : le dernier déplacé passe devant. */
export interface Position {
  x: number;
  y: number;
  z: number;
}

/** Marge minimale entre un encart libre et le bord de la fenêtre. */
export const EDGE = 8;
/** Marge gardée tout autour de la fenêtre quand on agrandit un graphique : il ne la couvre jamais toute. */
export const FRAME = 16;
/** Encarts l'un sous l'autre dans une marge ; les suivants s'empilent sur le dernier. */
export const DOCK_SLOTS = 2;
/** Décalage d'un encart empilé sur le précédent (vers le bas, et vers le centre de l'écran) : l'en-tête de celui de dessous reste visible. */
export const STACK_DY = 34;
export const STACK_DX = 18;
/** Taille minimale d'un graphique redimensionné à la main. */
export const MIN_W = 280;
export const MIN_H = 240;
/** Largeur (px) jusqu'à laquelle l'écran est étroit : encarts dans la colonne. Même seuil que le CSS (max-width: 1239px). */
export const NARROW_MAX = 1239;

export function isNarrow(width: number): boolean {
  return width <= NARROW_MAX;
}

export interface Size {
  w: number;
  h: number;
}

export type Side = "left" | "right";

/**
 * Le côté de chaque encart. Celui qu'il a reçu à son ouverture ne change plus :
 * un encart qui changerait de marge serait détruit puis recréé, et son
 * graphique rechargerait ses bougies (c'était le cas quand le côté dépendait du
 * rang : fermer le premier faisait passer tous les suivants de l'autre côté).
 * Un nouvel encart va du côté où il y a le moins d'encarts dans la marge (les
 * encarts déplacés ailleurs ne comptent pas) ; à gauche à égalité. Les encarts
 * fermés sont oubliés.
 */
export function assignSides(ids: readonly string[], previous: Readonly<Record<string, Side>>, free: ReadonlySet<string> = new Set()): Record<string, Side> {
  const out: Record<string, Side> = {};
  const docked = { left: 0, right: 0 };
  for (const id of ids) {
    const side = previous[id];
    if (side !== "left" && side !== "right") continue;
    out[id] = side;
    if (!free.has(id)) docked[side]++;
  }
  for (const id of ids) {
    if (out[id]) continue;
    const side: Side = docked.right < docked.left ? "right" : "left";
    out[id] = side;
    if (!free.has(id)) docked[side]++;
  }
  return out;
}

/** Même répartition (mêmes encarts, mêmes côtés) : rien à enregistrer. */
export function sameSides(a: Readonly<Record<string, Side>>, b: Readonly<Record<string, Side>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((id) => a[id] === b[id]);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Garde un encart (w × h) dans la fenêtre (vw × vh) : il ne se perd jamais hors de l'écran. */
export function clampPosition(p: { x: number; y: number }, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.round(clamp(p.x, EDGE, Math.max(EDGE, vw - w - EDGE))),
    y: Math.round(clamp(p.y, EDGE, Math.max(EDGE, vh - h - EDGE))),
  };
}

/**
 * Taille maximale d'un graphique qu'on redimensionne : jusqu'au bord de la
 * fenêtre, moins sa marge. Le bord opposé à la poignée ne bouge pas : le
 * gauche, ou le droit quand la poignée est à gauche (`flip`).
 */
export function resizeLimit(r: { left: number; right: number; top: number }, flip: boolean, vw: number, vh: number): Size {
  return {
    w: Math.max(MIN_W, Math.round(flip ? r.right - FRAME : vw - r.left - FRAME)),
    h: Math.max(MIN_H, Math.round(vh - r.top - FRAME)),
  };
}

/** Haut d'un graphique agrandi : sous la barre du haut (Kopilia, Tout fermer, Brief, Opportunités, Mémoire), comme les marges. */
export const MAX_TOP = 58;
/**
 * Bande du bas laissée libre sous un graphique agrandi : les boutons d'appel
 * au centre, la discussion à leur droite. Le graphique s'arrête au-dessus :
 * rien ne passe sous les boutons, rien ne recouvre ses outils ni son échelle.
 */
export const CALL_BAND = 116;

/** Taille d'un graphique agrandi : entre la barre du haut et la bande d'appel, à la marge des bords. */
export function maximizedSize(vw: number, vh: number): Size {
  return { w: Math.max(MIN_W, vw - 2 * FRAME), h: Math.max(MIN_H, vh - MAX_TOP - CALL_BAND) };
}

/**
 * Les graphiques agrandis après un affichage demandé à la voix : en agrandir
 * un rend leur taille aux autres (un seul en grand, celui qu'on vient de
 * nommer) ; réduire ou ramener dans sa marge l'enlève de la liste ; sans
 * encart, réduire les vide tous. `null` : rien ne change.
 */
export function maxedAfter(maxed: readonly string[], id: string | undefined, display: "maximize" | "restore" | "dock"): string[] | null {
  if (display === "maximize") {
    if (!id || (maxed.length === 1 && maxed[0] === id)) return null;
    return [id];
  }
  const next = id ? maxed.filter((x) => x !== id) : [];
  return next.length === maxed.length ? null : next;
}

/**
 * Les encarts de chaque marge, de haut en bas : les premiers l'un sous
 * l'autre, puis la pile posée sur le dernier, dans l'ordre d'ouverture. Celui
 * qu'on a fait passer devant (`front`) va sur le dessus de sa pile : les
 * autres reculent d'un cran, leurs en-têtes restent visibles. Les encarts
 * sortis de leur marge n'y sont pas.
 */
export function dockOrder(
  ids: readonly string[],
  sides: Readonly<Record<string, Side>>,
  free: ReadonlySet<string> = new Set(),
  front?: string | null,
): Record<Side, string[]> {
  const out: Record<Side, string[]> = { left: [], right: [] };
  for (const id of ids) {
    const side = sides[id];
    if ((side === "left" || side === "right") && !free.has(id)) out[side].push(id);
  }
  for (const list of Object.values(out)) {
    const at = front ? list.indexOf(front) : -1;
    if (at >= DOCK_SLOTS - 1) list.push(...list.splice(at, 1));
  }
  return out;
}

/** Rang de chaque encart dans sa marge : 0 pour les premiers et la base de la pile, puis 1, 2… pour ceux qui s'y empilent, décalés d'autant. */
export function stackRanks(order: Readonly<Record<Side, readonly string[]>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const list of Object.values(order)) list.forEach((id, i) => (out[id] = Math.max(0, i - (DOCK_SLOTS - 1))));
  return out;
}

/** La poignée de redimensionnement regarde le centre de l'écran : à gauche de l'encart quand il est dans la moitié droite. */
export function flipGrip(x: number, w: number, vw: number): boolean {
  return x + w / 2 > vw / 2;
}

/** Rang de superposition du prochain encart déplacé : devant tous les autres. */
export function nextZ(positions: Record<string, Position>): number {
  return Object.values(positions).reduce((max, p) => Math.max(max, p.z), 0) + 1;
}

/**
 * Point d'un encart où la galaxie attache son fil : le bord qui regarde l'orbe
 * (à côté de lui, au-dessus ou en dessous). Rien si l'encart couvre l'orbe ou
 * n'est pas affiché.
 */
export function anchorPoint(
  r: { left: number; right: number; top: number; bottom: number; width: number },
  cx: number,
  cy: number,
): { x: number; y: number } | undefined {
  if (!r.width) return undefined;
  const midY = (r.top + r.bottom) / 2;
  const midX = Math.max(r.left + 24, Math.min(r.right - 24, cx));
  if (r.right < cx) return { x: r.right, y: midY };
  if (r.left > cx) return { x: r.left, y: midY };
  if (r.top > cy) return { x: midX, y: r.top };
  if (r.bottom < cy) return { x: midX, y: r.bottom };
  return undefined;
}

/* ---------- Relecture du stockage du navigateur : une valeur abîmée est écartée, jamais propagée ---------- */

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function entries(raw: unknown): Array<[string, unknown]> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : [];
}

/** Tailles relues : nombres finis, au moins la taille minimale. */
export function sanitizeSizes(raw: unknown): Record<string, Size> {
  const out: Record<string, Size> = {};
  for (const [id, v] of entries(raw)) {
    const s = v as Partial<Size> | null;
    if (finite(s?.w) && finite(s?.h)) out[id] = { w: Math.max(MIN_W, Math.round(s.w)), h: Math.max(MIN_H, Math.round(s.h)) };
  }
  return out;
}

/** Positions relues : coordonnées et rang finis. */
export function sanitizePositions(raw: unknown): Record<string, Position> {
  const out: Record<string, Position> = {};
  for (const [id, v] of entries(raw)) {
    const p = v as Partial<Position> | null;
    if (finite(p?.x) && finite(p?.y) && finite(p?.z)) out[id] = { x: Math.round(p.x), y: Math.round(p.y), z: Math.max(0, Math.round(p.z)) };
  }
  return out;
}

/** Côtés relus : gauche ou droite seulement. */
export function sanitizeSides(raw: unknown): Record<string, Side> {
  const out: Record<string, Side> = {};
  for (const [id, v] of entries(raw)) if (v === "left" || v === "right") out[id] = v;
  return out;
}
