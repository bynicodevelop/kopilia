/**
 * Regroupe les deltas texte de l'assistant en phrases pour la synthèse, et
 * retire de la synthèse les blocs de code, journaux, appels d'outils et
 * secrets. Le texte technique complet reste affiché à l'écran (deltas bruts) ;
 * seule l'entrée du TTS est nettoyée.
 */

const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`]*`/g;
const TOOL_CALL = /<\/?(?:tool_use|tool_result|function_calls?|invoke|parameter)[^>]*>/gi;
// Jetons ressemblant à des secrets (clés, tokens) : on ne les prononce pas.
const SECRET_LIKE = /\b(?:sk-[A-Za-z0-9-_]{8,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/g;
// Lignes de journal typiques (timestamps / niveaux).
const LOG_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[(?:DEBUG|INFO|WARN|ERROR)\]|at\s+\w+).*$/gim;

export function sanitizeForSpeech(text: string): string {
  return text
    .replace(FENCE, " ")
    .replace(TOOL_CALL, " ")
    .replace(SECRET_LIKE, " ")
    .replace(LOG_LINE, " ")
    .replace(INLINE_CODE, (m) => m.replace(/`/g, ""))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Abréviations après lesquelles un point ne termine pas la phrase. */
const ABBREVIATIONS = new Set(["p", "mm", "mme", "env", "cf", "av", "apr", "dr", "st", "ex", "vs", "no"]);
const CLOSERS = new Set(["»", '"', "'", ")", "]", "”", "’"]);

/**
 * Fin de phrase à l'indice `i` (une ponctuation) ? Renvoie l'indice de
 * coupure, `null` si ce n'en est pas une, `undefined` s'il faut attendre la
 * suite. On coupe sur une ponctuation suivie d'un espace : jamais au milieu
 * de « 4.85 » ou « U.S.A. », ni après une initiale ou une abréviation
 * (« M. Powell », « p. ex. »).
 */
function sentenceEnd(buf: string, i: number): number | null | undefined {
  let k = i;
  while (k < buf.length && /[.!?…]/.test(buf[k])) k++;
  // Guillemet fermant compris, même précédé d'une espace (« oui. »).
  while (k < buf.length) {
    if (CLOSERS.has(buf[k])) k++;
    else if (/[ \u00A0\u202F]/.test(buf[k]) && buf[k + 1] === "»") k += 2;
    else break;
  }
  if (k >= buf.length) return undefined;
  if (!/\s/.test(buf[k])) return null;
  if (buf.slice(i, k).replace(/[^.!?…]/g, "") === ".") {
    // Initiale (« M. », « J. Powell ») ou abréviation ; « 16 h. » finit bien la phrase.
    const word = buf.slice(0, i).match(/(\p{L}+)$/u)?.[1] ?? "";
    const initial = word.length === 1 && word !== word.toLowerCase();
    if (initial || ABBREVIATIONS.has(word.toLowerCase())) return null;
  }
  return k;
}

/**
 * Une phrase : `text` tel qu'écrit (bout exact du texte affiché, espaces
 * compris : mis bout à bout, les segments redonnent la réponse) et `speech`,
 * ce qui part à la synthèse (vide pour un bloc de code, par exemple).
 */
export interface Segment {
  text: string;
  speech: string;
}

/** Première phrase encore sans fin au-delà de tant de caractères : son début part à la synthèse dès une virgule. */
const FIRST_CLAUSE_AFTER = 60;
/** … pourvu que ce début ait au moins tant de caractères (« Oui, » reste avec la suite). */
const FIRST_CLAUSE_MIN = 20;

export class SentenceGrouper {
  private buf = "";
  /** Un segment au moins est parti : la coupe à la virgule ne vaut que pour le premier. */
  private started = false;

  /** Ajoute un delta et renvoie les phrases complètes. */
  push(delta: string): Segment[] {
    this.buf += delta;
    const out: Segment[] = [];
    let start = 0;
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      let cut: number | null | undefined = null;
      if (c === "\n") cut = i + 1;
      else if (/[.!?…]/.test(c)) cut = sentenceEnd(this.buf, i);
      if (cut === undefined) break; // ponctuation en fin de tampon : on attend la suite
      if (cut === null) {
        i++;
        continue;
      }
      const text = this.buf.slice(start, cut);
      out.push({ text, speech: sanitizeForSpeech(text) });
      start = i = cut;
    }
    this.buf = this.buf.slice(start);
    if (!this.started && !out.length) {
      const clause = this.firstClause();
      if (clause) out.push(clause);
    }
    if (out.length) this.started = true;
    return out;
  }

  /**
   * Une longue première phrase retarde d'autant le premier son : Kokoro la
   * synthétise en entier avant de la jouer (0,3 s pour 23 caractères, 1,4 s
   * pour 166). Son début part donc seul, jusqu'à une virgule ; la suite est
   * synthétisée pendant qu'il est dit. Jamais dans un nombre (« 4 065,31 »),
   * ni au milieu de code.
   */
  private firstClause(): Segment | null {
    if (this.buf.length < FIRST_CLAUSE_AFTER || this.buf.includes("`")) return null;
    const comma = /[,;:](?=\s)/g;
    comma.lastIndex = FIRST_CLAUSE_MIN - 1;
    const hit = comma.exec(this.buf);
    if (!hit) return null;
    const text = this.buf.slice(0, hit.index + 1);
    this.buf = this.buf.slice(hit.index + 1);
    return { text, speech: sanitizeForSpeech(text) };
  }

  /** Vide le reliquat en fin de tour. */
  flush(): Segment | null {
    const text = this.buf;
    this.buf = "";
    return text ? { text, speech: sanitizeForSpeech(text) } : null;
  }
}
