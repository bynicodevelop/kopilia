// Canal Telegram : envoi par l'API Bot (texte, image), découpage, nouvelles
// tentatives, ordre des messages, jeton jamais montré ; ce qui part quand
// aucun écran n'est ouvert, et le graphique dessiné par le serveur. Aucun
// réseau : le client HTTP est un faux.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert, Scenario } from "@kopilia/contracts";
import { ConfigService } from "../src/config/config.service.js";
import { AppLogger } from "../src/common/logger.js";
import {
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_RETRY_DELAYS_MS,
  TELEGRAM_TEXT_MAX,
  TelegramChannel,
  escapeHtml,
  telegramChunks,
  type HttpRequest,
} from "../src/channels/telegram.js";
import { AGENT_EXCERPT_MAX, awayMessage, excerpt, macTexts, plainText, type AwayNews } from "../src/channels/away-texts.js";
import { AwayNotifier } from "../src/channels/away-notifier.js";
import type { OutboundMessage } from "../src/channels/channel.js";
import { CHART_HEIGHT, CHART_WIDTH, FUTURE_BARS, MAX_FUTURE_SHARE, chartSvg, futureBars, niceStep } from "../src/channels/chart-svg.js";
import { rasterize } from "../src/channels/chart-image.service.js";
import type { AlertFired } from "../src/alerts/alert.service.js";
import type { DesktopNotifier } from "../src/alerts/desktop-notifier.js";
import type { ChartImageService } from "../src/channels/chart-image.service.js";
import type { JobRow } from "../src/jobs/job.service.js";
import type { BriefRow } from "../src/veille/brief.service.js";
import { JobState } from "@kopilia/contracts";
import { DEFAULT_PUBLIC_FOOTER, parseTelegramChannels } from "../src/config/config.service.js";
import { DRAFT_TTL_MS, TelegramDrafts, normalizeChannelName, resolveTelegramTarget } from "../src/channels/telegram-targets.js";
import { telegramHtml } from "../src/channels/telegram.js";
import { ChannelsController } from "../src/channels/channels.controller.js";
import type { DashboardService } from "../src/dashboard/dashboard.service.js";
import type { XComposer } from "../src/channels/x-compose.js";

const TOKEN = "123456:jeton-secret-de-test";
const CHAT = "-1001234567890";

/** Ce que le faux client HTTP a reçu : la méthode de l'API Bot, l'adresse, et le corps lu. */
interface Sent {
  method: string;
  url: string;
  json?: Record<string, unknown>;
  form?: Map<string, unknown>;
}

/** Une réponse de l'API Bot (ok par défaut). */
type Reply = { status: number; body?: unknown } | Error;

/** Un canal Telegram configuré (ou non), son faux client HTTP, ses attentes et son journal. */
function channel(opts: { token?: string; chat?: string; replies?: Reply[]; channels?: string; footer?: string } = {}) {
  const config = {
    telegramToken: opts.token ?? TOKEN,
    telegramChatId: opts.chat ?? CHAT,
    telegramApiUrl: "https://api.telegram.test",
    telegramChannels: parseTelegramChannels(opts.channels ?? ""),
    telegramPublicFooter: opts.footer ?? DEFAULT_PUBLIC_FOOTER,
  } as unknown as ConfigService;
  const logs: string[] = [];
  const logger = {
    warn: (m: unknown) => logs.push(String(m)),
    debug: (m: unknown) => logs.push(String(m)),
    log: () => {},
    error: () => {},
  } as unknown as AppLogger;
  const ch = new TelegramChannel(config, logger);
  const sent: Sent[] = [];
  const waits: number[] = [];
  const replies = [...(opts.replies ?? [])];
  ch.http = async (url: string, init: HttpRequest) => {
    const method = url.split("/").at(-1)!;
    const s: Sent = { method, url };
    if (typeof init.body === "string") s.json = JSON.parse(init.body) as Record<string, unknown>;
    else s.form = new Map([...init.body.entries()]);
    sent.push(s);
    const r = replies.shift() ?? { status: 200, body: { ok: true, result: {} } };
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.body ?? { ok: r.status < 300 } };
  };
  ch.wait = async (ms) => void waits.push(ms);
  return { ch, sent, waits, logs, config };
}

/** Une erreur réseau comme celle de fetch, dont le message contient l'adresse (et donc le jeton). */
function networkError(): Error {
  const e = new Error(`fetch failed for https://api.telegram.test/bot${TOKEN}/sendMessage`) as Error & { cause?: unknown };
  e.cause = { code: "ENOTFOUND" };
  return e;
}

/** Les espaces insécables des nombres à la française, en espaces simples, pour comparer. */
const plain = (s: string | undefined) => (s ?? "").replace(/[\u202f\u00a0]/g, " ");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("Telegram sans jeton ni discussion : désactivé, rien ne part et la raison est dite", async () => {
  for (const o of [{ token: "" }, { chat: "" }]) {
    const { ch, sent } = channel(o);
    assert.equal(ch.enabled, false);
    const r = await ch.send({ text: "bonjour" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /KOPILIA_TELEGRAM_TOKEN.*KOPILIA_TELEGRAM_CHAT_ID/);
    assert.equal(sent.length, 0);
  }
});

test("un message : sendMessage à la discussion, en HTML, titre en gras et texte échappé, sans aperçu de lien", async () => {
  const { ch, sent } = channel();
  assert.equal(ch.enabled, true);
  const r = await ch.send({ title: "Or : ligne franchie", text: "3 950,40 à 14:32 · niveau < 3 951 & co" });
  assert.deepEqual(r, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "sendMessage");
  assert.equal(sent[0].url, `https://api.telegram.test/bot${TOKEN}/sendMessage`);
  assert.deepEqual(sent[0].json, {
    chat_id: CHAT,
    text: "<b>Or : ligne franchie</b>\n3 950,40 à 14:32 · niveau &lt; 3 951 &amp; co",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

test("une image : sendPhoto avec le PNG et sa légende ; une légende trop longue part avant, en message", async () => {
  const { ch, sent } = channel();
  await ch.send({ title: "Or", text: "le graphique", image: PNG });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "sendPhoto");
  const form = sent[0].form!;
  assert.equal(form.get("chat_id"), CHAT);
  assert.equal(form.get("caption"), "<b>Or</b>\nle graphique");
  assert.equal(form.get("parse_mode"), "HTML");
  const photo = form.get("photo") as Blob & { name: string };
  assert.equal(photo.type, "image/png");
  assert.equal(photo.name, "graphique.png");
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), PNG);

  const long = channel();
  await long.ch.send({ text: "x".repeat(TELEGRAM_CAPTION_MAX + 10), image: PNG });
  assert.deepEqual(
    long.sent.map((s) => s.method),
    ["sendMessage", "sendPhoto"],
  );
  assert.equal(long.sent[1].form!.get("caption"), undefined, "l'image part sans légende");
});

test("un texte trop long part en plusieurs messages, chacun dans la limite de Telegram", async () => {
  const line = "Le dollar recule & l'or <monte>. ";
  const text = Array.from({ length: 300 }, (_, k) => `${k} ${line}`).join("\n");
  const chunks = telegramChunks("Wrap", text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= TELEGRAM_TEXT_MAX, `${c.length} caractères`);
  assert.ok(chunks[0].startsWith("<b>Wrap</b>\n"));
  assert.ok(!chunks.slice(1).some((c) => c.includes("<b>")), "le titre n'ouvre que le premier");
  // Rien n'est perdu, rien n'est coupé dans une entité.
  const back = chunks.map((c) => c.replace(/^<b>Wrap<\/b>\n/, "")).join("\n");
  assert.equal(back.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), text.trim());
  // Une seule ligne, puis un seul mot, plus longs que la limite.
  const words = telegramChunks(undefined, "mot ".repeat(3000), 100);
  assert.ok(words.every((c) => c.length <= 100));
  assert.equal(words.join(" ").split(/\s+/).filter(Boolean).length, 3000);
  const word = telegramChunks(undefined, "&".repeat(250), 100);
  assert.ok(word.every((c) => c.length <= 100 && !/&(?!amp;)/.test(c)));
  assert.equal(word.join("").replace(/&amp;/g, "&"), "&".repeat(250));

  const { ch, sent } = channel();
  await ch.send({ title: "Wrap", text });
  assert.equal(sent.length, chunks.length);
  assert.deepEqual(
    sent.map((s) => s.json!.text),
    chunks,
  );
});

test("le réseau flanche : deux nouvelles tentatives espacées, puis c'est parti", async () => {
  const { ch, sent, waits } = channel({ replies: [networkError(), { status: 502 }] });
  const r = await ch.send({ text: "alerte" });
  assert.deepEqual(r, { ok: true });
  assert.equal(sent.length, 3);
  assert.deepEqual(waits, TELEGRAM_RETRY_DELAYS_MS);
});

test("trop de messages d'un coup : l'attente demandée par Telegram est respectée (bornée)", async () => {
  const { ch, waits } = channel({
    replies: [{ status: 429, body: { ok: false, description: "Too Many Requests: retry after 5", parameters: { retry_after: 5 } } }],
  });
  assert.deepEqual(await ch.send({ text: "x" }), { ok: true });
  assert.deepEqual(waits, [5_000]);
  const slow = channel({ replies: [{ status: 429, body: { ok: false, parameters: { retry_after: 600 } } }] });
  await slow.ch.send({ text: "x" });
  assert.deepEqual(slow.waits, [30_000]);
});

test("toujours en panne : abandon après trois essais, sans lever, et le jeton n'apparaît nulle part", async () => {
  const { ch, sent, logs } = channel({ replies: [networkError(), networkError(), networkError()] });
  const r = await ch.send({ text: "x" });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 3);
  const error = !r.ok ? r.error : "";
  assert.match(error, /réseau : .*ENOTFOUND/);
  assert.ok(!error.includes(TOKEN) && !error.includes("jeton-secret"), error);
  assert.ok(logs.length > 0);
  for (const l of logs) assert.ok(!l.includes(TOKEN) && !l.includes("jeton-secret"), l);
});

test("un refus (jeton, discussion) ne se retente pas, et dit quoi vérifier", async () => {
  const bad = channel({ replies: [{ status: 401, body: { ok: false, description: "Unauthorized" } }] });
  const r = await bad.ch.send({ text: "x" });
  assert.equal(bad.sent.length, 1);
  assert.match(!r.ok ? r.error : "", /401 : Unauthorized.*KOPILIA_TELEGRAM_TOKEN/);
  const chat = channel({ replies: [{ status: 400, body: { ok: false, description: "Bad Request: chat not found" } }] });
  const r2 = await chat.ch.send({ text: "x" });
  assert.equal(chat.sent.length, 1);
  assert.match(!r2.ok ? r2.error : "", /chat not found.*KOPILIA_TELEGRAM_CHAT_ID/);
});

test("les messages partent un par un, dans l'ordre, même si le premier attend ; un échec n'arrête pas les suivants", async () => {
  const { ch, sent } = channel({ replies: [networkError(), networkError(), networkError()] });
  const first = ch.send({ text: "un" });
  const second = ch.send({ text: "deux" });
  const third = ch.send({ text: "trois" });
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, true);
  assert.equal(c.ok, true);
  assert.deepEqual(
    sent.map((s) => s.json!.text),
    ["un", "un", "un", "deux", "trois"],
  );
});

test("un client HTTP qui lève tout de suite : l'envoi échoue proprement, sans exception", async () => {
  const { ch } = channel();
  ch.http = () => {
    throw new TypeError("boum");
  };
  const r = await ch.send({ text: "x" });
  assert.equal(r.ok, false);
  assert.deepEqual(await ch.send({ text: "" }), { ok: false, error: "message vide" });
});

test("échappement HTML : seuls &, < et >", () => {
  assert.equal(escapeHtml(`a & b < c > d "e" 'f'`), `a &amp; b &lt; c &gt; d "e" 'f'`);
});

/* ------------------------- Ce qui part écran fermé ------------------------ */

const GOLD_ALERT: Alert = {
  id: "a_1",
  symbol: "XAUUSD",
  name: "or",
  digits: 2,
  target: { kind: "price", price: 3950 },
  condition: "up",
  trigger: "once",
  timeframe: "15m",
  message: "regarde le RSI",
  state: "triggered",
  createdBy: "user",
  createdAt: 1,
  updatedAt: 1,
};

function fired(over: Partial<AlertFired> = {}): AlertFired {
  return { alert: GOLD_ALERT, eventId: "ev_1", direction: "up", price: 3950.4, level: 3950, at: new Date(2026, 10, 5, 14, 32, 5).getTime(), ...over };
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: "sc_1",
    symbol: "XAUUSD",
    name: "or",
    digits: 2,
    title: "Or : rejet de la résistance 4h",
    direction: "short",
    timeframe: "15m",
    contextTimeframe: "4h",
    horizon: "intraday",
    state: "proposed",
    entry: 2652,
    stop: 2661,
    targets: [2630, 2615],
    why: "",
    snapshot: "",
    plan: "",
    invalidation: "",
    depends: { hypotheses: [], drawings: [], events: [] },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    ...over,
  } as Scenario;
}

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job_1",
    session_id: "s_1",
    kind: "agent",
    project_id: null,
    claude_session_id: null,
    title: "Analyse du Nasdaq",
    state: JobState.Succeeded,
    summary: "## Résultat\n**Le Nasdaq** reste au-dessus de sa moyenne 50. [Source](https://exemple.fr/a)",
    pending_instruction: null,
    outcome: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

test("textes écran fermé : alerte (avec sa consigne), setup déclenché, abandon, recherche", () => {
  const a = awayMessage({ kind: "alert", fired: fired() });
  assert.equal(plain(a.title), "Or : 3 950,00 franchi à la hausse");
  assert.equal(plain(a.text), "3 950,40 à 14:32:05\nTa consigne : « regarde le RSI »");

  const s = awayMessage({ kind: "setup", scenario: scenario() });
  assert.equal(s.title, "Or : setup vendeur 15m");
  assert.equal(plain(s.text), "Rejet de la résistance 4h\nEntrée 2 652,00, stop 2 661,00, objectifs 2 630,00 et 2 615,00 (rapport 2,4)");

  const off = awayMessage({ kind: "abandon", scenario: scenario({ state: "invalidated", stateReason: "le prix a clôturé au-dessus du stop" }) });
  assert.equal(off.title, "Or : setup vendeur abandonné");
  assert.equal(off.text, "Rejet de la résistance 4h\nLe prix a clôturé au-dessus du stop");

  const pass = {
    jobId: "job_2",
    byUser: false,
    reason: "",
    failed: false,
    opened: [scenario({ state: "watching" }), scenario({ id: "sc_2", name: "Nasdaq", title: "Nasdaq : cassure", direction: "long" })],
    closed: [],
    open: [],
    result: "",
  };
  const found = awayMessage({ kind: "search", pass });
  assert.equal(found.title, "Recherche finie : 2 setups en attente");
  assert.equal(found.text, "Or, vendeur : rejet de la résistance 4h\nNasdaq, acheteur : cassure");
});

test("textes écran fermé : le wrap (titre et « En bref »), la fin d'un agent (début du résultat, en texte brut)", () => {
  const brief = {
    id: "brief_1",
    job_id: null,
    trigger: "scheduled",
    title: "Wrap du 5 novembre : l'or monte",
    content: "# …",
    spoken: "L'or dépasse 4 100 dollars.",
    created_at: 1,
    announced_at: null,
  } as BriefRow;
  assert.deepEqual(awayMessage({ kind: "brief", brief }), { title: "Wrap du 5 novembre : l'or monte", text: "L'or dépasse 4 100 dollars." });

  const done = awayMessage({ kind: "agent", job: job() });
  assert.equal(done.title, "Agent fini : Analyse du Nasdaq");
  assert.equal(done.text, "Résultat\nLe Nasdaq reste au-dessus de sa moyenne 50. Source");
  assert.equal(awayMessage({ kind: "agent", job: job({ kind: "task", state: JobState.Failed, summary: null }) }).title, "Tâche en échec : Analyse du Nasdaq");
  assert.equal(awayMessage({ kind: "agent", job: job({ summary: "" }) }).text, "Aucun résultat.");

  const long = awayMessage({ kind: "agent", job: job({ summary: Array.from({ length: 80 }, (_, k) => `Phrase numéro ${k} du résultat.`).join(" ") }) });
  assert.ok(long.text.length <= AGENT_EXCERPT_MAX + 2, `${long.text.length}`);
  assert.ok(long.text.endsWith("résultat. …"), long.text.slice(-30));
  assert.equal(excerpt("court", 600), "court");
  assert.equal(plainText("# Titre\n- un\n- deux\n\n\n\nfin"), "Titre\n• un\n• deux\n\nfin");
});

test("la notification du Mac garde ce qu'elle montrait : rien pour le wrap ni les agents", () => {
  assert.ok(macTexts({ kind: "alert", fired: fired() }));
  assert.ok(macTexts({ kind: "setup", scenario: scenario() }));
  assert.equal(macTexts({ kind: "agent", job: job() }), undefined);
  assert.equal(macTexts({ kind: "brief", brief: { title: "w", spoken: "" } as BriefRow }), undefined);
});

/** Le relais écran fermé, avec un faux Mac, un faux canal et un faux dessinateur. */
function relay(opts: { enabled?: boolean; image?: Buffer | { error: string } | Error } = {}) {
  const mac: string[] = [];
  const sent: OutboundMessage[] = [];
  const drawn: AlertFired[] = [];
  const logs: string[] = [];
  const telegram = {
    name: "telegram",
    enabled: opts.enabled ?? true,
    send: async (m: OutboundMessage) => (sent.push(m), { ok: true as const }),
  };
  const charts = {
    alertImage: async (f: AlertFired) => {
      drawn.push(f);
      if (opts.image instanceof Error) throw opts.image;
      return opts.image ?? PNG;
    },
  };
  const away = new AwayNotifier(
    { notify: (t: string, d: string) => void mac.push(`${t} | ${d}`) } as DesktopNotifier,
    telegram as unknown as TelegramChannel,
    charts as unknown as ChartImageService,
    { warn: (m: unknown) => void logs.push(String(m)) } as unknown as AppLogger,
  );
  return { away, mac, sent, drawn, logs };
}

test("écran fermé : une alerte part sur le Mac et sur Telegram, avec le graphique de son produit", async () => {
  const r = relay();
  r.away.tell({ kind: "alert", fired: fired() });
  assert.deepEqual(r.mac.map(plain), ["Or : 3 950,00 franchi à la hausse | 3 950,40 à 14:32:05"], "la notification du Mac part tout de suite");
  await r.away.last;
  assert.equal(r.drawn.length, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(plain(r.sent[0].title), "Or : 3 950,00 franchi à la hausse");
  assert.equal(r.sent[0].image, PNG);
});

test("écran fermé : sans graphique (courtier injoignable), l'alerte part quand même, en texte", async () => {
  for (const image of [{ error: "cours en direct non configurés" }, new Error("boum")]) {
    const r = relay({ image });
    r.away.tell({ kind: "alert", fired: fired() });
    await r.away.last;
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].image, undefined);
    assert.match(r.logs.join("\n"), /graphique de l'alerte non dessiné/);
  }
});

test("écran fermé : le wrap et la fin d'un agent vont sur Telegram seulement ; sans Telegram, rien ne change", async () => {
  const r = relay();
  const news: AwayNews[] = [
    { kind: "brief", brief: { title: "Wrap", spoken: "En bref." } as BriefRow },
    { kind: "agent", job: job() },
  ];
  for (const n of news) {
    r.away.tell(n);
    await r.away.last;
  }
  assert.deepEqual(r.mac, []);
  assert.deepEqual(
    r.sent.map((m) => m.title),
    ["Wrap", "Agent fini : Analyse du Nasdaq"],
  );
  assert.equal(r.drawn.length, 0, "pas de graphique hors alerte");

  const off = relay({ enabled: false });
  off.away.tell({ kind: "alert", fired: fired() });
  off.away.tell({ kind: "agent", job: job() });
  await off.away.last;
  assert.equal(off.mac.length, 1, "la notification du Mac, comme avant");
  assert.equal(off.sent.length, 0);
  assert.equal(off.drawn.length, 0, "aucun graphique dessiné pour rien");
});

test("micro coupé : la même alerte part sur Telegram avec son graphique, sans notification du Mac", async () => {
  const r = relay();
  r.away.relay({ kind: "alert", fired: fired() });
  await r.away.last;
  assert.deepEqual(r.mac, [], "l'écran ouvert a déjà sonné");
  assert.equal(r.sent.length, 1);
  assert.equal(plain(r.sent[0].title), "Or : 3 950,00 franchi à la hausse");
  assert.equal(r.sent[0].image, PNG);

  const off = relay({ enabled: false });
  off.away.relay({ kind: "alert", fired: fired() });
  await off.away.last;
  assert.equal(off.sent.length + off.mac.length + off.drawn.length, 0, "sans Telegram, rien");
});

/* ------------------------------ Le graphique ------------------------------ */

/** Bougies de 15 minutes de l'or jusqu'à `last` (epoch s), en zigzag autour de 3 950. */
function candles(n: number, last: number) {
  return Array.from({ length: n }, (_, k) => {
    const t = last - (n - 1 - k) * 900;
    const o = 3950 + 10 * Math.sin(k / 6);
    const c = 3950 + 10 * Math.sin((k + 1) / 6);
    return { t, o, h: Math.max(o, c) + 2, l: Math.min(o, c) - 2, c };
  });
}

test("graphique : bougies, axe des prix, dernier prix, tracés, alertes, moyennes et RSI de l'encart, alerte partie", () => {
  const last = Math.floor(new Date(2026, 10, 5, 14, 30).getTime() / 1000);
  const base = { symbol: "XAUUSD", createdAt: 1, updatedAt: 1 };
  const svg = chartSvg({
    name: "or",
    symbol: "XAUUSD",
    timeframe: "15m",
    digits: 2,
    candles: candles(300, last),
    now: last * 1000,
    drawings: [
      { ...base, id: "d_1", kind: "hline", price: 3958, label: "résistance & co", createdBy: "user" },
      { ...base, id: "d_2", kind: "zone", top: 3945, bottom: 3940, createdBy: "ia" },
      { ...base, id: "d_3", kind: "fib", a: { t: last - 40 * 900, price: 3940 }, b: { t: last - 10 * 900, price: 3960 }, extend: false, createdBy: "user" },
    ],
    alerts: [{ ...GOLD_ALERT, state: "active", target: { kind: "price", price: 3955 } }],
    indicators: [
      { id: "i_1", kind: "ma", type: "ema", period: 50, source: "close" },
      { id: "i_2", kind: "ma", type: "sma", period: 200, source: "close", hidden: true },
      { id: "i_3", kind: "rsi", period: 14, source: "close", overbought: 70, oversold: 30 },
    ],
    fired: { level: 3958, price: 3958.4, at: (last - 900) * 1000 },
  });
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.ok(svg.includes(">Or</text>") && svg.includes("XAUUSD · 15 minutes"), "en-tête");
  assert.ok(svg.includes("jeudi 5 novembre, 14:30"), "l'instant");
  assert.equal((svg.match(/<rect [^>]*fill="#(38d39f|ff6b6b)"/g) ?? []).length, 110, "les 110 dernières bougies");
  assert.ok(svg.includes("résistance &amp; co"), "nom du tracé, échappé");
  assert.ok(svg.includes(`stroke="#b48cff"`), "le niveau de l'IA en violet");
  assert.ok(svg.includes("0,618 "), "niveaux du Fibonacci");
  assert.ok(svg.includes(`stroke="#ffb454" stroke-width="1" stroke-dasharray="6 4"`), "l'alerte surveillée en pointillés");
  assert.ok(svg.includes("<circle"), "le point du franchissement");
  assert.ok(svg.includes("MME 50") && !svg.includes("MM 200"), "la moyenne visible, pas la masquée");
  assert.match(svg, /RSI 14 : \d+,\d/);
  assert.ok(!/[\u202f\u00a0]/.test(svg), "espaces insécables remplacés");
  assert.ok(svg.includes("jeu. 5"), "le jour qui change, sur l'axe du temps");

  const png = rasterize(svg);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "un PNG");
  assert.equal(png.readUInt32BE(16), 1280, "deux fois la largeur logique");
  assert.equal(png.readUInt32BE(20), 800);
});

test("graphique : une boîte de trade, le gain en vert pâle, le risque en rouge pâle, et leur rapport seul au milieu", () => {
  const last = Math.floor(new Date(2026, 10, 5, 14, 30).getTime() / 1000);
  const svg = chartSvg({
    name: "or",
    symbol: "XAUUSD",
    timeframe: "15m",
    digits: 2,
    candles: candles(120, last),
    now: last * 1000,
    drawings: [
      {
        symbol: "XAUUSD",
        createdAt: 1,
        updatedAt: 1,
        id: "d_4",
        kind: "position",
        side: "long",
        entry: 3950,
        stop: 3940,
        target: 3970,
        from: last - 10 * 900,
        label: "rejet",
        createdBy: "user",
      },
    ],
  });
  assert.ok(svg.includes(`fill="#38d39f" fill-opacity="0.1"`) && svg.includes(`fill="#ff6b6b" fill-opacity="0.1"`), "le gain et le risque, pâles");
  assert.ok(svg.includes(">2 R</text>"), "le rapport gain / risque");
  assert.ok(!svg.includes(">Objectif</text>") && !svg.includes(">Stop</text>") && !svg.includes(" %</text>"), "ni nom ni distance : les couleurs suffisent");
  assert.ok(svg.includes(">rejet</text>"), "son nom");
  assert.ok(rasterize(svg).length > 100);
});

test("graphique : de l'air à droite des bougies, et une boîte posée devant elles se voit en entier", () => {
  const last = Math.floor(new Date(2026, 10, 5, 14, 30).getTime() / 1000);
  const base = { symbol: "XAUUSD", createdAt: 1, updatedAt: 1, createdBy: "user" as const };
  const box = (from: number, to: number) => ({
    ...base,
    id: "d_5",
    kind: "position" as const,
    side: "long" as const,
    entry: 3950,
    stop: 3940,
    target: 3970,
    from,
    to,
  });
  // Sans tracé : FUTURE_BARS d'air ; une boîte loin devant en demande plus, dans la limite de MAX_FUTURE_SHARE du volet.
  assert.equal(futureBars([], last, 900, 110), FUTURE_BARS);
  assert.equal(futureBars([box(last + 5 * 900, last + 30 * 900)], last, 900, 110), 31);
  assert.equal(futureBars([box(last - 20 * 900, last - 5 * 900)], last, 900, 110), FUTURE_BARS, "une boîte du passé ne change rien");
  assert.equal(futureBars([box(last + 900, last + 1000 * 900)], last, 900, 110), (110 * MAX_FUTURE_SHARE) / (1 - MAX_FUTURE_SHARE));
  assert.equal(futureBars([{ ...base, id: "d_6", kind: "hline", price: 3950 }], last, 900, 110), FUTURE_BARS);

  const svg = chartSvg({
    name: "or",
    symbol: "XAUUSD",
    timeframe: "15m",
    digits: 2,
    candles: candles(120, last),
    now: last * 1000,
    drawings: [box(last + 5 * 900, last + 30 * 900)],
  });
  const plotW = CHART_WIDTH - 64;
  const rect = (color: string) => {
    const m = new RegExp(`<rect x="(-?[\\d.]+)" y="(-?[\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" fill="${color}" fill-opacity="0.1"/>`).exec(svg);
    assert.ok(m, "la boîte est dessinée");
    return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
  };
  const [gain, risk] = [rect("#38d39f"), rect("#ff6b6b")];
  assert.ok(gain.x > plotW / 2 && gain.x + gain.w <= plotW, `la boîte tient dans le volet, à droite des bougies (${gain.x} + ${gain.w} ≤ ${plotW})`);
  // L'objectif (3 970) et le stop (3 940), loin des bougies (3 938 à 3 962), restent dans le volet des prix.
  assert.ok(gain.y >= 34 && risk.y + risk.h <= CHART_HEIGHT - 20, `objectif et stop dans le cadre (${gain.y}, ${risk.y + risk.h})`);
});

test("graphique sans bougies : il le dit, sans planter", () => {
  const svg = chartSvg({ name: "or", symbol: "XAUUSD", timeframe: "1h", candles: [], now: Date.now() });
  assert.ok(svg.includes("Pas de bougies pour ce produit"));
  assert.ok(rasterize(svg).length > 100);
});

test("pas des graduations : 1, 2, 2,5, 5 × 10ⁿ", () => {
  assert.equal(niceStep(3.2), 5);
  assert.equal(niceStep(0.0021), 0.0025);
  assert.equal(niceStep(17), 20);
  assert.equal(niceStep(0), 1);
});

/* ---------------------- Plusieurs canaux : le public ---------------------- */

const PUBLIC = "-1009999";
/** L'erreur d'une réponse du contrôleur. */
const err = (r: object) => String((r as { error?: string }).error);

test("canaux nommés dans .env : « public:@canal, signaux:-100… », les éléments invalides ignorés", () => {
  assert.deepEqual(parseTelegramChannels(" Public:@moncanal ; signaux:-1001, :x, sansid:, public:-1 "), [
    { name: "public", chat: "@moncanal" },
    { name: "signaux", chat: "-1001" },
  ]);
  assert.deepEqual(parseTelegramChannels(""), []);
});

test("le canal désigné à la voix : le technique par défaut, sinon un canal nommé ; inconnu, les noms connus", () => {
  const channels = parseTelegramChannels(`public:${PUBLIC}`);
  assert.equal(normalizeChannelName("sur le Canal Public"), "public");
  for (const ref of [undefined, "", "technique", "mon canal privé", "perso"]) assert.deepEqual(resolveTelegramTarget(ref, channels), { kind: "technical" });
  for (const ref of ["public", "le canal public", "Public", "mon canal Telegram public"])
    assert.deepEqual(resolveTelegramTarget(ref, channels), { kind: "public", name: "public", chat: PUBLIC });
  const two = parseTelegramChannels("signaux:-1001,analyses:-1002");
  assert.deepEqual(resolveTelegramTarget("canal signaux", two), { kind: "public", name: "signaux", chat: "-1001" });
  assert.match((resolveTelegramTarget("public", two) as { error: string }).error, /canaux connus : technique, signaux, analyses/);
  assert.deepEqual(resolveTelegramTarget("le public", parseTelegramChannels("signaux:-1001")), { kind: "public", name: "signaux", chat: "-1001" });
});

test("la mention des messages publics : en italique, en bas, dans la légende comme dans le dernier morceau", () => {
  assert.equal(telegramHtml("Or", "texte", "Pas un conseil."), "<b>Or</b>\ntexte\n\n<i>Pas un conseil.</i>");
  const chunks = telegramChunks("Wrap", "ligne\n".repeat(400), 500, "Pas un conseil.");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.ok(chunks.at(-1)!.endsWith("\n\n<i>Pas un conseil.</i>"));
  assert.equal(chunks.filter((c) => c.includes("<i>")).length, 1);
});

test("les aperçus : publiés une seule fois, et plus après une demi-heure", () => {
  const drafts = new TelegramDrafts();
  let now = 1_000_000;
  drafts.now = () => now;
  const a = drafts.add({ name: "public", chat: PUBLIC, message: { text: "a" } });
  assert.equal(drafts.take(a.id)?.message.text, "a");
  assert.equal(drafts.take(a.id), undefined, "une seule fois");
  const b = drafts.add({ name: "public", chat: PUBLIC, message: { text: "b" } });
  now += DRAFT_TTL_MS + 1;
  assert.equal(drafts.take(b.id), undefined, "périmé");
});

/** Le contrôleur des envois, sur un faux Telegram et un faux dessinateur de graphiques. */
function controller(opts: { chat?: string; channels?: string; footer?: string } = {}) {
  const t = channel({ chat: opts.chat, channels: opts.channels ?? `public:${PUBLIC}`, footer: opts.footer });
  const charts = { timeframeOf: () => "15m", render: async () => PNG } as unknown as ChartImageService;
  const dashboard = { drawingProduct: async () => ({ symbol: "XAUUSD", name: "or", digits: 2 }) } as unknown as DashboardService;
  const c = new ChannelsController(t.config, t.ch, charts, dashboard, { enabled: false } as unknown as XComposer);
  return { c, ...t };
}

test("vers le canal technique : le message part tout de suite, avec le graphique demandé", async () => {
  const { c, sent } = controller();
  assert.deepEqual(await c.telegramSend({ text: "Le Nasdaq teste sa résistance." }), { sent: true, image: "aucune" });
  assert.deepEqual(await c.telegramSend({ text: "L'or", chart: "or", channel: "technique" }), { sent: true, image: "le graphique or en 15 minutes" });
  assert.deepEqual(
    sent.map((s) => [s.method, s.json?.chat_id ?? s.form?.get("chat_id")]),
    [
      ["sendMessage", CHAT],
      ["sendPhoto", CHAT],
    ],
  );
  assert.ok(!JSON.stringify(sent.map((s) => s.json ?? {})).includes("conseil"), "pas de mention dans le canal technique");
});

test("vers le canal public : rien n'est publié ; un aperçu, mention comprise, part dans le canal technique", async () => {
  const { c, sent } = controller();
  const r = (await c.telegramSend({ title: "Or", text: "Rejet de la résistance 4h.", chart: "or", channel: "le canal public" })) as Record<string, unknown>;
  assert.equal(r.sent, false);
  assert.equal(r.preview, true);
  assert.equal(r.channel, "public");
  assert.equal(r.image, "le graphique or en 15 minutes");
  assert.match(String(r.note), /dis-lui qu'il part avec le graphique or en 15 minutes/);
  assert.equal(r.text, `Or\nRejet de la résistance 4h.\n${DEFAULT_PUBLIC_FOOTER}`);
  assert.match(String(r.note), /seulement s'il dit oui : telegram_publish/);
  assert.match(String(r.draftId), /^tg_/);
  assert.ok(
    sent.every((s) => (s.json?.chat_id ?? s.form?.get("chat_id")) === CHAT),
    "tout part dans le canal technique, rien dans le public",
  );
  assert.match(String(sent[0].json!.text), /Aperçu pour le canal « public » : il ne sera publié que sur ton « oui »/);
  assert.equal(sent[1].method, "sendPhoto");
  assert.equal(sent[1].form!.get("caption"), `<b>Or</b>\nRejet de la résistance 4h.\n\n<i>${DEFAULT_PUBLIC_FOOTER}</i>`);
});

test("aperçu sans image : dit tel quel, pour que l'utilisateur le remarque avant son « oui »", async () => {
  const { c, sent } = controller();
  const r = (await c.telegramSend({ text: "Je vais pouvoir vous spammer maintenant.", channel: "public" })) as Record<string, unknown>;
  assert.equal(r.image, "aucune");
  assert.match(String(r.note), /dis-lui qu'il part sans image/);
  assert.equal(sent.at(-1)!.method, "sendMessage", "aperçu en texte seul");
});

test("publier un aperçu : le même message part sur le canal public, une seule fois", async () => {
  const { c, sent } = controller();
  const r = (await c.telegramSend({ text: "Le Nasdaq tient sa zone.", chart: "Nasdaq", channel: "public" })) as { draftId: string };
  const preview = sent.at(-1)!;
  const before = sent.length;
  assert.deepEqual(await c.telegramPublish({ draftId: r.draftId }), { sent: true, channel: "public" });
  assert.equal(sent.length, before + 1);
  const published = sent.at(-1)!;
  assert.equal(published.form!.get("chat_id"), PUBLIC);
  assert.equal(published.form!.get("caption"), preview.form!.get("caption"), "le texte de l'aperçu, tel quel");
  assert.deepEqual(Buffer.from(await (published.form!.get("photo") as Blob).arrayBuffer()), PNG, "la même image");
  assert.match(err(await c.telegramPublish({ draftId: r.draftId })), /aperçu inconnu ou périmé/);
  assert.match(err(await c.telegramPublish({})), /aperçu inconnu/);
  assert.equal(sent.length, before + 1, "rien de plus");
});

test("canal public : mention réglable ou retirée ; canal inconnu ; Telegram non configuré", async () => {
  const none = controller({ footer: "" });
  const r = (await none.c.telegramSend({ text: "x", channel: "public" })) as { text: string };
  assert.equal(r.text, "x");
  const unknown = controller();
  assert.match(err(await unknown.c.telegramSend({ text: "x", channel: "signaux" })), /aucun canal Telegram « signaux » ; canaux connus : technique, public/);
  assert.equal(unknown.sent.length, 0);
  const off = controller({ chat: "" });
  assert.match(err(await off.c.telegramSend({ text: "x" })), /KOPILIA_TELEGRAM_CHAT_ID/);
  // Sans canal technique, l'aperçu se relit à la voix : toujours rien de publié sans son accord.
  const voice = (await off.c.telegramSend({ text: "x", channel: "public" })) as Record<string, unknown>;
  assert.equal(voice.preview, true);
  assert.match(String(voice.note), /Pas de canal technique pour l'aperçu/);
  assert.equal(off.sent.length, 0);
});
