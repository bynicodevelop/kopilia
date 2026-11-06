import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseService } from "../src/db/database.service.js";
import { describeDocument, DocumentService, pdfPageCount, UnsupportedDocumentError } from "../src/documents/document.service.js";
import { documentsPrompt } from "../src/session/prompts.js";
import { minimalPdf, TINY_PNG } from "./fixtures.js";
import { insertSession, tempData, type TempData } from "./harness.js";

let data: TempData;
let dir: string;
let db: DatabaseService;
let docs: DocumentService;
const macOnly = { skip: !existsSync("/usr/bin/textutil") || !existsSync("/usr/bin/sips") ? "outils macOS absents" : false };

before(() => {
  data = tempData("docs");
  const { config, logger } = data;
  db = data.db;
  // Le dossier de données : les documents déposés y sont rangés.
  dir = join(data.root, "data");
  docs = new DocumentService(db, config, logger);
  for (const s of ["s1", "s2", "s3", "s4"]) insertSession(db, s, { at: 0 });
});

after(() => data?.cleanup());

test("texte court : lu directement, son contenu précède la phrase", async () => {
  const d = await docs.add("s1", "notes.md", Buffer.from("Support clé du Nasdaq : 21 500.\n"));
  assert.equal(d.kind, "text");
  assert.equal(d.inline, 1);
  const [block] = docs.content([d]);
  assert.equal(block.type, "text");
  assert.match((block as { text: string }).text, /^\[Document joint : « notes\.md » \(identifiant doc_[^)]+\)\]\nSupport clé du Nasdaq : 21 500\./);
});

test("texte long : pas dans le dialogue, une note invite à le confier à un agent", async () => {
  const d = await docs.add("s1", "transcription.txt", Buffer.from("mot ".repeat(12_000)));
  assert.equal(d.inline, 0);
  const blocks = docs.content([d]);
  assert.equal(blocks.length, 1);
  const note = (blocks[0] as { text: string }).text;
  assert.match(note, /trop long/);
  assert.match(note, /ask_agent/);
  assert.ok(note.includes(d.id), "l'identifiant permet de le confier à un agent");
  assert.ok(!note.includes("mot mot"), "le contenu n'est pas envoyé");
});

test("image : envoyée telle quelle, en bloc image", async () => {
  const d = await docs.add("s1", "graphique.png", TINY_PNG);
  assert.equal(d.kind, "image");
  assert.equal(d.media_type, "image/png");
  const [head, image] = docs.content([d]);
  assert.match((head as { text: string }).text, /« graphique\.png »/);
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG.toString("base64") } });
});

test("PDF : pages comptées ; court lu directement, long confié à un agent", async () => {
  assert.equal(await pdfPageCount(join(dir, "absent.pdf"), minimalPdf(3)), 3, "repli sans PDFKit : objets /Page");
  const short = await docs.add("s1", "rapport.pdf", minimalPdf(2));
  assert.equal(short.pages, 2);
  assert.equal(short.inline, 1);
  const [, block] = docs.content([short]);
  assert.equal(block.type, "document");
  assert.equal((block as { title?: string }).title, "rapport.pdf");
  assert.equal((block as { source: { media_type: string } }).source.media_type, "application/pdf");

  const long = await docs.add("s1", "BCE.pdf", minimalPdf(12));
  assert.equal(long.pages, 12);
  assert.equal(long.inline, 0);
  assert.equal(describeDocument(long), "« BCE.pdf », 12 pages");
  assert.match((docs.content([long])[0] as { text: string }).text, /trop long.*« BCE\.pdf », 12 pages/);
});

test("Word : converti en texte (textutil)", macOnly, async () => {
  const src = join(dir, "source.txt");
  writeFileSync(src, "Compte rendu : la Fed garde ses taux.");
  const docx = join(dir, "compte-rendu.docx");
  execFileSync("textutil", ["-convert", "docx", "-output", docx, src]);
  const d = await docs.add("s1", "compte-rendu.docx", readFileSync(docx));
  assert.equal(d.kind, "text");
  assert.match(readFileSync(d.path, "utf8"), /la Fed garde ses taux/);
});

test("photo HEIC ou TIFF : convertie en JPEG (sips)", macOnly, async () => {
  const png = join(dir, "pixel.png");
  writeFileSync(png, TINY_PNG);
  const tiff = join(dir, "scan.tiff");
  execFileSync("sips", ["-s", "format", "tiff", png, "--out", tiff], { stdio: "ignore" });
  const d = await docs.add("s1", "scan.tiff", readFileSync(tiff));
  assert.equal(d.media_type, "image/jpeg");
  assert.ok(d.path.endsWith(".jpg"));
  assert.equal(readFileSync(d.path).subarray(0, 2).toString("hex"), "ffd8", "un vrai JPEG");
  const width = execFileSync("sips", ["-g", "pixelWidth", d.path], { encoding: "utf8" });
  assert.match(width, /pixelWidth: 1\n/, "une petite image n'est pas agrandie");
});

test("format non pris en charge : refusé, rien ne reste sur le disque", async () => {
  const before = readdirSync(resolve(dir, "documents")).length;
  await assert.rejects(docs.add("s2", "positions.xlsx", Buffer.from("PK")), UnsupportedDocumentError);
  assert.equal(readdirSync(resolve(dir, "documents")).length, before);
});

test("nom dangereux : le fichier reste dans son dossier", async () => {
  const d = await docs.add("s2", "../../../etc/passwd.txt", Buffer.from("x"));
  assert.ok(d.path.startsWith(resolve(dir, "documents", d.id) + "/"), d.path);
  assert.equal(d.name, "../../../etc/passwd.txt", "le nom d'origine est gardé pour l'affichage");
});

test("la phrase suivante emporte les documents en attente de sa conversation, une seule fois", async () => {
  const a = await docs.add("s3", "a.txt", Buffer.from("a"));
  const b = await docs.add("s3", "b.txt", Buffer.from("b"));
  const other = await docs.add("s4", "autre.txt", Buffer.from("c"));
  assert.deepEqual(
    docs.take("s3", "t1").map((d) => d.id),
    [a.id, b.id],
  );
  assert.deepEqual(docs.take("s3", "t2"), [], "déjà partis");
  assert.deepEqual(
    docs.find("s3", [a.id, other.id]).map((d) => d.id),
    [a.id],
    "jamais ceux d'une autre conversation",
  );
  assert.deepEqual(
    docs.take("s4", "t3").map((d) => d.id),
    [other.id],
  );
});

test("retiré avant de parler : il ne part pas ; déjà parti : il reste", async () => {
  const kept = await docs.add("s3", "garde.txt", Buffer.from("g"));
  const dropped = await docs.add("s3", "brouillon.txt", Buffer.from("b"));
  assert.equal(docs.remove("s4", dropped.id), false, "pas depuis une autre conversation");
  assert.equal(docs.remove("s3", dropped.id), true);
  assert.ok(!existsSync(resolve(dir, "documents", dropped.id)));
  assert.deepEqual(
    docs.take("s3", "t4").map((d) => d.id),
    [kept.id],
  );
  assert.equal(docs.remove("s3", kept.id), false, "déjà envoyé avec une phrase");
});

test("consigne d'un agent : chaque document joint avec son chemin", () => {
  const prompt = documentsPrompt([{ path: "/data/documents/doc_1/BCE.pdf", label: "« BCE.pdf », 42 pages" }]);
  assert.match(prompt, /à lire avec Read/);
  assert.match(prompt, /^- \/data\/documents\/doc_1\/BCE\.pdf \(« BCE\.pdf », 42 pages\)$/m);
});
