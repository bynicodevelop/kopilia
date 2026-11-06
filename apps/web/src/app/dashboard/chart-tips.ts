/**
 * Les bulles d'information des outils d'un graphique : ce que fait l'outil,
 * comment s'en servir à la souris, et comment le demander à Kopilia. Rangées
 * comme la barre d'outils : les objets (tracés à la main), les indicateurs
 * techniques (calculés sur les bougies), l'analyse de l'IA, les alertes.
 */

export type TipKey = "magnet" | "hline" | "trendline" | "zone" | "fib" | "fibext" | "long" | "short" | "indicators" | "ai" | "alerts";

export interface ChartTip {
  /** Le groupe de l'outil, en tête de la bulle. */
  group: "Objet" | "Indicateurs" | "IA" | "Alertes";
  title: string;
  text: string;
  /** Une phrase à dire à Kopilia pour obtenir la même chose. */
  voice?: string;
}

/** Les bulles, avec la touche qui inverse l'aimant (⌘ sur Mac, Ctrl ailleurs). */
export function chartTips(mod: string): Record<TipKey, ChartTip> {
  return {
    magnet: {
      group: "Objet",
      title: "Aimant",
      text: `Colle les points posés au plus haut, au plus bas, à l'ouverture ou à la clôture de la bougie. Un clic passe de coupé à faible, puis à fort ; ${mod} maintenu l'inverse le temps d'un tracé.`,
    },
    hline: {
      group: "Objet",
      title: "Ligne horizontale",
      text: "Un clic sur un prix : un support, une résistance, un plus haut. Clic droit dessus pour y poser une alerte.",
      voice: "mets une résistance à 2 680",
    },
    trendline: {
      group: "Objet",
      title: "Oblique",
      text: "Deux clics, ou glisser ; Maj la cale à 0°, 45° ou 90°. Elle se prolonge vers la droite, et une alerte peut la suivre.",
      voice: "trace une oblique entre le plus bas de 9 h et celui de 14 h",
    },
    zone: {
      group: "Objet",
      title: "Zone",
      text: "Deux coins, ou glisser : une zone de support ou de résistance. Une alerte peut attendre le contact puis la clôture de la bougie.",
      voice: "trace la zone 2 650 – 2 660",
    },
    fib: {
      group: "Objet",
      title: "Retracement de Fibonacci",
      text: "Le début puis la fin du mouvement : les niveaux de repli (38,2 %, 50 %, 61,8 %…) s'affichent entre les deux.",
      voice: "trace un Fibonacci entre le plus bas de 14 h et le plus haut de 16 h",
    },
    fibext: {
      group: "Objet",
      title: "Extension de Fibonacci",
      text: "Trois clics : le début et la fin de l'impulsion, puis la fin du repli. Les objectifs (100 %, 161,8 %…) partent du repli.",
      voice: "trace une extension de Fibonacci de 2 600 à 2 680, repli à 2 640",
    },
    long: {
      group: "Objet",
      title: "Position longue",
      text: "Une boîte d'achat : un clic sur l'entrée, puis tire l'objectif et le stop. Le rapport gain / risque s'affiche au milieu. Une analyse, jamais un ordre.",
      voice: "trace une boîte d'achat sur l'or, entrée 2 650, stop 2 630, objectif 2 690",
    },
    short: {
      group: "Objet",
      title: "Position courte",
      text: "Une boîte de vente : un clic sur l'entrée, puis tire l'objectif et le stop. Le rapport gain / risque s'affiche au milieu. Une analyse, jamais un ordre.",
      voice: "trace une boîte de vente sur le Nasdaq, entrée 21 400, stop 21 480, objectif 21 200",
    },
    indicators: {
      group: "Indicateurs",
      title: "Indicateurs techniques",
      text: "Calculés sur les bougies : moyennes mobiles (simple, exponentielle, pondérée, lissée, de Hull) sur le graphique, RSI dans un bandeau dessous. Ils restent attachés au produit, dans toutes les unités.",
      voice: "mets les exponentielles 20, 50 et 200 sur tous les graphiques",
    },
    ai: {
      group: "IA",
      title: "Analyse de l'IA",
      text: "Ce que la machine ajoute, en violet : la carte automatique (zones, obliques et divergences RSI de l'algorithme, corrigées par l'IA) et les niveaux de ses setups. À montrer ou masquer.",
      voice: "cherche-moi des setups sur l'or",
    },
    alerts: {
      group: "Alertes",
      title: "Alertes",
      text: "À un prix ou sur un tracé : au franchissement, une fois par bougie, à la clôture, ou à la clôture après contact. Surveillées par le serveur, même page fermée ; Alt+A au prix pointé.",
      voice: "préviens-moi si l'or passe 2 700",
    },
  };
}

/** Largeur d'une bulle, en px. */
export const TIP_W = 250;

/**
 * Le bord gauche d'une bulle centrée sur un bouton, gardée dans la largeur de
 * l'encart (`width`), à 4 px des bords quand c'est possible.
 */
export function tipLeft(center: number, width: number, tipW = TIP_W): number {
  return Math.max(4, Math.min(center - tipW / 2, width - tipW - 4));
}
