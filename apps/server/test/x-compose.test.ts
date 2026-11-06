// Poster sur X sans l'API : longueur comptée comme X, lien de partage, image
// dans le presse-papiers, fenêtre de post ouverte. Ni navigateur ni
// presse-papiers réels : les commandes du Mac sont interceptées, et rien ne
// part jamais sur le réseau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { ConfigService } from "../src/config/config.service.js";
import { DEFAULT_PUBLIC_FOOTER } from "../src/config/config.service.js";
import type { AppLogger } from "../src/common/logger.js";
import { X_NOT_AVAILABLE, XComposer, clipboardScript, xIntentUrl, xLength, xPostText } from "../src/channels/x-compose.js";
import { ChannelsController } from "../src/channels/channels.controller.js";
import type { TelegramChannel } from "../src/channels/telegram.js";
import type { ChartImageService } from "../src/channels/chart-image.service.js";
import type { DashboardService } from "../src/dashboard/dashboard.service.js";
import { dialogueSystemPrompt } from "../src/session/prompts.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Un compositeur X dont les commandes du Mac sont interceptées : ce qu'il a lancé, et ce que contenait l'image copiée. */
function composer(opts: { enabled?: boolean; fail?: "osascript" | "open" } = {}) {
  const config = { xCompose: opts.enabled ?? true } as unknown as ConfigService;
  const logs: string[] = [];
  const logger = { warn: (m: unknown) => logs.push(String(m)) } as unknown as AppLogger;
  const x = new XComposer(config, logger);
  const runs: Array<{ file: string; args: string[]; png?: Buffer; path?: string }> = [];
  x.run = async (file, args) => {
    const run: (typeof runs)[number] = { file, args };
    if (file === "osascript") {
      run.path = /POSIX file "([^"]+)"/.exec(args[1])?.[1];
      if (run.path && existsSync(run.path)) run.png = readFileSync(run.path);
    }
    runs.push(run);
    if (opts.fail === file) throw new Error(`${file} a échoué`);
  };
  return { x, runs, logs };
}

test("longueur comptée comme X : un signe par caractère simple, accents et guillemets compris ; un émoji 2 ; un lien 23", () => {
  assert.equal(xLength("Bonjour"), 7);
  assert.equal(xLength("Or : « résistance »"), 19);
  assert.equal(xLength("été"), 3, "accents décomposés : un signe chacun");
  assert.equal(xLength("l’or"), 4, "apostrophe typographique : un signe");
  assert.equal(xLength("📈"), 2);
  assert.equal(xLength("👨‍👩‍👧"), 2, "un émoji composé reste un émoji");
  assert.equal(xLength("Or !"), 5, "l'espace fine insécable compte double sur X");
  assert.equal(xLength("Voir https://example.com/un/tres/long/chemin?avec=parametres"), 5 + 23);
  assert.equal(xLength("a http://x.co b https://y.co"), "a ".length + " b ".length + 2 * 23);
});

test("le post : le texte, puis la mention après une ligne vide ; sans mention, le texte seul", () => {
  assert.equal(xPostText("  Le Nasdaq tient sa zone. ", DEFAULT_PUBLIC_FOOTER), `Le Nasdaq tient sa zone.\n\n${DEFAULT_PUBLIC_FOOTER}`);
  assert.equal(xPostText("Le Nasdaq tient sa zone.", ""), "Le Nasdaq tient sa zone.");
  assert.equal(xPostText("", DEFAULT_PUBLIC_FOOTER), DEFAULT_PUBLIC_FOOTER);
});

test("le lien de partage d'X : le texte encodé, retours à la ligne et esperluettes compris", () => {
  assert.equal(xIntentUrl("Or : 4 020 & plus\nligne"), "https://x.com/intent/tweet?text=Or%20%3A%204%20020%20%26%20plus%0Aligne");
});

test("le presse-papiers : une image PNG lue depuis son fichier, chemin échappé pour AppleScript", () => {
  assert.equal(clipboardScript('/tmp/a"b.png'), 'set the clipboard to (read (POSIX file "/tmp/a\\"b.png") as «class PNGf»)');
});

test("ouvrir avec un graphique : le PNG dans le presse-papiers d'abord, puis le navigateur ; le fichier temporaire effacé", async () => {
  const { x, runs } = composer();
  assert.deepEqual(await x.open("Le Nasdaq tient sa zone.", PNG), { ok: true, imageCopied: true });
  assert.deepEqual(
    runs.map((r) => r.file),
    ["osascript", "open"],
  );
  assert.deepEqual(runs[0].png, PNG, "le fichier copié est l'image");
  assert.ok(runs[0].path && !existsSync(runs[0].path), "fichier temporaire effacé");
  assert.deepEqual(runs[1].args, ["https://x.com/intent/tweet?text=Le%20Nasdaq%20tient%20sa%20zone."]);
});

test("ouvrir sans graphique : seulement le navigateur, le presse-papiers n'est pas touché", async () => {
  const { x, runs } = composer();
  assert.deepEqual(await x.open("Texte"), { ok: true, imageCopied: false });
  assert.deepEqual(
    runs.map((r) => r.file),
    ["open"],
  );
});

test("graphique non copié : la fenêtre s'ouvre quand même, avec le texte, et la raison est gardée", async () => {
  const { x, runs, logs } = composer({ fail: "osascript" });
  assert.deepEqual(await x.open("Texte", PNG), { ok: true, imageCopied: false, imageError: "osascript a échoué" });
  assert.equal(runs.at(-1)!.file, "open");
  assert.match(logs.join("\n"), /graphique non copié/);
});

test("navigateur qui ne s'ouvre pas, ou X coupé (hors du Mac) : rien ne se passe, la raison est dite", async () => {
  const broken = composer({ fail: "open" });
  const r = await broken.x.open("Texte");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /le navigateur ne s'est pas ouvert/);
  const off = composer({ enabled: false });
  assert.deepEqual(await off.x.open("Texte", PNG), { ok: false, error: X_NOT_AVAILABLE });
  assert.equal(off.runs.length, 0);
});

/** Le contrôleur, sur un compositeur intercepté et un faux dessinateur de graphiques. */
function controller(opts: { enabled?: boolean; footer?: string; max?: number; fail?: "osascript" | "open" } = {}) {
  const t = composer({ enabled: opts.enabled, fail: opts.fail });
  const config = { xFooter: opts.footer ?? DEFAULT_PUBLIC_FOOTER, xMaxChars: opts.max ?? 280 } as unknown as ConfigService;
  const charts = { timeframeOf: () => "15m", render: async () => PNG } as unknown as ChartImageService;
  const dashboard = { drawingProduct: async () => ({ symbol: "XAUUSD", name: "or", digits: 2 }) } as unknown as DashboardService;
  const c = new ChannelsController(config, {} as TelegramChannel, charts, dashboard, t.x);
  return { c, ...t };
}

test("x_compose avec un graphique : la fenêtre s'ouvre, mention comprise, le graphique à coller ; rien n'est publié", async () => {
  const { c, runs } = controller();
  const r = (await c.xCompose({ text: "Or : rejet de la résistance en 4 heures.", chart: "or" })) as Record<string, unknown>;
  const post = `Or : rejet de la résistance en 4 heures.\n\n${DEFAULT_PUBLIC_FOOTER}`;
  assert.equal(r.opened, true);
  assert.equal(r.text, post);
  assert.equal(r.length, xLength(post));
  assert.equal(r.image, "le graphique or en 15 minutes, dans le presse-papiers");
  assert.match(String(r.note), /coller le graphique \(Commande V\), puis de relire et de cliquer Poster : rien n'est publié sans son clic/);
  assert.deepEqual(
    runs.map((x) => x.file),
    ["osascript", "open"],
  );
  assert.equal(runs[1].args[0], xIntentUrl(post));
});

test("x_compose sans graphique : le texte seul, et rien à coller", async () => {
  const { c, runs } = controller({ footer: "" });
  const r = (await c.xCompose({ text: "Le Nasdaq tient sa zone." })) as Record<string, unknown>;
  assert.equal(r.text, "Le Nasdaq tient sa zone.");
  assert.equal(r.image, "aucune");
  assert.doesNotMatch(String(r.note), /Commande V/);
  assert.deepEqual(
    runs.map((x) => x.file),
    ["open"],
  );
});

test("x_compose trop long pour X : rien ne s'ouvre, et la place qui reste au texte est dite", async () => {
  const { c, runs } = controller();
  const r = (await c.xCompose({ text: "a".repeat(240) })) as Record<string, unknown>;
  const room = 280 - xLength(DEFAULT_PUBLIC_FOOTER) - 2;
  assert.equal(r.opened, false);
  assert.match(
    String(r.error),
    new RegExp(
      `trop long pour X : ${240 + 2 + xLength(DEFAULT_PUBLIC_FOOTER)} signes comptés comme X, 280 au plus, mention comprise ; raccourcis le texte à ${room} signes`,
    ),
  );
  assert.equal(runs.length, 0);
  // Avec X Premium, la limite se règle.
  const premium = controller({ max: 25_000 });
  assert.equal(((await premium.c.xCompose({ text: "a".repeat(240) })) as { opened: boolean }).opened, true);
});

test("x_compose : graphique non copié dit tel quel ; demande vide, unité inconnue, X coupé", async () => {
  const failed = controller({ fail: "osascript" });
  const r = (await failed.c.xCompose({ text: "Or", chart: "or" })) as Record<string, unknown>;
  assert.equal(r.opened, true);
  assert.equal(r.image, "aucune : le graphique or en 15 minutes n'a pas pu être copié");
  assert.match(String(r.note), /le graphique n'a pas pu être copié/);
  assert.doesNotMatch(String(r.note), /Commande V/);

  const { c, runs } = controller();
  assert.match(String(((await c.xCompose({})) as { error: string }).error), /dis quoi poster/);
  assert.match(String(((await c.xCompose({ text: "Or", timeframe: "2h" })) as { error: string }).error), /unité de temps inconnue/);
  assert.equal(runs.length, 0);
  const off = controller({ enabled: false });
  assert.deepEqual(await off.c.xCompose({ text: "Or" }), { opened: false, error: X_NOT_AVAILABLE });
  assert.equal(off.runs.length, 0);
});

test("consigne du dialogue : X seulement s'il est disponible, l'utilisateur publie lui-même", () => {
  const p = dialogueSystemPrompt([], new Date("2026-11-06T10:00:00Z"), { x: true });
  assert.match(p, /x_compose ouvre la fenêtre de post d'X dans son navigateur/);
  assert.match(p, /Rien ne part sans lui : il colle l'image avec Commande V et clique Poster/);
  assert.match(p, /280 signes au plus mention comprise/);
  assert.doesNotMatch(dialogueSystemPrompt([], new Date("2026-11-06T10:00:00Z")), /x_compose/);
});
