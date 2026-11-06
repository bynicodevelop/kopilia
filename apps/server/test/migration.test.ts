import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { ConfigService } from "../src/config/config.service.js";
import { DatabaseService, MIGRATIONS, SCHEMA_VERSION } from "../src/db/database.service.js";
import { AppLogger } from "../src/common/logger.js";

test("base v1 existante : migrée sans perte (jobs.kind, briefs, calendrier)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kopilia-mig-"));
  try {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    // Base telle que créée par la version précédente : jobs sans `kind`.
    const old = new Database(join(dataDir, "kopilia.sqlite"));
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, claude_session_id TEXT, project_id TEXT, token TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT, claude_session_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL, summary TEXT, pending_instruction TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('s1', NULL, NULL, 't', 'closed', 1, 1);
      INSERT INTO jobs VALUES ('j1', 's1', NULL, NULL, 'Ancienne tâche', 'succeeded', 'ok', NULL, 'success', 1, 1);
      PRAGMA user_version = 1;
    `);
    old.close();

    process.env.KOPILIA_DATA_DIR = dataDir;
    const db = new DatabaseService(new ConfigService(), new AppLogger());
    db.onModuleInit();
    const row = db.db.prepare("SELECT title, kind FROM jobs WHERE id = 'j1'").get() as { title: string; kind: string };
    assert.deepEqual(row, { title: "Ancienne tâche", kind: "task" });
    assert.equal(db.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    // v6 : recherche dans les conversations, recettes versionnées, apprentissage ; v7 : tableau de bord.
    for (const table of ["turns", "skills", "skill_meta", "learning_runs", "learning_state", "panels", "drawings", "monitoring_rules", "monitoring_events"]) {
      assert.equal((db.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c, 0, table);
    }
    assert.deepEqual(db.db.prepare("SELECT prompt, trace FROM jobs WHERE id = 'j1'").get(), { prompt: null, trace: null });
    assert.equal((db.db.prepare("SELECT count(*) c FROM documents").get() as { c: number }).c, 0);
    assert.equal((db.db.prepare("SELECT count(*) c FROM briefs").get() as { c: number }).c, 0);
    assert.equal((db.db.prepare("SELECT count(*) c FROM calendar_events").get() as { c: number }).c, 0);
    assert.equal((db.db.prepare("SELECT count(*) c FROM calendar_fetches").get() as { c: number }).c, 0);
    db.onModuleDestroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Tables et colonnes d'une base (nom, type, non nul, défaut, clé), indépendamment de l'ordre. */
function shape(db: Database.Database) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name")
    .all() as { name: string }[];
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
    out[name] = cols
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)
      .sort()
      .join(", ");
  }
  return out;
}

function objects(db: Database.Database, type: "index" | "trigger") {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(type) as { name: string }[]).map(
    (r) => r.name,
  );
}

/**
 * Une base « v1 » reconstruite : le schéma neuf, moins tout ce que les migrations
 * 2 à 10 ajoutent et les tables que la v17 complète (le journal des trades, la
 * v15 le recrée sans sa colonne data), plus l'ancienne table skills (retirée en v6) et les tables de
 * surveillance réservées d'avant les alertes (refaites en v10).
 */
function v1(db: Database.Database) {
  db.exec(readFileSync(resolve(import.meta.dirname, "../src/db/schema.sql"), "utf8"));
  db.exec(`
    DROP TABLE briefs; DROP TABLE calendar_events; DROP TABLE calendar_fetches; DROP TABLE documents;
    DROP TABLE turns_fts; DROP TABLE turns; DROP TABLE skill_meta; DROP TABLE learning_runs;
    DROP TABLE learning_state; DROP TABLE panels; DROP TABLE drawings; DROP TABLE skills;
    CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT);
    DROP TABLE monitoring_events; DROP TABLE monitoring_rules;
    CREATE TABLE monitoring_rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL, channel TEXT NOT NULL, timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE monitoring_events (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES monitoring_rules(id), occurrence TEXT NOT NULL,
      occurred_at INTEGER NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(rule_id, occurrence));
    ALTER TABLE jobs DROP COLUMN trace; ALTER TABLE jobs DROP COLUMN prompt; ALTER TABLE jobs DROP COLUMN kind;
    DROP TABLE trade_events; DROP TABLE trade_snapshots;
  `);
}

test("migrations : depuis chaque version antérieure, la base rejoint le schéma neuf", () => {
  const fresh = new Database(":memory:");
  fresh.exec(readFileSync(resolve(import.meta.dirname, "../src/db/schema.sql"), "utf8"));
  const want = shape(fresh);
  const wantTriggers = objects(fresh, "trigger");
  const wantIndexes = objects(fresh, "index");
  for (let from = 1; from < SCHEMA_VERSION; from++) {
    const dir = mkdtempSync(join(tmpdir(), `kopilia-mig${from}-`));
    try {
      const dataDir = join(dir, "data");
      mkdirSync(dataDir);
      const old = new Database(join(dataDir, "kopilia.sqlite"));
      v1(old);
      for (let v = 2; v <= from; v++) if (MIGRATIONS[v]) old.exec(MIGRATIONS[v]);
      old.pragma(`user_version = ${from}`);
      old.close();

      process.env.KOPILIA_DATA_DIR = dataDir;
      const db = new DatabaseService(new ConfigService(), new AppLogger());
      db.onModuleInit();
      assert.equal(db.db.pragma("user_version", { simple: true }), SCHEMA_VERSION, `v${from}`);
      const got = shape(db.db);
      for (const table of Object.keys(want)) {
        assert.equal(got[table], want[table], `v${from} -> v${SCHEMA_VERSION} : table ${table}`);
      }
      assert.deepEqual(objects(db.db, "trigger"), wantTriggers, `v${from} : déclencheurs FTS`);
      assert.deepEqual(objects(db.db, "index"), wantIndexes, `v${from} : index`);
      // Le moteur de recherche des conversations fonctionne après migration.
      db.db.prepare("INSERT INTO sessions (id, token, state, created_at, updated_at) VALUES ('s', 't', 'active', 1, 1)").run();
      db.db.prepare("INSERT INTO turns (id, session_id, turn_id, role, text, created_at) VALUES ('t1', 's', 'u1', 'user', 'le café est prêt', 1)").run();
      assert.equal((db.db.prepare("SELECT count(*) c FROM turns_fts WHERE turns_fts MATCH 'cafe'").get() as { c: number }).c, 1, `v${from} : recherche`);
      db.onModuleDestroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("migration : rejouée après un arrêt brutal, elle ne casse pas la base", () => {
  const data = join(mkdtempSync(join(tmpdir(), "kopilia-mig-again-")), "data");
  try {
    mkdirSync(data);
    process.env.KOPILIA_DATA_DIR = data;
    const first = new DatabaseService(new ConfigService(), new AppLogger());
    first.onModuleInit();
    first.onModuleDestroy();
    // Deuxième ouverture de la même base : rien à refaire, aucune erreur.
    const again = new DatabaseService(new ConfigService(), new AppLogger());
    again.onModuleInit();
    assert.equal(again.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    again.onModuleDestroy();
  } finally {
    rmSync(resolve(data, ".."), { recursive: true, force: true });
  }
});

test("nom Kopilia : une base d'avant (jarvis.sqlite) est reprise, et ce qu'elle signait « ecovis » devient « kopilia »", () => {
  const data = join(mkdtempSync(join(tmpdir(), "kopilia-mig-nom-")), "data");
  try {
    mkdirSync(data);
    // Une base v19 telle que l'a laissée l'application sous son ancien nom.
    process.env.KOPILIA_DATA_DIR = data;
    const before = new DatabaseService(new ConfigService(), new AppLogger());
    before.onModuleInit();
    before.onModuleDestroy();
    renameSync(join(data, "kopilia.sqlite"), join(data, "jarvis.sqlite"));
    const old = new Database(join(data, "jarvis.sqlite"));
    old.exec(`
      INSERT INTO drawings (id, symbol, kind, spec, created_by, created_at, updated_at) VALUES ('d1', 'XAUUSD', 'hline', '{}', 'ecovis', 1, 1);
      INSERT INTO drawings (id, symbol, kind, spec, created_by, created_at, updated_at) VALUES ('d2', 'XAUUSD', 'hline', '{}', 'user', 1, 1);
    `);
    old.pragma("user_version = 19");
    old.close();

    const db = new DatabaseService(new ConfigService(), new AppLogger());
    db.onModuleInit();
    assert.ok(db.db.name.endsWith("/jarvis.sqlite"), "le fichier existant est gardé");
    assert.equal(db.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    const by = db.db.prepare("SELECT id, created_by FROM drawings ORDER BY id").all();
    assert.deepEqual(by, [
      { id: "d1", created_by: "kopilia" },
      { id: "d2", created_by: "user" },
    ]);
    db.onModuleDestroy();
    assert.equal(existsSync(join(data, "kopilia.sqlite")), false, "pas de seconde base à côté");
  } finally {
    rmSync(resolve(data, ".."), { recursive: true, force: true });
  }
});
