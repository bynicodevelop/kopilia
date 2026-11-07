import { z } from "zod";

/**
 * Le compte MetaApi (le pont entre Kopilia et le courtier) : allumé, en
 * pause pour économiser (MetaApi facture chaque heure où il est déployé),
 * ou entre les deux. En pause, rien ne change chez le courtier : stops et
 * objectifs y restent ; seuls les prix, les graphiques et les ordres de
 * Kopilia attendent qu'il se rallume.
 */
export const BROKER_STATES = [
  /** Allumé : prix, graphiques, ordres. */
  "on",
  /** Mise en pause demandée, MetaApi arrête le terminal. */
  "pausing",
  "paused",
  /** Rallumage en cours (une à trois minutes) : `since` dit depuis quand. */
  "waking",
  /** Un rallumage ou une pause a échoué : `error` dit pourquoi ; retenté plus tard. */
  "error",
  /** Pas de MetaApi configuré, ou pause automatique coupée (KOPILIA_BROKER_PAUSE=0) : rien à montrer. */
  "off",
] as const;
export type BrokerState = (typeof BROKER_STATES)[number];

/** Pourquoi le compte dort : le week-end, la nuit (en option), ou à la demande de l'utilisateur. */
export const BROKER_REASONS = ["weekend", "night", "manual"] as const;
export type BrokerReason = (typeof BROKER_REASONS)[number];

export const brokerStatusSchema = z.object({
  state: z.enum(BROKER_STATES),
  reason: z.enum(BROKER_REASONS).optional(),
  /** Depuis quand dans cet état (epoch ms). */
  since: z.number().int().nonnegative(),
  /** En pause : quand il se rallume de lui-même (epoch ms). */
  resumeAt: z.number().int().nonnegative().optional(),
  /** Allumé pendant une fenêtre de pause : il se rendort après ce délai sans usage (epoch ms). */
  sleepsAt: z.number().int().nonnegative().optional(),
  /** Durée du dernier rallumage mesuré (ms), pour prévenir du délai. */
  wakeMs: z.number().int().positive().optional(),
  /** Ce que l'écran affiche : « En pause pour le week-end · reprise dimanche à 22 h 30 ». */
  label: z.string(),
  error: z.string().optional(),
  /** Les règles : pause du week-end (par défaut), pause de nuit (en option). */
  weekend: z.boolean(),
  nights: z.boolean(),
});
export type BrokerStatus = z.infer<typeof brokerStatusSchema>;

/** « 1 min 10 », « 45 s » : une durée de rallumage, à dire ou à afficher. */
export function wakeDurationLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${String(r).padStart(2, "0")}` : `${m} min`;
}
