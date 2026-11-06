import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";

export const SCHEMA_VERSION = 20;

/**
 * Migrations des bases existantes, par version atteinte. Une base neuve reçoit
 * directement schema.sql, qui décrit toujours la dernière version.
 */
export const MIGRATIONS: Record<number, string> = {
  2: "ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';",
  3: `CREATE TABLE IF NOT EXISTS briefs (
        id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), trigger TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL, spoken TEXT NOT NULL, created_at INTEGER NOT NULL, announced_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs(created_at);`,
  4: `CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, at INTEGER NOT NULL, country TEXT NOT NULL, title TEXT NOT NULL,
        impact TEXT NOT NULL, forecast TEXT, previous TEXT, fetched_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_at ON calendar_events(source, at);
      CREATE TABLE IF NOT EXISTS calendar_fetches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL,
        events INTEGER, range_start INTEGER, range_end INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS idx_calendar_fetches_at ON calendar_fetches(source, at);`,
  5: `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), name TEXT NOT NULL, kind TEXT NOT NULL,
        media_type TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, pages INTEGER, chars INTEGER,
        inline INTEGER NOT NULL, turn_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id, turn_id);`,
  // Apprentissage : recherche dans les conversations, consigne et trace des
  // agents, recettes versionnées (l'ancienne table skills n'a jamais servi).
  6: `CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, outcome TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, content='turns', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text); END;
      CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
      CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text); END;
      INSERT INTO turns_fts(turns_fts) VALUES ('rebuild');
      ALTER TABLE jobs ADD COLUMN prompt TEXT;
      ALTER TABLE jobs ADD COLUMN trace TEXT;
      DROP TABLE IF EXISTS skills;
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, audience TEXT NOT NULL,
        description TEXT NOT NULL, body TEXT NOT NULL, files TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL, reason TEXT,
        run_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, announced_at INTEGER, UNIQUE(name, version));
      CREATE INDEX IF NOT EXISTS idx_skills_state ON skills(state, name);
      CREATE TABLE IF NOT EXISTS skill_meta (
        name TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, job_id TEXT, state TEXT NOT NULL, window_from INTEGER, window_to INTEGER,
        summary TEXT, changes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, finished_at INTEGER, announced_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_learning_runs_created ON learning_runs(created_at);
      CREATE TABLE IF NOT EXISTS learning_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Tableau de bord : les encarts affichés (graphiques, suivi des cours).
  7: `CREATE TABLE IF NOT EXISTS panels (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, spec TEXT NOT NULL, position INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  // L'index des tours par session manquait aux bases migrées en v6 (relecture, voisins d'un passage trouvé).
  8: `CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);`,
  // Analyse technique : les tracés d'un produit (lignes, obliques, zones).
  9: `CREATE TABLE IF NOT EXISTS drawings (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, label TEXT,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_drawings_symbol ON drawings(symbol, created_at);`,
  // Alertes : les tables de surveillance, réservées jusque-là et jamais remplies, prennent leur forme.
  10: `DROP TABLE IF EXISTS monitoring_events;
      DROP TABLE IF EXISTS monitoring_rules;
      CREATE TABLE monitoring_rules (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, symbol TEXT NOT NULL, drawing_id TEXT, spec TEXT NOT NULL, state TEXT NOT NULL,
        side INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, triggered_at INTEGER,
        triggered_price REAL);
      CREATE INDEX IF NOT EXISTS idx_monitoring_rules_symbol ON monitoring_rules(symbol, state);
      CREATE TABLE monitoring_events (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES monitoring_rules(id) ON DELETE CASCADE, occurrence TEXT NOT NULL,
        occurred_at INTEGER NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(rule_id, occurrence));
      CREATE INDEX IF NOT EXISTS idx_monitoring_events_delivered ON monitoring_events(delivered, occurred_at);`,
  // Recherche d'opportunités : alertes de l'IA (scénario, échéance), hypothèses, scénarios et leur fil,
  // exemples de setups, corrections de la carte automatique.
  11: `ALTER TABLE monitoring_rules ADD COLUMN scenario_id TEXT;
      ALTER TABLE monitoring_rules ADD COLUMN expires_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_monitoring_rules_scenario ON monitoring_rules(scenario_id);
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY, author TEXT NOT NULL, statement TEXT NOT NULL, products TEXT NOT NULL, bias TEXT NOT NULL, horizon TEXT NOT NULL,
        catalysts TEXT, invalidation TEXT NOT NULL, source TEXT, state TEXT NOT NULL, state_reason TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_hypotheses_state ON hypotheses(state, updated_at);
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, state_reason TEXT, review TEXT, wake_at INTEGER,
        wake_reason TEXT, feedback TEXT, outcome TEXT, checked_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, proposed_at INTEGER, told_at INTEGER, closed_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_scenarios_state ON scenarios(state, symbol);
      CREATE TABLE IF NOT EXISTS scenario_events (
        id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE, at INTEGER NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, by TEXT NOT NULL, job_id TEXT);
      CREATE INDEX IF NOT EXISTS idx_scenario_events ON scenario_events(scenario_id, at);
      CREATE INDEX IF NOT EXISTS idx_scenario_events_kind ON scenario_events(kind, at);
      CREATE TABLE IF NOT EXISTS setup_examples (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, timeframe TEXT NOT NULL, at INTEGER NOT NULL, positive INTEGER NOT NULL,
        note TEXT, context TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS map_adjustments (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, key TEXT NOT NULL, action TEXT NOT NULL, top REAL, bottom REAL,
        reason TEXT NOT NULL, job_id TEXT, created_at INTEGER NOT NULL, UNIQUE(symbol, timeframe, key));`,
  // Niveaux de travail de l'IA (tracés rattachés à un scénario), ce que l'utilisateur en garde, et ses suggestions sur les tracés de l'utilisateur.
  12: `ALTER TABLE drawings ADD COLUMN scenario_id TEXT;
      ALTER TABLE drawings ADD COLUMN reason TEXT;
      CREATE TABLE IF NOT EXISTS level_feedback (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, label TEXT, reason TEXT, verdict TEXT NOT NULL,
        note TEXT, scenario_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_level_feedback ON level_feedback(created_at);
      CREATE TABLE IF NOT EXISTS drawing_suggestions (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, drawing_id TEXT NOT NULL, scenario_id TEXT, text TEXT NOT NULL, state TEXT NOT NULL,
        job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_drawing_suggestions ON drawing_suggestions(state, symbol);`,
  // Indicateurs gardés par produit (et le modèle commun « * »), au-delà de la vie d'un encart.
  13: `CREATE TABLE IF NOT EXISTS chart_settings (symbol TEXT PRIMARY KEY, indicators TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  // Fiches d'analyse de l'utilisateur, une ouverte par produit, et leur fil.
  14: `CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, digits INTEGER, author TEXT NOT NULL, view TEXT NOT NULL,
        state TEXT NOT NULL, close_reason TEXT, closed_by TEXT, close_proposed_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, closed_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_open ON analyses(symbol) WHERE state = 'open';
      CREATE INDEX IF NOT EXISTS idx_analyses_symbol ON analyses(symbol, updated_at);
      CREATE TABLE IF NOT EXISTS analysis_entries (
        id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE, at INTEGER NOT NULL,
        kind TEXT NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL, data TEXT);
      CREATE INDEX IF NOT EXISTS idx_analysis_entries ON analysis_entries(analysis_id, at);`,
  // Prise de position : le money management, les trades passés par Kopilia et le journal de chaque ordre.
  15: `CREATE TABLE IF NOT EXISTS trading_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, state TEXT NOT NULL, spec TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_trades_state ON trades(state, created_at);
      CREATE TABLE IF NOT EXISTS trade_events (
        id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_trade_events ON trade_events(trade_id, at);`,
  // News en temps réel et chiffres publiés, gardés pour toujours ; rejouable sans dommage (IF NOT EXISTS partout).
  16: `CREATE TABLE IF NOT EXISTS news_items (
  id          TEXT PRIMARY KEY,        -- nw_<guid du site>
  source      TEXT NOT NULL,           -- financialjuice
  guid        TEXT NOT NULL,
  at          INTEGER NOT NULL,        -- publication (epoch ms)
  original    TEXT NOT NULL,           -- le titre d'origine, sans le préfixe du site
  text        TEXT,                    -- le texte, rare
  link        TEXT,
  title_fr    TEXT,                    -- la traduction (NULL tant qu'elle n'est pas faite)
  impact      TEXT,                    -- au plus une ligne, s'il y a un effet probable sur sa liste
  symbols     TEXT NOT NULL DEFAULT '[]', -- JSON : les produits de sa liste qu'elle touche
  level       TEXT NOT NULL,           -- high | medium | low
  elite       INTEGER NOT NULL DEFAULT 0, -- aperçu de l'offre payante du site
  reaction    TEXT,                    -- JSON : ce qu'a fait un produit juste après
  tries       INTEGER NOT NULL DEFAULT 0, -- traductions tentées
  announced_at INTEGER,                -- dite (voix, bandeau, Telegram)
  fetched_at  INTEGER NOT NULL,
  UNIQUE(source, guid)
);
CREATE INDEX IF NOT EXISTS idx_news_items_at ON news_items(at);
CREATE VIRTUAL TABLE IF NOT EXISTS news_fts USING fts5(original, title_fr, content='news_items', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS news_items_ai AFTER INSERT ON news_items BEGIN
  INSERT INTO news_fts(rowid, original, title_fr) VALUES (new.rowid, new.original, new.title_fr); END;
CREATE TRIGGER IF NOT EXISTS news_items_ad AFTER DELETE ON news_items BEGIN
  INSERT INTO news_fts(news_fts, rowid, original, title_fr) VALUES ('delete', old.rowid, old.original, old.title_fr); END;
CREATE TRIGGER IF NOT EXISTS news_items_au AFTER UPDATE OF original, title_fr ON news_items BEGIN
  INSERT INTO news_fts(news_fts, rowid, original, title_fr) VALUES ('delete', old.rowid, old.original, old.title_fr);
  INSERT INTO news_fts(rowid, original, title_fr) VALUES (new.rowid, new.original, new.title_fr); END;

-- Chiffres publiés (lus dans les news), gardés pour toujours, et l'annonce du
-- calendrier qu'ils complètent (à part : la mise à jour de la semaine réécrit
-- calendar_events, elle ne doit pas les effacer).
CREATE TABLE IF NOT EXISTS econ_figures (
  id           TEXT PRIMARY KEY,
  news_id      TEXT NOT NULL UNIQUE,
  at           INTEGER NOT NULL,       -- publication du chiffre
  event        TEXT NOT NULL,          -- le nom dans la news (« US Initial Jobless Claims »)
  country      TEXT,                   -- devise déduite du nom (USD…)
  actual       TEXT NOT NULL,
  forecast     TEXT,                   -- consensus donné par la news
  previous     TEXT,
  revised      TEXT,
  cal_at       INTEGER,                -- l'annonce du calendrier rapprochée
  cal_country  TEXT,
  cal_title    TEXT,
  cal_impact   TEXT,
  cal_forecast TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_econ_figures_at ON econ_figures(at);
CREATE INDEX IF NOT EXISTS idx_econ_figures_cal ON econ_figures(cal_at, cal_country, cal_title);`,
  // Journal de trading : ce qu'un événement de trade porte de plus (un geste : avant, après, d'où), et le graphique figé au ticket.
  17: `ALTER TABLE trade_events ADD COLUMN data TEXT;
      CREATE TABLE IF NOT EXISTS trade_snapshots (
        trade_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, analysis_id TEXT, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_trade_snapshots_analysis ON trade_snapshots(analysis_id);`,
  // Journal de trading : les analyses de son trading par l'IA, gardées et datées.
  18: `CREATE TABLE IF NOT EXISTS journal_reviews (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, days INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_journal_reviews ON journal_reviews(created_at);`,
  // Laboratoire de stratégies : la réserve de bougies (par source, produit et unité), les robots écrits par
  // Kopilia, leurs versions (code et plan), leurs backtests et leurs trades, le fil de chaque fiche, et les
  // leçons du carnet du laboratoire.
  19: `CREATE TABLE IF NOT EXISTS candles (
        source TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, t INTEGER NOT NULL,
        o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL,
        PRIMARY KEY (source, symbol, timeframe, t)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candle_coverage (
        source TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
        first_t INTEGER NOT NULL, last_t INTEGER NOT NULL, count INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, PRIMARY KEY (source, symbol, timeframe));
      CREATE TABLE IF NOT EXISTS robots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, idea TEXT NOT NULL, status TEXT NOT NULL, hypothesis TEXT, plan TEXT,
        products TEXT NOT NULL, timeframe TEXT, version INTEGER NOT NULL DEFAULT 0, trials INTEGER NOT NULL DEFAULT 0,
        best_backtest_id TEXT, job_id TEXT, parents TEXT NOT NULL DEFAULT '[]', session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS robot_versions (
        robot_id TEXT NOT NULL REFERENCES robots(id) ON DELETE CASCADE, version INTEGER NOT NULL,
        code TEXT NOT NULL, plan TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (robot_id, version));
      CREATE TABLE IF NOT EXISTS backtests (
        id TEXT PRIMARY KEY, robot_id TEXT NOT NULL REFERENCES robots(id) ON DELETE CASCADE, version INTEGER NOT NULL,
        job_id TEXT, trial INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_backtests_robot ON backtests(robot_id, created_at);
      CREATE TABLE IF NOT EXISTS backtest_trades (
        backtest_id TEXT NOT NULL REFERENCES backtests(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_backtest_trades ON backtest_trades(backtest_id);
      CREATE TABLE IF NOT EXISTS robot_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, robot_id TEXT NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, backtest_id TEXT, job_id TEXT);
      CREATE INDEX IF NOT EXISTS idx_robot_notes ON robot_notes(robot_id, at);
      CREATE TABLE IF NOT EXISTS lab_lessons (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, products TEXT NOT NULL, timeframe TEXT, robot_id TEXT, backtest_id TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);`,
  // Le nom Kopilia : ce que l'application signait « ecovis » (tracés, alertes, hypothèses, analyses, gestes
  // et sorties de trade, graphiques figés, bilans) est signé « kopilia ».
  20: `UPDATE drawings SET created_by = 'kopilia' WHERE created_by = 'ecovis';
      UPDATE monitoring_rules SET created_by = 'kopilia' WHERE created_by = 'ecovis';
      UPDATE hypotheses SET author = 'kopilia' WHERE author = 'ecovis';
      UPDATE analyses SET author = 'kopilia' WHERE author = 'ecovis';
      UPDATE analyses SET closed_by = 'kopilia' WHERE closed_by = 'ecovis';
      UPDATE analysis_entries SET "by" = 'kopilia' WHERE "by" = 'ecovis';
      UPDATE trades SET spec = replace(spec, '"ecovis"', '"kopilia"') WHERE instr(spec, '"ecovis"') > 0;
      UPDATE trade_events SET data = replace(data, '"ecovis"', '"kopilia"') WHERE instr(data, '"ecovis"') > 0;
      UPDATE trade_snapshots SET data = replace(data, '"ecovis"', '"kopilia"') WHERE instr(data, '"ecovis"') > 0;
      UPDATE journal_reviews SET data = replace(data, '"ecovis"', '"kopilia"') WHERE instr(data, '"ecovis"') > 0;`,
};

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  db!: Database.Database;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit() {
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    this.db = new Database(this.config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.logger.log(`SQLite ouvert: ${this.config.dbPath} (schema v${SCHEMA_VERSION})`, "db");
  }

  onModuleDestroy() {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
  }

  private migrate() {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current >= SCHEMA_VERSION) return;
    // La version est écrite dans la même transaction que le schéma : un arrêt
    // au mauvais moment ne laisse jamais une base migrée mais marquée ancienne
    // (les migrations rejouées échoueraient : colonne déjà ajoutée).
    this.tx(() => {
      if (current === 0) {
        // schema.sql est la source de vérité ; lue depuis le dépôt (dev et build).
        const schemaPath = resolve(this.config.repoRoot, "apps/server/src/db/schema.sql");
        this.db.exec(readFileSync(schemaPath, "utf8"));
      } else {
        for (let v = current + 1; v <= SCHEMA_VERSION; v++) if (MIGRATIONS[v]) this.db.exec(MIGRATIONS[v]);
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    this.logger.log(`Schéma appliqué (v${current} -> v${SCHEMA_VERSION})`, "db");
  }

  /** Exécute `fn` dans une transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
