// Verrou du protocole : un exemple valide par type de message. Si un champ
// obligatoire apparaît ou change de forme, l'exemple casse ici, et le web
// (qui lit ces messages sans les valider) doit être revu en même temps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientMessage, serverMessage } from "../src/events.js";

const env = { v: 1, eventId: "e1", sessionId: "s1", ts: 1 } as const;
const format = { sampleRate: 16000, channels: 1, bitDepth: 16, encoding: "pcm_s16le" } as const;

export const CLIENT_EXAMPLES: Record<string, Record<string, unknown>> = {
  "mic.format": { ...env, type: "mic.format", turnId: "u1", streamId: 1, format },
  "mic.cancel": { ...env, type: "mic.cancel", streamId: 1 },
  "playback.interrupt": { ...env, type: "playback.interrupt" },
  "call.state": { ...env, type: "call.state", inCall: true },
  "page.visibility": { ...env, type: "page.visibility", hidden: true },
  "text.input": { ...env, type: "text.input", turnId: "u1", text: "bonjour" },
  "job.command": { ...env, type: "job.command", command: "status" },
  "approval.resolve": { ...env, type: "approval.resolve", approvalId: "a1", decision: "approve" },
};

export const SERVER_EXAMPLES: Record<string, Record<string, unknown>> = {
  "session.ready": { ...env, type: "session.ready", claudeSessionId: null },
  "transcript.partial": { ...env, type: "transcript.partial", turnId: "u1", text: "bon" },
  "transcript.final": { ...env, type: "transcript.final", turnId: "u1", text: "Stop.", cut: true },
  "assistant.delta": { ...env, type: "assistant.delta", turnId: "u1", seq: 0, text: "Bon" },
  "assistant.done": { ...env, type: "assistant.done", turnId: "u1", outcome: "success" },
  "audio.start": { ...env, type: "audio.start", turnId: "u1", streamId: 2, format },
  "audio.end": { ...env, type: "audio.end", turnId: "u1", streamId: 2 },
  "speech.segment": { ...env, type: "speech.segment", turnId: "u1", streamId: 2, index: 0, text: "Bonjour." },
  "state.changed": { ...env, type: "state.changed", state: "listening" },
  "job.updated": { ...env, type: "job.updated", jobId: "j1", state: "running" },
  "agent.report": { ...env, type: "agent.report", turnId: "r1", jobId: "j1", title: "Recherche" },
  "brief.ready": { ...env, type: "brief.ready", briefId: "b1", title: "Brief", createdAt: 1, trigger: "manual" },
  "learning.updated": { ...env, type: "learning.updated", runId: "r1", kind: "review", summary: "", changes: 0, pending: 0 },
  "dashboard.updated": {
    ...env,
    type: "dashboard.updated",
    panels: [
      {
        id: "p_1",
        kind: "chart",
        title: "Euro-dollar",
        symbol: "EURUSD",
        timeframe: "15m",
        indicators: [{ id: "i_1", kind: "rsi", period: 14, source: "close", overbought: 70, oversold: 30 }],
        createdAt: 1,
        updatedAt: 1,
      },
      { id: "p_2", kind: "setups", title: "Setups", createdAt: 1, updatedAt: 1 },
      {
        id: "p_3",
        kind: "view",
        title: "USD semaine",
        view: {
          blocks: [
            { type: "heading", text: "Dollar" },
            { type: "quotes", products: [{ symbol: "XAUUSD", name: "or", digits: 2 }] },
            { type: "calendar", currencies: ["USD"], impact: "high", days: 5 },
          ],
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    drawings: [{ id: "d_1", symbol: "EURUSD", kind: "hline", price: 1.1, label: "résistance", createdBy: "user", createdAt: 1, updatedAt: 1 }],
    alerts: [
      {
        id: "a_1",
        symbol: "EURUSD",
        name: "euro-dollar",
        digits: 5,
        target: { kind: "drawing", drawingId: "d_1" },
        condition: "cross",
        trigger: "close",
        timeframe: "1h",
        message: "dis-moi si la cassure tient",
        state: "active",
        createdBy: "user",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
  "panel.display": { ...env, type: "panel.display", panelId: "p_1", display: "maximize" },
  "alert.triggered": {
    ...env,
    type: "alert.triggered",
    alertId: "a_1",
    symbol: "EURUSD",
    title: "Euro-dollar : ligne « résistance » franchie à la hausse",
    detail: "1,10012 à 14:32:05 · niveau 1,10000",
    direction: "up",
    price: 1.10012,
    at: 1,
  },
  "setups.updated": {
    ...env,
    type: "setups.updated",
    hypotheses: [
      {
        id: "h_1",
        author: "kopilia",
        statement: "Le dollar reprend avant le CPI",
        products: [{ symbol: "XAUUSD", name: "or" }],
        bias: "down",
        horizon: "intraday",
        invalidation: "CPI froid",
        state: "active",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    ],
    scenarios: [
      {
        id: "sc_1",
        symbol: "XAUUSD",
        name: "or",
        direction: "short",
        horizon: "intraday",
        timeframe: "15m",
        contextTimeframe: "4h",
        title: "Or : rejet de la résistance 4 h",
        why: "Hypothèse h_1 et la zone 4 h de l'utilisateur",
        snapshot: "Cours à 0,4 % sous la zone",
        plan: "Si mèche haute et clôture 15 min dans la zone : proposer la vente",
        invalidation: "Clôture 15 min au-dessus de la zone",
        depends: { hypotheses: ["h_1"], drawings: ["d_1"], events: [{ at: 2, country: "USD", title: "CPI m/m" }] },
        targets: [],
        state: "watching",
        checkedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
        events: [{ id: "se_1", at: 1, kind: "opened", text: "Ouvert", by: "agent" }],
      },
    ],
    stats: [{ label: "Tous", proposed: 1, target: 1, stop: 0, missed: 0, open: 0, r: 2 }],
  },
  "setup.signal": {
    ...env,
    type: "setup.signal",
    scenarioId: "sc_1",
    kind: "proposed",
    symbol: "XAUUSD",
    title: "Or : setup vendeur 15 min",
    detail: "Entrée 2 652, stop 2 661, objectif 2 630",
  },
  "setups.searched": {
    ...env,
    type: "setups.searched",
    byUser: true,
    opened: ["sc_1"],
    title: "Recherche finie : 1 setup en attente",
    detail: "Or, achat : rebond sur le support 1h 4 021–4 028",
  },
  "activity.changed": { ...env, type: "activity.changed", jobId: "job_1" },
  "news.added": {
    ...env,
    type: "news.added",
    items: [
      {
        id: "nw_1",
        at: 1,
        title: "Inscriptions au chômage (US) : 189 k, attendu 196 k",
        original: "US Initial Jobless Claims Actual 189k (Forecast 196k)",
        translated: true,
        impact: "Emploi solide : pression sur l'or.",
        symbols: ["XAUUSD"],
        level: "high",
        figure: {
          event: "US Initial Jobless Claims",
          actual: "189k",
          forecast: "196k",
          calendar: { title: "Unemployment Claims", country: "USD", impact: "high" },
        },
      },
    ],
    banners: [{ id: "nw_1", title: "News · Or", detail: "Inscriptions au chômage (US) : 189 k" }],
  },
  "market.quote": { ...env, type: "market.quote", symbol: "EURUSD", bid: 1.1, time: 1 },
  "activity.step": { ...env, type: "activity.step", tool: "WebSearch", label: "Recherche sur le web" },
  "documents.attached": { ...env, type: "documents.attached", turnId: "u1", documents: [{ documentId: "d1", name: "a.pdf" }] },
  "approval.required": { ...env, type: "approval.required", approvalId: "a1", action: "écrire", expiresAt: 2 },
  "trading.updated": {
    ...env,
    type: "trading.updated",
    state: {
      ordersEnabled: true,
      account: { name: "Compte démo", currency: "EUR", balance: 10000, equity: 10000, tradeAllowed: true, demo: true, at: 1 },
      settings: { defaultRisk: { mode: "percent", value: 1 }, maxRiskPercent: 3, capitalBase: "balance", commissions: {} },
      terms: {
        NAS100: { symbol: "NAS100", tickSize: 0.01, tickValue: 0.01, volumeStep: 0.1, minVolume: 0.1, maxVolume: 50, commission: 0, commissionSource: "none" },
      },
      trades: [],
    },
  },
  "trading.signal": { ...env, type: "trading.signal", kind: "filled", tradeId: "t_1", symbol: "NAS100", title: "Nasdaq : achat exécuté" },
  "journal.changed": { ...env, type: "journal.changed", tradeId: "t_1" },
  "journal.show": { ...env, type: "journal.show", tradeId: "t_1" },
  "broker.status": {
    ...env,
    type: "broker.status",
    status: {
      state: "paused",
      reason: "weekend",
      since: 1,
      resumeAt: 2,
      wakeMs: 70_000,
      label: "En pause pour le week-end · reprise dimanche à 22 h 30",
      weekend: true,
      nights: false,
    },
  },
  "robots.updated": {
    ...env,
    type: "robots.updated",
    robots: [
      {
        id: "rb_1",
        name: "Croisement MME 9/21",
        idea: "croisement de moyennes sur le Nasdaq en 15 minutes",
        status: "promising",
        products: ["NAS100"],
        timeframe: "15m",
        version: 2,
        trials: 12,
        best: {
          id: "bt_1",
          robotId: "rb_1",
          version: 2,
          products: ["NAS100"],
          timeframe: "15m",
          from: 1_700_000_000,
          to: 1_762_000_000,
          source: "broker",
          inSample: {
            trades: 300,
            wins: 123,
            losses: 177,
            winRate: 0.41,
            avgR: 0.18,
            totalR: 54,
            profitFactor: 1.4,
            maxDrawdownR: -14,
            longestLosingStreak: 7,
            avgBars: 9,
            positiveWindows: 0.7,
            windows: 6,
          },
          verdict: "promising",
          verdictReasons: ["412 trades"],
          trial: 12,
          createdAt: 1_762_000_000_000,
        },
        createdAt: 1_762_000_000_000,
        updatedAt: 1_762_000_000_000,
      },
    ],
  },
  error: { ...env, type: "error", code: "x", message: "oups" },
};

const typesOf = (union: typeof clientMessage | typeof serverMessage) => union.options.map((o) => o.shape.type.value as string).sort();

test("protocole : chaque message navigateur -> serveur a un exemple valide", () => {
  assert.deepEqual(Object.keys(CLIENT_EXAMPLES).sort(), typesOf(clientMessage));
  for (const [type, example] of Object.entries(CLIENT_EXAMPLES)) {
    const r = clientMessage.safeParse(example);
    assert.ok(r.success, `${type} : ${r.success ? "" : r.error.message}`);
  }
});

test("protocole : chaque message serveur -> navigateur a un exemple valide", () => {
  assert.deepEqual(Object.keys(SERVER_EXAMPLES).sort(), typesOf(serverMessage));
  for (const [type, example] of Object.entries(SERVER_EXAMPLES)) {
    const r = serverMessage.safeParse(example);
    assert.ok(r.success, `${type} : ${r.success ? "" : r.error.message}`);
  }
});

test("protocole : un message sans l'enveloppe ou d'un type inconnu est refusé", () => {
  const { v: _v, ...noVersion } = SERVER_EXAMPLES["error"];
  assert.equal(serverMessage.safeParse(noVersion).success, false);
  assert.equal(clientMessage.safeParse({ ...env, type: "inconnu" }).success, false);
});
