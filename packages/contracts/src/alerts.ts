import { z } from "zod";

/*
 * Alertes du graphique d'un produit : à un prix, sur un tracé (ligne
 * horizontale, oblique, zone, ou un niveau d'un Fibonacci), ou sur une bande de prix (une zone sans
 * tracé, posée par l'IA). Le serveur les surveille sur les cotations, page
 * fermée comprise ; quand une se déclenche, l'écran la signale et Kopilia la
 * dit, en suivant la consigne qu'elle porte. Une alerte rattachée à un
 * scénario (posée par l'IA) réveille l'agent de ce scénario à la place.
 */

/**
 * Franchir le niveau : dans un sens ou dans l'autre, à la hausse, à la baisse.
 * Le toucher compte. Pour une zone, c'est y entrer : par-dessous (à la hausse)
 * ou par-dessus (à la baisse).
 */
export const ALERT_CONDITIONS = ["cross", "up", "down"] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export const ALERT_CONDITION_NAMES: Record<AlertCondition, string> = {
  cross: "Franchissement (les deux sens)",
  up: "Franchit à la hausse",
  down: "Franchit à la baisse",
};

/**
 * Quand elle part : une seule fois (puis elle s'arrête), au plus une fois par
 * bougie, quand une bougie clôture de l'autre côté (les mèches ne comptent
 * pas), ou à la clôture de la bougie qui a touché le niveau (`touch_close` :
 * au contact, rien ne part encore ; à la clôture de cette bougie, l'alerte
 * part une fois, avec la bougie et ce qu'elle montre : rejet ou non).
 */
export const ALERT_TRIGGERS = ["once", "bar", "close", "touch_close"] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

export const ALERT_TRIGGER_NAMES: Record<AlertTrigger, string> = {
  once: "Une seule fois",
  bar: "Une fois par bougie",
  close: "Sur clôture de bougie",
  touch_close: "À la clôture après contact",
};

/** La bougie du contact, à sa clôture : de quel côté elle a clôturé. */
export type ContactVerdict = "rejection" | "inside" | "break";

/**
 * Ce que montre la bougie qui a touché un niveau (une zone : `lo` à `hi` ;
 * une ligne : `lo` = `hi`), arrivé par `dir` (« down » : venu d'en haut, sur
 * un support ; « up » : venu d'en bas, sur une résistance). Clôture revenue du
 * côté d'où venait le prix : un rejet ; dans la zone : pas encore ; de
 * l'autre côté : une cassure.
 */
export function contactVerdict(close: number, lo: number, hi: number, dir: "up" | "down"): ContactVerdict {
  if (dir === "down") return close > hi ? "rejection" : close < lo ? "break" : "inside";
  return close < lo ? "rejection" : close > hi ? "break" : "inside";
}

/**
 * Surveillée ; suspendue à la main ; déclenchée (une seule fois : elle s'est
 * arrêtée) ; expirée (son tracé s'arrête avant maintenant, ou son échéance
 * est passée).
 */
export const ALERT_STATES = ["active", "paused", "triggered", "expired"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

/** Alertes de l'utilisateur surveillées (actives ou suspendues) d'un produit au plus. */
export const MAX_ALERTS = 20;
/** Alertes de l'IA (rattachées à un scénario) surveillées d'un produit au plus : elles ne prennent pas la place des siennes. */
export const MAX_AI_ALERTS = 8;
/** Longueur de la consigne pour Kopilia (l'intention, pour une alerte de l'IA). */
export const MAX_ALERT_MESSAGE = 300;

/**
 * Ce que l'alerte surveille : un prix, un tracé du même produit (son
 * identifiant d_… : ligne, oblique ou zone ; pour un Fibonacci, un de ses
 * niveaux, `level`, son ratio : 0.618), ou une bande de prix (zone sans
 * tracé : celle d'une carte automatique, ou que l'IA s'est donnée).
 */
export const alertTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price"), price: z.number().positive() }),
  z.object({ kind: z.literal("drawing"), drawingId: z.string().min(1), level: z.number().nonnegative().optional() }),
  z.object({ kind: z.literal("band"), top: z.number().positive(), bottom: z.number().positive() }),
]);
export type AlertTarget = z.infer<typeof alertTargetSchema>;

/** Une alerte, gardée par le serveur ; son identifiant (a_…) est stable. */
export const alertSchema = z.object({
  id: z.string().min(1),
  /** Symbole exact du courtier, son nom courant (« or ») et ses décimales. */
  symbol: z.string().min(1),
  name: z.string(),
  digits: z.number().int().nonnegative().optional(),
  target: alertTargetSchema,
  condition: z.enum(ALERT_CONDITIONS),
  trigger: z.enum(ALERT_TRIGGERS),
  /**
   * Unité de temps (« 1h ») : celle des bougies d'une alerte par bougie ou sur
   * clôture, et celle où une oblique est calculée (le graphique où l'alerte a
   * été posée : elle touche exactement la ligne qu'on y voyait).
   */
  timeframe: z.string().min(1),
  /** Consigne pour Kopilia quand elle se déclenche (« regarde le RSI et dis-moi si la cassure tient »). */
  message: z.string().max(MAX_ALERT_MESSAGE).optional(),
  state: z.enum(ALERT_STATES),
  /** Posée à la souris ou par Kopilia (à la voix, ou par l'IA pour un scénario). */
  createdBy: z.enum(["user", "kopilia"]),
  /** Alerte de l'IA : le scénario dont elle réveille l'agent (sc_…) ; sa consigne est l'intention à vérifier. */
  scenarioId: z.string().min(1).optional(),
  /** Échéance (epoch ms) : passée, l'alerte expire. Toujours donnée pour une alerte de l'IA. */
  expiresAt: z.number().int().positive().optional(),
  createdAt: z.number().int().positive(),
  /** Dernière fois qu'elle a été (ré)armée : posée, réglée, réactivée, sa ligne déplacée. */
  updatedAt: z.number().int().positive(),
  /** Dernier déclenchement : instant (epoch ms) et prix. */
  triggeredAt: z.number().int().positive().optional(),
  triggeredPrice: z.number().optional(),
});
export type Alert = z.infer<typeof alertSchema>;

/**
 * Le sens par défaut d'une alerte de prix : au-dessus du cours, elle attend la
 * hausse ; au-dessous, la baisse ; sans cours (ou dessus), les deux.
 */
export function defaultCondition(level: number, price?: number): AlertCondition {
  if (price === undefined || !Number.isFinite(price) || level === price) return "cross";
  return level > price ? "up" : "down";
}
