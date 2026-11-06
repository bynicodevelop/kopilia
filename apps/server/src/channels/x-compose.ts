import { Injectable } from "@nestjs/common";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { newId } from "../common/ids.js";
import { appleText } from "../alerts/desktop-notifier.js";

/*
 * Poster sur X (ex-Twitter) sans l'API, payante : le lien officiel de
 * partage d'X (« web intent ») ouvre la fenêtre de post, le texte déjà écrit,
 * dans le navigateur où l'utilisateur est connecté. Ce lien ne prend aucune
 * image : le graphique va dans le presse-papiers du Mac, et l'utilisateur le
 * colle. C'est lui qui clique Poster : Kopilia ne publie jamais rien sur X.
 */

/** Le lien de partage d'X (docs.x.com, « Web Intent »). */
export const X_INTENT_URL = "https://x.com/intent/tweet";
/** Un lien compte toujours pour 23 signes sur X, quelle que soit sa longueur (raccourci en t.co). */
export const X_URL_WEIGHT = 23;

export const X_NOT_AVAILABLE =
  "X n'est pas disponible ici : Kopilia ouvre la fenêtre de post dans le navigateur du Mac où il tourne (réglage KOPILIA_X_COMPOSE du fichier .env)";

/** Les caractères qui comptent pour un signe sur X ; tous les autres (émojis, idéogrammes, espace fine insécable…) pour deux. */
const SINGLE_WEIGHT: Array<[number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const URL_PATTERN = /https?:\/\/\S+/g;

/** La longueur d'un post comptée comme X la compte (règles de twitter-text, simplifiées) : un lien = 23, un émoji = 2. */
export function xLength(text: string): number {
  const s = text.normalize("NFC");
  const links = s.match(URL_PATTERN)?.length ?? 0;
  return links * X_URL_WEIGHT + s.split(URL_PATTERN).reduce((n, part) => n + weightedLength(part), 0);
}

/** Un texte sans lien : un signe par caractère simple, deux pour un émoji ou un idéogramme (un caractère tel qu'on le voit). */
function weightedLength(s: string): number {
  let n = 0;
  for (const { segment } of new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(s)) {
    const cp = segment.codePointAt(0)!;
    n += SINGLE_WEIGHT.some(([a, b]) => cp >= a && cp <= b) ? [...segment].length : 2;
  }
  return n;
}

/** Le post tel qu'il s'ouvre : le texte, puis la mention en bas, séparée par une ligne vide. */
export function xPostText(text: string, footer: string): string {
  return [text.trim(), footer.trim()].filter(Boolean).join("\n\n");
}

/** Le lien qui ouvre la fenêtre de post d'X avec ce texte. */
export function xIntentUrl(text: string): string {
  return `${X_INTENT_URL}?text=${encodeURIComponent(text)}`;
}

/** Le script AppleScript qui met une image PNG (un fichier) dans le presse-papiers du Mac. */
export function clipboardScript(pngPath: string): string {
  return `set the clipboard to (read (POSIX file ${appleText(pngPath)}) as «class PNGf»)`;
}

/** Ce qu'il est advenu : la fenêtre ouverte, et le graphique copié ou non (pourquoi) ; sinon, pourquoi rien ne s'est ouvert. */
export type ComposeOutcome = { ok: true; imageCopied: boolean; imageError?: string } | { ok: false; error: string };

/**
 * Ouvre la fenêtre de post d'X sur le Mac : `open` lance le navigateur par
 * défaut sur le lien de partage, après avoir mis le graphique dans le
 * presse-papiers (osascript). Sans graphique copié, la fenêtre s'ouvre
 * quand même, avec le texte. Rien ne part sur le réseau depuis le serveur.
 */
@Injectable()
export class XComposer {
  /** Lance une commande du Mac ; remplacée en test (ni navigateur ni presse-papiers). */
  run: (file: string, args: string[]) => Promise<void> = (file, args) =>
    new Promise((resolve, reject) => execFile(file, args, { timeout: 10_000 }, (e) => (e ? reject(e) : resolve())));

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  get enabled(): boolean {
    return this.config.xCompose;
  }

  async open(text: string, image?: Buffer): Promise<ComposeOutcome> {
    if (!this.enabled) return { ok: false, error: X_NOT_AVAILABLE };
    // Le presse-papiers d'abord : l'image est prête quand la fenêtre apparaît.
    const imageError = image ? await this.copyImage(image) : undefined;
    try {
      await this.run("open", [xIntentUrl(text)]);
    } catch (e) {
      this.logger.warn(`fenêtre de post d'X non ouverte : ${(e as Error).message}`, "channels");
      return { ok: false, error: `le navigateur ne s'est pas ouvert (${(e as Error).message})` };
    }
    return { ok: true, imageCopied: !!image && !imageError, ...(imageError ? { imageError } : {}) };
  }

  /** Copie le PNG dans le presse-papiers par un fichier temporaire, effacé ensuite ; l'erreur, s'il y en a une. */
  private async copyImage(png: Buffer): Promise<string | undefined> {
    const file = join(tmpdir(), `${newId("kopilia-x")}.png`);
    try {
      await writeFile(file, png);
      await this.run("osascript", ["-e", clipboardScript(file)]);
      return undefined;
    } catch (e) {
      const message = (e as Error).message;
      this.logger.warn(`graphique non copié dans le presse-papiers : ${message}`, "channels");
      return message;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
}
