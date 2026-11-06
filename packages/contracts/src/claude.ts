/**
 * Formes des événements stream-json émis par `claude -p --output-format
 * stream-json --verbose --include-partial-messages`, plus la ligne d'entrée.
 *
 * Ces types sont volontairement tolérants : le CLI évolue, donc on n'exige
 * que les champs effectivement consommés et on ignore le reste. La liste
 * exacte des événements de la version installée est capturée par
 * `scripts/record-claude-events.mjs` et consignée dans le rapport de recette.
 */

/** Bloc d'un tour utilisateur (format de l'API Messages) : texte, image ou PDF joints. */
export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

/** Ligne écrite sur stdin du CLI pour un tour utilisateur. */
export interface ClaudeUserInput {
  type: "user";
  message: {
    role: "user";
    content: string | ClaudeContentBlock[];
  };
}

/** Un texte seul, ou des blocs (documents joints puis texte). */
export function makeUserInput(content: string | ClaudeContentBlock[]): ClaudeUserInput {
  return { type: "user", message: { role: "user", content } };
}

/** Événement système d'initialisation (porte le session_id). */
export interface ClaudeSystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  [k: string]: unknown;
}

/** Message assistant (complet ou partiel selon --include-partial-messages). */
export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: string; text?: string }>;
  };
  session_id?: string;
  [k: string]: unknown;
}

/** Delta de flux (stream_event) lorsque les messages partiels sont activés. */
export interface ClaudeStreamEvent {
  type: "stream_event";
  event: {
    type: string;
    delta?: { type?: string; text?: string };
    [k: string]: unknown;
  };
  session_id?: string;
  [k: string]: unknown;
}

/** Résultat final du tour. */
export interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  [k: string]: unknown;
}

export type ClaudeStreamJsonEvent = ClaudeSystemInit | ClaudeAssistantEvent | ClaudeStreamEvent | ClaudeResultEvent | { type: string; [k: string]: unknown };

export function isSystemInit(e: ClaudeStreamJsonEvent): e is ClaudeSystemInit {
  return e.type === "system" && (e as ClaudeSystemInit).subtype === "init";
}
export function isResult(e: ClaudeStreamJsonEvent): e is ClaudeResultEvent {
  return e.type === "result";
}
