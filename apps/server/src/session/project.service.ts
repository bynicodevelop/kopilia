import { Injectable } from "@nestjs/common";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { DatabaseService } from "../db/database.service.js";
import { ConfigService } from "../config/config.service.js";
import { newId } from "../common/ids.js";

export interface ProjectRow {
  id: string;
  path: string;
  label: string;
  authorized: number;
  created_at: number;
}

/**
 * Paquets macOS : techniquement des dossiers, mais ce sont des documents
 * (MindNode, Keynote…), pas des projets.
 */
const PACKAGE_DIR = /\.(mindnode|app|bundle|pages|numbers|key|photoslibrary|fcpbundle|logicx|band|rtfd|scriv|xcodeproj|xcworkspace|playground)$/i;

/**
 * L'espace de travail de Kopilia est un dossier racine (Documents) dont chaque
 * sous-dossier est un projet. La table `projects` sert de registre des dossiers
 * dans lesquels un ouvrier a travaillé (référencée par les tâches).
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  get(id: string): ProjectRow | undefined {
    return this.db.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  /** Projets disponibles : sous-dossiers visibles de l'espace de travail. */
  listFolders(): string[] {
    return readdirSync(this.config.workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !PACKAGE_DIR.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, "fr"));
  }

  /**
   * Résout un sous-dossier de l'espace de travail (vide = la racine). Suit les
   * liens symboliques et refuse tout chemin qui sortirait des racines autorisées.
   */
  resolveFolder(folder?: string): string {
    const name = folder?.trim() ?? "";
    const target = name ? resolve(this.config.workspaceRoot, name) : this.config.workspaceRoot;
    let canonical: string;
    try {
      canonical = realpathSync(target);
    } catch {
      throw new Error(`dossier introuvable : ${name}`);
    }
    if (!statSync(canonical).isDirectory()) throw new Error(`pas un dossier : ${name}`);
    if (!this.config.isPathAllowed(canonical)) throw new Error(`dossier hors de l'espace autorisé : ${name}`);
    return canonical;
  }

  /** Libellé lisible d'un dossier, p.ex. « Documents/Kopilia ». */
  folderLabel(dir: string): string {
    const root = this.config.workspaceRoot;
    const rel = relative(root, dir);
    return rel ? `${basename(root)}/${rel}` : basename(root);
  }

  /** Enregistre un dossier (chemin canonique, sous une racine autorisée). */
  register(dir: string, label?: string): ProjectRow {
    let canonical: string;
    try {
      canonical = realpathSync(dir);
    } catch {
      throw new Error(`répertoire introuvable: ${dir}`);
    }
    if (!statSync(canonical).isDirectory()) throw new Error(`pas un répertoire: ${canonical}`);
    if (!this.config.isPathAllowed(canonical)) {
      throw new Error(`chemin hors des racines autorisées: ${canonical}`);
    }
    const existing = this.db.db.prepare("SELECT * FROM projects WHERE path = ?").get(canonical) as ProjectRow | undefined;
    if (existing) return existing;
    const row: ProjectRow = {
      id: newId("proj"),
      path: canonical,
      label: label ?? this.folderLabel(canonical),
      authorized: 1,
      created_at: Date.now(),
    };
    this.db.db.prepare("INSERT INTO projects (id, path, label, authorized, created_at) VALUES (@id,@path,@label,@authorized,@created_at)").run(row);
    return row;
  }
}
