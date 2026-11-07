// Heures de Paris, quel que soit le fuseau de la machine de test.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import { tempData } from "./harness.js";
import { MarketService } from "../src/market/market.service.js";
import { BrokerError, BrokerPauseService, type BrokerReady } from "../src/market/broker-pause.service.js";
import type { TradingService } from "../src/trading/trading.service.js";

const PROV = "https://prov.test";
const CLIENT = "https://mt-client-api-v1.london.agiliumtrade.ai";
const paris = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

/**
 * Un faux MetaApi qui joue les états du compte : une mise en pause passe par
 * UNDEPLOYING, un rallumage par DEPLOYING puis « déployé, pas encore connecté
 * au courtier ». Chaque demande est notée (méthode et chemin).
 */
function setup(opts: { state?: string; env?: Record<string, string> } = {}) {
  const data = tempData("broker", {
    KOPILIA_METAAPI_TOKEN: "jeton-de-test",
    KOPILIA_METAAPI_ACCOUNT_ID: "acc-1",
    KOPILIA_METAAPI_PROVISIONING_URL: PROV,
    KOPILIA_METAAPI_CLIENT_URL: "",
    KOPILIA_METAAPI_STREAM: "0",
    KOPILIA_BROKER_PAUSE: "1",
    KOPILIA_BROKER_IDLE_MIN: "20",
    ...opts.env,
  });
  const market = new MarketService(data.config, data.logger);
  market.retryDelaysMs = [0];
  const account = { state: opts.state ?? "DEPLOYED", connectionStatus: "CONNECTED", steps: 0 };
  const calls: string[] = [];
  market.fetchImpl = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace(PROV, "").replace(CLIENT, "")}`);
    if (method === "POST" && url === `${PROV}/users/current/accounts/acc-1/undeploy`) {
      account.state = "UNDEPLOYING";
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url === `${PROV}/users/current/accounts/acc-1/deploy`) {
      account.state = "DEPLOYING";
      account.connectionStatus = "DISCONNECTED";
      return new Response(null, { status: 204 });
    }
    if (method !== "GET") return Response.json({ message: "inattendu" }, { status: 405 });
    if (url === `${PROV}/users/current/accounts/acc-1`) {
      // MetaApi avance d'une étape entre deux lectures.
      if (account.steps++ > 0) {
        if (account.state === "UNDEPLOYING") account.state = "UNDEPLOYED";
        else if (account.state === "DEPLOYING") account.state = "DEPLOYED";
        else if (account.state === "DEPLOYED" && account.connectionStatus === "DISCONNECTED") account.connectionStatus = "CONNECTED";
      }
      return Response.json({ _id: "acc-1", name: "Démo", state: account.state, connectionStatus: account.connectionStatus, region: "london" });
    }
    if (url === `${PROV}/users/current/servers/mt-client-api`) return Response.json({ domain: "agiliumtrade.ai" });
    if (url === `${CLIENT}/users/current/accounts/acc-1/symbols`) return Response.json(["NAS100", "XAUUSD"]);
    if (url.startsWith(`${CLIENT}/users/current/accounts/acc-1/symbols/NAS100/`)) {
      return url.endsWith("specification")
        ? Response.json({ symbol: "NAS100", description: "Nasdaq", digits: 2 })
        : Response.json({ symbol: "NAS100", bid: 25000, ask: 25001, time: new Date().toISOString() });
    }
    return Response.json({ message: `inattendu : ${url}` }, { status: 404 });
  };
  const trades: Array<{ symbol: string }> = [];
  let ticket: object | undefined;
  const trading = { liveTrades: () => trades, ticket: () => ticket } as unknown as TradingService;
  const broker = new BrokerPauseService(data.config, data.db, market, trading, data.logger);
  let clock = 0;
  broker.now = () => clock;
  const ready: BrokerReady[] = [];
  broker.on("ready", (r) => ready.push(r));
  return {
    broker,
    market,
    calls,
    account,
    trades,
    ready,
    setTicket: (t?: object) => (ticket = t),
    /** Démarre le service à cet instant, sans sa minuterie (les vérifications sont lancées à la main). */
    start(at: number) {
      clock = at;
      broker.onModuleInit();
      broker.onModuleDestroy();
    },
    at(t: number) {
      clock = t;
    },
    posts: () => calls.filter((c) => c.startsWith("POST")),
    cleanup() {
      market.feed.stop();
      data.cleanup();
    },
  };
}

test("en semaine, le compte reste allumé : rien n'est demandé à MetaApi que son état", async () => {
  const f = setup();
  try {
    f.start(paris(11, 3, 15));
    await f.broker.check();
    assert.equal(f.broker.status().state, "on");
    assert.deepEqual(f.posts(), []);
    const r = await f.market.prices(["NAS100"]);
    assert.ok("prices" in r && r.prices?.[0] && "price" in r.prices[0], "les prix passent");
  } finally {
    f.cleanup();
  }
});

test("week-end : en pause après le délai sans usage, rallumé seul le dimanche à 22 h 30", async () => {
  const f = setup();
  try {
    f.start(paris(11, 6, 23, 10));
    await f.broker.check();
    assert.equal(f.broker.status().state, "on", "au démarrage, un compte allumé attend le délai sans usage");
    assert.deepEqual(f.posts(), []);

    f.at(paris(11, 6, 23, 31));
    await f.broker.check();
    assert.deepEqual(f.posts(), ["POST /users/current/accounts/acc-1/undeploy"], "mis en pause, jamais supprimé");
    assert.equal(f.broker.status().state, "pausing");
    await f.broker.check();
    const paused = f.broker.status();
    assert.equal(paused.state, "paused");
    assert.equal(paused.reason, "weekend");
    assert.equal(paused.resumeAt, paris(11, 8, 22, 30));
    assert.equal(paused.label, "En pause pour le week-end · reprise dimanche à 22 h 30");

    // En pause, une demande de prix répond tout de suite, sans rien demander aux cours.
    const before = f.calls.length;
    const r = await f.market.prices(["NAS100"]);
    assert.ok("error" in r && /en pause pour le week-end \(reprise dimanche à 22 h 30\) : dis « rallume le courtier »/.test(r.error ?? ""), JSON.stringify(r));
    assert.equal(f.calls.length, before);
    assert.equal(f.market.paused, true);

    f.at(paris(11, 7, 15));
    await f.broker.check();
    assert.equal(f.broker.status().state, "paused", "le samedi, il dort");
    assert.equal(f.posts().length, 1);

    f.at(paris(11, 8, 22, 31));
    await f.broker.check();
    assert.equal(f.broker.status().state, "waking");
    assert.deepEqual(f.posts().at(-1), "POST /users/current/accounts/acc-1/deploy");
    const waking = await f.market.prices(["NAS100"]);
    assert.ok("error" in waking && /se rallume/.test(waking.error ?? ""));
    f.at(paris(11, 8, 22, 31) + 30_000);
    await f.broker.check(); // déployé, pas encore connecté au courtier
    assert.equal(f.broker.status().state, "waking");
    f.at(paris(11, 8, 22, 32) + 10_000);
    await f.broker.check();
    const on = f.broker.status();
    assert.equal(on.state, "on");
    assert.equal(on.wakeMs, 70_000, "la durée du rallumage est gardée pour prévenir du délai");
    assert.deepEqual(f.ready, [{ ms: 70_000, requested: false }]);
    assert.equal(f.market.paused, false);
    assert.ok(f.calls.every((c) => !c.startsWith("DELETE")));
  } finally {
    f.cleanup();
  }
});

test("rallumé à la voix un samedi : dit prêt, puis se rendort après 20 minutes sans usage", async () => {
  const f = setup({ state: "UNDEPLOYED" });
  try {
    f.start(paris(11, 7, 10));
    await f.broker.check();
    assert.equal(f.broker.status().state, "paused", "trouvé en pause au démarrage : il y reste");
    assert.deepEqual(f.posts(), []);

    await f.broker.wake(true);
    assert.equal(f.broker.status().state, "waking");
    f.at(paris(11, 7, 10, 1));
    await f.broker.check();
    await f.broker.check();
    assert.equal(f.broker.status().state, "on");
    assert.equal(f.ready.length, 1);
    assert.equal(f.ready[0].requested, true, "demandé à la voix : Kopilia dira qu'il est prêt");
    assert.equal(f.broker.awakeInWindow(), true);

    f.at(paris(11, 7, 10, 15));
    f.broker.touch(); // il regarde un graphique
    f.at(paris(11, 7, 10, 30));
    await f.broker.check();
    assert.equal(f.broker.status().state, "on", "encore utilisé il y a 15 minutes");
    assert.equal(f.broker.status().sleepsAt, paris(11, 7, 10, 35));

    f.at(paris(11, 7, 10, 36));
    await f.broker.check();
    assert.equal(f.broker.status().state, "pausing");
    assert.equal(f.posts().filter((p) => p.endsWith("undeploy")).length, 1);
  } finally {
    f.cleanup();
  }
});

test("Mac rallumé un lundi à 8 h, compte en pause depuis vendredi : il se rallume seul", async () => {
  const f = setup({ state: "UNDEPLOYED" });
  try {
    f.start(paris(11, 9, 8));
    await f.broker.check();
    assert.equal(f.broker.status().state, "waking");
    assert.deepEqual(f.posts(), ["POST /users/current/accounts/acc-1/deploy"]);
  } finally {
    f.cleanup();
  }
});

test("la nuit, en option : sautée tant qu'un trade est en cours ou en attente", async () => {
  const f = setup();
  try {
    f.start(paris(11, 3, 20));
    await f.broker.setRules({ nights: true });
    f.trades.push({ symbol: "NAS100" });
    f.at(paris(11, 3, 23, 30));
    await f.broker.check();
    assert.equal(f.broker.status().state, "on", "position ouverte : il reste allumé");
    f.trades.length = 0;
    await f.broker.check();
    assert.equal(f.broker.status().state, "pausing");
    await f.broker.check();
    assert.equal(f.broker.status().label, "En pause pour la nuit · reprise demain à 5 h");
    f.at(paris(11, 4, 5, 1));
    await f.broker.check();
    assert.equal(f.broker.status().state, "waking");
  } finally {
    f.cleanup();
  }
});

test("le week-end, une position ouverte n'empêche pas la pause (marchés fermés, stop et objectif chez le courtier)", async () => {
  const f = setup();
  try {
    f.start(paris(11, 6, 23, 10));
    f.trades.push({ symbol: "XAUUSD" });
    f.at(paris(11, 7, 9));
    await f.broker.check();
    assert.equal(f.broker.status().state, "pausing");
  } finally {
    f.cleanup();
  }
});

test("pause à la main un jour de marché : refusée avec un trade en cours sauf confirmation, toujours avec un ticket", async () => {
  const f = setup();
  try {
    f.start(paris(11, 3, 15));
    f.trades.push({ symbol: "NAS100" });
    await assert.rejects(f.broker.pause(), (e: Error) => e instanceof BrokerError && /trade en cours ou en attente \(NAS100\)/.test(e.message));
    f.setTicket({ id: "tk_1" });
    await assert.rejects(f.broker.pause(true), (e: Error) => e instanceof BrokerError && /ticket attend ta confirmation/.test(e.message));
    f.setTicket(undefined);
    await f.broker.pause(true);
    await f.broker.check();
    const s = f.broker.status();
    assert.equal(s.state, "paused");
    assert.equal(s.reason, "manual");
    assert.equal(s.label, "En pause à ta demande · reprise demain à 6 h 30");
    // Le lendemain matin de semaine, il se rallume de lui-même.
    f.at(paris(11, 4, 6, 31));
    await f.broker.check();
    assert.equal(f.broker.status().state, "waking");
  } finally {
    f.cleanup();
  }
});

test("pause coupée sur ce serveur (KOPILIA_BROKER_PAUSE=0) : rien n'est touché", async () => {
  const f = setup({ env: { KOPILIA_BROKER_PAUSE: "0" } });
  try {
    f.start(paris(11, 7, 10));
    assert.equal(f.broker.status().state, "off");
    await assert.rejects(f.broker.wake(true), BrokerError);
    assert.deepEqual(f.calls, []);
    assert.equal(f.market.paused, false);
  } finally {
    f.cleanup();
  }
});
