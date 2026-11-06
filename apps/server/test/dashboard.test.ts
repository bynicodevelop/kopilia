import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigService } from "../src/config/config.service.js";
import { AppLogger } from "../src/common/logger.js";
import { DatabaseService } from "../src/db/database.service.js";
import { MarketService } from "../src/market/market.service.js";
import { DashboardError, DashboardService, MAX_PANELS } from "../src/dashboard/dashboard.service.js";
import { DrawingService, describeDrawing } from "../src/dashboard/drawing.service.js";
import { shapeFromBody } from "../src/mcp/control.controller.js";
import { AlertService } from "../src/alerts/alert.service.js";
import { ScenarioService } from "../src/setups/scenario.service.js";
import { viewData } from "../src/views/views.controller.js";
import { tempData } from "./harness.js";

/** Un courtier de test ; le flux de cotations ne tourne pas (aucun écran). */
const BROKER: Record<string, { name: string; digits: number }> = {
  "EURUSD.i": { name: "euro-dollar", digits: 5 },
  NAS100: { name: "Nasdaq 100", digits: 2 },
  XAUUSD: { name: "or", digits: 2 },
  DJ30: { name: "Dow Jones", digits: 1 },
  GER40: { name: "DAX", digits: 1 },
  US500: { name: "S&P 500", digits: 1 },
  UK100: { name: "FTSE", digits: 1 },
  JP225: { name: "Nikkei", digits: 0 },
  USOIL: { name: "pétrole", digits: 2 },
  "GBPUSD.i": { name: "livre-dollar", digits: 5 },
  "USDJPY.i": { name: "dollar-yen", digits: 3 },
  BTCUSD: { name: "bitcoin", digits: 2 },
  XAGUSD: { name: "argent", digits: 3 },
};

function setup() {
  const { config, logger, db, cleanup } = tempData("dash", { KOPILIA_METAAPI_TOKEN: "jeton" });
  const market = new MarketService(config, logger);
  // Seule la résolution du produit est simulée : le reste de MetaApi n'est pas appelé ici.
  market.resolve = async (query: string) => {
    const q = query.replace(/^l'/, "").toUpperCase();
    const symbol = Object.keys(BROKER).find((s) => s === q || s.startsWith(q) || BROKER[s].name.toUpperCase() === q);
    return symbol ? { symbol, ...BROKER[symbol] } : { error: `« ${query} » introuvable chez le courtier`, suggestions: [] };
  };
  const watched: string[][] = [];
  market.feed.setSymbols = (symbols: string[]) => void watched.push(symbols);
  market.feed.setAlertSymbols = () => {};
  const drawings = new DrawingService(db, logger);
  const dashboard = new DashboardService(db, market, drawings, new AlertService(db, market, drawings, logger), logger);
  const updates: number[] = [];
  dashboard.on("updated", (view) => updates.push(view.panels.length));
  return { dashboard, updates, watched, cleanup, db };
}

test("ouvrir un graphique : produit retrouvé, 15 minutes par défaut, le même produit ne s'ouvre pas deux fois", async () => {
  const { dashboard, updates, watched, cleanup } = setup();
  try {
    const { panel, created } = await dashboard.openChart("l'euro-dollar");
    assert.ok(created);
    assert.equal(panel.kind, "chart");
    assert.equal(panel.title, "Euro-dollar");
    assert.equal(panel.symbol, "EURUSD.i");
    assert.equal(panel.timeframe, "15m");
    assert.equal(panel.digits, 5);
    assert.match(panel.id, /^p_[0-9a-f]{6}$/);

    const again = await dashboard.openChart("EURUSD", "1h");
    assert.equal(again.created, false);
    assert.equal(again.panel.id, panel.id);
    assert.equal(again.panel.timeframe, "1h", "rouvert avec une unité : elle change");
    assert.equal(dashboard.list().length, 1);
    assert.deepEqual(updates, [1, 1]);
    assert.deepEqual(watched.at(-1), ["EURUSD.i"], "le flux suit les produits affichés");

    await assert.rejects(dashboard.openChart("Toto"), (e: Error) => e instanceof DashboardError && /introuvable/.test(e.message));
    await assert.rejects(dashboard.openChart("or", "2h"), /unité de temps inconnue/);
  } finally {
    cleanup();
  }
});

test("suivi : un seul encart, les produits s'y ajoutent, un introuvable est signalé sans bloquer les autres", async () => {
  const { dashboard, cleanup } = setup();
  try {
    const first = await dashboard.openQuotes(["Nasdaq 100", "Toto"]);
    assert.ok(first.created);
    assert.equal(first.panel.title, "Suivi");
    assert.deepEqual(
      first.panel.symbols?.map((s) => s.symbol),
      ["NAS100"],
    );
    assert.deepEqual(first.errors, ["« Toto » introuvable chez le courtier"]);

    const more = await dashboard.openQuotes(["or", "NAS100"]);
    assert.equal(more.created, false);
    assert.deepEqual(
      more.panel.symbols?.map((s) => s.name),
      ["Nasdaq 100", "or"],
      "sans doublon",
    );

    const removed = await dashboard.update("suivi", { remove: ["Nasdaq"], add: ["DAX"] });
    assert.deepEqual(
      removed.panel.symbols?.map((s) => s.symbol),
      ["XAUUSD", "GER40"],
    );
    await dashboard.update("le suivi", { remove: ["or", "DAX"] });
    assert.equal(dashboard.list().length, 0, "plus rien à suivre : l'encart se ferme");
  } finally {
    cleanup();
  }
});

test("liste des produits : toute sa liste dans son ordre, une seule, relue à chaque ouverture, suivie par le flux, pas réglable", async () => {
  const { dashboard, watched, cleanup } = setup();
  try {
    const mine = ["XAGUSD", "USOIL", "or", "NAS100", "DJ30", "EURUSD", "GBPUSD", "USDJPY", "Toto"];
    const first = await dashboard.openProducts(mine);
    assert.ok(first.created);
    assert.equal(first.panel.kind, "products");
    assert.equal(first.panel.title, "Produits");
    assert.deepEqual(
      first.panel.symbols?.map((s) => s.symbol),
      ["XAGUSD", "USOIL", "XAUUSD", "NAS100", "DJ30", "EURUSD.i", "GBPUSD.i", "USDJPY.i"],
      "au-delà des 8 d'un suivi, dans l'ordre de sa liste",
    );
    assert.deepEqual(first.errors, ["« Toto » introuvable chez le courtier"]);
    assert.deepEqual(watched.at(-1)?.length, 8, "le flux suit tous ses produits");

    const again = await dashboard.openProducts(["or", "NAS100"]);
    assert.equal(again.created, false);
    assert.equal(again.panel.id, first.panel.id);
    assert.deepEqual(
      again.panel.symbols?.map((s) => s.symbol),
      ["XAUUSD", "NAS100"],
      "sa liste a changé dans le .env : relue",
    );

    await dashboard.openQuotes(["DAX"]);
    assert.equal(dashboard.find("mes produits")?.kind, "products");
    assert.equal(dashboard.find("la liste des produits")?.kind, "products", "« liste » seule désigne le suivi, « liste des produits » la liste");
    assert.equal(dashboard.find("la liste")?.kind, "quotes");
    assert.match(dashboard.describe(), /p_\w+ : liste de ses 2 produits \(prix et variation du jour ; un clic sur une ligne ouvre le graphique\)/);
    await assert.rejects(dashboard.update("produits", { add: ["DAX"] }), /la liste des produits ne se règle pas/);
    await assert.rejects(dashboard.openProducts(["Toto"]), /introuvable/);
  } finally {
    cleanup();
  }
});

test("désigner un encart à la voix : produit, identifiant ou « suivi » ; fermer un, tous, tous sauf", async () => {
  const { dashboard, watched, cleanup } = setup();
  try {
    const eur = (await dashboard.openChart("EURUSD")).panel;
    const gold = (await dashboard.openChart("XAUUSD")).panel;
    await dashboard.openQuotes(["Nasdaq 100"]);
    assert.equal(dashboard.find("l'or")?.id, gold.id);
    assert.equal(dashboard.find("euro-dollar")?.id, eur.id);
    assert.equal(dashboard.find(eur.id)?.id, eur.id);
    assert.equal(dashboard.find("le suivi")?.kind, "quotes");
    assert.equal(dashboard.find("Nasdaq"), undefined, "le Nasdaq n'a pas de graphique, seulement une ligne du suivi");
    assert.match(
      dashboard.describe(),
      /^\[Encarts à l'écran : p_\w+ : graphique Euro-dollar \(EURUSD\.i\) en 15 minutes ; p_\w+ : graphique Or \(XAUUSD\) en 15 minutes ; p_\w+ : suivi de Nasdaq 100\.\]$/,
    );

    assert.deepEqual(
      dashboard.close("or").map((p) => p.title),
      ["Or"],
    );
    assert.throws(() => dashboard.close("or"), /aucun encart « or » à l'écran ; affichés : Euro-dollar \(p_\w+\), Suivi/);
    assert.throws(() => dashboard.close(undefined), /dis quel encart fermer/);

    const kept = dashboard.close(undefined, { all: true, except: ["EURUSD"] });
    assert.deepEqual(
      kept.map((p) => p.kind),
      ["quotes"],
    );
    assert.deepEqual(
      dashboard.list().map((p) => p.id),
      [eur.id],
    );
    assert.deepEqual(
      dashboard.close(undefined, { all: true }).map((p) => p.id),
      [eur.id],
    );
    assert.deepEqual(dashboard.list(), []);
    assert.equal(dashboard.describe(), "");
    assert.deepEqual(dashboard.close(undefined, { all: true }), [], "rien à fermer : pas une erreur");
    assert.deepEqual(watched.at(-1), []);
  } finally {
    cleanup();
  }
});

test("régler un graphique : unité de temps, produit (et son titre) ; douze encarts au plus", async () => {
  const { dashboard, cleanup } = setup();
  try {
    const { panel } = await dashboard.openChart("EURUSD");
    const slower = await dashboard.update(panel.id, { timeframe: "4h" });
    assert.equal(slower.panel.timeframe, "4h");
    const swapped = await dashboard.update("EURUSD", { symbol: "Dow Jones" });
    assert.equal(swapped.panel.title, "Dow Jones");
    assert.equal(swapped.panel.symbol, "DJ30");
    assert.equal(swapped.panel.digits, 1);
    assert.equal(swapped.panel.timeframe, "4h", "l'unité reste");
    await assert.rejects(dashboard.update("DJ30", {}), /rien à changer/);

    await dashboard.openChart("EURUSD");
    await dashboard.openChart("or");
    await dashboard.openChart("DAX");
    for (const name of ["S&P 500", "FTSE", "Nikkei", "pétrole", "livre-dollar", "dollar-yen", "bitcoin", "argent"]) await dashboard.openChart(name);
    assert.equal(dashboard.list().length, MAX_PANELS);
    await assert.rejects(dashboard.openChart("Nasdaq 100"), /12 encarts au plus/);
    await assert.rejects(dashboard.openQuotes(["Nasdaq 100"]), /12 encarts au plus/);
  } finally {
    cleanup();
  }
});

test("le tableau de bord survit à un redémarrage : relu en base, le flux repart", async () => {
  const { dashboard, cleanup } = setup();
  try {
    await dashboard.openChart("EURUSD");
    await dashboard.openQuotes(["or"]);
    const config = new ConfigService();
    const db = new DatabaseService(config, new AppLogger());
    db.onModuleInit();
    const market = new MarketService(config, new AppLogger());
    const watched: string[][] = [];
    market.feed.setSymbols = (symbols: string[]) => void watched.push(symbols);
    market.feed.setAlertSymbols = () => {};
    const drawings = new DrawingService(db, new AppLogger());
    const reborn = new DashboardService(db, market, drawings, new AlertService(db, market, drawings, new AppLogger()), new AppLogger());
    reborn.onModuleInit();
    assert.deepEqual(
      reborn.list().map((p) => p.title),
      ["Euro-dollar", "Suivi"],
    );
    assert.deepEqual(watched, [["EURUSD.i", "XAUUSD"]]);
    db.onModuleDestroy();
  } finally {
    cleanup();
  }
});

test("encart illisible en base (spec abîmée) : ignoré et retiré, les écrans se connectent toujours", async () => {
  const { dashboard, cleanup, db } = setup();
  try {
    await dashboard.openChart("EURUSD");
    db.db.prepare("INSERT INTO panels (id, kind, title, spec, position, created_at, updated_at) VALUES ('p_abime', 'chart', 'Abîmé', '{', 99, 1, 1)").run();
    db.db.prepare("INSERT INTO panels (id, kind, title, spec, position, created_at, updated_at) VALUES ('p_vide', 'quotes', 'Vide', '{}', 98, 1, 1)").run();
    assert.deepEqual(
      dashboard.list().map((p) => p.title),
      ["Euro-dollar"],
      "la connexion d'un écran lit list() : elle ne doit pas lever",
    );
    assert.match(dashboard.describe(), /Euro-dollar/);
    assert.equal((db.db.prepare("SELECT count(*) c FROM panels").get() as { c: number }).c, 1, "les lignes illisibles sont retirées");
  } finally {
    cleanup();
  }
});

test("indicateurs gardés par produit : un graphique fermé puis rouvert les retrouve ; modèle commun pour tous, d'un coup, sans rien ouvrir", async () => {
  const { dashboard, cleanup, db } = setup();
  try {
    const labels = (list?: Array<{ kind: string; type?: string; period: number }>) =>
      (list ?? []).map((i) => `${i.kind === "ma" ? i.type : i.kind}${i.period}`);
    // Un produit : ses indicateurs survivent à la fermeture de son graphique.
    let { panel } = await dashboard.openChart("or");
    await dashboard.update(panel.id, { addIndicators: [{ kind: "rsi" }] });
    dashboard.close(panel.id);
    ({ panel } = await dashboard.openChart("or"));
    assert.deepEqual(labels(panel.indicators), ["rsi14"], "rouvert, l'or retrouve son RSI");

    // Tous les graphiques : le modèle commun et chaque produit qui a les siens, sans rien ouvrir ; le graphique affiché suit.
    const before = dashboard.list().length;
    let r = await dashboard.applyIndicators({ all: true }, { addIndicators: [20, 50, 200].map((period) => ({ kind: "ema", period })) });
    assert.equal(dashboard.list().length, before, "aucun encart ouvert ni fermé");
    assert.deepEqual(labels(r.model), ["ema20", "ema50", "ema200"]);
    assert.deepEqual(
      r.products.map((p) => [p.symbol, labels(p.indicators)]),
      [["XAUUSD", ["rsi14", "ema20", "ema50", "ema200"]]],
    );
    assert.deepEqual(labels(dashboard.get(panel.id)!.indicators), ["rsi14", "ema20", "ema50", "ema200"], "le graphique affiché suit");
    ({ panel } = await dashboard.openChart("argent"));
    assert.deepEqual(labels(panel.indicators), ["ema20", "ema50", "ema200"], "un produit jamais ouvert suit le modèle");

    // Retirer partout ; un indicateur déjà là n'est pas doublé.
    r = await dashboard.applyIndicators({ all: true }, { removeIndicators: [{ kind: "ema", period: 200 }], addIndicators: [{ kind: "ema", period: 20 }] });
    assert.deepEqual(labels(r.model), ["ema20", "ema50"]);
    assert.deepEqual(labels(dashboard.get(panel.id)!.indicators), ["ema20", "ema50"]);

    // Des produits nommés : seulement eux ; un produit inconnu est dit, les autres passent.
    r = await dashboard.applyIndicators({ products: ["Nasdaq 100", "cuivre"] }, { addIndicators: [{ kind: "rsi" }] });
    assert.deepEqual(
      r.products.map((p) => [p.symbol, labels(p.indicators)]),
      [["NAS100", ["ema20", "ema50", "rsi14"]]],
    );
    assert.deepEqual(r.errors, ["« cuivre » introuvable chez le courtier"]);
    assert.deepEqual(labels(r.model), [], "le modèle n'est pas renvoyé pour des produits nommés");
    assert.deepEqual(labels(dashboard.get(panel.id)!.indicators), ["ema20", "ema50"], "l'argent n'est pas touché");

    // Sans ajout ni retrait : l'état, rien n'est écrit.
    const rows = (db.db.prepare("SELECT count(*) AS n FROM chart_settings").get() as { n: number }).n;
    r = await dashboard.applyIndicators({ all: true }, {});
    assert.equal(r.changed, 0);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM chart_settings").get() as { n: number }).n, rows);
    await assert.rejects(dashboard.applyIndicators({}, { addIndicators: [{ kind: "rsi" }] }), /dis sur quels produits/);
  } finally {
    cleanup();
  }
});

test("indicateurs d'un graphique : ajoutés avec leurs réglages, réglés, retirés, sans doublon, plafonnés ; chaque produit garde les siens", async () => {
  const { dashboard, cleanup } = setup();
  try {
    const { panel } = await dashboard.openChart("or");
    let r = await dashboard.update(panel.id, {
      addIndicators: [{ kind: "sma", period: 50 }, { kind: "ma", type: "ema", period: 200, source: "hl2" }, { kind: "rsi" }, { kind: "sma", period: 50 }],
    });
    const list = r.panel.indicators!;
    assert.deepEqual(
      list.map((i) => [i.kind, i.kind === "ma" ? i.type : "", i.period, i.source]),
      [
        ["ma", "sma", 50, "close"],
        ["ma", "ema", 200, "hl2"],
        ["rsi", "", 14, "close"],
      ],
      "le doublon de calcul est écarté",
    );
    assert.ok(list.every((i) => /^i_[0-9a-f]{4}$/.test(i.id)));
    const [mm50, mme200, rsi] = list;
    r = await dashboard.update(panel.id, {
      editIndicators: [
        { id: mm50.id, type: "ema" },
        { id: rsi.id, overbought: 80, oversold: 20, signal: { type: "sma", period: 14 } },
      ],
    });
    assert.deepEqual(r.panel.indicators![0], { ...mm50, type: "ema" }, "seul le réglage donné change, l'identifiant reste");
    assert.deepEqual(r.panel.indicators![2], { ...rsi, overbought: 80, oversold: 20, signal: { type: "sma", period: 14 } });
    await assert.rejects(dashboard.update(panel.id, { editIndicators: [{ id: rsi.id, oversold: 90 }] }), /RSI mal réglé/);
    await assert.rejects(dashboard.update(panel.id, { editIndicators: [{ id: "i_zzzz", period: 3 }] }), /aucun indicateur « i_zzzz »/);
    r = await dashboard.update(panel.id, { symbol: "NAS100" });
    assert.equal(r.panel.symbol, "NAS100");
    assert.equal(r.panel.indicators, undefined, "un autre produit vient avec les siens (ici aucun)");
    r = await dashboard.update(panel.id, { symbol: "or" });
    assert.equal(r.panel.indicators?.length, 3, "l'or retrouve les siens");
    assert.match(dashboard.describe(), new RegExp(`avec ${mm50.id} MME 50, ${mme200.id} MME 200 · \\(H \\+ B\\) / 2, ${rsi.id} RSI 14\\.`));
    r = await dashboard.update(panel.id, { removeIndicators: [{ kind: "ma" }] });
    assert.deepEqual(
      r.panel.indicators!.map((i) => i.id),
      [rsi.id],
      "sans longueur : toutes les moyennes",
    );
    r = await dashboard.update(panel.id, { removeIndicators: [{ id: rsi.id }] });
    assert.equal(r.panel.indicators, undefined);
    await assert.rejects(dashboard.update(panel.id, { addIndicators: [{ kind: "macd", period: 12 }] }), DashboardError);
    const many = Array.from({ length: 11 }, (_, k) => ({ kind: "ema", period: 5 + k }));
    await assert.rejects(dashboard.update(panel.id, { addIndicators: many }), /10 indicateurs au plus/);
    // La liste entière (l'écran) : un indicateur complet garde son identifiant, un incomplet en reçoit un.
    r = await dashboard.update(panel.id, {
      indicators: [
        { ...mm50, hidden: true, color: "red" },
        { kind: "wma", period: 10 },
      ],
    });
    assert.deepEqual(r.panel.indicators![0], { ...mm50, hidden: true, color: "red" });
    assert.equal(r.panel.indicators![1].kind === "ma" && r.panel.indicators![1].type, "wma");
    assert.match(dashboard.describe(), /MM 50 \(masqué\)/);
  } finally {
    cleanup();
  }
});

test("indicateurs gardés avant leurs réglages : complétés et réécrits une fois (identifiant stable)", async () => {
  const { dashboard, cleanup, db } = setup();
  try {
    const { panel } = await dashboard.openChart("or");
    const spec = JSON.parse((db.db.prepare("SELECT spec FROM panels WHERE id = ?").get(panel.id) as { spec: string }).spec);
    db.db
      .prepare("UPDATE panels SET spec = ? WHERE id = ?")
      .run(JSON.stringify({ ...spec, indicators: [{ kind: "ema", period: 21 }, { kind: "rsi", period: 14 }, { kind: "macd" }] }), panel.id);
    const first = dashboard.get(panel.id)!.indicators!;
    assert.deepEqual(
      first.map((i) => (i.kind === "ma" ? `${i.type}${i.period}` : `rsi${i.period}`)),
      ["ema21", "rsi14"],
      "l'illisible est écarté",
    );
    assert.deepEqual(dashboard.get(panel.id)!.indicators, first, "relu : mêmes identifiants");
  } finally {
    cleanup();
  }
});

test("tracés : rattachés au produit, montrés avec son graphique, décrits à Kopilia, vérifiés", async () => {
  const { dashboard, cleanup } = setup();
  try {
    const views: Array<{ panels: number; drawings: number }> = [];
    dashboard.on("updated", (v) => views.push({ panels: v.panels.length, drawings: v.drawings.length }));
    const { panel } = await dashboard.openChart("or");
    const drawings = dashboard.drawings;
    const line = drawings.create("XAUUSD", { kind: "hline", price: 2680.5 }, { label: " résistance ", by: "kopilia" });
    assert.match(line.id, /^d_[0-9a-f]{6}$/);
    assert.equal(line.label, "résistance");
    // Zone donnée à l'envers : rangée (haut au-dessus du bas).
    const zone = drawings.create("XAUUSD", { kind: "zone", top: 2650, bottom: 2660 }, { by: "user" });
    assert.equal(zone.kind === "zone" && zone.top, 2660);
    const away = drawings.create("NAS100", { kind: "hline", price: 21000 }, { by: "kopilia" });
    assert.deepEqual(views.at(-1), { panels: 1, drawings: 2 }, "un tracé d'un produit affiché est envoyé aux écrans");
    assert.equal(views.length, 3, "celui d'un produit non affiché attend son graphique");
    assert.deepEqual(
      dashboard.view().drawings.map((d) => d.id),
      [line.id, zone.id],
    );
    // Les milliers sont séparés par une espace fine insécable (Intl fr-FR) : \s.
    assert.match(dashboard.describe(), new RegExp(`${line.id} ligne à 2\\s680,50 « résistance », ${zone.id} zone 2\\s650,00 – 2\\s660,00`));

    const at = Date.UTC(2026, 10, 3, 9, 0) / 1000;
    const trend = drawings.create(
      "XAUUSD",
      { kind: "trendline", a: { t: at, price: 2600 }, b: { t: at + 4 * 3600, price: 2640 }, extend: true },
      { by: "user" },
    );
    assert.match(dashboard.describe(), /oblique de 2\s600,00 \(3 nov\. 10:00\) à 2\s640,00 \(3 nov\. 14:00\), prolongée/);
    assert.throws(
      () => drawings.create("XAUUSD", { kind: "trendline", a: { t: at, price: 1 }, b: { t: at, price: 1 }, extend: false }, { by: "user" }),
      /deux points différents/,
    );
    // Maj à 90° : une verticale, qui marque un instant ; jamais prolongée.
    const vertical = drawings.create("XAUUSD", { kind: "trendline", a: { t: at, price: 2640 }, b: { t: at, price: 2600 }, extend: true }, { by: "user" });
    assert.equal(vertical.kind === "trendline" && vertical.extend, false);
    assert.match(dashboard.describe(), /ligne verticale le 3 nov\. 10:00, de 2\s600,00 à 2\s640,00/);
    drawings.remove([vertical.id]);
    assert.throws(() => drawings.create("XAUUSD", { kind: "zone", top: 1, bottom: 1 }, { by: "user" }), /deux prix différents/);
    assert.throws(() => drawings.create("XAUUSD", { kind: "cercle" }, { by: "user" }), /tracé illisible/);

    const moved = drawings.update(line.id, { shape: { kind: "hline", price: 2690 }, label: null });
    assert.equal(moved.kind === "hline" && moved.price, 2690);
    assert.equal(moved.label, undefined, "label null : nom retiré");
    assert.throws(() => drawings.update(line.id, { shape: { kind: "zone", top: 2, bottom: 1 } }), /ne change pas de genre/);

    assert.deepEqual(
      drawings.remove([trend.id, "d_inconnu"]).map((d) => d.id),
      [trend.id],
    );
    await dashboard.update(panel.id, { symbol: "NAS100" });
    assert.deepEqual(
      dashboard.view().drawings.map((d) => d.id),
      [away.id],
      "le graphique passé au Nasdaq montre ses tracés à lui",
    );
    assert.equal(drawings.clear("XAUUSD").length, 2);
  } finally {
    cleanup();
  }
});

test("Fibonacci : retracement et extension gardés par produit, décrits avec leurs niveaux, vérifiés", async () => {
  const { dashboard, cleanup } = setup();
  try {
    await dashboard.openChart("or");
    const drawings = dashboard.drawings;
    const at = Date.UTC(2026, 10, 3, 13, 0) / 1000; // 14:00 à Paris
    const fib = drawings.create("XAUUSD", { kind: "fib", a: { t: at, price: 2600 }, b: { t: at + 2 * 3600, price: 2700 }, extend: false }, { by: "kopilia" });
    assert.match(fib.id, /^d_[0-9a-f]{6}$/);
    assert.deepEqual(drawings.get(fib.id), fib, "relu tel quel en base");
    // Les niveaux avec leur prix : Kopilia les dit sans calculer.
    assert.match(
      describeDrawing(fib, 2),
      /^retracement de Fibonacci de 2\s600,00 \(3 nov\. 14:00\) à 2\s700,00 \(3 nov\. 16:00\) ; niveaux 0 à 2\s700,00, 0,236 à 2\s676,40, 0,382 à 2\s661,80, 0,5 à 2\s650,00, 0,618 à 2\s638,20, 0,786 à 2\s621,40, 1 à 2\s600,00$/,
    );
    // La note des encarts, devant chaque phrase, les laisse à chart_drawings.
    assert.match(
      dashboard.describe(),
      new RegExp(`${fib.id} retracement de Fibonacci de 2\\s600,00 \\(3 nov\\. 14:00\\) à 2\\s700,00 \\(3 nov\\. 16:00\\)[^;]`),
    );
    assert.doesNotMatch(dashboard.describe(), /0,618/);

    const ext = drawings.create(
      "XAUUSD",
      { kind: "fibext", a: { t: at, price: 2600 }, b: { t: at + 2 * 3600, price: 2700 }, c: { t: at + 3 * 3600, price: 2650 }, extend: true },
      { label: "objectifs", by: "user" },
    );
    assert.match(
      describeDrawing(ext, 2),
      /^extension de Fibonacci de l'impulsion 2\s600,00 \(3 nov\. 14:00\) – 2\s700,00 \(3 nov\. 16:00\), projetée depuis 2\s650,00 \(3 nov\. 17:00\), prolongée « objectifs » ; niveaux 0 à 2\s650,00, 0,382 à 2\s688,20, 0,618 à 2\s711,80, 1 à 2\s750,00, 1,272 à 2\s777,20, 1,618 à 2\s811,80, 2 à 2\s850,00, 2,618 à 2\s911,80$/,
    );
    assert.deepEqual(
      dashboard.view().drawings.map((d) => d.kind),
      ["fib", "fibext"],
      "envoyés aux écrans avec le graphique du produit",
    );

    // Un mouvement, pas un point : deux instants et deux prix différents.
    const flat = { t: at + 3600, price: 2600 };
    assert.throws(
      () => drawings.create("XAUUSD", { kind: "fib", a: { t: at, price: 2600 }, b: flat, extend: false }, { by: "user" }),
      /instants et des prix différents/,
    );
    assert.throws(
      () => drawings.create("XAUUSD", { kind: "fibext", a: { t: at, price: 2600 }, b: { t: at, price: 2700 }, c: flat, extend: false }, { by: "user" }),
      /impulsion/,
    );
    const [low, high] = [
      { t: at, price: 2600 },
      { t: at + 2 * 3600, price: 2700 },
    ];
    assert.throws(() => drawings.create("XAUUSD", { kind: "fibext", a: low, b: high, extend: false }, { by: "user" }), /tracé illisible/);

    // Déplacé (son troisième point, sans prolongement), mais jamais changé de genre.
    const moved = drawings.update(ext.id, { shape: { kind: "fibext", a: low, b: high, c: { t: at + 4 * 3600, price: 2640 }, extend: false } });
    assert.equal(moved.kind === "fibext" && moved.c.price, 2640);
    assert.throws(() => drawings.update(fib.id, { shape: { kind: "fibext", a: low, b: high, c: flat, extend: false } }), /ne change pas de genre/);
    assert.equal(drawings.remove([fib.id, ext.id]).length, 2);
  } finally {
    cleanup();
  }
});

test("chart_draw : un Fibonacci à partir des points donnés par Kopilia (heure de Paris) ; déplacé, le reste ne bouge pas", () => {
  const at = Date.UTC(2026, 10, 3, 13, 0) / 1000; // 14:00 à Paris
  const fib = shapeFromBody("fib", { start: { time: "2026-11-03 14:00", price: 2600 }, end: { time: "2026-11-03 16:00", price: 2700 } });
  assert.deepEqual(fib, { kind: "fib", a: { t: at, price: 2600 }, b: { t: at + 7200, price: 2700 }, extend: false }, "pas prolongé par défaut");
  const ext = shapeFromBody("fibext", {
    start: { time: "2026-11-03 14:00", price: 2600 },
    end: { time: "2026-11-03 16:00", price: 2700 },
    projection: { time: "2026-11-03 17:00", price: 2650 },
    extend: true,
  });
  assert.deepEqual(ext, { kind: "fibext", a: { t: at, price: 2600 }, b: { t: at + 7200, price: 2700 }, c: { t: at + 3 * 3600, price: 2650 }, extend: true });
  const current = { ...(ext as object), id: "d_000001", symbol: "XAUUSD", createdBy: "kopilia", createdAt: 1, updatedAt: 1 } as Parameters<
    typeof shapeFromBody
  >[2];
  assert.deepEqual(shapeFromBody("fibext", { projection: { price: 2640 } }, current), {
    kind: "fibext",
    a: { t: at, price: 2600 },
    b: { t: at + 7200, price: 2700 },
    c: { t: at + 3 * 3600, price: 2640 },
    extend: true,
  });
  assert.throws(() => shapeFromBody("spirale", {}), /fibext ou position/);
});

test("boîte de trade : gardée par produit, décrite avec son gain, son risque et son rapport ; ses niveaux dans l'ordre de son sens", async () => {
  const { dashboard, cleanup } = setup();
  try {
    await dashboard.openChart("or");
    const drawings = dashboard.drawings;
    const at = Date.UTC(2026, 10, 3, 13, 0) / 1000; // 14:00 à Paris
    const long = drawings.create(
      "XAUUSD",
      { kind: "position", side: "long", entry: 2650, stop: 2630, target: 2690, from: at, to: at + 5 * 3600 },
      { by: "user" },
    );
    assert.deepEqual(drawings.get(long.id), long, "relue telle quelle en base");
    assert.match(
      describeDrawing(long, 2),
      /^boîte d'achat : entrée 2\s650,00, stop 2\s630,00 \(20,00 de risque\), objectif 2\s690,00 \(40,00 de gain\), rapport gain \/ risque 2 R, du 3 nov\. 14:00 au 3 nov\. 19:00$/,
    );
    const short = drawings.create(
      "XAUUSD",
      { kind: "position", side: "short", entry: 2650, stop: 2665, target: 2620, from: at + 3600 },
      { label: "rejet", by: "kopilia" },
    );
    assert.match(describeDrawing(short, 2), /^boîte de vente « rejet » : entrée .*, rapport gain \/ risque 2 R, depuis le 3 nov\. 15:00$/);
    // Ses niveaux dans l'ordre de son sens, et une largeur.
    const bad = (shape: object) => () => drawings.create("XAUUSD", { kind: "position", from: at, ...shape }, { by: "user" });
    assert.throws(bad({ side: "long", entry: 2650, stop: 2660, target: 2690 }), /pour un achat, le stop va sous l'entrée/);
    assert.throws(bad({ side: "long", entry: 2650, stop: 2640, target: 2640 }), /pour un achat, l'objectif va au-dessus de l'entrée/);
    assert.throws(bad({ side: "short", entry: 2650, stop: 2640, target: 2620 }), /pour une vente, le stop va au-dessus de l'entrée/);
    assert.throws(bad({ side: "short", entry: 2650, stop: 2660, target: 2660 }), /pour une vente, l'objectif va sous l'entrée/);
    assert.throws(bad({ side: "long", entry: 2650, stop: 2640, target: 2690, to: at }), /une boîte de trade a une largeur/);
    assert.throws(bad({ side: "achat", entry: 2650, stop: 2640, target: 2690 }), /tracé illisible/);
    const swapped = drawings.create(
      "XAUUSD",
      { kind: "position", side: "long", entry: 2650, stop: 2640, target: 2690, from: at + 3600, to: at },
      { by: "user" },
    );
    assert.ok(swapped.kind === "position" && swapped.from === at && swapped.to === at + 3600, "début et fin remis dans l'ordre");
    // Réglée à la souris : même genre, autres niveaux.
    const moved = drawings.update(long.id, { shape: { kind: "position", side: "long", entry: 2655, stop: 2630, target: 2705, from: at, to: at + 5 * 3600 } });
    assert.match(describeDrawing(moved, 2), /rapport gain \/ risque 2 R/);
    assert.deepEqual(
      dashboard.view().drawings.map((d) => d.kind),
      ["position", "position", "position"],
      "envoyées aux écrans avec le graphique du produit",
    );
  } finally {
    cleanup();
  }
});

test("chart_draw : une boîte de trade à partir des prix dits ; son sens déduit du stop, son début à maintenant ; réglée, le reste ne bouge pas", () => {
  const at = Date.UTC(2026, 10, 3, 13, 0) / 1000; // 14:00 à Paris
  const given = shapeFromBody("position", { entry: 2650, stop: 2665, objective: 2620, from: "2026-11-03 14:00", to: "2026-11-03 18:00" });
  assert.deepEqual(
    given,
    { kind: "position", side: "short", entry: 2650, stop: 2665, target: 2620, from: at, to: at + 4 * 3600 },
    "un stop au-dessus de l'entrée : une vente",
  );
  const before = Math.floor(Date.now() / 60_000) * 60;
  const now = shapeFromBody("position", { side: "long", entry: 2650, stop: 2640, objective: 2690 }) as { from: number; to?: number };
  assert.ok(now.from >= before && now.from <= Date.now() / 1000, "sans début : maintenant (à la minute)");
  assert.equal(now.to, undefined, "sans fin : jusqu'au bord droit du graphique");
  const current = { ...(given as object), id: "d_000002", symbol: "XAUUSD", createdBy: "kopilia", createdAt: 1, updatedAt: 1 } as Parameters<
    typeof shapeFromBody
  >[2];
  assert.deepEqual(
    shapeFromBody("position", { stop: 2670 }, current),
    { kind: "position", side: "short", entry: 2650, stop: 2670, target: 2620, from: at, to: at + 4 * 3600 },
    "« monte le stop à 2 670 »",
  );
});

test("tracé illisible en base : retiré, les autres restent", async () => {
  const { dashboard, cleanup, db } = setup();
  try {
    const ok = dashboard.drawings.create("XAUUSD", { kind: "hline", price: 1 }, { by: "user" });
    db.db
      .prepare(
        "INSERT INTO drawings (id, symbol, kind, spec, label, created_by, created_at, updated_at) VALUES ('d_abime', 'XAUUSD', 'hline', '{', NULL, 'user', 1, 1)",
      )
      .run();
    assert.deepEqual(
      dashboard.drawings.list(["XAUUSD"]).map((d) => d.id),
      [ok.id],
    );
    assert.equal((db.db.prepare("SELECT count(*) c FROM drawings").get() as { c: number }).c, 1);
  } finally {
    cleanup();
  }
});

test("liste des setups : un seul encart, désigné par « setups », il ne se règle pas, et ses produits sont suivis tant qu'il est là", async () => {
  const { config, logger, db, cleanup } = tempData("dash-setups", { KOPILIA_METAAPI_TOKEN: "jeton" });
  const market = new MarketService(config, logger);
  market.resolve = async (query: string) =>
    /or|xau/i.test(query) ? { symbol: "XAUUSD", ...BROKER.XAUUSD } : { error: `« ${query} » introuvable`, suggestions: [] };
  const watched: string[][] = [];
  market.feed.setSymbols = (symbols: string[]) => void watched.push(symbols);
  market.feed.setAlertSymbols = () => {};
  const drawings = new DrawingService(db, logger);
  const alerts = new AlertService(db, market, drawings, logger);
  const scenarios = new ScenarioService(db, alerts, logger);
  const dashboard = new DashboardService(db, market, drawings, alerts, logger, scenarios);
  try {
    const first = dashboard.openSetups();
    assert.equal(first.created, true);
    assert.equal(first.panel.kind, "setups");
    assert.equal(first.panel.title, "Setups");
    assert.deepEqual(first.setups, []);
    assert.equal(dashboard.openSetups().created, false, "une seule liste");
    await dashboard.openQuotes(["or"]);
    assert.equal(dashboard.find("la liste des setups")?.kind, "setups");
    assert.equal(dashboard.find("les dossiers ouverts")?.kind, "setups");
    assert.equal(dashboard.find("le suivi")?.kind, "quotes");
    await assert.rejects(dashboard.update("setups", { add: ["or"] }), /ne se règle pas/);
    assert.match(dashboard.describe(), /liste des setups repérés/);

    // Un setup ouvert sur l'or : son produit est suivi, puisque la liste est affichée.
    scenarios.open(
      {
        product: { symbol: "XAUUSD", ...BROKER.XAUUSD },
        direction: "long",
        horizon: "intraday",
        timeframe: "15m",
        title: "Or : rebond sur le support 1h 4 021–4 028",
        why: "Support 1h à 10 contacts.",
        snapshot: "Cours 4 037 à 16:40, 10 points au-dessus de la zone.",
        plan: "Si une bougie 15m rejette la zone : proposer long.",
        invalidation: "Clôture 1h sous 4 021",
        expiresAt: Date.now() + 3_600_000,
      },
      { by: "agent" },
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(watched.at(-1)?.includes("XAUUSD"));
    assert.equal(dashboard.openSetups().setups.length, 1);

    dashboard.close("setups");
    assert.equal(
      dashboard.list().some((p) => p.kind === "setups"),
      false,
    );
  } finally {
    scenarios.onModuleDestroy();
    cleanup();
  }
});

test("vues : composées du catalogue, produits résolus et suivis, désignées par leur titre, remplacées plutôt que doublées", async () => {
  const { dashboard, watched, cleanup } = setup();
  try {
    const { panel, created } = await dashboard.openView("Métaux", [
      { type: "heading", text: "Or et argent" },
      { type: "quotes", symbols: ["or", "argent", "XAUUSD"] },
      { type: "sparkline", symbol: "or" },
      { type: "calendar", currencies: ["usd"] },
      { type: "text", text: "<b>Ceci reste du texte</b>" },
    ]);
    assert.equal(created, true);
    assert.equal(panel.kind, "view");
    assert.equal(panel.title, "Métaux");
    const blocks = panel.view!.blocks;
    assert.deepEqual(blocks[1], {
      type: "quotes",
      products: [
        { symbol: "XAUUSD", name: "or", digits: 2 },
        { symbol: "XAGUSD", name: "argent", digits: 3 },
      ],
    });
    assert.deepEqual(blocks[2], { type: "sparkline", product: { symbol: "XAUUSD", name: "or", digits: 2 }, timeframe: "1h", bars: 48 });
    assert.deepEqual(blocks[3], { type: "calendar", currencies: ["USD"] });
    assert.deepEqual(watched.at(-1), ["XAUUSD", "XAGUSD"], "le flux suit les produits de la vue");
    assert.equal(dashboard.find("la vue métaux")?.id, panel.id);
    assert.match(dashboard.describe(), /vue « Métaux » \(titre « Or et argent » ; cours de or, argent ; courbe or 1h ; calendrier USD ; texte\)/);

    // Le même titre : la vue est remplacée.
    const again = await dashboard.openView("métaux", [{ type: "brief" }]);
    assert.equal(again.created, false);
    assert.equal(again.panel.id, panel.id);
    assert.equal(dashboard.list().length, 1);

    const renamed = await dashboard.updateView("Métaux", { title: "Matin", blocks: [{ type: "setups", symbol: "or", states: ["waiting"] }] });
    assert.equal(renamed.title, "Matin");
    assert.deepEqual(renamed.view!.blocks, [{ type: "setups", product: { symbol: "XAUUSD", name: "or", digits: 2 }, states: ["waiting"] }]);
    await assert.rejects(dashboard.update("Matin", { timeframe: "1h" }), /view_update/);
  } finally {
    cleanup();
  }
});

test("vues : une erreur dit le bloc et le champ, pour que Kopilia corrige de lui-même", async () => {
  const { dashboard, cleanup } = setup();
  try {
    await assert.rejects(dashboard.openView("", [{ type: "brief" }]), /besoin d'un titre/);
    await assert.rejects(dashboard.openView("x", [{ type: "html", html: "<script>" }]), /bloc 1 : genre inconnu « html » \(genres : heading, text/);
    await assert.rejects(
      dashboard.openView("x", [{ type: "brief" }, { type: "table", columns: ["a", "b"], rows: [["1"]] }]),
      /bloc 2 \(table\), rows\.0 : 1 case pour 2 colonnes/,
    );
    await assert.rejects(dashboard.openView("x", [{ type: "quotes", symbols: ["Toto"] }]), /bloc 1 \(quotes\) : « Toto » introuvable/);
    assert.equal(dashboard.list().length, 0, "rien n'est ouvert");
  } finally {
    cleanup();
  }
});

test("vues : le calendrier (fenêtre, impact, devises) et le dernier brief servis à l'écran", () => {
  const calls: Array<{ start: number; end: number; impacts: string[]; currencies: string[] }> = [];
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  const data = viewData(
    {
      blocks: [{ type: "calendar", currencies: ["USD"], impact: "high", days: 2 }, { type: "heading", text: "x" }, { type: "brief" }, { type: "calendar" }],
    },
    {
      events: (start, end, impacts, currencies) => {
        calls.push({ start, end, impacts, currencies });
        return [{ at: now + 3_600_000, country: "USD", title: "ISM", impact: "high", forecast: "49,5", previous: "48,7" }];
      },
      brief: () => ({ id: "b_1", title: "Wrap", spoken: "Le dollar recule.", created_at: 1 }),
    },
    now,
  );
  assert.deepEqual(Object.keys(data.blocks), ["0", "2", "3"]);
  assert.deepEqual(calls[0], { start: now - 2 * 3_600_000, end: new Date(2026, 10, 7).getTime(), impacts: ["high"], currencies: ["USD"] });
  assert.deepEqual(calls[1].impacts, ["high", "medium"], "moyennes et fortes par défaut");
  assert.equal(calls[1].end, new Date(2026, 10, 6).getTime(), "aujourd'hui et demain par défaut");
  assert.deepEqual(data.blocks[2], { brief: { briefId: "b_1", title: "Wrap", spoken: "Le dollar recule.", createdAt: 1 } });
});

test("robots : un seul encart, désigné par « robots » ou « stratégies », qui ne se règle pas et ne suit aucun produit", async () => {
  const { dashboard, cleanup } = setup();
  try {
    const first = dashboard.openRobots();
    assert.equal(first.created, true);
    assert.equal(first.panel.kind, "robots");
    assert.equal(first.panel.title, "Robots");
    assert.deepEqual(first.robots, []);
    assert.equal(dashboard.openRobots().created, false);
    assert.equal(dashboard.find("les robots")?.kind, "robots");
    assert.equal(dashboard.find("mes stratégies")?.kind, "robots");
    await assert.rejects(dashboard.update("robots", { timeframe: "1h" }), /ne se règle pas/);
    assert.match(dashboard.describe(), /robots \(les stratégies du laboratoire/);
    // Un changement du tableau de bord (ici une fermeture) passe par les produits suivis : un encart Robots n'en a pas.
    assert.equal(
      dashboard.view().panels.some((p) => p.kind === "robots"),
      true,
    );
    dashboard.close("robots");
    assert.equal(
      dashboard.view().panels.some((p) => p.kind === "robots"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("activité : un seul encart, désigné par « activité » ou « agents », qui ne se règle pas", async () => {
  const { dashboard, cleanup } = setup();
  try {
    const first = dashboard.openActivity();
    assert.equal(first.created, true);
    assert.equal(first.panel.kind, "activity");
    assert.equal(first.panel.title, "Activité");
    assert.equal(dashboard.openActivity().created, false);
    assert.equal(dashboard.showsActivity(), true);
    assert.equal(dashboard.find("l'activité")?.kind, "activity");
    assert.equal(dashboard.find("les agents")?.kind, "activity");
    await assert.rejects(dashboard.update("activité", { timeframe: "1h" }), /ne se règle pas/);
    assert.match(dashboard.describe(), /activité \(agents et tâches récents/);
    dashboard.close(undefined, { all: true });
    assert.equal(dashboard.showsActivity(), false, "« tout fermer » la ferme aussi");
  } finally {
    cleanup();
  }
});
