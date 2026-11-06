-- Schéma Kopilia (SQLite). Appliqué par DatabaseService.
-- Toutes les écritures passent par des transactions côté Nest.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Projets (dépôts) autorisés, identifiés par leur chemin canonique.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,   -- chemin canonique (realpath)
  label       TEXT NOT NULL,
  authorized  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- Sessions de dialogue Kopilia (connexion logique navigateur <-> serveur).
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  claude_session_id  TEXT,            -- id de session CLI (pour --resume)
  project_id         TEXT REFERENCES projects(id),
  token              TEXT NOT NULL,   -- jeton court d'ouverture WS
  state              TEXT NOT NULL,   -- active | closed | system (veille, apprentissage : jamais fermée)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Tours de dialogue (utilisateur + assistant), rétention configurable.
CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  turn_id     TEXT NOT NULL,          -- id logique du tour (côté client)
  role        TEXT NOT NULL,          -- user | assistant
  text        TEXT NOT NULL,
  outcome     TEXT,                   -- success | error | interrupted (assistant)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at);

-- Recherche plein texte dans les conversations passées (« on en avait parlé… »).
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text,
  content='turns',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Agents et tâches (sessions Claude Code distinctes, lancées par Kopilia).
CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id),
  kind                 TEXT NOT NULL DEFAULT 'task', -- agent (lecture seule) | task (agit)
  project_id           TEXT REFERENCES projects(id),
  claude_session_id    TEXT,
  title                TEXT NOT NULL,
  state                TEXT NOT NULL,   -- queued|running|awaiting_approval|succeeded|failed|cancelled|unverified
  summary              TEXT,
  pending_instruction  TEXT,
  outcome              TEXT,
  prompt               TEXT,            -- consigne reçue (relue par l'apprentissage)
  trace                TEXT,            -- JSON : outils appelés, en bref, et leurs erreurs
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

-- Approbations d'actions sensibles.
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES jobs(id),
  session_id  TEXT REFERENCES sessions(id),
  action      TEXT NOT NULL,         -- description exacte de l'action
  project_id  TEXT,
  state       TEXT NOT NULL,         -- pending | approved | denied | expired
  decision    TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

-- Briefs de veille (macro, banques centrales, géopolitique), rédigés par un agent.
CREATE TABLE IF NOT EXISTS briefs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT REFERENCES jobs(id),
  trigger       TEXT NOT NULL,       -- manual | scheduled
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,       -- Markdown complet
  spoken        TEXT NOT NULL,       -- « En bref » : ce que Kopilia dit à voix haute
  created_at    INTEGER NOT NULL,
  announced_at  INTEGER              -- NULL tant que Kopilia ne l'a pas annoncé
);
CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs(created_at);

-- Documents déposés dans la conversation : ils partent avec la phrase suivante de l'utilisateur.
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  name        TEXT NOT NULL,         -- nom d'origine du fichier
  kind        TEXT NOT NULL,         -- pdf | image | text
  media_type  TEXT NOT NULL,         -- type du fichier lu par Claude
  path        TEXT NOT NULL,         -- fichier lu par Claude (converti si besoin : Word -> texte, HEIC -> JPEG)
  size        INTEGER NOT NULL,      -- octets reçus
  pages       INTEGER,               -- PDF
  chars       INTEGER,               -- texte
  inline      INTEGER NOT NULL,      -- 1 : lu par le dialogue ; 0 : trop long, confié à un agent
  turn_id     TEXT,                  -- phrase qui l'a emporté (NULL : en attente)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id, turn_id);

-- Calendrier économique (Forex Factory), semaine par semaine. Instants en UTC (ms).
CREATE TABLE IF NOT EXISTS calendar_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,         -- forexfactory
  at          INTEGER NOT NULL,      -- heure de l'annonce
  country     TEXT NOT NULL,         -- devise concernée (USD, EUR…)
  title       TEXT NOT NULL,
  impact      TEXT NOT NULL,         -- high | medium | low | holiday
  forecast    TEXT,                  -- prévision (consensus), telle que publiée
  previous    TEXT,
  fetched_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_at ON calendar_events(source, at);

-- Récupérations du calendrier (fraîcheur, limite de requêtes, semaine couverte).
CREATE TABLE IF NOT EXISTS calendar_fetches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  events      INTEGER,
  range_start INTEGER,               -- semaine couverte par le flux
  range_end   INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_calendar_fetches_at ON calendar_fetches(source, at);

-- Mémoire (personnelle ou projet), indépendante du contexte du CLI.
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,       -- personal (profil) | environment (notes d'environnement) | project
  project_id    TEXT,                -- NULL si personal
  kind          TEXT NOT NULL,       -- fact|preference|decision|correction|topic|commitment|hypothesis
  content       TEXT NOT NULL,
  provenance    TEXT NOT NULL,       -- turn:<id> | instruction | inference
  status        TEXT NOT NULL,       -- active | superseded | forgotten
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER NOT NULL,
  expires_at    INTEGER,
  supersedes_id TEXT REFERENCES memories(id)
);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, project_id, status);

-- Index plein-texte FTS5 sur le contenu des souvenirs actifs.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Alertes (règles de surveillance) : à un prix, sur un tracé d'un produit
-- (ligne, oblique, zone) ou sur une bande de prix ; plus tard sur un
-- indicateur. Surveillées par le serveur sur les cotations.
CREATE TABLE IF NOT EXISTS monitoring_rules (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,     -- price | drawing | band
  symbol          TEXT NOT NULL,     -- symbole exact du courtier
  drawing_id      TEXT,              -- tracé suivi (kind drawing)
  spec            TEXT NOT NULL,     -- JSON : produit, prix, condition, déclenchement, unité de temps, consigne
  state           TEXT NOT NULL,     -- active | paused | triggered | expired
  side            INTEGER,           -- côté du prix : 1 au-dessus du niveau, -1 au-dessous, 0 dessus
  created_by      TEXT NOT NULL,     -- user | kopilia
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,  -- dernière fois (ré)armée
  triggered_at    INTEGER,
  triggered_price REAL,
  scenario_id     TEXT,              -- alerte de l'IA : le scénario dont elle réveille l'agent
  expires_at      INTEGER            -- échéance (toujours donnée pour une alerte de l'IA)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_rules_symbol ON monitoring_rules(symbol, state);
CREATE INDEX IF NOT EXISTS idx_monitoring_rules_scenario ON monitoring_rules(scenario_id);

-- Déclenchements (dédupliqués par alerte + clé d'occurrence : une fois, une bougie) ;
-- `delivered` : Kopilia l'a dit (sinon, au prochain décroché).
CREATE TABLE IF NOT EXISTS monitoring_events (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL REFERENCES monitoring_rules(id) ON DELETE CASCADE,
  occurrence   TEXT NOT NULL,
  occurred_at  INTEGER NOT NULL,
  payload      TEXT NOT NULL,        -- JSON : sens, prix, niveau
  delivered    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(rule_id, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_events_delivered ON monitoring_events(delivered, occurred_at);

-- Cache d'observations de marché datées (faits, pas interprétations).
CREATE TABLE IF NOT EXISTS observations (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  url           TEXT NOT NULL,
  org           TEXT NOT NULL,
  period        TEXT,
  value         TEXT,
  unit          TEXT,
  revision      TEXT,
  published_at  INTEGER,
  collected_at  INTEGER NOT NULL      -- UTC
);

-- Rôles versionnés et compétences générées.
CREATE TABLE IF NOT EXISTS roles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  config     TEXT NOT NULL,          -- JSON
  created_at INTEGER NOT NULL,
  UNIQUE(name, version)
);

-- Recettes (skills) : comment faire une classe de tâches pour l'utilisateur.
-- Chaque changement est une nouvelle version ; une seule version active par nom.
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,          -- kebab-case, au niveau de la classe de tâches
  version      INTEGER NOT NULL,
  state        TEXT NOT NULL,          -- draft | active | superseded | rejected | archived
  audience     TEXT NOT NULL,          -- dialogue | agents | all
  description  TEXT NOT NULL,          -- quand l'ouvrir (index)
  body         TEXT NOT NULL,          -- la recette (Markdown)
  files        TEXT NOT NULL DEFAULT '{}', -- JSON { "references/<sujet>.md": "…" }
  origin       TEXT NOT NULL,          -- review | curator | user
  reason       TEXT,                   -- pourquoi ce changement (montré à la validation)
  run_id       TEXT,                   -- relecture ou rangement d'origine
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  announced_at INTEGER,
  UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS idx_skills_state ON skills(state, name);

-- Usage et protection d'une recette, toutes versions confondues.
CREATE TABLE IF NOT EXISTS skill_meta (
  name         TEXT PRIMARY KEY,
  pinned       INTEGER NOT NULL DEFAULT 0, -- épinglée : jamais archivée ni fusionnée
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- Relectures (ce que Kopilia retient d'une conversation) et rangements.
CREATE TABLE IF NOT EXISTS learning_runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,          -- review | curator
  job_id       TEXT,
  state        TEXT NOT NULL,          -- running | done | failed
  window_from  INTEGER,                -- tours relus : created_at > window_from
  window_to    INTEGER,                --               et <= window_to
  summary      TEXT,
  changes      TEXT NOT NULL DEFAULT '[]', -- JSON : ce qui a changé (souvenirs, recettes)
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  announced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_learning_runs_created ON learning_runs(created_at);

-- État de l'apprentissage (curseur des tours relus, dernier rangement).
CREATE TABLE IF NOT EXISTS learning_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tableau de bord : les encarts affichés (graphique d'un produit, suivi de
-- plusieurs), gardés d'une conversation et d'un redémarrage à l'autre.
CREATE TABLE IF NOT EXISTS panels (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,         -- chart | quotes | setups
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,         -- JSON : symbole, unité de temps, produits suivis
  position    INTEGER NOT NULL,      -- ordre d'affichage
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Réglages des graphiques d'un produit, gardés quand son encart se ferme :
-- ses indicateurs, retrouvés à sa réouverture. « * » : le modèle commun, pour
-- les produits qui n'ont pas les leurs.
CREATE TABLE IF NOT EXISTS chart_settings (
  symbol      TEXT PRIMARY KEY,      -- symbole exact du courtier, ou « * »
  indicators  TEXT NOT NULL,         -- JSON : les indicateurs (moyennes, RSI)
  updated_at  INTEGER NOT NULL
);

-- Tracés d'analyse technique d'un produit (ligne horizontale, oblique, zone),
-- dessinés à la souris ou par Kopilia ; leur identifiant est stable : les
-- alertes s'y rattacheront.
CREATE TABLE IF NOT EXISTS drawings (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,         -- symbole exact du courtier
  kind        TEXT NOT NULL,         -- hline | trendline | zone | fib | fibext | position
  spec        TEXT NOT NULL,         -- JSON : prix, points (instant de bougie, prix), prolongement
  label       TEXT,
  created_by  TEXT NOT NULL,         -- user | kopilia | ia (niveau de travail d'un scénario)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  scenario_id TEXT,                  -- ia : le scénario qui l'a tracé (il part avec lui)
  reason      TEXT                   -- ia : pourquoi ce niveau
);
CREATE INDEX IF NOT EXISTS idx_drawings_symbol ON drawings(symbol, created_at);

-- Recherche d'opportunités : hypothèses (le sens attendu, de l'IA ou de
-- l'utilisateur), scénarios (le dossier que l'IA ouvre sur un produit, ses
-- alertes et ses rendez-vous), leur fil, les exemples de setups montrés par
-- l'utilisateur, et les corrections de la carte automatique.
CREATE TABLE IF NOT EXISTS hypotheses (
  id            TEXT PRIMARY KEY,
  author        TEXT NOT NULL,         -- user | kopilia
  statement     TEXT NOT NULL,
  products      TEXT NOT NULL,         -- JSON [{symbol, name}]
  bias          TEXT NOT NULL,         -- up | down | neutral
  horizon       TEXT NOT NULL,         -- intraday | swing
  catalysts     TEXT,
  invalidation  TEXT NOT NULL,
  source        TEXT,
  state         TEXT NOT NULL,         -- active | confirmed | invalidated | expired
  state_reason  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_state ON hypotheses(state, updated_at);

CREATE TABLE IF NOT EXISTS scenarios (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,         -- symbole exact du courtier
  spec          TEXT NOT NULL,         -- JSON : produit, sens, unités, pourquoi, photo, plan, invalidation, dépendances, niveaux
  state         TEXT NOT NULL,         -- watching | proposed | invalidated | expired | closed
  state_reason  TEXT,
  review        TEXT,                  -- une dépendance a changé depuis la dernière lecture
  wake_at       INTEGER,               -- prochain rendez-vous de l'agent
  wake_reason   TEXT,
  feedback      TEXT,                  -- JSON : réaction de l'utilisateur
  outcome       TEXT,                  -- JSON : résultat d'un setup proposé
  checked_at    INTEGER NOT NULL,      -- dernière lecture par l'IA (« ce qui a changé depuis »)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  proposed_at   INTEGER,
  told_at       INTEGER,               -- l'utilisateur a été prévenu
  closed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scenarios_state ON scenarios(state, symbol);

CREATE TABLE IF NOT EXISTS scenario_events (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL,          -- opened | alert | rendezvous | wake | decision | context | feedback | update | note | proposed | closed
  text         TEXT NOT NULL,
  by           TEXT NOT NULL,          -- agent | user | system
  job_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scenario_events ON scenario_events(scenario_id, at);
CREATE INDEX IF NOT EXISTS idx_scenario_events_kind ON scenario_events(kind, at);

-- « Ça, c'est un setup » : un instant du graphique montré par l'utilisateur, et son contexte.
CREATE TABLE IF NOT EXISTS setup_examples (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  name        TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  at          INTEGER NOT NULL,        -- instant du setup (epoch ms)
  positive    INTEGER NOT NULL,        -- 1 : un setup ; 0 : un contre-exemple
  note        TEXT,
  context     TEXT NOT NULL,           -- JSON : prix, tracés, indicateurs à cet instant
  created_at  INTEGER NOT NULL
);

-- Carte automatique corrigée par l'IA : une zone ou une oblique ajustée ou écartée, et pourquoi.
CREATE TABLE IF NOT EXISTS map_adjustments (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  key         TEXT NOT NULL,           -- clé stable de l'élément de la carte
  action      TEXT NOT NULL,           -- adjust | remove
  top         REAL,
  bottom      REAL,
  reason      TEXT NOT NULL,
  job_id      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(symbol, timeframe, key)
);

-- Niveaux de l'IA gardés ou retirés par l'utilisateur : ce qu'il retient ou non (sa façon de trader).
CREATE TABLE IF NOT EXISTS level_feedback (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- hline | trendline | zone
  spec        TEXT NOT NULL,           -- JSON de la forme
  label       TEXT,
  reason      TEXT,                    -- pourquoi l'IA l'avait tracé
  verdict     TEXT NOT NULL,           -- keep | dismiss
  note        TEXT,
  scenario_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_level_feedback ON level_feedback(created_at);

-- Suggestions de l'IA sur les tracés de l'utilisateur (elle ne les modifie jamais : elle les signale).
CREATE TABLE IF NOT EXISTS drawing_suggestions (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  drawing_id  TEXT NOT NULL,
  scenario_id TEXT,
  text        TEXT NOT NULL,
  state       TEXT NOT NULL,           -- open | done | dismissed
  job_id      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drawing_suggestions ON drawing_suggestions(state, symbol);

-- Fiches d'analyse : l'analyse de l'utilisateur sur un produit (biais
-- fondamental et technique, idée de trade, invalidation), une fiche ouverte par
-- produit qui continue d'un jour à l'autre, et son fil daté (ce qu'il a dit, les
-- objections du contradicteur, ce qui est arrivé), jamais effacé.
CREATE TABLE IF NOT EXISTS analyses (
  id                TEXT PRIMARY KEY,
  symbol            TEXT NOT NULL,     -- symbole exact du courtier
  name              TEXT NOT NULL,
  digits            INTEGER,
  author            TEXT NOT NULL,     -- user | kopilia
  view              TEXT NOT NULL,     -- JSON : l'état courant (biais, idée, invalidation)
  state             TEXT NOT NULL,     -- open | closed
  close_reason      TEXT,
  closed_by         TEXT,              -- user | kopilia (sur sa confirmation)
  close_proposed_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_open ON analyses(symbol) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_analyses_symbol ON analyses(symbol, updated_at);

CREATE TABLE IF NOT EXISTS analysis_entries (
  id          TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,           -- view | why | challenge | setup | zone | invalidated | close_proposed | closed
  by          TEXT NOT NULL,           -- user | kopilia | system
  text        TEXT NOT NULL,
  data        TEXT                     -- JSON : l'état de la fiche après une lecture (view), les points relevés (challenge)
);
CREATE INDEX IF NOT EXISTS idx_analysis_entries ON analysis_entries(analysis_id, at);

-- Prise de position : le money management de l'utilisateur (clé « money », JSON).
CREATE TABLE IF NOT EXISTS trading_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Trades passés par Kopilia sur la confirmation de l'utilisateur, suivis chez le courtier par leur clientId.
CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,           -- symbole exact du courtier
  state       TEXT NOT NULL,           -- pending | open | closed | cancelled | rejected
  spec        TEXT NOT NULL,           -- JSON : le trade (niveaux, jambes, résultat)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_state ON trades(state, created_at);

-- Le journal de chaque ordre : le ticket confirmé, ce qui est parti, la réponse du courtier.
CREATE TABLE IF NOT EXISTS trade_events (
  id          TEXT PRIMARY KEY,
  trade_id    TEXT NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,           -- ticket | order | rejected | unknown | filled | closed | cancelled | gesture | note
  text        TEXT NOT NULL,
  data        TEXT                     -- JSON : un geste (stop, objectif, part fermée : avant, après, d'où)
);
CREATE INDEX IF NOT EXISTS idx_trade_events ON trade_events(trade_id, at);

-- Journal de trading : le graphique d'un trade figé à la confirmation du ticket
-- (ses tracés, son unité de temps, ses indicateurs) et la fiche d'analyse alors ouverte.
CREATE TABLE IF NOT EXISTS trade_snapshots (
  trade_id    TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  analysis_id TEXT,                    -- la fiche du produit ouverte au ticket
  at          INTEGER NOT NULL,
  data        TEXT NOT NULL            -- JSON : tracés, unité de temps, indicateurs, état de la fiche
);
CREATE INDEX IF NOT EXISTS idx_trade_snapshots_analysis ON trade_snapshots(analysis_id);

-- Journal de trading : les analyses de son trading par l'IA, à sa demande, gardées et datées.
CREATE TABLE IF NOT EXISTS journal_reviews (
  id          TEXT PRIMARY KEY,        -- jr_…
  created_at  INTEGER NOT NULL,
  days        INTEGER NOT NULL,        -- la période analysée
  data        TEXT NOT NULL            -- JSON : chiffres du serveur, résumé, constats, règle proposée
);
CREATE INDEX IF NOT EXISTS idx_journal_reviews ON journal_reviews(created_at);

-- News en temps réel (flux RSS de FinancialJuice), traduites, avec leur niveau ;
-- gardées pour toujours : c'est son contexte macro.
CREATE TABLE IF NOT EXISTS news_items (
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
CREATE INDEX IF NOT EXISTS idx_econ_figures_cal ON econ_figures(cal_at, cal_country, cal_title);

-- Laboratoire de stratégies (v19) : la réserve de bougies, les robots écrits par Kopilia, leurs versions,
-- leurs backtests et leurs trades, le fil de chaque fiche, les leçons du carnet du laboratoire.
CREATE TABLE IF NOT EXISTS candles (
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
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);
