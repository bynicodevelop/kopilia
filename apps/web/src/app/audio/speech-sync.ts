/**
 * Affichage de la réponse au rythme de la voix. Le serveur repère chaque
 * phrase (`speech.segment`) juste avant son audio : on la cale sur l'horloge
 * de lecture, au début de sa première tranche, puis on la révèle mot à mot au
 * prorata de sa durée. Une pause de lecture (l'utilisateur parle) gèle
 * l'horloge, donc le texte. Une phrase muette (bloc de code) s'affiche à la
 * suite de la précédente.
 */

/** Le texte devance à peine la voix : le mot apparaît quand il commence à être dit. */
const LEAD_S = 0.12;

interface Phrase {
  text: string;
  silent: boolean;
  /** Début de son audio sur l'horloge de lecture (inconnu tant qu'aucune tranche n'est programmée). */
  startAt: number | null;
  duration: number;
}

export class SpeechSync {
  private phrases = new Map<number, Phrase>();
  /** Phrase repérée dont la première tranche audio n'est pas encore arrivée. */
  private awaitingAudio?: Phrase;
  /** Phrase qui reçoit les tranches audio en cours. */
  private current?: Phrase;
  private full = "";
  private all = false;
  /** Déjà affiché : l'affichage ne recule jamais (durée encore incomplète, p.ex.). */
  private shown = "";

  /** Texte reçu (deltas), affiché ou non. */
  get text(): string {
    return this.full;
  }

  get revealedAll(): boolean {
    return this.all;
  }

  addText(delta: string): void {
    this.full += delta;
  }

  /** Repère d'une phrase ; son audio suit (sauf phrase muette). */
  mark(index: number, text: string, silent = false): void {
    const phrase: Phrase = { text, silent, startAt: null, duration: 0 };
    this.phrases.set(index, phrase);
    if (!silent) this.awaitingAudio = phrase;
  }

  /** Une tranche audio vient d'être programmée à `startAt` (horloge de lecture), pour `duration` secondes. */
  audio(startAt: number, duration: number): void {
    if (this.awaitingAudio) {
      this.awaitingAudio.startAt = startAt;
      this.current = this.awaitingAudio;
      this.awaitingAudio = undefined;
    }
    // Sans phrase repérée (phrase d'attente « Je regarde ça. »), rien à afficher.
    if (this.current) this.current.duration += duration;
  }

  /** Tout afficher : fin de la réponse, coupure, ou pas de voix. */
  revealAll(): void {
    this.all = true;
  }

  /** Texte à afficher à l'instant `t` de l'horloge de lecture. */
  visible(t: number): string {
    if (this.all) return (this.shown = this.full);
    let out = "";
    for (let i = 0; this.phrases.has(i); i++) {
      const p = this.phrases.get(i)!;
      if (p.silent) {
        out += p.text;
        continue;
      }
      if (p.startAt === null) break;
      const elapsed = t + LEAD_S - p.startAt;
      if (elapsed <= 0) break;
      if (p.duration > 0 && elapsed >= p.duration) {
        out += p.text;
        continue;
      }
      out += revealWords(p.text, p.duration > 0 ? elapsed / p.duration : 0);
      break;
    }
    if (out.length > this.shown.length) this.shown = out;
    return this.shown;
  }
}

/** Début de `text` jusqu'au bout du mot en cours, à la proportion `p` (0..1) de sa lecture. */
export function revealWords(text: string, p: number): string {
  const at = Math.floor(Math.min(1, Math.max(0, p)) * text.length);
  const nextSpace = text.slice(at).search(/\s/);
  return nextSpace < 0 ? text : text.slice(0, at + nextSpace);
}
