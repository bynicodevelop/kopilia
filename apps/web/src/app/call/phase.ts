/**
 * Ce que montre l'écran d'après l'état de la voix : la phase (orbe, ligne
 * d'aide), le droit de couper la parole. Fonctions pures, testées à plat.
 */
import { PTT_KEY } from "./push-to-talk";

/**
 * Phase affichée. Avant le premier geste dans la page (le navigateur ne
 * laisse pas encore Kopilia parler) : `ready`. Ensuite : `listening` (prêt,
 * touche relâchée), `hearing` (touche tenue, tu parles), `thinking`,
 * `speaking` (Kopilia parle).
 */
export type Phase = "offline" | "ready" | "listening" | "hearing" | "thinking" | "speaking";

export interface CallState {
  connected: boolean;
  /** Le micro est ouvert et le son autorisé (premier geste fait) : Kopilia peut parler et t'entendre. */
  armed: boolean;
  /** La touche est tenue : ta phrase s'enregistre. */
  userSpeaking: boolean;
  /** Lecture de Kopilia en pause : tu as pris la parole, on attend ta phrase. */
  holding: boolean;
  /** Kopilia est audible. */
  speaking: boolean;
  /** État du serveur (state.changed). */
  state: string;
}

export function phaseOf(s: CallState): Phase {
  if (!s.connected) return "offline";
  if (!s.armed) return "ready";
  if (s.userSpeaking) return "hearing";
  if (s.holding) return "thinking";
  // Le serveur peut avoir fini d'envoyer alors que la réponse s'entend encore.
  if (s.speaking) return "speaking";
  if (s.state === "thinking" || s.state === "transcribing") return "thinking";
  if (s.state === "speaking") return "speaking";
  return "listening";
}

/**
 * Kopilia prépare ou dit une réponse : on peut lui couper la parole. Pas pendant
 * la transcription de sa propre phrase (rien encore à couper : c'est le
 * serveur qui l'interrompra si une nouvelle phrase arrive).
 */
export function canInterruptOf(s: Pick<CallState, "armed" | "speaking" | "state">): boolean {
  return s.armed && (s.speaking || s.state === "thinking" || s.state === "speaking");
}

/** La ligne d'aide sous l'orbe. `readyDocs` : documents déposés qui partiront avec la prochaine phrase. */
export function hintFor(phase: Phase, o: { readyDocs: number; micSupported: boolean }): string {
  const what = o.readyDocs > 1 ? "des documents" : "du document";
  switch (phase) {
    case "offline":
      return "Connexion à Kopilia…";
    case "ready":
    case "listening":
      if (!o.micSupported) return "Micro indisponible dans ce navigateur";
      return o.readyDocs ? `Maintiens ${PTT_KEY} et dis-moi quoi faire ${what}` : `Maintiens ${PTT_KEY} pour parler`;
    case "hearing":
      return "Je t'écoute… lâche pour envoyer";
    case "thinking":
      return "Je réfléchis…";
    case "speaking":
      return `Appuie sur ${PTT_KEY} pour m'arrêter`;
  }
}

/** Attente avant la reconnexion n° `retry` (0, 1, 2…) : 1 s, 2 s, 4 s… plafonnée à 10 s. */
export function reconnectDelay(retry: number): number {
  return Math.min(10_000, 1000 * 2 ** retry);
}
