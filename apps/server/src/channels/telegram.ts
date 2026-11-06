import { Injectable } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import type { OutboundChannel, OutboundMessage, SendOutcome } from "./channel.js";

/** La requête que l'API Bot reçoit : du JSON, ou un formulaire pour une image. */
export interface HttpRequest {
  method: "POST";
  headers?: Record<string, string>;
  body: string | FormData;
  signal?: AbortSignal;
}

/** Le client HTTP : fetch, remplacé en test par un faux (aucun réseau). */
export type HttpClient = (url: string, init: HttpRequest) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Réponse de l'API Bot : `ok`, sinon pourquoi, et l'attente demandée quand on écrit trop vite. */
interface BotReply {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Longueur maximale d'un message, et de la légende d'une image (Telegram). */
export const TELEGRAM_TEXT_MAX = 4096;
export const TELEGRAM_CAPTION_MAX = 1024;
/** Attentes avant la deuxième et la troisième tentative, quand le réseau ou Telegram flanche. */
export const TELEGRAM_RETRY_DELAYS_MS = [2_000, 8_000];
/** Attente au plus demandée par Telegram (trop de messages d'un coup) qu'on accepte de respecter. */
const MAX_RETRY_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Messages en attente au plus : au-delà (réseau coupé longtemps), les nouveaux sont abandonnés. */
const QUEUE_MAX = 30;

export const TELEGRAM_NOT_CONFIGURED =
  "Telegram n'est pas configuré : il manque le jeton du bot (KOPILIA_TELEGRAM_TOKEN) ou l'identifiant de la discussion (KOPILIA_TELEGRAM_CHAT_ID) dans le fichier .env de Kopilia";

/** Un appel de l'API Bot : sa méthode et de quoi construire son corps (refait à chaque tentative). */
interface Call {
  method: "sendMessage" | "sendPhoto";
  body: () => Pick<HttpRequest, "headers" | "body">;
}

/**
 * Le canal Telegram : un bot (créé par l'utilisateur avec BotFather) écrit
 * par l'API Bot (sendMessage, sendPhoto) dans son canal technique, privé (ce
 * qui part de soi-même), ou dans un autre de ses canaux, nommé (sendTo).
 * Désactivé sans jeton ni identifiant de discussion. Les messages partent un
 * par un, dans l'ordre ; un échec du réseau, une erreur de Telegram ou une
 * demande d'attente donnent lieu à deux nouvelles tentatives, un refus (jeton,
 * discussion) non. Rien ne bloque le reste du serveur, et le jeton n'apparaît
 * dans aucun journal ni message d'erreur.
 */
@Injectable()
export class TelegramChannel implements OutboundChannel {
  readonly name = "telegram";
  http: HttpClient = (url, init) => fetch(url, init);
  wait: (ms: number) => Promise<void> = (ms) => sleep(ms);
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  get enabled(): boolean {
    return !!this.config.telegramToken && !!this.config.telegramChatId;
  }

  /** Vers le canal technique. */
  send(message: OutboundMessage): Promise<SendOutcome> {
    return this.sendTo(this.config.telegramChatId, message);
  }

  /** Vers une discussion donnée (son identifiant), à la suite des autres messages. */
  sendTo(chat: string, message: OutboundMessage): Promise<SendOutcome> {
    if (!this.config.telegramToken || !chat) return Promise.resolve({ ok: false, error: TELEGRAM_NOT_CONFIGURED });
    if (!message.text.trim() && !message.title?.trim() && !message.image) return Promise.resolve({ ok: false, error: "message vide" });
    if (this.pending >= QUEUE_MAX) {
      this.logger.warn(`Telegram : ${this.pending} messages en attente, celui-ci est abandonné`, "telegram");
      return Promise.resolve({ ok: false, error: "trop de messages Telegram en attente (réseau coupé ?)" });
    }
    this.pending++;
    const run = this.queue.then(() => this.deliver(chat, message)).finally(() => this.pending--);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async deliver(chat: string, message: OutboundMessage): Promise<SendOutcome> {
    try {
      for (const call of this.calls(chat, message)) {
        const outcome = await this.call(call);
        if (!outcome.ok) {
          this.logger.warn(`Telegram : message non envoyé (${outcome.error})`, "telegram");
          return outcome;
        }
      }
      this.logger.debug(`Telegram : envoyé${message.title ? ` (${message.title})` : ""}`, "telegram");
      return { ok: true };
    } catch (e) {
      const error = this.clean((e as Error).message);
      this.logger.warn(`Telegram : message non envoyé (${error})`, "telegram");
      return { ok: false, error };
    }
  }

  /** Les appels d'un message : l'image avec sa légende si elle tient, sinon le texte (découpé), puis l'image. */
  private calls(chat: string, message: OutboundMessage): Call[] {
    const caption = telegramHtml(message.title, message.text, message.footer);
    const texts = (photo: boolean) =>
      photo && caption.length <= TELEGRAM_CAPTION_MAX
        ? []
        : telegramChunks(message.title, message.text, TELEGRAM_TEXT_MAX, message.footer).map((text) => this.textCall(chat, text));
    if (!message.image) return texts(false);
    const png = message.image;
    const withCaption = caption.length <= TELEGRAM_CAPTION_MAX && caption.length > 0;
    const photo: Call = {
      method: "sendPhoto",
      body: () => {
        const form = new FormData();
        form.set("chat_id", chat);
        form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "graphique.png");
        if (withCaption) {
          form.set("caption", caption);
          form.set("parse_mode", "HTML");
        }
        return { body: form };
      },
    };
    return [...texts(true), photo];
  }

  private textCall(chat: string, text: string): Call {
    return {
      method: "sendMessage",
      body: () => ({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      }),
    };
  }

  /** Un appel, avec ses nouvelles tentatives. */
  private async call(call: Call): Promise<SendOutcome> {
    const url = `${this.config.telegramApiUrl}/bot${this.config.telegramToken}/${call.method}`;
    let error = "";
    for (let attempt = 0; attempt <= TELEGRAM_RETRY_DELAYS_MS.length; attempt++) {
      let delay = TELEGRAM_RETRY_DELAYS_MS[attempt] ?? 0;
      try {
        const res = await this.http(url, { method: "POST", ...call.body(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const reply = ((await res.json().catch(() => ({}))) ?? {}) as BotReply;
        if (res.status < 300 && reply.ok !== false) return { ok: true };
        error = `Telegram a répondu ${res.status}${reply.description ? ` : ${this.clean(reply.description)}` : ""}`;
        if (res.status === 429) delay = Math.min(MAX_RETRY_AFTER_MS, Math.max(delay, (reply.parameters?.retry_after ?? 0) * 1000));
        // Jeton refusé, discussion introuvable, bot exclu, message mal formé : une nouvelle tentative n'y changerait rien.
        else if (res.status < 500) return { ok: false, error: refusal(res.status, error) };
      } catch (e) {
        error = `réseau : ${this.clean(networkError(e))}`;
      }
      if (attempt < TELEGRAM_RETRY_DELAYS_MS.length) {
        this.logger.debug(`Telegram : ${error} ; nouvel essai dans ${Math.round(delay / 1000)} s`, "telegram");
        await this.wait(delay);
      }
    }
    return { ok: false, error };
  }

  /** Un message d'erreur sans le jeton (une adresse de l'API Bot le contient). */
  private clean(text: string): string {
    const token = this.config.telegramToken;
    return token ? text.split(token).join("***") : text;
  }
}

/** Un refus de Telegram, avec ce qu'il faut vérifier. */
function refusal(status: number, error: string): string {
  if (status === 401 || status === 404) return `${error} (jeton du bot refusé : vérifie KOPILIA_TELEGRAM_TOKEN dans .env)`;
  if (status === 400 || status === 403)
    return `${error} (vérifie KOPILIA_TELEGRAM_CHAT_ID, et que le bot est membre de la discussion, administrateur s'il s'agit d'un canal)`;
  return error;
}

/** « fetch failed (ENOTFOUND) », « The operation was aborted due to timeout ». */
function networkError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string; errors?: Array<{ code?: string }> } };
  const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? err.cause?.message;
  return `${err.message}${code ? ` (${code})` : ""}`;
}

/** Le texte pour le mode HTML de Telegram : seuls &, < et > sont à échapper. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Le titre en gras, puis le texte, échappés ; la mention en italique, après une ligne vide. */
export function telegramHtml(title: string | undefined, text: string, footer?: string): string {
  const head = title?.trim() ? `<b>${escapeHtml(title.trim())}</b>` : "";
  const body = [head, escapeHtml(text.trim())].filter(Boolean).join("\n");
  return footer?.trim() ? [body, footerHtml(footer)].filter(Boolean).join("\n\n") : body;
}

function footerHtml(footer: string): string {
  return `<i>${escapeHtml(footer.trim())}</i>`;
}

/**
 * Le message découpé en morceaux d'au plus 4 096 caractères, une fois échappé :
 * aux sauts de ligne, sinon entre deux mots, sinon dans le mot. Le titre ouvre
 * le premier morceau (la place lui est gardée dans chacun, pour rester simple).
 * Le texte est découpé avant d'être échappé : un « &amp; » n'est jamais coupé.
 * La mention (`footer`), en italique, ferme le dernier morceau.
 */
export function telegramChunks(title: string | undefined, text: string, max = TELEGRAM_TEXT_MAX, footer?: string): string[] {
  const head = title?.trim() ? `<b>${escapeHtml(title.trim().slice(0, 200))}</b>` : "";
  // La mention ferme le dernier morceau : sa place est gardée dans chacun, comme celle du titre.
  const tail = footer?.trim() ? footerHtml(footer.slice(0, 300)) : "";
  const room = max - (head ? head.length + 1 : 0) - (tail ? tail.length + 2 : 0);
  const size = (s: string) => escapeHtml(s).length;
  const pieces: string[] = [];
  let current = "";
  const push = (part: string, sep: string) => {
    if (current && size(current) + sep.length + size(part) <= room) current += sep + part;
    else {
      if (current) pieces.push(current);
      current = part;
    }
  };
  for (const line of text.trim().split("\n")) {
    if (size(line) <= room) {
      push(line, "\n");
      continue;
    }
    // Une ligne trop longue : mot à mot, et un mot trop long, coupé.
    let sep = "\n";
    for (const word of line.split(" ")) {
      let w = word;
      while (size(w) > room) {
        let n = Math.min(w.length, room);
        while (n > 1 && size(w.slice(0, n)) > room) n--;
        push(w.slice(0, n), sep);
        w = w.slice(n);
        sep = " ";
      }
      if (w) push(w, sep);
      sep = " ";
    }
  }
  if (current) pieces.push(current);
  const out = pieces.map(escapeHtml);
  if (head) {
    if (out.length) out[0] = `${head}\n${out[0]}`;
    else out.push(head);
  }
  if (tail) {
    if (out.length) out[out.length - 1] += `\n\n${tail}`;
    else out.push(tail);
  }
  return out;
}
