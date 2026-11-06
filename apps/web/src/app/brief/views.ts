/** Un brief de veille : ce que l'écran en sait (bouton « Brief »). */
export interface BriefMeta {
  briefId: string;
  title: string;
  createdAt: number;
}
/** Brief ouvert à l'écran : HTML déjà échappé et rendu. */
export interface BriefView extends BriefMeta {
  html: string;
}
