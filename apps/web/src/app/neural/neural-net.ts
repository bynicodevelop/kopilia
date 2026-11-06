import { cssVar, isLight, onThemeChange, prefersReducedMotion, rgba, SYSTEM_FONT } from "../theme";
/**
 * Réseau de neurones galactique, sur tout l'écran, derrière l'orbe : décoratif,
 * mais il dit où en est Kopilia. L'orbe est le cœur d'une galaxie :
 * - un ciel d'étoiles et des nébuleuses, toujours là, très discrets au repos ;
 * - des bras spiraux de neurones reliés entre eux, qui tournent lentement et
 *   s'embrasent quand Kopilia réfléchit : des cascades y courent, chaque
 *   neurone allumé en déclenche un ou deux autres, depuis le cœur vers le bord ;
 * - les étapes du tour en cours (recherche web, agent dépêché…) poussent en
 *   arbre au-dessus de l'orbe : la première part de l'orbe, chacune en
 *   déclenche deux autres ; un influx court jusqu'à la nouvelle, qui s'allume
 *   et lance une cascade dans la galaxie ;
 * - chaque agent ou tâche en cours est un astre plus loin, nommé par son
 *   projet ; ses étapes faites poussent de lui de la même façon, en
 *   arborescence ; il clignote en finissant.
 */

/** Ce que montre le réseau : l'état de Kopilia à cet instant. */
export interface NetModel {
  /** Kopilia prépare ou dit une réponse : la galaxie s'embrase. */
  busy: boolean;
  /** Étapes du tour en cours (outils appelés par le dialogue). */
  steps: Array<{ id: string; label: string }>;
  /** Agents et tâches connus : seuls ceux en cours, ou qui viennent de finir, s'affichent. */
  jobs: Array<{ id: string; name: string; kind: "agent" | "task"; state: string; steps: number; lastStep?: string }>;
  /** Encarts du tableau de bord, par le point de leur bord qui regarde l'orbe : un fil les y rattache. */
  anchors?: Array<{ id: string; x: number; y: number }>;
}

/** Un encart rattaché à l'orbe ; il s'efface quand il se ferme. */
export interface Anchor {
  id: string;
  x: number;
  y: number;
  born: number;
  leaving?: number;
}

/** Durée d'effacement du fil d'un encart fermé. */
export const ANCHOR_LEAVE_MS = 450;

/** Met les fils en accord avec les encarts affichés : apparitions, déplacements, départs. */
export function syncAnchors(anchors: Map<string, Anchor>, list: Array<{ id: string; x: number; y: number }>, now: number): void {
  const seen = new Set<string>();
  for (const a of list) {
    seen.add(a.id);
    const known = anchors.get(a.id);
    if (known) {
      known.x = a.x;
      known.y = a.y;
      known.leaving = undefined;
    } else {
      anchors.set(a.id, { ...a, born: now });
    }
  }
  for (const [id, a] of anchors) {
    if (!seen.has(id) && a.leaving === undefined) a.leaving = now;
    if (a.leaving !== undefined && now - a.leaving > ANCHOR_LEAVE_MS) anchors.delete(id);
  }
}

export interface NetNode {
  id: string;
  kind: "step" | "agent" | "task";
  name: string;
  state: string;
  /** Instant d'apparition (ms). */
  born: number;
  /** Instant où il commence à s'effacer. */
  leaving?: number;
  outcome?: "ok" | "fail";
  /** Une étape faite = un bloc ; leurs instants d'apparition. */
  blocks: number[];
  lastStep?: string;
  /** Rang d'arrivée : place stable autour de l'orbe (pour une étape, sa place dans l'arbre). */
  slot: number;
  x: number;
  y: number;
  /** Étape : instant où l'influx parti de l'étape mère (ou de l'orbe) l'atteint ; elle n'apparaît qu'alors. */
  arrive?: number;
  /** Instant où il a déclenché la suivante : il s'allume. */
  flash?: number;
  /** Sa cascade dans la galaxie est partie. */
  fired?: boolean;
}

const ACTIVE = new Set(["queued", "running", "awaiting_approval"]);
/** Durée d'effacement d'un nœud (le clignotement de fin compris). */
export const LEAVE_MS = 2200;
/** Étapes du tour gardées à l'écran (les plus anciennes s'effacent) : un arbre de trois étages. */
export const MAX_STEPS = 7;
/** Étapes dessinées autour d'un agent : un arbre de quatre étages ; au-delà, les places resservent. */
export const MAX_BLOCKS = 15;

/** Met les nœuds en accord avec le modèle : naissances, étapes, départs. */
export function syncNodes(nodes: Map<string, NetNode>, model: NetModel, now: number): void {
  const seen = new Set<string>();
  for (const j of model.jobs) {
    const node = nodes.get(j.id);
    if (!ACTIVE.has(j.state)) {
      // Fini : il clignote (vert ou rouge) puis s'efface. Jamais vu en cours : rien.
      if (node && node.leaving === undefined) {
        node.leaving = now;
        node.outcome = j.state === "succeeded" ? "ok" : "fail";
        node.state = j.state;
      }
      if (node) seen.add(j.id);
      continue;
    }
    seen.add(j.id);
    const n = node ?? newNode(nodes, j.id, j.kind, now);
    n.leaving = n.outcome = undefined;
    n.name = j.name;
    n.state = j.state;
    n.lastStep = j.lastStep;
    while (n.blocks.length < j.steps) n.blocks.push(now);
  }

  const kept = model.busy ? model.steps.slice(-MAX_STEPS) : [];
  for (const s of kept) {
    const id = `step:${s.id}`;
    seen.add(id);
    const n = nodes.get(id) ?? newNode(nodes, id, "step", now);
    n.leaving = undefined;
    n.name = s.label;
  }

  for (const [id, n] of nodes) {
    if (!seen.has(id) && n.leaving === undefined) n.leaving = now;
    if (n.leaving !== undefined && now - n.leaving > LEAVE_MS) nodes.delete(id);
  }
}

function newNode(nodes: Map<string, NetNode>, id: string, kind: NetNode["kind"], now: number): NetNode {
  // Première place libre de sa couronne : un nœud ne saute pas quand un autre part.
  const ring = kind === "step" ? "step" : "job";
  const taken = new Set([...nodes.values()].filter((n) => (n.kind === "step" ? "step" : "job") === ring).map((n) => n.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  const node: NetNode = { id, kind, name: "", state: "running", born: now, blocks: [], slot, x: NaN, y: NaN };
  nodes.set(id, node);
  return node;
}

/** Angles (degrés, 0 = à droite, vers le bas positif) : de part et d'autre de l'orbe, hors du texte du dessous. */
const JOB_ANGLES = [-18, 198, 18, 162, -40, 220, 40, 140, -62, 242, 62, 118];
/** Arbre des étapes au-dessus de l'orbe : hauteur du premier étage, écart entre étages (resserré sur un écran bas), largeur. */
const STEP_R = 118;
const STEP_LEVEL = 62;
const STEP_WIDTH = 480;
/** Bandeau du haut de l'écran (en-tête, travaux en cours) : l'arbre reste dessous. */
const TOP_ROOM = 120;
/** Arbre des étapes d'un agent, autour de lui, vers l'extérieur. */
const BLOCK_FAN = 1.9;
const BLOCK_R = 22;
const BLOCK_LEVEL = 15;

/**
 * Place `k` d'un arbre binaire rangé en tas (0 ; 1 et 2 ; 3 à 6…) : son étage,
 * et sa position dans l'éventail de 0 à 1. Les deux filles d'une place
 * l'encadrent à l'étage suivant.
 */
export function treeSpot(k: number): { depth: number; across: number } {
  const depth = Math.floor(Math.log2(k + 1));
  return { depth, across: (k + 1 - 2 ** depth + 0.5) / 2 ** depth };
}

/** La place mère de `k` (-1 : la racine, rattachée à l'orbe ou à l'agent). */
export function treeParent(k: number): number {
  return k > 0 ? Math.floor((k - 1) / 2) : -1;
}

/** Place `k` de l'arbre des étapes d'un agent placé en (x, y), qui s'ouvre dans la direction `out` (radians). */
export function blockSpot(k: number, x: number, y: number, out: number): { x: number; y: number } {
  const { depth, across } = treeSpot(k);
  const a = out + BLOCK_FAN * (across - 0.5);
  const r = BLOCK_R + depth * BLOCK_LEVEL;
  return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
}

/** Place visée d'un nœud autour de l'orbe (cx, cy), dans une fenêtre w × h. */
export function targetOf(node: Pick<NetNode, "kind" | "slot">, cx: number, cy: number, w: number, h: number): { x: number; y: number } {
  if (node.kind === "step") {
    // En arbre au-dessus de l'orbe : chaque étage plus haut, les filles de part et d'autre de
    // leur mère ; les branches du bord retombent un peu.
    const { depth, across } = treeSpot(node.slot);
    const level = clamp((cy - TOP_ROOM - STEP_R) / 2, 34, STEP_LEVEL);
    const dx = (across - 0.5) * STEP_WIDTH;
    return { x: cx + dx, y: cy - STEP_R - depth * level + Math.abs(dx) * 0.1 };
  }
  const a = (JOB_ANGLES[node.slot % JOB_ANGLES.length] * Math.PI) / 180;
  const round = Math.floor(node.slot / JOB_ANGLES.length);
  // Les astres occupent tout l'écran, plus en largeur qu'en hauteur.
  const rx = clamp(w / 2 - 130, 170, 640) + round * 40;
  const ry = clamp(h / 2 - 150, 115, 320) + round * 20;
  return {
    x: clamp(cx + Math.cos(a) * rx, 90, Math.max(90, w - 90)),
    y: clamp(cy + Math.sin(a) * ry, 60, Math.max(60, h - 70)),
  };
}

/* ------------------------------------------------------------------ */
/* Dessin                                                              */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;
/** Le disque de la galaxie, vu de biais. */
const TILT = 0.56;
const ARMS = 3;
/** Enroulement des bras (radians du centre au bord). */
const TWIST = 3.4;
const CORE_RADIUS = 92;
/** Rotation (radians par milliseconde) au repos, et en plus quand Kopilia réfléchit. */
const IDLE_SPIN = 0.000012;
const BUSY_SPIN = 0.00007;
/** Vitesse d'un influx de la galaxie (px/ms), et d'un influx qui fait pousser une étape. */
const PULSE_SPEED = 0.3;
const STEP_SPEED = 0.45;
/** Trajet d'un influx jusqu'à une étape d'agent. */
const BLOCK_TRAVEL = 420;
/** Influx en vol au plus : une cascade s'arrête plutôt que de ralentir l'écran. */
const MAX_PULSES = 320;

interface Palette {
  agent: string;
  task: string;
  step: string;
  violet: string;
  warn: string;
  danger: string;
  ok: string;
  text: string;
  muted: string;
  star: string;
  /** Fond clair : pas d'addition de lumière (elle blanchirait tout). */
  light: boolean;
}

interface Pulse {
  born: number;
  dur: number;
  /** Lien orbe -> nœud (id) ; `inward` : du nœud vers l'orbe (un résultat qui remonte). */
  to?: string;
  inward?: boolean;
  /** Influx de la galaxie, du neurone `a` au neurone `b`. */
  a?: number;
  b?: number;
  /** Relais restants : à l'arrivée, `b` en déclenche un ou deux autres. */
  hops?: number;
  /** Chance de se diviser en deux à chaque relais. */
  fork?: number;
  /** Neurones déjà atteints par la cascade : elle ne revient pas sur ses pas. */
  seen?: Set<number>;
  color?: string;
}

/** Positions en coordonnées du disque (rayon, angle), tournées puis inclinées au dessin. */
interface Galaxy {
  maxR: number;
  stars: Array<{ r: number; a: number; size: number; tw: number; depth: number }>;
  neurons: Array<{ r: number; a: number; tw: number; flash: number; hue: 0 | 1 | 2 }>;
  edges: Array<[number, number]>;
  /** Voisins de chaque neurone (par les arêtes). */
  links: number[][];
  /** Neurones proches du cœur : les cascades de Kopilia qui réfléchit en partent. */
  inner: number[];
  nebulae: Array<{ r: number; a: number; size: number; hue: 0 | 1 | 2 }>;
}

export class NeuralNet {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly nodes = new Map<string, NetNode>();
  private readonly anchors = new Map<string, Anchor>();
  private pulses: Pulse[] = [];
  private galaxy?: Galaxy;
  private palette = readPalette();
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private readonly reduced = prefersReducedMotion();
  /** Embrasement de la galaxie (0 au repos, 1 quand Kopilia réfléchit). */
  private ambient = 0;
  /** Fondu d'ouverture de la page. */
  private presence = 0;
  private rot = 0;
  private cx = NaN;
  private cy = NaN;
  private w = 0;
  private h = 0;
  private last = 0;
  private lastDraw = 0;
  private nextPulse = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    onThemeChange(() => {
      this.palette = readPalette();
      this.sprites.clear();
    });
  }

  /** Une image : met le réseau à jour et le dessine autour du centre de l'orbe. */
  frame(now: number, model: NetModel, orbX: number, orbY: number): void {
    const dt = this.last ? Math.min(100, now - this.last) : 16;
    this.last = now;
    this.resize();

    const before = new Map([...this.nodes].map(([id, n]) => [id, n.blocks.length]));
    syncNodes(this.nodes, model, now);
    syncAnchors(this.anchors, model.anchors ?? [], now);
    this.presence += (1 - this.presence) * Math.min(1, dt / 900);
    this.ambient += ((model.busy ? 1 : 0) - this.ambient) * Math.min(1, dt / 700);
    this.rot += this.reduced ? 0 : dt * (IDLE_SPIN + BUSY_SPIN * this.ambient);
    // Le cœur suit l'orbe en douceur (une notification qui s'ajoute ne fait pas sauter la galaxie).
    if (Number.isNaN(this.cx)) {
      this.cx = orbX;
      this.cy = orbY;
    }
    const k = Math.min(1, dt / 300);
    this.cx += (orbX - this.cx) * k;
    this.cy += (orbY - this.cy) * k;
    this.galaxy ??= makeGalaxy(this.w, this.h);
    for (const n of this.galaxy.neurons) n.flash *= Math.exp(-dt / 380);
    this.growSteps(now);
    this.spawnPulses(now, before);

    // Au repos, sans rien qui bouge vite : 20 images par seconde suffisent.
    const calm = this.ambient < 0.02 && !this.nodes.size && !this.pulses.some((p) => p.to || (p.hops ?? 0) > 1);
    if (calm && now - this.lastDraw < 50) return;
    this.lastDraw = now;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = this.palette.light ? "source-over" : "lighter";
    this.drawGalaxy(now);
    this.drawAnchors(now);
    for (const n of this.nodes.values()) {
      const t = targetOf(n, this.cx, this.cy, this.w, this.h);
      if (Number.isNaN(n.x)) {
        // Naissance : un astre jaillit de l'orbe vers sa place (une étape y est déjà, l'influx la fait pousser).
        n.x = n.kind === "step" ? t.x : this.cx;
        n.y = n.kind === "step" ? t.y : this.cy;
      }
      const e = this.reduced ? 1 : Math.min(1, dt / 260);
      n.x += (t.x - n.x) * e;
      n.y += (t.y - n.y) * e;
    }
    for (const n of this.nodes.values()) this.drawLink(n, now);
    this.drawPulses(now);
    for (const n of this.nodes.values()) this.drawNode(n, now);
    ctx.globalCompositeOperation = "source-over";
    for (const n of this.nodes.values()) this.drawLabel(n, now);
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.w && h === this.h && this.canvas.width === Math.round(w * dpr)) return;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.galaxy = undefined;
    this.pulses = this.pulses.filter((p) => p.to);
  }

  /**
   * Étapes nouvelles : leur mère (la place au-dessus dans l'arbre, sinon
   * l'orbe) s'allume et leur envoie un influx ; elles apparaissent à son
   * arrivée, et lancent alors une cascade dans la galaxie.
   */
  private growSteps(now: number) {
    for (const n of this.nodes.values()) {
      if (n.kind !== "step") continue;
      if (n.arrive === undefined) {
        const t = targetOf(n, this.cx, this.cy, this.w, this.h);
        const mother = this.motherOf(n);
        const from = mother ?? this.orbEdge(t.x, t.y);
        if (mother) mother.flash = now;
        const travel = this.reduced ? 0 : clamp(Math.hypot(t.x - from.x, t.y - from.y) / STEP_SPEED, 220, 650);
        n.arrive = n.born + travel;
      }
      if (!n.fired && now >= n.arrive && n.leaving === undefined) {
        n.fired = true;
        this.cascadeAt(n.x, n.y, 6, 0.8, this.palette.step, now);
      }
    }
  }

  /** L'étape mère d'une étape : celle de la place au-dessus dans l'arbre, si elle est encore là. */
  private motherOf(n: NetNode): NetNode | undefined {
    const slot = treeParent(n.slot);
    if (slot < 0) return undefined;
    for (const m of this.nodes.values()) if (m.kind === "step" && m.slot === slot) return m;
    return undefined;
  }

  /** Le bord de l'orbe, dans la direction de (x, y). */
  private orbEdge(x: number, y: number): { x: number; y: number } {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const d = Math.hypot(dx, dy) || 1;
    const start = Math.min(CORE_RADIUS, d * 0.6);
    return { x: this.cx + (dx / d) * start, y: this.cy + (dy / d) * start };
  }

  /** Point du disque (rayon, angle) à l'écran : tourné, puis incliné. */
  private project(r: number, a: number, depth = 1): { x: number; y: number } {
    const t = a + this.rot * depth;
    return { x: this.cx + r * Math.cos(t), y: this.cy + r * Math.sin(t) * TILT };
  }

  /**
   * Influx : vers un astre qui naît (et une cascade dans la galaxie autour de
   * lui), en retour pour chaque étape faite, en continu tant qu'un travail
   * tourne ; et des cascades depuis le cœur de la galaxie, rares au repos,
   * serrées et longues quand Kopilia réfléchit.
   */
  private spawnPulses(now: number, before: Map<string, number>) {
    const g = this.galaxy!;
    // Fin d'un influx de la galaxie : le neurone d'arrivée s'allume et passe le relais.
    const arrived: Pulse[] = [];
    this.pulses = this.pulses.filter((p) => {
      if (now - p.born < p.dur) return true;
      if (p.b !== undefined) arrived.push(p);
      return false;
    });
    for (const p of arrived) {
      const n = g.neurons[p.b!];
      if (!n) continue;
      n.flash = 1;
      if (p.hops) this.fire(p.b!, p.a!, p.hops, p.fork ?? 0, p.color ?? this.palette.step, now, p.seen ?? new Set());
    }
    if (this.reduced) return;
    for (const n of this.nodes.values()) {
      if (n.leaving !== undefined || n.kind === "step") continue;
      const had = before.get(n.id);
      if (had === undefined) {
        this.pulses.push({ to: n.id, born: now, dur: 650 });
        this.cascadeAt(n.x, n.y, 5, 0.7, this.colorOf(n), now + 650);
      } else if (n.blocks.length > had) {
        this.pulses.push({ to: n.id, born: now + BLOCK_TRAVEL, dur: 750, inward: true });
        this.cascadeAt(n.x, n.y, 4, 0.6, this.colorOf(n), now);
      } else if (n.state === "running" && Math.random() < 0.012) {
        this.pulses.push({ to: n.id, born: now, dur: 900 + Math.random() * 600, inward: Math.random() < 0.4 });
      }
    }
    if (now > this.nextPulse && g.inner.length) {
      const busy = this.ambient > 0.5;
      const from = g.inner[Math.floor(Math.random() * g.inner.length)];
      const hops = busy ? 3 + Math.floor(Math.random() * 3) : 1 + (Math.random() < 0.3 ? 1 : 0);
      g.neurons[from].flash = 1;
      this.fire(from, -1, hops, busy ? 0.55 : 0.2, this.palette.step, now, new Set([from]));
      this.nextPulse = now + (1800 - 1500 * this.ambient) * (0.5 + Math.random());
    }
  }

  /** Une cascade qui part du neurone le plus proche de (x, y), à l'instant `at`. */
  private cascadeAt(x: number, y: number, hops: number, fork: number, color: string, at: number) {
    const g = this.galaxy;
    if (!g?.neurons.length || this.reduced) return;
    let best = 0;
    let bestD = Infinity;
    g.neurons.forEach((n, i) => {
      const p = this.project(n.r, n.a);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    });
    this.fire(best, -1, hops, fork, color, at, new Set([best]));
  }

  /**
   * Le neurone `i` déclenche un ou deux de ses voisins (deux avec la chance
   * `fork`), de préférence vers l'extérieur : l'activité rayonne du cœur vers
   * le bord. Chacun relaiera à son tour à l'arrivée, `hops` fois.
   */
  private fire(i: number, from: number, hops: number, fork: number, color: string, at: number, seen: Set<number>) {
    const g = this.galaxy!;
    if (hops <= 0 || this.pulses.length >= MAX_PULSES) return;
    const next = g.links[i].filter((j) => j !== from && !seen.has(j));
    if (!next.length) return;
    const r = (j: number) => g.neurons[j].r + (Math.random() - 0.5) * 120;
    next.sort((a, b) => r(b) - r(a));
    const a = this.project(g.neurons[i].r, g.neurons[i].a);
    for (const j of next.slice(0, Math.random() < fork ? 2 : 1)) {
      seen.add(j);
      const b = this.project(g.neurons[j].r, g.neurons[j].a);
      const dur = clamp(Math.hypot(b.x - a.x, b.y - a.y) / PULSE_SPEED, 160, 700);
      this.pulses.push({ a: i, b: j, born: at + 30, dur, hops: hops - 1, fork, seen, color });
    }
  }

  /** Nébuleuses, étoiles, puis la toile des neurones et leurs influx. */
  private drawGalaxy(now: number) {
    const g = this.galaxy!;
    const ctx = this.ctx;
    const p = this.palette;
    const lit = this.ambient;
    const base = this.presence;
    const hues = [p.step, p.agent, p.violet];

    // Nébuleuses : de grands voiles colorés qui tournent avec le disque.
    for (const n of g.nebulae) {
      const { x, y } = this.project(n.r, n.a, 0.6);
      this.glow(x, y, n.size, hues[n.hue], (0.08 + 0.08 * lit) * base, true);
    }
    // Cœur de la galaxie : un halo autour de l'orbe, plus vif quand il réfléchit.
    this.glow(this.cx, this.cy, 260 + 60 * lit, p.step, (0.06 + 0.14 * lit) * base, true);

    // Étoiles : les lointaines tournent moins vite (parallaxe) et scintillent.
    ctx.fillStyle = p.star;
    for (const s of g.stars) {
      const { x, y } = this.project(s.r, s.a, s.depth);
      if (x < -2 || y < -2 || x > this.w + 2 || y > this.h + 2) continue;
      const tw = this.reduced ? 0.7 : 0.45 + 0.55 * Math.sin(now / 900 + s.tw) ** 2;
      ctx.globalAlpha = Math.min(1, (0.6 + 0.35 * lit) * tw * base);
      ctx.fillRect(x - s.size / 2, y - s.size / 2, s.size, s.size);
    }
    ctx.globalAlpha = 1;

    // Toile : un seul tracé pour toutes les arêtes.
    const pts = g.neurons.map((n) => this.project(n.r, n.a));
    ctx.strokeStyle = rgba(p.step, (0.06 + 0.12 * lit) * base);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [i, j] of g.edges) {
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[j].x, pts[j].y);
    }
    ctx.stroke();

    // Neurones : un éclat qui scintille, et s'allume quand un influx arrive.
    g.neurons.forEach((n, i) => {
      const { x, y } = pts[i];
      if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) return;
      const tw = this.reduced ? 0.8 : 0.6 + 0.4 * Math.sin(now / 1100 + n.tw) ** 2;
      const a = ((0.3 + 0.45 * lit) * tw + 0.9 * n.flash) * base;
      this.glow(x, y, 7 + 13 * n.flash, hues[n.hue], a);
    });
  }

  /**
   * Fil de l'orbe à chaque encart du tableau de bord : discret, un peu plus
   * vif quand Kopilia réfléchit ; à l'ouverture, un influx y court jusqu'à
   * l'encart, qui garde une lueur à son bord.
   */
  private drawAnchors(now: number) {
    const ctx = this.ctx;
    const color = this.palette.task;
    for (const a of this.anchors.values()) {
      const age = now - a.born;
      const fade = a.leaving === undefined ? 1 : Math.max(0, 1 - (now - a.leaving) / ANCHOR_LEAVE_MS);
      const life = Math.min(1, age / 300) * fade * this.presence;
      if (life <= 0.003) continue;
      const g = anchorGeometry(a, this.cx, this.cy);
      ctx.strokeStyle = rgba(color, (0.14 + 0.12 * this.ambient) * life);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.sx, g.sy);
      ctx.quadraticCurveTo(g.mx, g.my, a.x, a.y);
      ctx.stroke();
      this.glow(a.x, a.y, 9, color, 0.35 * life);
      if (age < 700 && !this.reduced) {
        const t = age / 700;
        this.glow(quad(g.sx, g.mx, a.x, t), quad(g.sy, g.my, a.y, t), 10, color, life);
      }
    }
  }

  /**
   * Lien orbe -> nœud : une courbe légère, plus vive quand il travaille. Une
   * étape est reliée à sa mère (ou à l'orbe) d'un trait droit, qui pousse avec
   * l'influx jusqu'à elle.
   */
  private drawLink(n: NetNode, now: number) {
    const ctx = this.ctx;
    if (n.kind === "step") {
      const from = this.motherOf(n) ?? this.orbEdge(n.x, n.y);
      const arrive = n.arrive ?? n.born;
      const t = arrive > n.born ? clamp((now - n.born) / (arrive - n.born), 0, 1) : 1;
      const x = from.x + (n.x - from.x) * t;
      const y = from.y + (n.y - from.y) * t;
      const color = this.colorOf(n);
      ctx.strokeStyle = rgba(color, 0.32 * (t < 1 ? this.presence : this.life(n, now)));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      // L'influx en route, une étincelle en tête du trait.
      if (t < 1) this.glow(x, y, 10, color, this.presence);
      return;
    }
    const { sx, sy, mx, my } = linkGeometry(n, this.cx, this.cy);
    const color = this.colorOf(n);
    const life = this.life(n, now);
    const beat = n.state === "running" && !this.reduced ? 0.5 + 0.5 * Math.sin(now / 420 + n.slot) : 1;
    ctx.strokeStyle = rgba(color, (0.22 + 0.2 * beat) * life);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, n.x, n.y);
    ctx.stroke();
  }

  private drawPulses(now: number) {
    const g = this.galaxy!;
    for (const p of this.pulses) {
      if (now < p.born) continue;
      let t = (now - p.born) / p.dur;
      if (p.inward) t = 1 - t;
      if (p.to) {
        const n = this.nodes.get(p.to);
        if (!n) continue;
        const { sx, sy, mx, my } = linkGeometry(n, this.cx, this.cy);
        this.glow(quad(sx, mx, n.x, t), quad(sy, my, n.y, t), 9, this.colorOf(n), this.life(n, now));
      } else {
        const na = g.neurons[p.a ?? -1];
        const nb = g.neurons[p.b ?? -1];
        if (!na || !nb) continue;
        const a = this.project(na.r, na.a);
        const b = this.project(nb.r, nb.a);
        const color = p.color ?? this.palette.step;
        const alpha = (0.45 + 0.45 * this.ambient) * this.presence;
        // Une traînée derrière l'influx : on voit le chemin de la cascade.
        const tail = Math.max(0, t - 0.45);
        const ctx = this.ctx;
        ctx.strokeStyle = rgba(color, 0.7 * alpha);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(a.x + (b.x - a.x) * tail, a.y + (b.y - a.y) * tail);
        ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        ctx.stroke();
        this.glow(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 7, color, alpha);
      }
    }
  }

  private drawNode(n: NetNode, now: number) {
    const ctx = this.ctx;
    const life = this.life(n, now);
    const color = this.colorOf(n);
    // Naissance (pour une étape : à l'arrivée de l'influx) : il gonfle, dépasse un peu, se pose (« boum »).
    const age = now - (n.arrive ?? n.born);
    if (age < 0) return;
    const pop = this.reduced ? 1 : easeOutBack(Math.min(1, age / 420));
    const r = (n.kind === "step" ? 4.5 : 8.5) * pop;
    // Il vient d'en déclencher une autre : il s'allume, une onde part de lui.
    const lit = n.flash !== undefined && now >= n.flash && !this.reduced ? Math.exp(-(now - n.flash) / 320) : 0;
    if (lit > 0.05) {
      ctx.strokeStyle = rgba(color, 0.5 * lit * life);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3 + (1 - lit) * 16, 0, TAU);
      ctx.stroke();
    }

    // Onde de naissance, et de fin pour un travail terminé.
    const ring = n.leaving !== undefined && n.kind !== "step" ? (now - n.leaving) / 900 : age / 700;
    if (ring < 1 && !this.reduced) {
      ctx.strokeStyle = rgba(color, 0.55 * (1 - ring) * Math.min(1, life + 0.3));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 4 + ring * 30, 0, TAU);
      ctx.stroke();
    }

    const beat = n.state === "running" && !this.reduced ? 0.75 + 0.25 * Math.sin(now / 380 + n.slot * 1.7) : 1;
    this.glow(n.x, n.y, r * (4 + 2.5 * lit), color, (0.55 * beat + 0.45 * lit) * life);
    ctx.fillStyle = rgba(color, 0.95 * life);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, TAU);
    ctx.fill();

    if (n.kind !== "step") this.drawBlocks(n, now, color, life);
  }

  /**
   * Les étapes faites, en arborescence qui part de l'astre vers l'extérieur :
   * la première de lui, puis deux de chacune. Pour chaque nouvelle, la place
   * mère s'allume, un influx court jusqu'à elle et elle s'allume à son tour.
   * Au-delà de MAX_BLOCKS, les places resservent : le neurone se rallume.
   */
  private drawBlocks(n: NetNode, now: number, color: string, life: number) {
    const ctx = this.ctx;
    const count = Math.min(n.blocks.length, MAX_BLOCKS);
    if (!count) return;
    const first: number[] = [];
    const last: number[] = [];
    n.blocks.forEach((born, i) => {
      const k = i % MAX_BLOCKS;
      first[k] ??= born;
      last[k] = born;
    });
    const travel = this.reduced ? 0 : BLOCK_TRAVEL;
    const sway = this.reduced ? 0 : 0.07 * Math.sin(now / 1900 + n.slot);
    const out = Math.atan2(n.y - this.cy, n.x - this.cx) + sway;
    const pts = Array.from({ length: count }, (_, k) => blockSpot(k, n.x, n.y, out));
    const firing = (k: number) => (now >= last[k] && !this.reduced ? Math.exp(-(now - last[k]) / 300) : 0);
    // L'astre lui-même s'allume quand il déclenche la première place.
    const rootLit = firing(0);
    if (rootLit > 0.05) this.glow(n.x, n.y, 30, color, 0.5 * rootLit * life);
    for (let k = 0; k < count; k++) {
      const mother = treeParent(k);
      const from = mother < 0 ? { x: n.x, y: n.y } : pts[mother];
      const to = pts[k];
      // Le trait pousse avec le premier influx.
      const grow = travel ? clamp((now - first[k]) / travel, 0, 1) : 1;
      ctx.strokeStyle = rgba(color, 0.4 * life);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(from.x + (to.x - from.x) * grow, from.y + (to.y - from.y) * grow);
      ctx.stroke();
      // L'influx en route vers la place.
      const run = travel ? (now - last[k]) / travel : 1;
      if (run >= 0 && run < 1) this.glow(from.x + (to.x - from.x) * run, from.y + (to.y - from.y) * run, 8, color, life);
      // Le neurone : il apparaît à l'arrivée du premier influx, se rallume à chacun.
      const age = now - first[k] - travel;
      if (age < 0) continue;
      const pop = this.reduced ? 1 : easeOutBack(Math.min(1, age / 380));
      const since = now - last[k] - travel;
      const lit = since >= 0 && !this.reduced ? Math.exp(-since / 450) : 0;
      const kids = [2 * k + 1, 2 * k + 2].filter((c) => c < count).reduce((m, c) => Math.max(m, firing(c)), 0);
      this.glow(to.x, to.y, (6 + 8 * Math.max(lit, kids)) * pop, color, (0.45 + 0.55 * Math.max(lit, kids)) * life);
      ctx.fillStyle = rgba(color, 0.9 * life);
      ctx.beginPath();
      ctx.arc(to.x, to.y, 2.3 * pop, 0, TAU);
      ctx.fill();
    }
  }

  private drawLabel(n: NetNode, now: number) {
    const ctx = this.ctx;
    const life = this.life(n, now);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const below = n.kind === "step" ? 9 : 27;
    const name = n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name;
    ctx.font = `${n.kind === "step" ? 11 : 12}px ${SYSTEM_FONT}`;
    ctx.fillStyle = rgba(n.kind === "step" ? this.palette.muted : this.palette.text, (n.kind === "step" ? 0.85 : 0.92) * life);
    ctx.fillText(name, n.x, n.y + below);
    if (n.kind === "step") return;
    ctx.font = `11px ${SYSTEM_FONT}`;
    ctx.fillStyle = rgba(this.palette.muted, 0.9 * life);
    ctx.fillText(metaOf(n), n.x, n.y + below + 15);
  }

  /** Halo pré-rendu (une image par couleur), bien plus rapide qu'un dégradé par point. */
  private glow(x: number, y: number, radius: number, color: string, alpha: number, soft = false) {
    if (alpha <= 0.003) return;
    const key = `${color}${soft ? ":soft" : ""}`;
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = 64;
      const g = sprite.getContext("2d")!;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      if (soft) {
        grad.addColorStop(0, rgba(color, 1));
        grad.addColorStop(0.5, rgba(color, 0.35));
      } else {
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.12, rgba(color, 1));
        grad.addColorStop(0.35, rgba(color, 0.3));
      }
      grad.addColorStop(1, rgba(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this.sprites.set(key, sprite);
    }
    this.ctx.globalAlpha = Math.min(1, alpha);
    this.ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
    this.ctx.globalAlpha = 1;
  }

  /** Opacité : pleine en vie, puis elle tombe pendant le départ. */
  private life(n: NetNode, now: number): number {
    const fadeIn = clamp((now - (n.arrive ?? n.born)) / 250, 0, 1);
    if (n.leaving === undefined) return fadeIn * this.presence;
    // Un travail terminé reste vif le temps de son clignotement, puis s'efface.
    const hold = n.kind === "step" ? 0 : 900;
    const t = Math.max(0, now - n.leaving - hold) / (LEAVE_MS - hold);
    return fadeIn * this.presence * Math.max(0, 1 - t);
  }

  private colorOf(n: NetNode): string {
    if (n.outcome === "ok") return this.palette.ok;
    if (n.outcome === "fail") return this.palette.danger;
    if (n.state === "awaiting_approval") return this.palette.warn;
    return n.kind === "agent" ? this.palette.agent : n.kind === "task" ? this.palette.task : this.palette.step;
  }
}

/** « 3 étapes · Recherche web », « En attente d'accord », « Terminé ». */
export function metaOf(n: Pick<NetNode, "kind" | "state" | "blocks" | "lastStep" | "outcome">): string {
  if (n.outcome === "ok") return "Terminé";
  if (n.outcome === "fail") return n.state === "cancelled" ? "Annulé" : "Échec";
  if (n.state === "awaiting_approval") return "En attente d'accord";
  const who = n.kind === "agent" ? "Agent" : "Tâche";
  if (!n.blocks.length) return `${who} · démarrage`;
  const steps = `${n.blocks.length} étape${n.blocks.length > 1 ? "s" : ""}`;
  return n.lastStep ? `${steps} · ${n.lastStep}` : `${who} · ${steps}`;
}

/** Départ du lien au bord de l'orbe, et point de contrôle qui le courbe un peu. */
function linkGeometry(n: NetNode, cx: number, cy: number) {
  const dx = n.x - cx;
  const dy = n.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  const start = Math.min(CORE_RADIUS, d * 0.6);
  const sx = cx + (dx / d) * start;
  const sy = cy + (dy / d) * start;
  const bend = (n.slot % 2 ? 1 : -1) * Math.min(60, d * 0.15);
  const mx = (sx + n.x) / 2 + (-dy / d) * bend;
  const my = (sy + n.y) / 2 + (dx / d) * bend;
  return { sx, sy, mx, my };
}

/** Départ du fil d'un encart au bord de l'orbe, courbé vers le haut ou le bas selon le côté. */
function anchorGeometry(a: { x: number; y: number }, cx: number, cy: number) {
  const dx = a.x - cx;
  const dy = a.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  const start = Math.min(CORE_RADIUS, d * 0.6);
  const sx = cx + (dx / d) * start;
  const sy = cy + (dy / d) * start;
  const bend = (dy < 0 ? -1 : 1) * Math.min(50, d * 0.12);
  return { sx, sy, mx: (sx + a.x) / 2 + (-dy / d) * bend, my: (sy + a.y) / 2 + (dx / d) * bend };
}

/** Une galaxie qui remplit l'écran : ciel d'étoiles, bras de neurones, nébuleuses. */
function makeGalaxy(w: number, h: number): Galaxy {
  // Assez grande pour couvrir les coins une fois le disque incliné.
  const maxR = Math.hypot(w / 2, h / (2 * TILT)) * 1.05;
  const stars = Array.from({ length: clamp(Math.round((w * h) / 2600), 160, 800) }, () => ({
    r: maxR * Math.sqrt(Math.random()),
    a: Math.random() * TAU,
    size: Math.random() < 0.08 ? 2 : Math.random() < 0.45 ? 1.4 : 1,
    tw: Math.random() * TAU,
    depth: 0.25 + Math.random() * 0.5,
  }));
  const neurons: Galaxy["neurons"] = [];
  const count = clamp(Math.round((w * h) / 8500), 70, 200);
  for (let i = 0; i < count; i++) {
    // Surtout le long des bras spiraux ; quelques-uns épars.
    const scattered = Math.random() < 0.18;
    const t = scattered ? Math.sqrt(Math.random()) : Math.random() ** 0.85;
    const r = CORE_RADIUS + 40 + t * (maxR * 0.92 - CORE_RADIUS - 40);
    const a = scattered ? Math.random() * TAU : ((i % ARMS) * TAU) / ARMS + t * TWIST + gauss() * 0.3;
    neurons.push({ r, a, tw: Math.random() * TAU, flash: 0, hue: Math.random() < 0.68 ? 0 : Math.random() < 0.55 ? 1 : 2 });
  }
  // Chaque neurone est relié à ses deux plus proches voisins (dans le plan du disque).
  const pos = neurons.map((n) => ({ x: n.r * Math.cos(n.a), y: n.r * Math.sin(n.a) }));
  const edges: Galaxy["edges"] = [];
  const known = new Set<string>();
  pos.forEach((p, i) => {
    const near = pos
      .map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) }))
      .filter((o) => o.j !== i && o.d < maxR * 0.3)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const { j } of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!known.has(key)) {
        known.add(key);
        edges.push([i, j]);
      }
    }
  });
  const links: number[][] = neurons.map(() => []);
  for (const [i, j] of edges) {
    links[i].push(j);
    links[j].push(i);
  }
  const inner = neurons.flatMap((n, i) => (n.r < maxR * 0.35 && links[i].length ? [i] : []));
  const nebulae: Galaxy["nebulae"] = [0, 1, 2].map((k) => ({
    r: maxR * (0.16 + 0.12 * k),
    a: (k * TAU) / 3 + 0.6,
    size: maxR * (0.55 - 0.1 * k),
    hue: k as 0 | 1 | 2,
  }));
  return { maxR, stars, neurons, edges, links, inner, nebulae };
}

function readPalette(): Palette {
  const v = cssVar;
  const light = isLight();
  return {
    agent: v("--accent-2", "#38d39f"),
    task: v("--accent", "#5b8cff"),
    step: v("--accent", "#5b8cff"),
    violet: light ? "#7357e0" : "#9b7bff",
    warn: v("--warn", "#ffb454"),
    danger: v("--danger", "#ff6b6b"),
    ok: v("--accent-2", "#38d39f"),
    text: v("--text", "#e8eaed"),
    muted: v("--muted", "#9aa0ab"),
    star: light ? "#5c636e" : "#dfe6ff",
    light,
  };
}

/** Couleur avec opacité : définie avec le thème (gardée ici pour les tests de la galaxie). */
export { rgba };

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Loi à peu près normale, centrée (écart type ~0,6). */
function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
}

function quad(a: number, c: number, b: number, t: number): number {
  return (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
}

function easeOutBack(t: number): number {
  const c = 1.9;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}
