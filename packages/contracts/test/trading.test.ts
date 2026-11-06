// Money management et taille d'une boîte de trade : calculés à la main sur un
// compte de 10 000 € et un indice à 1 € le point par lot (tick de 0,01).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MONEY_SETTINGS,
  breakEvenPrice,
  drawingShapeSchema,
  effectiveRisk,
  findTier,
  moneySettingsSchema,
  tierLabel,
  floorToStep,
  lotsLabel,
  moneyLabel,
  pendingExecution,
  percentLabel,
  riskLabel,
  roundToTick,
  sizeBox,
  sizePosition,
  stepDecimals,
  tradeR,
  type SymbolTerms,
} from "../src/index.js";

/** NAS100 : 1 € le point par lot, soit 0,01 € le tick de 0,01 ; lots de 0,1 à 50. */
const NAS: SymbolTerms = {
  symbol: "NAS100",
  tickSize: 0.01,
  tickValue: 0.01,
  volumeStep: 0.1,
  minVolume: 0.1,
  maxVolume: 50,
  digits: 2,
  commission: 0,
  commissionSource: "none",
};
const BOX = { entry: 21450, stop: 21410, target: 21570 };

test("taille au pourcentage : risque ÷ perte d'un lot, arrondie vers le bas au pas", () => {
  const s = sizePosition(BOX, NAS, 10_000, { mode: "percent", value: 1 });
  // 100 € ÷ 40 € par lot = 2,5 lots.
  assert.equal(s.lots, 2.5);
  assert.equal(s.loss, 100);
  assert.equal(s.gain, 300);
  assert.equal(s.riskPercent, 1);
  assert.equal(s.problem, undefined);
});

test("la commission compte dans la perte : la taille baisse, le vrai risque est dit", () => {
  const s = sizePosition(BOX, { ...NAS, commission: 0.96 }, 10_000, { mode: "percent", value: 1 });
  // 100 ÷ (40 + 0,96) = 2,44 → 2,4 lots ; perte 2,4 × 40,96 = 98,30 € ; gain 2,4 × (120 − 0,96).
  assert.equal(s.lots, 2.4);
  assert.ok(Math.abs(s.loss - 98.304) < 1e-9);
  assert.ok(Math.abs(s.gain - 285.696) < 1e-9);
  assert.ok(Math.abs(s.fees - 2.304) < 1e-9);
  assert.ok(Math.abs(s.riskPercent - 0.98304) < 1e-9);
});

test("taille au montant, et en lots (la perte se calcule)", () => {
  assert.equal(sizePosition(BOX, NAS, 10_000, { mode: "amount", value: 150 }).lots, 3.7);
  const lots = sizePosition(BOX, NAS, 10_000, { mode: "lots", value: 2 });
  assert.equal(lots.lots, 2);
  assert.equal(lots.loss, 80);
  assert.equal(lots.riskPercent, 0.8);
});

test("le plafond par trade réduit la taille d'un pourcentage trop haut, refuse des lots qui le dépassent", () => {
  const big = sizePosition(BOX, NAS, 10_000, { mode: "percent", value: 5 }, { maxRiskPercent: 3 });
  assert.equal(big.lots, 7.5);
  assert.equal(big.capped, "max-risk");
  assert.equal(big.riskPercent, 3);
  const lots = sizePosition(BOX, NAS, 10_000, { mode: "lots", value: 10 }, { maxRiskPercent: 3 });
  assert.equal(lots.lots, 10);
  assert.match(lots.problem ?? "", /4 % de risque dépasse ton plafond de 3 %/);
});

test("un stop trop loin pour le risque : taille nulle, avec la perte du plus petit lot", () => {
  const s = sizePosition({ entry: 21450, stop: 20450, target: 22450 }, NAS, 1_000, { mode: "percent", value: 1 }, { currency: "EUR" });
  assert.equal(s.lots, 0);
  assert.match(s.problem ?? "", /le plus petit lot \(0,1 lot\) perdrait 100\s€/);
});

test("au-delà du volume maximal du courtier, la taille s'arrête au maximum", () => {
  const s = sizePosition(BOX, { ...NAS, maxVolume: 2 }, 10_000, { mode: "percent", value: 1 });
  assert.equal(s.lots, 2);
  assert.equal(s.capped, "max-volume");
});

test("sans capital ou sans écart au stop, aucune taille", () => {
  assert.equal(sizePosition(BOX, NAS, 0, { mode: "percent", value: 1 }).problem, "capital du compte inconnu");
  assert.equal(sizePosition({ ...BOX, stop: BOX.entry }, NAS, 10_000, { mode: "percent", value: 1 }).problem, "le stop est sur l'entrée");
});

test("break-even : l'entrée décalée de la commission d'un lot, au tick supérieur, du côté du gain", () => {
  // 0,96 € de commission ÷ 0,01 € le tick = 96 ticks = 0,96 point.
  assert.equal(breakEvenPrice("long", 21450, { ...NAS, commission: 0.96 }), 21450.96);
  assert.equal(breakEvenPrice("short", 21450, { ...NAS, commission: 0.96 }), 21449.04);
  // Euro-dollar : 7 $ par lot, 1 $ le tick de 0,00001 → 7 ticks.
  const eur = { tickSize: 0.00001, tickValue: 1, commission: 7, digits: 5 };
  assert.equal(breakEvenPrice("long", 1.0832, eur), 1.08327);
  assert.equal(breakEvenPrice("long", 1.0832, { ...eur, commission: 0 }), 1.0832);
});

test("pas et arrondis", () => {
  assert.equal(stepDecimals(0.01), 2);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(1e-7), 7);
  assert.equal(floorToStep(2.4399, 0.1), 2.4);
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(roundToTick(21450.123, NAS), 21450.12);
  assert.equal(roundToTick(2650.37, { tickSize: 0.25, digits: 2 }), 2650.25);
});

test("libellés à la française", () => {
  assert.equal(moneyLabel(98.3, "EUR"), "98 €");
  assert.equal(moneyLabel(2.304, "EUR"), "2,30 €");
  assert.equal(moneyLabel(285.7, "EUR", { sign: true }), "+286 €");
  assert.equal(moneyLabel(-98.3, "EUR", { sign: true }), "−98 €");
  assert.equal(moneyLabel(1160, "USD"), "1 160 $");
  assert.equal(moneyLabel(12, "XYZ1"), "12 XYZ1");
  assert.equal(lotsLabel(0.01), "0,01 lot");
  assert.equal(lotsLabel(2.4), "2,4 lots");
  assert.equal(percentLabel(0.98304), "0,98 %");
  assert.equal(riskLabel({ mode: "percent", value: 1 }), "1 % du capital");
  assert.equal(riskLabel({ mode: "lots", value: 3 }), "3 lots");
});

test("la taille d'une boîte selon l'état : son risque à elle, sinon celui du money management", () => {
  const state = {
    account: { name: "Démo", currency: "EUR", balance: 10_000, equity: 9_000, tradeAllowed: true, demo: true, at: 1 },
    settings: DEFAULT_MONEY_SETTINGS,
    terms: { NAS100: NAS },
  };
  assert.equal(sizeBox({ symbol: "NAS100", ...BOX }, state)?.lots, 2.5);
  assert.equal(sizeBox({ symbol: "NAS100", ...BOX, risk: { mode: "percent", value: 2 } }, state)?.lots, 5);
  // Sur les capitaux propres : 1 % de 9 000 €.
  assert.equal(sizeBox({ symbol: "NAS100", ...BOX }, { ...state, settings: { ...state.settings, capitalBase: "equity" } })?.lots, 2.2);
  assert.equal(sizeBox({ symbol: "XAUUSD", ...BOX }, state), undefined);
});

test("un ordre en attente au prix de l'entrée : à cours limité ou stop selon le marché", () => {
  const q = { bid: 21450, ask: 21451 };
  assert.equal(pendingExecution("long", 21400, q), "limit");
  assert.equal(pendingExecution("long", 21500, q), "stop");
  assert.equal(pendingExecution("short", 21500, q), "limit");
  assert.equal(pendingExecution("short", 21400, q), "stop");
});

test("le résultat en R, et une boîte qui garde son risque", () => {
  assert.equal(tradeR(150, 100), 1.5);
  assert.equal(tradeR(-98.3, 98.3), -1);
  assert.equal(tradeR(10, 0), undefined);
  const shape = drawingShapeSchema.parse({ kind: "position", side: "long", ...BOX, from: 1, risk: { mode: "amount", value: 150 } });
  assert.deepEqual(shape.kind === "position" && shape.risk, { mode: "amount", value: 150 });
  assert.equal(drawingShapeSchema.safeParse({ kind: "position", side: "long", ...BOX, from: 1, risk: { mode: "percent", value: -1 } }).success, false);
});

test("paliers de risque : retrouvés sans majuscules ni accents, et une boîte au palier suit son pourcentage du moment", () => {
  const tiers = [
    { name: "Standard", percent: 1 },
    { name: "A+", percent: 3, when: "quand le 4 h et le 15 min vont dans le même sens" },
  ];
  assert.equal(findTier(tiers, "a+")?.percent, 3);
  assert.equal(findTier(tiers, "  standard ")?.name, "Standard");
  assert.equal(findTier(tiers, "B"), undefined);
  assert.deepEqual(effectiveRisk({ mode: "percent", value: 3, tier: "A+" }, { tiers: [{ name: "A+", percent: 2.5 }] }), {
    mode: "percent",
    value: 2.5,
    tier: "A+",
  });
  assert.deepEqual(effectiveRisk({ mode: "percent", value: 3, tier: "disparu" }, { tiers }), { mode: "percent", value: 3, tier: "disparu" });
  assert.equal(tierLabel(tiers[1], true), "A+ 3 % (quand le 4 h et le 15 min vont dans le même sens)");
  assert.equal(riskLabel({ mode: "percent", value: 3, tier: "A+" }), "3 % du capital (palier A+)");
  const state = {
    account: { name: "Démo", currency: "EUR", balance: 10_000, equity: 10_000, tradeAllowed: true, demo: true, at: 1 },
    settings: { ...DEFAULT_MONEY_SETTINGS, tiers: [{ name: "A+", percent: 2 }] },
    terms: { NAS100: NAS },
  };
  assert.equal(sizeBox({ symbol: "NAS100", ...BOX, risk: { mode: "percent", value: 3, tier: "A+" } }, state)?.lots, 5);
  // Des réglages enregistrés avant les paliers : la liste vide par défaut.
  assert.deepEqual(
    moneySettingsSchema.parse({ defaultRisk: { mode: "percent", value: 1 }, maxRiskPercent: 3, capitalBase: "balance", commissions: {} }).tiers,
    [],
  );
});

test("journal : gagnant, perdant ou neutre sous 0,1 R ; la sortie en mots ; un stop qui s'éloigne du gain", async () => {
  const { tradeOutcome, exitLabel, widensStop } = await import("../src/journal.js");
  assert.equal(tradeOutcome({ state: "closed", r: 1.2 }), "win");
  assert.equal(tradeOutcome({ state: "closed", r: -0.5 }), "loss");
  assert.equal(tradeOutcome({ state: "closed", r: -0.03 }), "neutral");
  assert.equal(tradeOutcome({ state: "closed", r: 0.1 }), "win");
  assert.equal(tradeOutcome({ state: "open", r: 2 }), undefined);
  const exit = (reason: "target" | "stop" | "manual", extra: { stop?: number; protected?: boolean } = {}) =>
    exitLabel({
      state: "closed",
      stop: extra.stop ?? 100,
      initialStop: 100,
      protected: extra.protected ?? false,
      legs: [{ clientId: "c", lots: 1, state: "closed", exits: [{ id: "d", at: 1, price: 110, lots: 1, profit: 10, reason }] }],
    });
  assert.equal(exit("target"), "à l'objectif");
  assert.equal(exit("stop"), "au stop");
  assert.equal(exit("stop", { stop: 104 }), "au stop déplacé");
  assert.equal(exit("stop", { stop: 120, protected: true }), "au stop remonté");
  assert.equal(exit("manual"), "à la main, sur la plateforme");
  assert.equal(widensStop("long", 100, 95), true);
  assert.equal(widensStop("long", 100, 105), false);
  assert.equal(widensStop("short", 100, 105), true);
});
