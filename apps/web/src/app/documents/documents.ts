/** Un document déposé, en attente de la prochaine phrase de l'utilisateur. */
export interface DocView {
  /** Identifiant local, avant que le serveur n'attribue le sien. */
  localId: string;
  name: string;
  size: number;
  status: "uploading" | "ready";
  documentId?: string;
  pages?: number | null;
  /** Faux : trop long pour le dialogue, Kopilia le confiera à un agent. */
  inline?: boolean;
}

/** Taille maximale acceptée par le serveur. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Formats lus par Kopilia (proposés par le sélecteur de fichiers). */
export const ACCEPTED_DOCUMENTS = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".bmp",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".log",
  ".yaml",
  ".yml",
  ".docx",
  ".doc",
  ".rtf",
  ".odt",
  ".html",
  ".htm",
].join(",");

/** « 842 o », « 142 Ko », « 2,3 Mo ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

/** « PDF », « PNG », « DOCX » : la vignette montre le format. */
export function docType(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "DOC";
}

/** Ce qu'affiche la vignette sous le nom : envoi, pages ou taille, et la lecture par un agent. */
export function docMeta(d: DocView): string {
  if (d.status === "uploading") return "Envoi…";
  const what = d.pages ? `${d.pages} page${d.pages > 1 ? "s" : ""}` : formatSize(d.size);
  return d.inline === false ? `${what} · lu par un agent` : what;
}

/** Une capture collée s'appelle « image.png » : on lui donne un nom parlant. */
export function pastedName(name: string, now = new Date()): string {
  if (!/^image\.\w+$/i.test(name)) return name;
  const ext = name.slice(name.lastIndexOf("."));
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `Capture ${hh}h${mm}${ext}`;
}
