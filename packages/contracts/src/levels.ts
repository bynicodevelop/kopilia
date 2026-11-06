import { type Ohlc, rsi, smma, sourceValues } from "./technical.js";

/**
 * Carte technique automatique : supports et résistances (zones), obliques et
 * divergences du RSI, repérés sur les bougies par des règles simples et
 * déterministes. C'est un premier jet : une IA le relit et le corrige, d'où les
 * extrêmes bruts renvoyés à côté des estimations. Mêmes calculs à l'écran et au
 * serveur ; fonctions pures, bougies triées des plus anciennes aux plus récentes.
 */

/** Une bougie datée : son instant d'ouverture (epoch s, UTC) et ses prix. */
export interface OhlcBar extends Ohlc {
  t: number;
}

/** Un point du graphique : la position de la bougie (indice), son instant et un prix. */
export interface BarPoint {
  i: number;
  t: number;
  price: number;
}

/** Un sommet (`price` = plus haut) ou un creux (`price` = plus bas) confirmé. */
export interface Pivot extends BarPoint {
  kind: "high" | "low";
}

/** Bougies comparées de part et d'autre d'un sommet ou d'un creux. */
export interface PivotOptions {
  left?: number;
  right?: number;
}

/* ---------------------------------- ATR ---------------------------------- */

/**
 * Average True Range de Wilder : l'étendue vraie (plus haut − plus bas, écart
 * avec la clôture précédente compris) lissée à 1 / période, comme TradingView ;
 * la première bougie n'a que son étendue. NaN tant qu'il manque des bougies.
 * C'est l'unité de mesure des tolérances de ce module : elle suit la volatilité
 * du produit et de l'unité de temps.
 */
export function atr(bars: readonly Ohlc[], period = 14): number[] {
  const ranges = bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const prev = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
  return smma(ranges, period);
}

/** L'ATR sur la dernière bougie, ou NaN. */
function lastAtr(bars: readonly Ohlc[], period: number): number {
  const series = atr(bars, period);
  return series.length ? series[series.length - 1] : NaN;
}

/* ------------------------------ Pivots ------------------------------ */

/**
 * Sommets et creux (fractales) : un plus haut strictement au-dessus des `left`
 * précédents et au moins égal aux `right` suivants (l'inverse pour un creux).
 * L'inégalité large à droite garde un seul pivot sur un double sommet exact :
 * le premier. Les `right` dernières bougies ne sont pas encore confirmées ; une
 * bougie qui englobe ses voisines peut être sommet et creux à la fois. Triés
 * par position.
 */
export function pivots(bars: readonly OhlcBar[], left = 3, right = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const b = bars[i];
    let high = true;
    let low = true;
    for (let j = i - left; j <= i + right && (high || low); j++) {
      if (j === i) continue;
      const o = bars[j];
      if (j < i ? o.h >= b.h : o.h > b.h) high = false;
      if (j < i ? o.l <= b.l : o.l < b.l) low = false;
    }
    if (high) out.push({ i, t: b.t, kind: "high", price: b.h });
    if (low) out.push({ i, t: b.t, kind: "low", price: b.l });
  }
  return out;
}

/* ------------------------------- Zones ------------------------------- */

export interface AutoZoneOptions extends PivotOptions {
  atrPeriod?: number;
  /** Écart de prix, en ATR, sous lequel deux pivots désignent le même niveau. */
  tolerance?: number;
  /** Zones au plus. */
  max?: number;
  /** Âge (en bougies) auquel un contact ne compte plus que pour moitié dans le score. */
  halfLife?: number;
}

/** Rôle d'une zone par rapport à la dernière clôture. */
export type ZoneRole = "support" | "resistance" | "inside";

/** Une zone de support ou de résistance repérée sur les pivots. */
export interface AutoZone {
  /** Identifiant stable d'un calcul à l'autre tant que la zone bouge peu (« z:110.5 »). */
  key: string;
  /** Estimation de la zone : médianes des bords de corps et des extrêmes de mèche. */
  top: number;
  bottom: number;
  /** Enveloppe brute des contacts (mèches et corps), pour corriger l'estimation. */
  wickTop: number;
  wickBottom: number;
  /** Pivots qui la touchent. */
  touches: number;
  /** Instants du premier et du dernier contact. */
  first: number;
  last: number;
  role: ZoneRole;
  /** Contacts pondérés par la fraîcheur (un contact récent compte 1, puis moitié moins par `halfLife` bougies). */
  score: number;
}

/** Un pivot et ce qu'il apporte à une zone : [bord du corps, extrême de la mèche], et son poids. */
interface Contact {
  pivot: Pivot;
  lo: number;
  hi: number;
  weight: number;
}

/**
 * Zones de support et de résistance. Les pivots, sommets et creux ensemble (un
 * ancien support devient résistance), sont regroupés par prix : le pivot qui a
 * le plus de voisins à moins de `tolerance` × ATR (de la dernière bougie) prend
 * ses voisins, puis on recommence avec ceux qui restent. Le groupe est ainsi
 * centré sur le prix le plus visité, et un pivot lointain ne déplace pas les
 * autres groupes. Chaque pivot apporte [max(o, c), h] pour un sommet, [l, min(o,
 * c)] pour un creux ; la zone va de la médiane des bas à la médiane des hauts.
 * Estimation volontairement simple, qui peut couper des mèches. Seuls les
 * groupes d'au moins deux pivots restent ; les zones qui se chevauchent sont
 * fusionnées. Les meilleurs scores d'abord.
 */
export function autoZones(bars: readonly OhlcBar[], opts: AutoZoneOptions = {}): AutoZone[] {
  const n = bars.length;
  const unit = lastAtr(bars, opts.atrPeriod ?? 14);
  if (!(unit > 0)) return [];
  const tol = (opts.tolerance ?? 0.5) * unit;
  const halfLife = opts.halfLife ?? 100;
  const contacts = pivots(bars, opts.left, opts.right).map((p): Contact => {
    const b = bars[p.i];
    const weight = 0.5 ** ((n - 1 - p.i) / halfLife);
    return p.kind === "high" ? { pivot: p, lo: Math.max(b.o, b.c), hi: b.h, weight } : { pivot: p, lo: b.l, hi: Math.min(b.o, b.c), weight };
  });
  const groups = mergeOverlaps(groupByPrice(contacts, tol).filter((g) => g.length >= 2));
  const close = bars[n - 1].c;
  const step = niceStep(unit / 4);
  const zones = groups
    .map((g) => ({ g, ...bounds(g) }))
    .sort((a, b) => a.bottom + a.top - (b.bottom + b.top))
    .map(({ g, top, bottom }): AutoZone => ({
      key: `z:${roundTo((top + bottom) / 2, step)}`,
      top,
      bottom,
      wickTop: Math.max(...g.map((c) => c.hi)),
      wickBottom: Math.min(...g.map((c) => c.lo)),
      touches: g.length,
      first: Math.min(...g.map((c) => c.pivot.t)),
      last: Math.max(...g.map((c) => c.pivot.t)),
      role: close > top ? "support" : close < bottom ? "resistance" : "inside",
      score: g.reduce((s, c) => s + c.weight, 0),
    }));
  // Deux zones distinctes au même milieu arrondi (rare) : la plus haute prend un suffixe.
  const seen = new Map<string, number>();
  for (const z of zones) {
    const k = (seen.get(z.key) ?? 0) + 1;
    seen.set(z.key, k);
    if (k > 1) z.key = `${z.key}:${k}`;
  }
  return zones.sort((a, b) => b.score - a.score || b.last - a.last || a.bottom - b.bottom).slice(0, opts.max ?? 8);
}

/** Regroupement par prix autour des pivots les plus entourés (voir `autoZones`). */
function groupByPrice(contacts: readonly Contact[], tol: number): Contact[][] {
  let rest = [...contacts].sort((a, b) => a.pivot.price - b.pivot.price || a.pivot.i - b.pivot.i);
  const groups: Contact[][] = [];
  while (rest.length) {
    // Fenêtre glissante sur les prix triés : voisins (et leur poids) de chaque pivot.
    let lo = 0;
    let hi = 0;
    let weight = 0;
    let best = { j: 0, count: -1, weight: -1 };
    for (let j = 0; j < rest.length; j++) {
      const p = rest[j].pivot.price;
      while (hi < rest.length && rest[hi].pivot.price <= p + tol) weight += rest[hi++].weight;
      while (rest[lo].pivot.price < p - tol) weight -= rest[lo++].weight;
      const count = hi - lo;
      // Le plus de voisins ; à égalité, les plus récents (poids), puis le pivot le plus récent.
      const dw = weight - best.weight;
      if (count > best.count || (count === best.count && (dw > 1e-9 || (dw > -1e-9 && rest[j].pivot.i > rest[best.j].pivot.i)))) best = { j, count, weight };
    }
    const center = rest[best.j].pivot.price;
    groups.push(rest.filter((c) => Math.abs(c.pivot.price - center) <= tol));
    rest = rest.filter((c) => Math.abs(c.pivot.price - center) > tol);
  }
  return groups;
}

/** Fusionne les groupes dont les zones se chevauchent (ou se touchent), jusqu'à ce qu'il n'y en ait plus. */
function mergeOverlaps(groups: Contact[][]): Contact[][] {
  let current = groups;
  for (;;) {
    const sorted = current.map((g) => ({ g, ...bounds(g) })).sort((a, b) => a.bottom - b.bottom || a.top - b.top);
    const merged: Contact[][] = [];
    let top = -Infinity;
    for (const z of sorted) {
      if (merged.length && z.bottom <= top) {
        merged[merged.length - 1] = [...merged[merged.length - 1], ...z.g];
        top = Math.max(top, z.top);
      } else {
        merged.push(z.g);
        top = z.top;
      }
    }
    if (merged.length === current.length) return merged;
    current = merged;
  }
}

/** La zone d'un groupe : médiane des bas, médiane des hauts. */
function bounds(g: readonly Contact[]): { top: number; bottom: number } {
  return { top: median(g.map((c) => c.hi)), bottom: median(g.map((c) => c.lo)) };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Le plus grand pas « rond » (1, 2 ou 5 × 10ⁿ) qui ne dépasse pas `x`. Arrondir
 * la clé à un pas rond, plutôt qu'au quart d'ATR exact, la garde identique
 * quand l'ATR varie un peu d'une bougie à l'autre.
 */
function niceStep(x: number): number {
  const pow = 10 ** Math.floor(Math.log10(x));
  const m = x / pow;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow;
}

/** `x` arrondi au pas `step`, écrit sans bruit de virgule flottante (« 110.5 »). */
function roundTo(x: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return (Math.round(x / step) * step).toFixed(decimals);
}

/* ------------------------------- Obliques ------------------------------- */

export interface AutoTrendlineOptions extends PivotOptions {
  atrPeriod?: number;
  /** Distance à la droite, en ATR, d'un contact ; et dépassement toléré d'une clôture. */
  tolerance?: number;
  /** Derniers pivots de chaque sorte parmi lesquels choisir les deux points d'une oblique. */
  pivotsPerKind?: number;
  /** Contacts au moins (les deux points compris). */
  minTouches?: number;
  /** Obliques au plus, par sorte. */
  max?: number;
}

/** Une oblique : support montant (par les creux) ou résistance descendante (par les sommets). */
export interface AutoTrendline {
  /** Identifiant : sorte et instants des deux points (« s:1730000000-1730090000 »). */
  key: string;
  kind: "support" | "resistance";
  a: BarPoint;
  b: BarPoint;
  /** Pente, en prix par bougie (positions, pas temps : les interruptions ne comptent pas). */
  slope: number;
  /** Pivots du même genre près de la droite, à partir de `a`. */
  touches: number;
  /** Instant du dernier contact. */
  last: number;
  /** Prix de la droite à la dernière bougie. */
  priceNow: number;
}

/**
 * Obliques : chaque paire de creux montants (de sommets descendants) parmi les
 * `pivotsPerKind` derniers donne une droite, en position de bougie. Elle compte
 * les pivots du même genre, à partir du premier point, à moins de `tolerance` ×
 * ATR ; elle est rejetée si une clôture, du premier point à la dernière bougie,
 * passe au-delà de plus de cette tolérance (dessous pour un support, dessus
 * pour une résistance) : une oblique cassée ne sert plus. Les mèches peuvent la
 * percer. Les meilleures d'abord (contacts, puis dernier contact, puis la plus
 * ajustée), sans doublons quasi identiques (même prix, à la tolérance près, au
 * premier point et à la dernière bougie).
 */
export function autoTrendlines(bars: readonly OhlcBar[], opts: AutoTrendlineOptions = {}): AutoTrendline[] {
  const n = bars.length;
  const unit = lastAtr(bars, opts.atrPeriod ?? 14);
  if (!(unit > 0)) return [];
  const tol = (opts.tolerance ?? 0.3) * unit;
  const all = pivots(bars, opts.left, opts.right);
  const out: AutoTrendline[] = [];
  for (const kind of ["support", "resistance"] as const) {
    const side = kind === "support" ? 1 : -1;
    const cands = all.filter((p) => p.kind === (kind === "support" ? "low" : "high")).slice(-(opts.pivotsPerKind ?? 12));
    const lines: (AutoTrendline & { fit: number })[] = [];
    for (let x = 0; x < cands.length; x++) {
      for (let y = x + 1; y < cands.length; y++) {
        const [pa, pb] = [cands[x], cands[y]];
        const slope = (pb.price - pa.price) / (pb.i - pa.i);
        if (slope * side <= 0) continue;
        const at = (i: number) => pa.price + slope * (i - pa.i);
        const touching = cands.filter((p) => p.i >= pa.i && Math.abs(p.price - at(p.i)) <= tol);
        if (touching.length < (opts.minTouches ?? 3)) continue;
        let broken = false;
        for (let i = pa.i; i < n && !broken; i++) broken = (at(i) - bars[i].c) * side > tol;
        if (broken) continue;
        lines.push({
          key: `${kind === "support" ? "s" : "r"}:${pa.t}-${pb.t}`,
          kind,
          a: { i: pa.i, t: pa.t, price: pa.price },
          b: { i: pb.i, t: pb.t, price: pb.price },
          slope,
          touches: touching.length,
          last: touching[touching.length - 1].t,
          priceNow: at(n - 1),
          fit: touching.reduce((s, p) => s + Math.abs(p.price - at(p.i)), 0),
        });
      }
    }
    lines.sort((p, q) => q.touches - p.touches || q.last - p.last || p.fit - q.fit || q.b.i - q.a.i - (p.b.i - p.a.i) || p.a.i - q.a.i);
    const kept: AutoTrendline[] = [];
    for (const { fit: _, ...line } of lines) {
      if (kept.length >= (opts.max ?? 2)) break;
      if (!kept.some((k) => sameLine(k, line, tol))) kept.push(line);
    }
    out.push(...kept);
  }
  return out.sort((p, q) => q.touches - p.touches || q.last - p.last);
}

/** Deux obliques au même prix, à la tolérance près, au premier de leurs points et à la dernière bougie. */
function sameLine(p: AutoTrendline, q: AutoTrendline, tol: number): boolean {
  const start = Math.min(p.a.i, q.a.i);
  const at = (l: AutoTrendline, i: number) => l.a.price + l.slope * (i - l.a.i);
  return Math.abs(at(p, start) - at(q, start)) <= tol && Math.abs(p.priceNow - q.priceNow) <= tol;
}

/* ------------------------------ Divergences ------------------------------ */

export interface RsiDivergenceOptions extends PivotOptions {
  /** Bougies, en partant de la dernière, où chercher les deux pivots. */
  lookback?: number;
  /** Période du RSI (sur la clôture). */
  period?: number;
  /** Écart de RSI au moins, en points : en dessous, ce n'est que du bruit de lissage. */
  minRsiGap?: number;
}

/** Un pivot d'une divergence, avec le RSI de sa bougie. */
export interface DivergencePoint extends BarPoint {
  rsi: number;
}

/** Divergence classique entre le prix et le RSI, sur deux pivots consécutifs du même genre. */
export interface RsiDivergence {
  /** Haussière : creux plus bas du prix, RSI plus haut ; baissière : sommet plus haut, RSI plus bas. */
  kind: "bullish" | "bearish";
  from: DivergencePoint;
  to: DivergencePoint;
}

/**
 * Divergences classiques du RSI de Wilder (sur la clôture) : entre deux creux
 * consécutifs des `lookback` dernières bougies, le prix fait plus bas et le RSI
 * plus haut (haussière) ; entre deux sommets consécutifs, le prix fait plus
 * haut et le RSI plus bas (baissière). Le RSI est celui des bougies des pivots,
 * calculé sur toutes les bougies pour être amorcé. Les plus récentes d'abord.
 */
export function rsiDivergences(bars: readonly OhlcBar[], opts: RsiDivergenceOptions = {}): RsiDivergence[] {
  const n = bars.length;
  const r = rsi(sourceValues(bars, "close"), opts.period ?? 14);
  const gap = opts.minRsiGap ?? 1;
  const recent = pivots(bars, opts.left, opts.right).filter((p) => p.i >= n - (opts.lookback ?? 60) && Number.isFinite(r[p.i]));
  const point = (p: Pivot): DivergencePoint => ({ i: p.i, t: p.t, price: p.price, rsi: r[p.i] });
  const out: RsiDivergence[] = [];
  for (const kind of ["low", "high"] as const) {
    const list = recent.filter((p) => p.kind === kind);
    for (let k = 1; k < list.length; k++) {
      const [p, q] = [list[k - 1], list[k]];
      if (kind === "low" && q.price < p.price && r[q.i] - r[p.i] >= gap) out.push({ kind: "bullish", from: point(p), to: point(q) });
      if (kind === "high" && q.price > p.price && r[p.i] - r[q.i] >= gap) out.push({ kind: "bearish", from: point(p), to: point(q) });
    }
  }
  return out.sort((a, b) => b.to.i - a.to.i || b.from.i - a.from.i);
}

/* ------------------------------ Carte complète ------------------------------ */

export interface AutoMapOptions {
  /** Période de l'ATR, unité des tolérances (zones et obliques, sauf réglage propre). */
  atrPeriod?: number;
  zones?: AutoZoneOptions;
  trendlines?: AutoTrendlineOptions;
  divergences?: RsiDivergenceOptions;
}

/** La carte technique d'un graphique. */
export interface AutoMap {
  /** ATR sur la dernière bougie (NaN s'il manque des bougies). */
  atr: number;
  zones: AutoZone[];
  trendlines: AutoTrendline[];
  divergences: RsiDivergence[];
}

/** Zones, obliques et divergences d'un coup ; des listes vides s'il y a trop peu de bougies. */
export function autoMap(bars: readonly OhlcBar[], opts: AutoMapOptions = {}): AutoMap {
  const atrPeriod = opts.atrPeriod ?? 14;
  return {
    atr: lastAtr(bars, atrPeriod),
    zones: autoZones(bars, { atrPeriod, ...opts.zones }),
    trendlines: autoTrendlines(bars, { atrPeriod, ...opts.trendlines }),
    divergences: rsiDivergences(bars, opts.divergences),
  };
}
