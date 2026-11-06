import { z } from "zod";

/**
 * Analyse technique : les indicateurs d'un graphique et les tracés d'un
 * produit, leur forme et leurs calculs. Partagés par l'écran, qui les dessine,
 * et par le serveur, qui les décrit à Kopilia et les surveillera (alertes) : les
 * deux voient les mêmes valeurs. Fonctions pures.
 */

/* ------------------------------ Indicateurs ------------------------------ */

/** Moyennes mobiles : simple, exponentielle, pondérée, lissée (Wilder, RMA), de Hull. */
export const MA_TYPES = ["sma", "ema", "wma", "smma", "hma"] as const;
export type MaType = (typeof MA_TYPES)[number];

/** Le prix d'une bougie sur lequel se calcule un indicateur. */
export const PRICE_SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** Couleurs proposées pour un indicateur (leur teinte exacte suit le thème, sombre ou clair). */
export const INDICATOR_COLORS = ["orange", "violet", "cyan", "pink", "green", "yellow", "blue", "red", "gray"] as const;
export type IndicatorColor = (typeof INDICATOR_COLORS)[number];

/** Ce qui se règle sur tout indicateur : couleur (sinon une couleur selon son rang), épaisseur, masqué. */
const indicatorStyle = {
  /** Identifiant stable dans le graphique : on le règle, on le retire (et une alerte s'y rattachera). */
  id: z.string().min(1).max(24),
  color: z.enum(INDICATOR_COLORS).optional(),
  /** Épaisseur du trait, de 1 à 4. */
  width: z.number().int().min(1).max(4).optional(),
  /** Masqué : gardé avec ses réglages, ni tracé ni calculé à l'écran. */
  hidden: z.boolean().optional(),
};

/** Moyenne mobile, tracée sur les bougies. */
export const maSchema = z.object({
  kind: z.literal("ma"),
  type: z.enum(MA_TYPES),
  /** Longueur, en bougies. */
  period: z.number().int().min(1).max(500),
  source: z.enum(PRICE_SOURCES),
  ...indicatorStyle,
});

/** RSI de Wilder, dans son bandeau sous les bougies : seuils de surachat et de survente, et sa moyenne (facultative). */
export const rsiSchema = z.object({
  kind: z.literal("rsi"),
  period: z.number().int().min(2).max(200),
  source: z.enum(PRICE_SOURCES),
  overbought: z.number().min(50).max(100),
  oversold: z.number().min(0).max(50),
  /** Moyenne du RSI (ligne de signal), tracée dans le même bandeau. */
  signal: z.object({ type: z.enum(MA_TYPES), period: z.number().int().min(1).max(200) }).optional(),
  ...indicatorStyle,
});

export const indicatorSchema = z.discriminatedUnion("kind", [maSchema, rsiSchema]);
export type Indicator = z.infer<typeof indicatorSchema>;
export type MovingAverage = z.infer<typeof maSchema>;
export type RsiIndicator = z.infer<typeof rsiSchema>;
export type IndicatorKind = Indicator["kind"];

/**
 * Un indicateur tel qu'on le demande (à la souris, à la voix) : seul le genre
 * est obligatoire, le reste prend les réglages d'usage (`completeIndicator`).
 * `sma`, `ema`… comme genre : la moyenne de ce type.
 */
export const indicatorInputSchema = z.object({
  kind: z.enum(["ma", "rsi", ...MA_TYPES]),
  type: z.enum(MA_TYPES).optional(),
  period: z.number().int().optional(),
  source: z.enum(PRICE_SOURCES).optional(),
  overbought: z.number().optional(),
  oversold: z.number().optional(),
  signal: z
    .object({ type: z.enum(MA_TYPES), period: z.number().int() })
    .nullable()
    .optional(),
  color: z.enum(INDICATOR_COLORS).optional(),
  width: z.number().int().optional(),
  hidden: z.boolean().optional(),
});
export type IndicatorInput = z.infer<typeof indicatorInputSchema>;

/** Indicateurs d'un graphique au plus. */
export const MAX_INDICATORS = 10;

/** Longueur d'usage de chaque moyenne, et du RSI. */
export const DEFAULT_PERIOD: Record<MaType | "rsi", number> = { sma: 20, ema: 21, wma: 20, smma: 14, hma: 9, rsi: 14 };

/** Seuils d'usage de surachat et de survente du RSI. */
export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

/** « MM », « MME »… : l'abréviation d'une moyenne, affichée et dite. */
export const MA_SHORT: Record<MaType, string> = { sma: "MM", ema: "MME", wma: "MMP", smma: "MML", hma: "HMA" };
/** « simple », « exponentielle »… : son nom dans les réglages. */
export const MA_NAMES: Record<MaType, string> = {
  sma: "simple",
  ema: "exponentielle",
  wma: "pondérée",
  smma: "lissée (Wilder)",
  hma: "de Hull",
};
export const SOURCE_NAMES: Record<PriceSource, string> = {
  close: "clôture",
  open: "ouverture",
  high: "plus haut",
  low: "plus bas",
  hl2: "(H + B) / 2",
  hlc3: "(H + B + C) / 3",
  ohlc4: "(O + H + B + C) / 4",
};

/** « MME 21 », « MM 50 · plus haut », « RSI 14 » : le nom affiché et dit (la source seulement si ce n'est pas la clôture). */
export function indicatorLabel(i: Indicator): string {
  const name = i.kind === "ma" ? `${MA_SHORT[i.type]} ${i.period}` : `RSI ${i.period}`;
  return i.source === "close" ? name : `${name} · ${SOURCE_NAMES[i.source]}`;
}

/** Mêmes réglages de calcul (le style mis à part) : un doublon. */
export function sameIndicator(a: Indicator, b: Indicator): boolean {
  return calcKey(a) === calcKey(b);
}

function calcKey(i: Indicator): string {
  return i.kind === "ma"
    ? `ma:${i.type}:${i.period}:${i.source}`
    : `rsi:${i.period}:${i.source}:${i.overbought}:${i.oversold}:${i.signal ? `${i.signal.type}${i.signal.period}` : ""}`;
}

/** Les moyennes se tracent sur les bougies ; le RSI, dans son bandeau (0 à 100). */
export function isOverlay(i: Indicator): i is MovingAverage {
  return i.kind === "ma";
}

/**
 * Un indicateur complet à partir de ce qui est demandé : réglages d'usage
 * pour ce qui manque (moyenne simple 20 sur la clôture, RSI 14 à 70 / 30),
 * bornes vérifiées. Lève une erreur lisible sinon.
 */
export function completeIndicator(input: IndicatorInput, id: string): Indicator {
  const base = {
    id,
    ...(input.color ? { color: input.color } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.hidden ? { hidden: true } : {}),
  };
  const source = input.source ?? "close";
  if (input.kind === "rsi") {
    const r = rsiSchema.safeParse({
      kind: "rsi",
      period: input.period ?? DEFAULT_PERIOD.rsi,
      source,
      overbought: input.overbought ?? RSI_OVERBOUGHT,
      oversold: input.oversold ?? RSI_OVERSOLD,
      ...(input.signal ? { signal: input.signal } : {}),
      ...base,
    });
    if (!r.success) throw new Error(`RSI mal réglé : ${issues(r.error)}`);
    if (r.data.oversold >= r.data.overbought) throw new Error("RSI mal réglé : la survente doit être sous le surachat");
    return r.data;
  }
  const type = input.kind === "ma" ? (input.type ?? "sma") : input.kind;
  const r = maSchema.safeParse({ kind: "ma", type, period: input.period ?? DEFAULT_PERIOD[type], source, ...base });
  if (!r.success) throw new Error(`moyenne mal réglée : ${issues(r.error)}`);
  return r.data;
}

/** Le nom d'un réglage, tel qu'on le dit. */
const SETTING_NAMES: Record<string, string> = {
  period: "longueur",
  source: "source",
  type: "type",
  overbought: "surachat",
  oversold: "survente",
  "signal.period": "longueur de la moyenne du RSI",
  "signal.type": "type de la moyenne du RSI",
  color: "couleur",
  width: "épaisseur",
};

/** Ce qui ne va pas, en français (« survente : au plus 50 »). */
function issues(e: z.ZodError): string {
  return e.issues
    .map((i) => {
      const key = i.path.join(".");
      const name = SETTING_NAMES[key] ?? (key || "réglage");
      if (i.code === "too_small") return `${name} : au moins ${i.minimum}`;
      if (i.code === "too_big") return `${name} : au plus ${i.maximum}`;
      if (i.code === "invalid_type") return `${name} : ${i.expected === "number" ? "un nombre" : "illisible"}`;
      if (i.code === "invalid_enum_value") return `${name} : ${i.options.join(", ")}`;
      return `${name} : ${i.message}`;
    })
    .join(" ; ");
}

/**
 * Un indicateur gardé avant les réglages (`{kind: "sma" | "ema" | "rsi",
 * period}`, sans identifiant) : complété ; un indicateur illisible donne
 * undefined.
 */
export function upgradeIndicator(raw: unknown, id: () => string): Indicator | undefined {
  const current = indicatorSchema.safeParse(raw);
  if (current.success) return current.data;
  const old = indicatorInputSchema.safeParse(raw);
  if (!old.success) return undefined;
  try {
    return completeIndicator(old.data, (raw as { id?: string }).id || id());
  } catch {
    return undefined;
  }
}

/** Une bougie, pour les calculs : ouverture, plus haut, plus bas, clôture. */
export interface Ohlc {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Le prix choisi de chaque bougie. */
export function sourceValues(bars: readonly Ohlc[], source: PriceSource): number[] {
  switch (source) {
    case "open":
      return bars.map((b) => b.o);
    case "high":
      return bars.map((b) => b.h);
    case "low":
      return bars.map((b) => b.l);
    case "hl2":
      return bars.map((b) => (b.h + b.l) / 2);
    case "hlc3":
      return bars.map((b) => (b.h + b.l + b.c) / 3);
    case "ohlc4":
      return bars.map((b) => (b.o + b.h + b.l + b.c) / 4);
    default:
      return bars.map((b) => b.c);
  }
}

/** Moyenne mobile simple des `period` dernières valeurs ; NaN tant qu'il n'y en a pas assez. */
export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Moyenne mobile exponentielle (2 / (période + 1)), amorcée sur la moyenne simple des `period` premières valeurs. */
export function ema(values: readonly number[], period: number): number[] {
  return smoothed(values, period, 2 / (period + 1));
}

/** Moyenne lissée de Wilder (SMMA, RMA : 1 / période), amorcée sur la moyenne simple ; celle du RSI. */
export function smma(values: readonly number[], period: number): number[] {
  return smoothed(values, period, 1 / period);
}

function smoothed(values: readonly number[], period: number, k: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Moyenne pondérée linéairement (la plus récente pèse `period`, la plus ancienne 1). */
export function wma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const weight = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += values[i - k] * (period - k);
    out[i] = sum / weight;
  }
  return out;
}

/** Moyenne de Hull : WMA(2 × WMA(n / 2) − WMA(n), √n), réactive et lisse. */
export function hma(values: readonly number[], period: number): number[] {
  const half = wma(values, Math.max(1, Math.floor(period / 2)));
  const full = wma(values, period);
  const diff = values.map((_, i) => 2 * half[i] - full[i]);
  return movingAverage("wma", diff, Math.max(1, Math.round(Math.sqrt(period))));
}

/** Une moyenne de ce type sur une série qui peut commencer par des NaN (le RSI, une autre moyenne). */
export function movingAverage(type: MaType, values: readonly number[], period: number): number[] {
  const first = values.findIndex((v) => Number.isFinite(v));
  if (first < 0) return values.map(() => NaN);
  const tail = values.slice(first);
  const calc = type === "sma" ? sma : type === "ema" ? ema : type === "wma" ? wma : type === "smma" ? smma : hma;
  return [...new Array<number>(first).fill(NaN), ...calc(tail, period)];
}

/**
 * RSI de Wilder (lissage 1 / période), comme MetaTrader et TradingView : la
 * première valeur à la bougie `period`, sur les moyennes simples des hausses et
 * des baisses ; 100 sans aucune baisse, 50 sans aucun mouvement.
 */
export function rsi(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = rsiOf(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiOf(gain, loss);
  }
  return out;
}

function rsiOf(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Les séries d'un indicateur sur des bougies : la ligne principale, et la moyenne du RSI s'il en a une. */
export function indicatorSeries(i: Indicator, bars: readonly Ohlc[]): { main: number[]; signal?: number[] } {
  const values = sourceValues(bars, i.source);
  if (i.kind === "ma") return { main: movingAverage(i.type, values, i.period) };
  const main = rsi(values, i.period);
  return i.signal ? { main, signal: movingAverage(i.signal.type, main, i.signal.period) } : { main };
}

/* -------------------------------- Tracés -------------------------------- */

/** Ligne horizontale, oblique, zone (rectangle), retracement et extension de Fibonacci, boîte de trade (position). */
export const DRAWING_KINDS = ["hline", "trendline", "zone", "fib", "fibext", "position"] as const;
export type DrawingKind = (typeof DRAWING_KINDS)[number];

/** Un point d'un tracé : l'instant d'une bougie (epoch s, UTC) et un prix. */
const anchorSchema = z.object({ t: z.number().int(), price: z.number() });
export type DrawingAnchor = z.infer<typeof anchorSchema>;

const hlineShape = z.object({ kind: z.literal("hline"), price: z.number() });
/** Oblique entre deux points (verticale s'ils sont au même instant) ; `extend` : prolongée au-delà du second, vers la droite. */
const trendlineShape = z.object({ kind: z.literal("trendline"), a: anchorSchema, b: anchorSchema, extend: z.boolean() });
/**
 * Zone entre deux prix ; de `from` à `to` (instants de bougies, epoch s).
 * Sans `from`, elle part du début du graphique ; sans `to`, elle va jusqu'à
 * maintenant et au-delà (support ou résistance encore valable).
 */
const zoneShape = z.object({
  kind: z.literal("zone"),
  top: z.number(),
  bottom: z.number(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});

/**
 * Retracement de Fibonacci, comme sur TradingView : de `a` à `b` (du plus bas
 * au plus haut, ou l'inverse), le niveau 0 sur `b`, 1 sur `a`. Ses niveaux
 * vont d'un point à l'autre ; `extend` : prolongés vers la droite.
 */
const fibShape = z.object({ kind: z.literal("fib"), a: anchorSchema, b: anchorSchema, extend: z.boolean() });
/**
 * Extension de Fibonacci (« Trend-Based Fib Extension ») : une impulsion de
 * `a` à `b`, puis `c`, d'où les niveaux sont projetés avec l'amplitude de
 * l'impulsion (0 sur `c`, 1 à `c` + (`b` − `a`)). Ils partent de `c` vers la
 * droite, sur la largeur de l'impulsion ; `extend` : jusqu'au bord droit.
 */
const fibExtShape = z.object({ kind: z.literal("fibext"), a: anchorSchema, b: anchorSchema, c: anchorSchema, extend: z.boolean() });

/** Le sens d'une boîte de trade : achat (position longue) ou vente (position courte). */
export const POSITION_SIDES = ["long", "short"] as const;
export type PositionSide = (typeof POSITION_SIDES)[number];

/**
 * Ce que l'utilisateur fixe pour la taille d'une position : un pourcentage du
 * capital (« 1 % »), un montant dans la devise du compte (« 150 € ») ou un
 * nombre de lots ; le reste (taille, perte, gain) se calcule.
 */
export const RISK_MODES = ["percent", "amount", "lots"] as const;
export type RiskMode = (typeof RISK_MODES)[number];
export const riskSchema = z.object({
  mode: z.enum(RISK_MODES),
  value: z.number().positive().finite(),
  /** Le palier de l'utilisateur choisi (« A+ ») : son pourcentage du moment fait foi. */
  tier: z.string().min(1).max(20).optional(),
});
export type Risk = z.infer<typeof riskSchema>;

/**
 * Boîte de trade, comme les positions longue et courte de TradingView : une
 * entrée, un stop et un objectif (un achat a son stop dessous et son objectif
 * dessus ; une vente, l'inverse), de `from` (l'instant de la bougie d'entrée)
 * à `to` (son bord droit ; sans, jusqu'au bord droit du graphique). `risk` :
 * le risque choisi pour elle (sans : celui du money management). Une analyse :
 * rien ne part chez le courtier tant que l'utilisateur ne confirme pas un
 * ordre (voir trading.ts).
 */
const positionShape = z.object({
  kind: z.literal("position"),
  side: z.enum(POSITION_SIDES),
  entry: z.number(),
  stop: z.number(),
  target: z.number(),
  from: z.number().int(),
  to: z.number().int().optional(),
  risk: riskSchema.optional(),
});

/** La forme d'un tracé, telle qu'on la crée ou la modifie. */
export const drawingShapeSchema = z.discriminatedUnion("kind", [hlineShape, trendlineShape, zoneShape, fibShape, fibExtShape, positionShape]);
export type DrawingShape = z.infer<typeof drawingShapeSchema>;

const drawingMeta = {
  id: z.string().min(1),
  /** Symbole exact du courtier : un tracé appartient au produit, quelle que soit l'unité de temps. */
  symbol: z.string().min(1),
  /** Nom court affiché à côté (« résistance », « R1 »). */
  label: z.string().max(40).optional(),
  /**
   * Tracé à la souris ou par Kopilia (à la voix), ou par l'IA de la recherche
   * d'opportunités : un niveau de travail d'un de ses scénarios, qui part avec
   * lui, sauf si l'utilisateur le garde (il devient alors le sien).
   */
  createdBy: z.enum(["user", "kopilia", "ia"]),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  /** Niveau de l'IA : le scénario qui l'a tracé. */
  scenarioId: z.string().optional(),
  /** Niveau de l'IA : pourquoi ce niveau. */
  reason: z.string().max(400).optional(),
};

/** Un tracé d'un produit, gardé par le serveur ; son identifiant est stable (les alertes s'y rattacheront). */
export const drawingSchema = z.discriminatedUnion("kind", [
  hlineShape.extend(drawingMeta),
  trendlineShape.extend(drawingMeta),
  zoneShape.extend(drawingMeta),
  fibShape.extend(drawingMeta),
  fibExtShape.extend(drawingMeta),
  positionShape.extend(drawingMeta),
]);
export type Drawing = z.infer<typeof drawingSchema>;

/** Une boîte de trade (seule sa forme compte). */
export type PositionShape = Extract<DrawingShape, { kind: "position" }>;

/** Ce qu'une boîte risque (de l'entrée au stop) et ce qu'elle vise (de l'entrée à l'objectif), en écarts de prix positifs. */
export function positionDistances(p: Pick<PositionShape, "entry" | "stop" | "target">): { risk: number; reward: number } {
  return { risk: Math.abs(p.entry - p.stop), reward: Math.abs(p.target - p.entry) };
}

/** Le rapport gain / risque d'une boîte : ce que vise l'objectif, en multiples du risque (undefined sans risque). */
export function positionRatio(p: Pick<PositionShape, "entry" | "stop" | "target">): number | undefined {
  const { risk, reward } = positionDistances(p);
  return risk > 0 ? reward / risk : undefined;
}

/** « 2 R », « 2,5 R », « 1,35 R » : le rapport gain / risque, à la française (deux décimales au plus). */
export function ratioLabel(ratio: number): string {
  return `${String(Number(ratio.toFixed(2))).replace(".", ",")} R`;
}

/**
 * Pourquoi ces niveaux ne font pas une boîte de ce sens (undefined : ils la
 * font) : un achat a son stop sous l'entrée et son objectif au-dessus ; une
 * vente, l'inverse.
 */
export function positionProblem(p: Pick<PositionShape, "side" | "entry" | "stop" | "target">): string | undefined {
  if (p.side === "long") {
    if (!(p.stop < p.entry)) return "pour un achat, le stop va sous l'entrée";
    if (!(p.target > p.entry)) return "pour un achat, l'objectif va au-dessus de l'entrée";
  } else {
    if (!(p.stop > p.entry)) return "pour une vente, le stop va au-dessus de l'entrée";
    if (!(p.target < p.entry)) return "pour une vente, l'objectif va sous l'entrée";
  }
  return undefined;
}

/** Le sens que donnent ces niveaux : un stop sous l'entrée, un achat ; au-dessus, une vente (undefined : on ne sait pas). */
export function positionSideOf(p: { entry?: number; stop?: number; target?: number }): PositionSide | undefined {
  if (p.entry !== undefined && p.stop !== undefined && p.stop !== p.entry) return p.stop < p.entry ? "long" : "short";
  if (p.entry !== undefined && p.target !== undefined && p.target !== p.entry) return p.target > p.entry ? "long" : "short";
  return undefined;
}

/** Les niveaux d'un retracement de Fibonacci. */
export const FIB_RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
/** Les niveaux d'une extension de Fibonacci. */
export const FIB_EXTENSION_RATIOS = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618] as const;

/** Un retracement ou une extension de Fibonacci (seule leur forme compte). */
export type FibShape = Extract<DrawingShape, { kind: "fib" | "fibext" }>;

/**
 * Les niveaux d'un Fibonacci, dans l'ordre des ratios : un retracement part de
 * `b` (0) et revient vers `a` (1) ; une extension part de `c` (0) et reprend
 * l'amplitude de `a` à `b` (1 : `c` + (`b` − `a`)).
 */
export function fibLevels(f: FibShape): Array<{ ratio: number; price: number }> {
  if (f.kind === "fib") return FIB_RETRACEMENT_RATIOS.map((ratio) => ({ ratio, price: f.b.price + (f.a.price - f.b.price) * ratio }));
  return FIB_EXTENSION_RATIOS.map((ratio) => ({ ratio, price: f.c.price + (f.b.price - f.a.price) * ratio }));
}

/** Les ratios des niveaux d'un retracement (`fib`) ou d'une extension (`fibext`). */
export function fibRatios(kind: FibShape["kind"]): readonly number[] {
  return kind === "fib" ? FIB_RETRACEMENT_RATIOS : FIB_EXTENSION_RATIOS;
}

/** Le prix du niveau de ce ratio (undefined : le Fibonacci n'a pas ce niveau). */
export function fibLevelPrice(f: FibShape, ratio: number | undefined): number | undefined {
  if (ratio === undefined) return undefined;
  return fibLevels(f).find((l) => Math.abs(l.ratio - ratio) < 1e-9)?.price;
}

/** « 0,618 », « 1 », « 2,618 » : un ratio de Fibonacci, à la française. */
export function fibRatioLabel(ratio: number): string {
  return String(ratio).replace(".", ",");
}

/** Tracés d'un produit au plus. */
export const MAX_DRAWINGS = 40;

/**
 * Position (en bougies, fractionnaire) d'un instant parmi des bougies d'unité
 * `tf` secondes, triées : dans la bougie qui le contient (0,25 = un quart de
 * bougie), au pas de `tf` avant la première ou après la dernière. Un instant
 * pris dans une interruption (nuit, week-end) tombe sur la bougie suivante.
 * Une oblique se calcule sur ces positions, en temps de marché : elle reste
 * droite à l'écran, d'une unité de temps à l'autre, et c'est son prix à cette
 * position que les alertes compareront.
 */
export function barPosition(times: readonly number[], t: number, tf: number): number {
  const n = times.length;
  if (!n) return NaN;
  if (t < times[0]) return (t - times[0]) / tf;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const frac = (t - times[lo]) / tf;
  return lo === n - 1 ? lo + frac : lo + Math.min(1, frac);
}

/** Instant (epoch s) de la position entière `i` : celui de la bougie, ou au pas de `tf` au-delà des bougies chargées. */
export function barTime(times: readonly number[], i: number, tf: number): number {
  const n = times.length;
  if (!n) return NaN;
  if (i < 0) return times[0] + i * tf;
  if (i > n - 1) return times[n - 1] + (i - (n - 1)) * tf;
  return times[i];
}

/**
 * Prix d'une oblique à la position `x`, ses points placés aux positions `xa`
 * et `xb` : undefined avant son premier point, ou après le second si elle
 * n'est pas prolongée ; undefined aussi pour une verticale (elle marque un
 * instant, pas un prix).
 */
export function trendlinePrice(line: { a: DrawingAnchor; b: DrawingAnchor; extend: boolean }, xa: number, xb: number, x: number): number | undefined {
  const [x0, p0, x1, p1] = xa <= xb ? [xa, line.a.price, xb, line.b.price] : [xb, line.b.price, xa, line.a.price];
  if (x1 === x0 || x < x0 || (!line.extend && x > x1)) return undefined;
  return p0 + ((p1 - p0) * (x - x0)) / (x1 - x0);
}
