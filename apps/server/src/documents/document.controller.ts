import {
  BadRequestException,
  Controller,
  Delete,
  Headers,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UseGuards,
} from "@nestjs/common";
import { SessionGuard } from "../http/session.guard.js";
import type { Request } from "express";
import { basename } from "node:path";
import { DocumentRow, DocumentService, MAX_DOCUMENT_BYTES, UnsupportedDocumentError } from "./document.service.js";

/**
 * Dépôt de documents par l'interface (même origine, loopback). Le fichier
 * arrive brut (application/octet-stream), son nom dans l'en-tête x-file-name ;
 * la session et son jeton, ceux du WebSocket, dans x-session-id et x-session-token.
 */
@Controller("api/documents")
@UseGuards(SessionGuard)
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Post()
  async upload(@Req() req: Request, @Headers("x-session-id") sessionId: string, @Headers("x-file-name") fileName?: string) {
    const session = sessionId; // vérifiée par SessionGuard
    const data = await readBody(req, MAX_DOCUMENT_BYTES);
    if (!data.length) throw new BadRequestException("fichier vide");
    try {
      return view(await this.documents.add(session, decodeName(fileName), data));
    } catch (e) {
      if (e instanceof UnsupportedDocumentError) throw new UnsupportedMediaTypeException(e.message);
      throw e;
    }
  }

  /** Retire un document encore en attente (déjà parti avec une phrase : introuvable). */
  @Delete(":id")
  remove(@Param("id") id: string, @Headers("x-session-id") sessionId: string) {
    if (!this.documents.remove(sessionId, id)) throw new NotFoundException("document introuvable ou déjà envoyé");
    return { removed: true };
  }
}

function view(d: DocumentRow) {
  return { documentId: d.id, name: d.name, kind: d.kind, size: d.size, pages: d.pages, inline: d.inline === 1 };
}

/** Nom d'origine (encodé par le navigateur), sans chemin. */
function decodeName(raw?: string): string {
  let name = "";
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    /* nom mal encodé */
  }
  return basename(name.replace(/\\/g, "/")).trim().slice(0, 200) || "document";
}

/** Corps brut de la requête ; au-delà de `limit`, il est lu jusqu'au bout puis refusé. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) reject(new PayloadTooLargeException(`document trop lourd (${Math.round(limit / 1024 / 1024)} Mo au plus)`));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
