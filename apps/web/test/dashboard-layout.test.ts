import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_BAND,
  EDGE,
  FRAME,
  MAX_TOP,
  MIN_H,
  MIN_W,
  assignSides,
  clampPosition,
  dockOrder,
  flipGrip,
  anchorPoint,
  isNarrow,
  maximizedSize,
  maxedAfter,
  nextZ,
  resizeLimit,
  sameSides,
  sanitizePositions,
  sanitizeSides,
  sanitizeSizes,
  stackRanks,
} from "../src/app/dashboard/layout";

test("côtés : à l'ouverture, en alternance, à gauche d'abord", () => {
  assert.deepEqual(assignSides(["a", "b", "c", "d"], {}), { a: "left", b: "right", c: "left", d: "right" });
  assert.deepEqual(assignSides([], { a: "left" }), {}, "tout fermé : rien à garder");
});

test("côtés : fermer le premier ne fait changer personne de côté", () => {
  // Euro-dollar à gauche, Nasdaq à droite, Or à gauche ; on ferme l'Euro-dollar.
  const before = assignSides(["eur", "nas", "or"], {});
  const after = assignSides(["nas", "or"], before);
  assert.deepEqual(after, { nas: "right", or: "left" }, "chacun reste où il était (sinon son graphique recharge)");
});

test("côtés : un nouvel encart va du côté le moins chargé", () => {
  // Deux à droite, un à gauche : le suivant va à gauche.
  assert.equal(assignSides(["a", "b", "c", "n"], { a: "right", b: "right", c: "left" }).n, "left");
  // Un de chaque côté : à gauche à égalité.
  assert.equal(assignSides(["a", "b", "n"], { a: "right", b: "left" }).n, "left");
  // Un encart déplacé hors de sa marge n'y occupe plus de place.
  assert.equal(assignSides(["a", "b", "n"], { a: "left", b: "right" }, new Set(["a"])).n, "left");
  assert.equal(assignSides(["a", "b", "n"], { a: "left", b: "right" }, new Set(["b"])).n, "right");
});

test("côtés : une valeur abîmée dans le stockage est réattribuée", () => {
  assert.deepEqual(assignSides(["a"], { a: "milieu" as never }), { a: "left" });
});

test("côtés : même répartition, rien à enregistrer", () => {
  assert.equal(sameSides({ a: "left", b: "right" }, { b: "right", a: "left" }), true);
  assert.equal(sameSides({ a: "left" }, { a: "right" }), false);
  assert.equal(sameSides({ a: "left" }, { a: "left", b: "right" }), false);
});

test("un encart déplacé reste dans la fenêtre", () => {
  // Là où on le lâche, s'il y tient.
  assert.deepEqual(clampPosition({ x: 300, y: 200 }, 400, 300, 1440, 900), { x: 300, y: 200 });
  // Trop à gauche ou trop haut : collé à la marge.
  assert.deepEqual(clampPosition({ x: -50, y: -10 }, 400, 300, 1440, 900), { x: EDGE, y: EDGE });
  // Trop à droite ou trop bas : son bord reste visible.
  assert.deepEqual(clampPosition({ x: 1400, y: 880 }, 400, 300, 1440, 900), { x: 1440 - 400 - EDGE, y: 900 - 300 - EDGE });
  // Plus grand que la fenêtre : on garde au moins son en-tête (coin haut-gauche à la marge).
  assert.deepEqual(clampPosition({ x: 100, y: 100 }, 1600, 1000, 1440, 900), { x: EDGE, y: EDGE });
  // Pixels entiers (pas de flou sur Retina).
  assert.deepEqual(clampPosition({ x: 10.6, y: 20.2 }, 400, 300, 1440, 900), { x: 11, y: 20 });
});

test("agrandir un graphique : jusqu'au bord de la fenêtre moins sa marge, le bord opposé à la poignée fixe", () => {
  // À gauche, poignée à droite : il grandit vers la droite, jusqu'à la marge.
  assert.deepEqual(resizeLimit({ left: 16, right: 456, top: 58 }, false, 1440, 900), { w: 1440 - 16 - FRAME, h: 900 - 58 - FRAME });
  // À droite, poignée à gauche : il grandit vers la gauche, son bord droit reste.
  assert.deepEqual(resizeLimit({ left: 984, right: 1424, top: 58 }, true, 1440, 900), { w: 1424 - FRAME, h: 900 - 58 - FRAME });
  // Collé au bord : au moins la taille minimale.
  assert.deepEqual(resizeLimit({ left: 1400, right: 1430, top: 890 }, false, 1440, 900), { w: MIN_W, h: MIN_H });
});

test("un graphique agrandi s'arrête au-dessus de la bande d'appel, sous la barre du haut", () => {
  assert.deepEqual(maximizedSize(1440, 900), { w: 1440 - 2 * FRAME, h: 900 - MAX_TOP - CALL_BAND });
  // Fenêtre très basse : jamais sous la taille minimale.
  assert.deepEqual(maximizedSize(1300, 300), { w: 1300 - 2 * FRAME, h: MIN_H });
});

test("au-delà de deux encarts par marge, les suivants s'empilent sur le dernier, décalés de leur rang", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const sides = { a: "left", b: "right", c: "left", d: "right", e: "left", f: "right", g: "left" } as const;
  assert.deepEqual(dockOrder(ids, sides), { left: ["a", "c", "e", "g"], right: ["b", "d", "f"] });
  assert.deepEqual(stackRanks(dockOrder(ids, sides)), { a: 0, c: 0, e: 1, g: 2, b: 0, d: 0, f: 1 });
  // Un encart sorti de sa marge ne compte pas : celui d'après reprend sa place.
  assert.deepEqual(stackRanks(dockOrder(ids, sides, new Set(["c"]))), { a: 0, e: 0, g: 1, b: 0, d: 0, f: 1 });
});

test("pile : celui qu'on fait passer devant va sur le dessus, les autres reculent d'un cran", () => {
  const ids = ["a", "c", "e", "g"];
  const sides = { a: "left", c: "left", e: "left", g: "left" } as const;
  // La base de la pile (c) passe sur le dessus : e devient la base.
  assert.deepEqual(dockOrder(ids, sides, new Set(), "c").left, ["a", "e", "g", "c"]);
  assert.deepEqual(stackRanks(dockOrder(ids, sides, new Set(), "e")), { a: 0, c: 0, g: 1, e: 2 });
  // Le premier de la marge n'est pas dans la pile : rien ne bouge.
  assert.deepEqual(dockOrder(ids, sides, new Set(), "a").left, ids);
});

test("la poignée regarde le centre de l'écran", () => {
  assert.equal(flipGrip(16, 400, 1440), false, "à gauche : poignée à droite");
  assert.equal(flipGrip(1000, 400, 1440), true, "à droite : poignée à gauche");
  assert.equal(flipGrip(520, 400, 1440), false, "centré : à droite par défaut");
});

test("le dernier encart déplacé passe devant", () => {
  assert.equal(nextZ({}), 1);
  assert.equal(nextZ({ a: { x: 0, y: 0, z: 3 }, b: { x: 0, y: 0, z: 7 } }), 8);
});

test("écran étroit : même seuil que le CSS (1 239 px)", () => {
  assert.equal(isNarrow(1239), true);
  assert.equal(isNarrow(1240), false);
});

test("stockage relu : une valeur abîmée est écartée, jamais propagée", () => {
  assert.deepEqual(sanitizeSizes({ a: { w: 500.4, h: 300 }, b: { w: "abc", h: 1 }, c: null, d: { w: 10, h: 10 } }), {
    a: { w: 500, h: 300 },
    d: { w: MIN_W, h: MIN_H },
  });
  assert.deepEqual(sanitizePositions({ a: { x: 10, y: 20, z: 2 }, b: { x: NaN, y: 0, z: 1 }, c: { x: 1, y: 2 } }), { a: { x: 10, y: 20, z: 2 } });
  assert.deepEqual(sanitizeSides({ a: "left", b: "milieu", c: 3 }), { a: "left" });
  for (const junk of [null, 42, "texte", [1, 2]]) {
    assert.deepEqual(sanitizeSizes(junk), {});
    assert.deepEqual(sanitizePositions(junk), {});
    assert.deepEqual(sanitizeSides(junk), {});
  }
});

test("fil de la galaxie : attaché au bord de l'encart qui regarde l'orbe", () => {
  const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w });
  const [cx, cy] = [700, 400];
  assert.deepEqual(anchorPoint(rect(16, 58, 300, 200), cx, cy), { x: 316, y: 158 }, "à gauche : bord droit, au milieu");
  assert.deepEqual(anchorPoint(rect(1100, 58, 300, 200), cx, cy), { x: 1100, y: 158 }, "à droite : bord gauche");
  assert.deepEqual(anchorPoint(rect(560, 600, 300, 200), cx, cy), { x: 700, y: 600 }, "en dessous : bord haut, en face de l'orbe");
  assert.deepEqual(anchorPoint(rect(560, 50, 300, 200), cx, cy), { x: 700, y: 250 }, "au-dessus : bord bas");
  assert.deepEqual(anchorPoint(rect(600, 300, 300, 200), cx, cy), undefined, "il couvre l'orbe : pas de fil");
  assert.deepEqual(anchorPoint(rect(0, 0, 0, 0), cx, cy), undefined, "pas affiché");
});

test("affichage à la voix : un seul graphique agrandi, réduire l'enlève, sans encart tout reprend sa taille", () => {
  assert.deepEqual(maxedAfter([], "p_or", "maximize"), ["p_or"]);
  // En agrandir un autre rend leur taille aux premiers.
  assert.deepEqual(maxedAfter(["p_or", "p_nq"], "p_ym", "maximize"), ["p_ym"]);
  assert.deepEqual(maxedAfter(["p_nq", "p_or"], "p_or", "maximize"), ["p_or"]);
  assert.equal(maxedAfter(["p_or"], "p_or", "maximize"), null);
  assert.deepEqual(maxedAfter(["p_or", "p_nq"], "p_or", "restore"), ["p_nq"]);
  assert.equal(maxedAfter(["p_nq"], "p_or", "restore"), null);
  assert.deepEqual(maxedAfter(["p_or", "p_nq"], undefined, "restore"), []);
  assert.equal(maxedAfter([], undefined, "restore"), null);
  assert.deepEqual(maxedAfter(["p_or"], "p_or", "dock"), []);
  assert.equal(maxedAfter([], "p_or", "dock"), null);
});
