/**
 * Les canaux extérieurs où Kopilia publie : Telegram aujourd'hui, d'autres
 * demain (Twitter…). Un message ne dépend d'aucun canal : un titre, un texte
 * brut et, au besoin, une image ; chaque canal le met en forme à sa façon
 * (gras, longueur, découpage) et dit s'il est parti.
 */

export interface OutboundMessage {
  /** Première ligne, mise en avant (en gras sur Telegram). */
  title?: string;
  /** Texte brut, sans mise en forme : le canal l'échappe. */
  text: string;
  /** Une image PNG (le graphique d'un produit). */
  image?: Buffer;
  /** Une mention en bas (« Analyse personnelle, pas un conseil en investissement. »), discrète. */
  footer?: string;
}

/** Ce qu'il est advenu d'un envoi ; `error` : en français, sans jamais de secret. */
export type SendOutcome = { ok: true } | { ok: false; error: string };

export interface OutboundChannel {
  /** « telegram » : pour les journaux et les réponses de Kopilia. */
  readonly name: string;
  /** Configuré (ses identifiants sont dans .env) ; sinon, rien ne part. */
  readonly enabled: boolean;
  /** Envoie, à la suite des messages précédents ; ne lève jamais. */
  send(message: OutboundMessage): Promise<SendOutcome>;
}
