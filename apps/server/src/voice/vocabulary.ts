import { existsSync, readFileSync } from "node:fs";

/** Au-delà, l'amorce déborde la moitié du contexte texte de Whisper (224 jetons). */
export const PROMPT_MAX_CHARS = 500;

export interface Vocabulary {
  /** Termes transmis en amorce à Whisper (orthographe des noms propres, sigles). */
  terms: string[];
  /** Corrections appliquées au texte transcrit : [erreur, correction]. */
  replacements: Array<[string, string]>;
}

/**
 * Fichier de vocabulaire : un terme par ligne ; « erreur => correction » pour
 * une correction ; « # » = commentaire.
 */
export function parseVocabulary(text: string): Vocabulary {
  const vocab: Vocabulary = { terms: [], replacements: [] };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const arrow = line.indexOf("=>");
    if (arrow < 0) vocab.terms.push(line);
    else {
      const from = line.slice(0, arrow).trim();
      const to = line.slice(arrow + 2).trim();
      if (from && to) vocab.replacements.push([from, to]);
    }
  }
  return vocab;
}

export function readVocabularyFile(path: string): Vocabulary {
  return existsSync(path) ? parseVocabulary(readFileSync(path, "utf8")) : { terms: [], replacements: [] };
}

/**
 * Amorce de transcription (« initial prompt » de Whisper) : les termes, sans
 * doublon, séparés par des virgules, coupés à `max` caractères sur un terme
 * entier. Une liste courte et choisie marche mieux qu'une longue : chaque terme
 * superflu dilue les autres.
 */
export function buildSttPrompt(terms: string[], max = PROMPT_MAX_CHARS): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let length = 0;
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    const next = length + (out.length ? 2 : 0) + term.length;
    if (next + 1 > max) break;
    seen.add(key);
    out.push(term);
    length = next;
  }
  return out.length ? `${out.join(", ")}.` : "";
}

/** Applique les corrections sur des mots entiers, sans tenir compte de la casse. */
export function applyReplacements(text: string, replacements: Array<[string, string]>): string {
  let out = text;
  for (const [from, to] of replacements) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), to);
  }
  return out;
}
