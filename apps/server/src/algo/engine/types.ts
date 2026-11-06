/*
 * Les types du moteur de backtest et de l'API du robot. Ce fichier n'a aucune
 * dépendance : il est partagé par le serveur Nest, le bac à sable (worker) et
 * la documentation donnée à l'agent qui écrit le robot.
 */

/** Une bougie close : ouverture en epoch secondes, puis OHLC et volume de ticks. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export type Side = "long" | "short";

/** Les coûts du courtier appliqués par le moteur, en unités de prix du produit. */
export interface Costs {
  /** Écart achat-vente : les bougies sont au bid, un achat se fait au bid + écart. */
  spread: number;
  /** Commission d'un aller-retour, en unités de prix (0 si le courtier ne facture que l'écart). */
  commission: number;
  /** Glissement sur chaque exécution au marché ou sur stop, en unités de prix. */
  slippage: number;
}

export const SESSION_NAMES = ["asia", "london", "new_york", "off"] as const;
export type SessionName = (typeof SESSION_NAMES)[number];

/** L'heure de Paris d'une bougie, et la séance qu'elle ouvre. */
export interface Clock {
  /** « AAAA-MM-JJ » à Paris. */
  date: string;
  hour: number;
  minute: number;
  /** 0 dimanche … 6 samedi. */
  weekday: number;
  session: SessionName;
}

/** Ce qu'un robot demande au moteur pour entrer. */
export interface EntryRequest {
  side: Side;
  /** Le stop est obligatoire : sans lui, pas de R. */
  stop: number;
  target?: number;
  /** Entrée à cours limité (meilleur prix) : remplie quand le prix la touche. */
  limit?: number;
  /** Entrée stop (cassure) : remplie quand le prix la traverse. */
  stopEntry?: number;
  /** Nombre de bougies pendant lesquelles un ordre en attente reste valable (défaut : jusqu'à annulation). */
  expires?: number;
  tag?: string;
}

/** La position ouverte, telle que le robot la voit. */
export interface OpenPosition {
  side: Side;
  entry: number;
  stop: number;
  target?: number;
  /** Bougie et instant d'entrée. */
  entryIndex: number;
  entryAt: number;
  /** Distance au stop à l'entrée : 1 R. */
  risk: number;
  /** Nombre de bougies closes depuis l'entrée. */
  bars: number;
  tag?: string;
  /** Résultat latent à la dernière clôture, en R. */
  openR: number;
}

/** Un ordre en attente (limite ou stop), tel que le robot le voit. */
export interface PendingOrder extends EntryRequest {
  placedIndex: number;
}

export interface TradeRecord {
  symbol: string;
  side: Side;
  entryIndex: number;
  exitIndex: number;
  entryAt: number;
  exitAt: number;
  entry: number;
  exit: number;
  stop: number;
  target?: number;
  /** Résultat net de l'écart, de la commission et du glissement, en R. */
  r: number;
  reason: string;
  /** Pire et meilleure excursion pendant le trade, en R. */
  mae: number;
  mfe: number;
  bars: number;
  tag?: string;
}

/** Une série de bougies lue par le robot : la principale ou une unité de contexte. */
export interface Series {
  readonly timeframe: string;
  /** Nombre de bougies closes disponibles jusqu'à maintenant. */
  readonly length: number;
  /** La bougie `i` en arrière (0 : la dernière close). Lance une erreur au-delà de l'historique. */
  bar(i?: number): Bar;
  open(i?: number): number;
  high(i?: number): number;
  low(i?: number): number;
  close(i?: number): number;
  /** Moyenne mobile simple de la clôture, valeur `i` bougies en arrière (NaN tant que la période n'est pas remplie). */
  sma(period: number, i?: number): number;
  ema(period: number, i?: number): number;
  /** RSI de Wilder. */
  rsi(period: number, i?: number): number;
  /** ATR (moyenne de Wilder des vraies amplitudes). */
  atr(period: number, i?: number): number;
  /** Plus haut des `period` dernières bougies closes (hors celle en cours si i = 0 ? non : la dernière close comprise). */
  highest(period: number, i?: number): number;
  lowest(period: number, i?: number): number;
}

/** Ce que le robot reçoit à chaque bougie close. */
export interface Ctx {
  readonly symbol: string;
  readonly timeframe: string;
  /** Indice de la bougie close dans l'historique, et son instant d'ouverture (epoch s). */
  readonly index: number;
  readonly time: number;
  readonly bar: Bar;
  readonly series: Series;
  /** L'heure de Paris et la séance de la bougie close. */
  readonly clock: Clock;
  readonly params: Record<string, unknown>;
  readonly position: OpenPosition | null;
  readonly pending: PendingOrder | null;
  /** Une unité de contexte (« 1h », « 4h », « 1d ») : ses bougies closes au moment de la bougie close. */
  context(timeframe: string): Series;
  /** Achète : au marché à l'ouverture suivante, ou en attente (limit / stopEntry). Refusé si une position est ouverte. */
  buy(req: Omit<EntryRequest, "side">): void;
  sell(req: Omit<EntryRequest, "side">): void;
  /** Clôt la position à l'ouverture suivante. */
  close(reason?: string): void;
  /** Annule l'ordre en attente. */
  cancel(): void;
  setStop(price: number): void;
  setTarget(price: number | undefined): void;
  /** Une note dans le journal du backtest (200 au plus). */
  log(message: string): void;
}

/** Le module écrit par Kopilia : `export default { … } satisfies Robot`. */
export interface Robot {
  name?: string;
  /** Paramètres par défaut, remplaçables à chaque backtest. */
  params?: Record<string, unknown>;
  /** Bougies à laisser passer avant la première décision (défaut : 50). */
  warmup?: number;
  onBar(ctx: Ctx): void;
}

export interface RunInput {
  symbol: string;
  timeframe: string;
  bars: Bar[];
  /** Les unités de contexte disponibles, par unité. */
  context?: Record<string, Bar[]>;
  /** Les bougies d'une minute, pour départager stop et objectif dans une même bougie. */
  minute?: Bar[];
  costs: Costs;
  params?: Record<string, unknown>;
  /** Durée d'une bougie en secondes, par unité (principale et contextes). */
  seconds: Record<string, number>;
}

export interface RunOutput {
  symbol: string;
  trades: TradeRecord[];
  logs: string[];
  /** Nombre de bougies jouées. */
  bars: number;
  error?: string;
}
