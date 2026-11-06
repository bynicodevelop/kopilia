import { Drawing, DrawingAnchor, barPosition } from "@kopilia/contracts";

/*
 * Deux niveaux sont-ils le même ? Une zone et une ligne horizontale se
 * comparent en prix (elles se chevauchent, ou presque) ; deux obliques, par
 * leur tracé prolongé. Sert à ce que la carte automatique s'efface derrière
 * les tracés de l'utilisateur, et que l'IA ne trace jamais par-dessus. Pur.
 */

/** Une bande de prix ; une ligne horizontale a son bas égal à son haut. */
export interface PriceBand {
  lo: number;
  hi: number;
}

/** Une bande qui reprend les bornes d'une zone, à un dixième de sa largeur près : c'est la même zone (pas une autre, voisine). */
export function sameBounds(a: PriceBand, b: PriceBand): boolean {
  const tol = Math.max(0.1 * Math.max(a.hi - a.lo, b.hi - b.lo), 1e-9 * Math.abs(b.hi));
  return Math.abs(a.hi - b.hi) <= tol && Math.abs(a.lo - b.lo) <= tol;
}

/** Une oblique, par deux points (instant de bougie en secondes, prix). */
export interface Line {
  a: DrawingAnchor;
  b: DrawingAnchor;
}

/** La bande d'un tracé horizontal : une ligne, ou une zone encore valable à `nowS` (epoch s) ; rien pour une oblique. */
export function bandOfDrawing(d: Drawing, nowS: number): PriceBand | undefined {
  if (d.kind === "hline") return { lo: d.price, hi: d.price };
  if (d.kind === "zone") return d.to !== undefined && d.to < nowS ? undefined : { lo: Math.min(d.top, d.bottom), hi: Math.max(d.top, d.bottom) };
  return undefined;
}

/** L'oblique d'un tracé (pas une verticale). */
export function lineOfDrawing(d: Drawing): Line | undefined {
  return d.kind === "trendline" && d.a.t !== d.b.t ? { a: d.a, b: d.b } : undefined;
}

/** Deux bandes sont le même niveau si elles se chevauchent ou sont à moins de `tol` l'une de l'autre. */
export function sameBand(a: PriceBand, b: PriceBand, tol: number): boolean {
  return a.lo <= b.hi + tol && b.lo <= a.hi + tol;
}

/**
 * Deux obliques sont la même si, prolongées, elles passent à moins de `tol`
 * l'une de l'autre à la dernière bougie, et à moins du double là où la plus
 * récente commence (même pente, à peu près). Les positions sont celles des
 * bougies (`times`, unité `tf` secondes), comme à l'écran.
 */
export function sameLine(p: Line, q: Line, times: readonly number[], tf: number, tol: number): boolean {
  if (!times.length || p.a.t === p.b.t || q.a.t === q.b.t) return false;
  const pos = (t: number) => barPosition(times, t, tf);
  const at = (l: Line, x: number) => {
    const xa = pos(l.a.t);
    const xb = pos(l.b.t);
    return l.a.price + ((l.b.price - l.a.price) * (x - xa)) / (xb - xa);
  };
  const last = times.length - 1;
  const start = Math.max(Math.min(pos(p.a.t), pos(p.b.t)), Math.min(pos(q.a.t), pos(q.b.t)));
  return Math.abs(at(p, last) - at(q, last)) <= tol && Math.abs(at(p, start) - at(q, start)) <= 2 * tol;
}

/** Le tracé de cette liste qui est le même niveau que `level` (bande ou oblique), s'il y en a un. */
export function sameLevelIn(
  level: { band?: PriceBand; line?: Line },
  drawings: readonly Drawing[],
  ctx: { tol: number; times: readonly number[]; tf: number; nowS: number },
): Drawing | undefined {
  return drawings.find((d) => {
    const band = bandOfDrawing(d, ctx.nowS);
    if (level.band && band) return sameBand(level.band, band, ctx.tol);
    const line = lineOfDrawing(d);
    if (level.line && line) return sameLine(level.line, line, ctx.times, ctx.tf, ctx.tol);
    return false;
  });
}
