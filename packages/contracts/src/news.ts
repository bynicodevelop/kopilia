import { z } from "zod";

/*
 * Les news en temps réel : les titres du flux RSS de FinancialJuice, traduits
 * en français, avec au plus une ligne d'impact et un niveau d'importance
 * (le flux n'en donne aucun). Les chiffres publiés (« Actual … (Forecast …) »)
 * sont rapprochés des annonces du calendrier.
 */

/** Fort : dit à la voix, en bandeau, sur Telegram s'il ne regarde pas ; moyen : touche sa liste ; faible : le reste. */
export const NEWS_LEVELS = ["high", "medium", "low"] as const;
export type NewsLevel = (typeof NEWS_LEVELS)[number];

/** Un chiffre publié, tel que la news le donne, et l'annonce du calendrier qu'il complète. */
export const newsFigureSchema = z.object({
  /** Le nom de l'indicateur dans le titre (« US Initial Jobless Claims »). */
  event: z.string(),
  actual: z.string(),
  forecast: z.string().optional(),
  previous: z.string().optional(),
  revised: z.string().optional(),
  /** L'annonce du calendrier rapprochée : son titre, son impact, son consensus. */
  calendar: z
    .object({
      title: z.string(),
      country: z.string(),
      impact: z.string(),
      forecast: z.string().optional(),
    })
    .optional(),
});
export type NewsFigure = z.infer<typeof newsFigureSchema>;

/** Ce qu'a fait un produit de sa liste dans les minutes qui ont suivi la news. */
export const newsReactionSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  /** Variation en %, du prix d'avant la news au plus loin atteint ensuite. */
  changePct: z.number(),
  /** Le mouvement, en multiples de l'amplitude moyenne d'une bougie d'une minute avant la news. */
  strength: z.number(),
  minutes: z.number().int().positive(),
});
export type NewsReaction = z.infer<typeof newsReactionSchema>;

export const newsItemSchema = z.object({
  id: z.string().min(1),
  /** Heure de publication (epoch ms). */
  at: z.number().int().positive(),
  /** Le titre en français (l'original tant qu'il n'est pas traduit). */
  title: z.string(),
  /** Le titre d'origine, en anglais, sans le préfixe du site. */
  original: z.string(),
  translated: z.boolean(),
  /** Au plus une ligne, seulement s'il y a un effet probable sur sa liste. */
  impact: z.string().optional(),
  /** Les produits de sa liste qu'elle touche (symboles du courtier). */
  symbols: z.array(z.string()),
  level: z.enum(NEWS_LEVELS),
  figure: newsFigureSchema.optional(),
  reaction: newsReactionSchema.optional(),
  /** Aperçu de l'offre payante du site (« FJElite ») : le titre seul. */
  elite: z.boolean().optional(),
  link: z.string().optional(),
});
export type NewsItem = z.infer<typeof newsItemSchema>;
