import { test } from "node:test";
import assert from "node:assert/strict";
import { docMeta, docType, formatSize, pastedName } from "../src/app/documents/documents";

test("taille lisible", () => {
  assert.equal(formatSize(842), "842 o");
  assert.equal(formatSize(145_000), "142 Ko");
  assert.equal(formatSize(2.3 * 1024 * 1024), "2,3 Mo");
});

test("vignette : envoi, pages ou taille, et lecture par un agent", () => {
  const base = { localId: "l", name: "rapport.pdf", size: 145_000 };
  assert.equal(docMeta({ ...base, status: "uploading" }), "Envoi…");
  assert.equal(docMeta({ ...base, status: "ready", pages: 1, inline: true }), "1 page");
  assert.equal(docMeta({ ...base, status: "ready", pages: 42, inline: false }), "42 pages · lu par un agent");
  assert.equal(docMeta({ ...base, status: "ready", pages: null, inline: true }), "142 Ko");
});

test("capture collée : un nom parlant à la place de « image.png »", () => {
  const at = new Date(2026, 10, 3, 9, 5);
  assert.equal(pastedName("image.png", at), "Capture 09h05.png");
  assert.equal(pastedName("graphique NQ.png", at), "graphique NQ.png");
});

test("vignette d'un document : son format, en capitales", () => {
  assert.equal(docType("rapport.pdf"), "PDF");
  assert.equal(docType("compte-rendu.docx"), "DOCX");
  assert.equal(docType("archive.tar.gz"), "GZ");
  assert.equal(docType("sans-extension"), "DOC");
  assert.equal(docType(".cache"), "DOC", "un fichier caché n'a pas d'extension");
});
