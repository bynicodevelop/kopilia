import type { TelegramChannelConfig } from "../config/config.service.js";
import { newId } from "../common/ids.js";
import type { OutboundMessage } from "./channel.js";

/*
 * Les canaux Telegram de l'utilisateur, tels qu'il les nomme à la voix : son
 * canal technique, privé (par défaut), et ses autres canaux, publics, nommés
 * dans .env. Un message pour un canal public attend son accord : il est gardé
 * en aperçu, puis publié tel quel.
 */

export type TelegramTarget = { kind: "technical" } | { kind: "public"; name: string; chat: string };

/** Ce qui désigne le canal technique (après normalisation) : rien, ou l'un de ces mots. */
const TECHNICAL = new Set(["", "technique", "tech", "prive", "perso", "personnel", "moi", "principal"]);
/** Les mots qui entourent un nom de canal dans une phrase (« sur mon canal public »). */
const FILLER = new Set(["le", "la", "les", "l", "mon", "ma", "mes", "du", "de", "d", "sur", "dans", "canal", "canaux", "groupe", "telegram", "chaine"]);

/** « sur le Canal Public » -> « public » : minuscules, sans accents ni mots de liaison. */
export function normalizeChannelName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}

/** Le canal désigné : le technique par défaut, sinon un canal nommé ; une erreur qui liste les noms connus. */
export function resolveTelegramTarget(ref: string | undefined, channels: TelegramChannelConfig[]): TelegramTarget | { error: string } {
  const q = normalizeChannelName(ref ?? "");
  if (TECHNICAL.has(q)) return { kind: "technical" };
  const named = channels.map((c) => ({ ...c, key: normalizeChannelName(c.name) }));
  const found = named.find((c) => c.key === q) ?? named.find((c) => c.key && (q.split(" ").includes(c.key) || c.key.includes(q)));
  if (found) return { kind: "public", name: found.name, chat: found.chat };
  if (q.split(" ").includes("public") && channels.length === 1) return { kind: "public", ...channels[0] };
  const known = ["technique", ...channels.map((c) => c.name)].join(", ");
  return { error: `aucun canal Telegram « ${(ref ?? "").trim()} » ; canaux connus : ${known}` };
}

/** Un message pour un canal public, en attente de l'accord de l'utilisateur. */
export interface TelegramDraft {
  id: string;
  name: string;
  chat: string;
  message: OutboundMessage;
  at: number;
}

/** Un aperçu reste publiable une demi-heure. */
export const DRAFT_TTL_MS = 30 * 60_000;
const MAX_DRAFTS = 10;

/** Les aperçus en attente : publiés une seule fois, tels qu'ils ont été montrés. */
export class TelegramDrafts {
  private drafts = new Map<string, TelegramDraft>();
  now: () => number = () => Date.now();

  add(d: Omit<TelegramDraft, "id" | "at">): TelegramDraft {
    this.prune();
    while (this.drafts.size >= MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value as string);
    const draft: TelegramDraft = { ...d, id: newId("tg"), at: this.now() };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  /** L'aperçu à publier (retiré : il ne part qu'une fois) ; rien s'il est inconnu ou périmé. */
  take(id: string): TelegramDraft | undefined {
    this.prune();
    const d = this.drafts.get(id);
    this.drafts.delete(id);
    return d;
  }

  private prune() {
    const limit = this.now() - DRAFT_TTL_MS;
    for (const [id, d] of this.drafts) if (d.at < limit) this.drafts.delete(id);
  }
}

/** Le message en texte, tel que Kopilia le relit : le titre, le texte, la mention. */
export function spokenDraft(m: OutboundMessage): string {
  return [m.title, m.text, m.footer]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("\n");
}
