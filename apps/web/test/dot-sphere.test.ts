import { test } from "node:test";
import assert from "node:assert/strict";
import { POINTS, energyOf, fibonacciSphere, haloRadius, mix } from "../src/app/orb/dot-sphere";

test("sphère de points : tous sur la sphère unité, répartis sur tout le volume", () => {
  const { xyz, seed } = fibonacciSphere(POINTS);
  assert.equal(xyz.length, POINTS * 3);
  assert.equal(seed.length, POINTS);
  let front = 0;
  let top = 0;
  for (let i = 0; i < POINTS; i++) {
    const [x, y, z] = [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-5, `point ${i} hors de la sphère`);
    if (z > 0) front++;
    if (y > 0) top++;
  }
  // Moitié devant, moitié en haut : pas de trou ni de paquet.
  assert.ok(Math.abs(front - POINTS / 2) < POINTS * 0.05, `devant : ${front}`);
  assert.ok(Math.abs(top - POINTS / 2) < POINTS * 0.05, `en haut : ${top}`);
  // Deux voisins ne sont jamais au même endroit.
  assert.ok(Math.hypot(xyz[0] - xyz[3], xyz[1] - xyz[4], xyz[2] - xyz[5]) > 0.01);
});

test("énergie de l'orbe : rien hors ligne, le plus quand il réfléchit", () => {
  assert.equal(energyOf("offline"), 0);
  assert.ok(energyOf("ready") < energyOf("listening"));
  assert.ok(energyOf("listening") < energyOf("hearing"));
  assert.ok(energyOf("speaking") < energyOf("thinking"));
  assert.ok(energyOf("thinking") <= 1);
});

test("halo : jamais coupé par le bord du canvas (sinon on voit un carré)", () => {
  // Canvas de 368 px, sphère au repos (86 px) ou gonflée au maximum (94 px) : le halo tient entier.
  assert.equal(haloRadius(86.5, 368), 86.5 * 1.75);
  assert.equal(haloRadius(94.3, 368), 94.3 * 1.75);
  // Canvas trop petit : le halo s'arrête un pixel avant le bord.
  assert.equal(haloRadius(86.4, 288), 143);
  assert.equal(haloRadius(100, 0), 0);
});

test("mélange de couleurs du thème", () => {
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#5b8cff", "#38d39f", 0), "#5b8cff");
  assert.equal(mix("#5b8cff", "#38d39f", 1), "#38d39f");
  assert.equal(mix("#fff", "#000", 2), "#000000", "borné");
});
