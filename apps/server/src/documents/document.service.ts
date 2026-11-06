import { Injectable } from "@nestjs/common";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ClaudeContentBlock } from "@kopilia/contracts";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";
import { newId } from "../common/ids.js";

const run = promisify(execFile);

export type DocumentKind = "pdf" | "image" | "text";

export interface DocumentRow {
  id: string;
  session_id: string;
  name: string;
  kind: DocumentKind;
  media_type: string;
  path: string;
  size: number;
  pages: number | null;
  chars: number | null;
  inline: number;
  turn_id: string | null;
  created_at: number;
}

/** Un dépôt ne dépasse pas la taille maximale d'une requête de l'API (PDF compris). */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * Au-delà, un document est confié à un agent : dans le dialogue, il serait
 * renvoyé à chaque phrase et ralentirait toutes les réponses suivantes.
 */
const INLINE_MAX_PAGES = 10;
const INLINE_MAX_PDF_BYTES = 10 * 1024 * 1024;
const INLINE_MAX_CHARS = 40_000;
/** PDF dont le nombre de pages est inconnu : lu directement seulement s'il est petit. */
const INLINE_UNKNOWN_PDF_BYTES = 1024 * 1024;

/** Image envoyée telle quelle jusqu'à cette taille (l'API en accepte 5 Mo une fois en base64) ; au-delà, réduite. */
const IMAGE_MAX_BYTES = 3_750_000;
/** Côté le plus long d'une image réduite ou convertie (l'API la réduirait de toute façon). */
const IMAGE_MAX_SIDE = 2000;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Images converties en JPEG par sips (macOS) : photos d'iPhone, scans. */
const CONVERTED_IMAGES = new Set([".heic", ".heif", ".tif", ".tiff", ".bmp"]);
const TEXT_FILES = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".log", ".yaml", ".yml"]);
/** Convertis en texte par textutil (macOS). */
const WORD_FILES = new Set([".docx", ".doc", ".rtf", ".odt", ".html", ".htm"]);

/** Nombre de pages d'un PDF par PDFKit (macOS). */
const JXA_PAGE_COUNT =
  'ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); return d.isNil() ? 0 : d.pageCount; }';

/** Format refusé : le message est montré tel quel à l'utilisateur. */
export class UnsupportedDocumentError extends Error {}

interface Prepared {
  kind: DocumentKind;
  media_type: string;
  path: string;
  pages: number | null;
  chars: number | null;
  inline: boolean;
}

/**
 * Documents déposés dans la conversation (PDF, images, textes, Word). Chacun
 * attend la phrase suivante de l'utilisateur, qui l'emporte : un document
 * court est lu directement par le dialogue, un long est confié à un agent.
 * Les fichiers restent dans data/documents/<id>/.
 */
@Injectable()
export class DocumentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  /** Enregistre un document déposé ; il attend la phrase suivante de la session. */
  async add(sessionId: string, name: string, data: Buffer): Promise<DocumentRow> {
    const ext = extname(name).toLowerCase();
    const id = newId("doc");
    const dir = resolve(this.config.dataDir, "documents", id);
    mkdirSync(dir, { recursive: true });
    const original = join(dir, diskName(name));
    writeFileSync(original, data);
    try {
      const p = await prepare(original, ext, data);
      const row: DocumentRow = {
        id,
        session_id: sessionId,
        name,
        kind: p.kind,
        media_type: p.media_type,
        path: p.path,
        size: data.length,
        pages: p.pages,
        chars: p.chars,
        inline: p.inline ? 1 : 0,
        turn_id: null,
        created_at: Date.now(),
      };
      this.db.db
        .prepare(
          "INSERT INTO documents (id,session_id,name,kind,media_type,path,size,pages,chars,inline,turn_id,created_at) VALUES (@id,@session_id,@name,@kind,@media_type,@path,@size,@pages,@chars,@inline,@turn_id,@created_at)",
        )
        .run(row);
      this.logger.log(`document ${id} reçu : ${name} (${p.kind}${p.inline ? "" : ", confié à un agent"})`, "documents");
      return row;
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /** Documents en attente de la session : ils partent avec la phrase `turnId`. */
  take(sessionId: string, turnId: string): DocumentRow[] {
    return this.db.tx(() => {
      const rows = this.db.db
        .prepare("SELECT * FROM documents WHERE session_id = ? AND turn_id IS NULL ORDER BY created_at, rowid")
        .all(sessionId) as DocumentRow[];
      const mark = this.db.db.prepare("UPDATE documents SET turn_id = ? WHERE id = ?");
      for (const r of rows) {
        mark.run(turnId, r.id);
        r.turn_id = turnId;
      }
      return rows;
    });
  }

  /** Retire un document encore en attente (l'utilisateur l'a enlevé avant de parler). */
  remove(sessionId: string, id: string): boolean {
    const row = this.db.db.prepare("SELECT * FROM documents WHERE id = ? AND session_id = ? AND turn_id IS NULL").get(id, sessionId) as DocumentRow | undefined;
    if (!row) return false;
    this.db.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    rmSync(resolve(this.config.dataDir, "documents", id), { recursive: true, force: true });
    return true;
  }

  /** Documents de la session parmi `ids` (ceux d'une autre session sont ignorés). */
  find(sessionId: string, ids: string[]): DocumentRow[] {
    if (!ids.length) return [];
    return this.db.db
      .prepare(`SELECT * FROM documents WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
      .all(sessionId, ...ids) as DocumentRow[];
  }

  /**
   * Blocs du tour de dialogue, avant la phrase de l'utilisateur : le contenu
   * d'un document court, ou une note qui invite à confier un long à un agent.
   */
  content(docs: DocumentRow[]): ClaudeContentBlock[] {
    return docs.flatMap((d): ClaudeContentBlock[] => {
      if (!d.inline) {
        return [
          {
            type: "text",
            text: `[Document joint, trop long pour être lu ici : ${describeDocument(d)} (identifiant ${d.id}). Pour répondre à l'utilisateur, confie sa lecture à un agent avec ask_agent, en passant cet identifiant dans documents.]`,
          },
        ];
      }
      const head = `[Document joint : ${describeDocument(d)} (identifiant ${d.id})]`;
      let file: Buffer;
      try {
        file = readFileSync(d.path);
      } catch {
        return [{ type: "text", text: `[Document joint introuvable sur le disque : ${describeDocument(d)}. Dis-le à l'utilisateur.]` }];
      }
      if (d.kind === "text") return [{ type: "text", text: `${head}\n${file.toString("utf8")}` }];
      const data = file.toString("base64");
      if (d.kind === "pdf") {
        return [
          { type: "text", text: head },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: d.name },
        ];
      }
      return [
        { type: "text", text: head },
        { type: "image", source: { type: "base64", media_type: d.media_type, data } },
      ];
    });
  }
}

/** « « rapport.pdf », 42 pages » : le document tel que Kopilia et ses agents le désignent. */
export function describeDocument(d: { name: string; kind: DocumentKind; pages: number | null }): string {
  const pages = d.kind === "pdf" && d.pages ? `, ${d.pages} page${d.pages > 1 ? "s" : ""}` : "";
  return `« ${d.name} »${pages}`;
}

/** Ce que le dialogue ou un agent lira, selon le format du fichier. */
async function prepare(original: string, ext: string, data: Buffer): Promise<Prepared> {
  if (ext === ".pdf") {
    const pages = await pdfPageCount(original, data);
    const inline = pages !== null ? pages <= INLINE_MAX_PAGES && data.length <= INLINE_MAX_PDF_BYTES : data.length <= INLINE_UNKNOWN_PDF_BYTES;
    return { kind: "pdf", media_type: "application/pdf", path: original, pages, chars: null, inline };
  }
  if ((IMAGE_TYPES[ext] && data.length > IMAGE_MAX_BYTES) || CONVERTED_IMAGES.has(ext)) {
    return { kind: "image", media_type: "image/jpeg", path: await toJpeg(original), pages: null, chars: null, inline: true };
  }
  if (IMAGE_TYPES[ext]) {
    return { kind: "image", media_type: IMAGE_TYPES[ext], path: original, pages: null, chars: null, inline: true };
  }
  if (TEXT_FILES.has(ext) || WORD_FILES.has(ext)) {
    const path = WORD_FILES.has(ext) ? await toText(original) : original;
    const chars = readFileSync(path, "utf8").length;
    return { kind: "text", media_type: "text/plain", path, pages: null, chars, inline: chars <= INLINE_MAX_CHARS };
  }
  throw new UnsupportedDocumentError(`format non pris en charge (${ext || "fichier sans extension"}) : PDF, image, texte ou Word`);
}

/**
 * Nombre de pages d'un PDF : PDFKit (macOS), sinon les objets /Page du
 * fichier (incomplet si le PDF compresse sa structure) ; null si inconnu.
 */
export async function pdfPageCount(path: string, data: Buffer): Promise<number | null> {
  try {
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", JXA_PAGE_COUNT, path], { timeout: 10_000 });
    const n = Number(stdout.trim());
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    /* hors macOS, ou PDF que PDFKit n'ouvre pas */
  }
  return data.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length || null;
}

/** JPEG d'au plus IMAGE_MAX_SIDE pixels de côté, par sips (macOS). */
async function toJpeg(src: string): Promise<string> {
  const out = `${src}.jpg`;
  try {
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", src], { timeout: 20_000 });
    const side = Math.max(...[...stdout.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
    const args = ["-s", "format", "jpeg", "-s", "formatOptions", "85"];
    // -Z agrandirait aussi une petite image : seulement pour réduire.
    if (side > IMAGE_MAX_SIDE) args.push("-Z", String(IMAGE_MAX_SIDE));
    await run("sips", [...args, src, "--out", out], { timeout: 30_000 });
    statSync(out);
  } catch {
    throw new UnsupportedDocumentError("image illisible ou format d'image non pris en charge");
  }
  return out;
}

/** Texte d'un document Word, RTF, OpenDocument ou HTML, par textutil (macOS). */
async function toText(src: string): Promise<string> {
  const out = `${src}.txt`;
  try {
    await run("textutil", ["-convert", "txt", "-encoding", "UTF-8", "-output", out, src], { timeout: 30_000 });
    statSync(out);
  } catch {
    throw new UnsupportedDocumentError("document illisible : impossible d'en extraire le texte");
  }
  return out;
}

/** Nom de fichier sûr sur le disque (le nom d'origine est gardé en base). */
function diskName(name: string): string {
  const ext = extname(name)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "");
  const stem = basename(name, extname(name))
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^[.\s]+/, "")
    .slice(0, 100);
  return `${stem || "document"}${ext}`;
}
