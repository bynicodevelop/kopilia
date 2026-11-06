import type { WebSocket } from "ws";

/** Un écran connecté (une page ouverte sur une session). */
export interface Conn {
  ws: WebSocket;
  sessionId: string;
  deltaSeq: number;
  /** eventIds déjà traités (idempotence après reconnexion). */
  seen: Set<string>;
  /** Dernier tour lancé : un tour plus ancien (interrompu) ne pilote plus l'état. */
  latestTurn: string;
  /** L'utilisateur a coupé Kopilia : le tour suivant le signale à Claude. */
  cutNote: boolean;
  /** Sa réponse au clic à un ticket, que le tour suivant signale à Claude (un refus : rien n'est parti). */
  clickNote?: string;
  /** Énoncés en cours (ouverts, pas encore transcrits) : l'utilisateur parle. */
  openUtterances: Set<number>;
  /** L'écran peut faire parler Kopilia (premier geste dans la page : son autorisé, micro ouvert) : il peut lui parler de lui-même. */
  inCall: boolean;
  /** Micro coupé : l'utilisateur parle à quelqu'un d'autre, Kopilia ne s'invite pas. */
  muted: boolean;
  /** Page cachée (un autre onglet, fenêtre réduite) : l'utilisateur ne la regarde pas. */
  hidden: boolean;
  /**
   * Une phrase qui avait l'air inachevée (« Envoie le ») : elle attend sa
   * suite un instant, pour partir avec elle en une seule demande.
   */
  held?: HeldPhrase;
}

/** Une phrase inachevée qui attend sa suite. */
export interface HeldPhrase {
  turnId: string;
  text: string;
  bargeIn: boolean;
  /** Le premier morceau est arrivé à cet instant (epoch ms) : l'attente a un plafond. */
  since: number;
  lang?: string;
  timer: NodeJS.Timeout;
}

/**
 * Associe un flux micro à une connexion. Un flux peut porter plusieurs prises
 * de parole (le VAD du worker STT segmente et émet un final par énoncé).
 */
export interface MicRoute {
  conn: Conn;
  baseTurnId: string;
  utter: number;
  /** L'utilisateur a pris la parole pendant que Kopilia parlait (lecture en pause). */
  bargeIn: boolean;
  /** Dite en maintenant la touche : relâcher clôt la phrase, elle n'attend jamais de suite. */
  ptt: boolean;
}
