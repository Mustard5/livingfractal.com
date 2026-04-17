CREATE TABLE IF NOT EXISTS packages (
  name         TEXT PRIMARY KEY,
  version      TEXT,
  description  TEXT,
  homepage     TEXT,
  license      TEXT,
  channel      TEXT NOT NULL,
  last_synced  DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS options (
  path          TEXT PRIMARY KEY,
  type          TEXT,
  default_value TEXT,
  description   TEXT,
  example       TEXT,
  declared_by   TEXT,
  channel       TEXT NOT NULL,
  last_synced   DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_profiles (
  id             TEXT PRIMARY KEY,
  module_path    TEXT NOT NULL,
  manufacturer   TEXT,
  model          TEXT,
  model_aliases  TEXT,
  description    TEXT,
  has_readme     INTEGER NOT NULL DEFAULT 0,
  last_synced    DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS curated_patterns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT UNIQUE NOT NULL,
  category          TEXT NOT NULL,
  description       TEXT,
  nix_snippet       TEXT NOT NULL,
  requires_packages TEXT,
  requires_options  TEXT,
  tier_minimum      TEXT NOT NULL DEFAULT 'guided',
  tested            INTEGER NOT NULL DEFAULT 0,
  added_date        DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS security_policy (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type     TEXT NOT NULL,
  match_expression TEXT NOT NULL,
  severity         TEXT NOT NULL,
  tier_scope       TEXT NOT NULL,
  message          TEXT NOT NULL,
  remediation      TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  started_at    DATETIME NOT NULL,
  finished_at   DATETIME,
  status        TEXT NOT NULL,
  rows_upserted INTEGER,
  rows_deleted  INTEGER,
  error_message TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  source_table,
  source_id UNINDEXED,
  searchable_text,
  tokenize = 'porter unicode61'
);

CREATE INDEX IF NOT EXISTS idx_packages_channel    ON packages(channel);
CREATE INDEX IF NOT EXISTS idx_options_channel     ON options(channel);
CREATE INDEX IF NOT EXISTS idx_hardware_manufacturer ON hardware_profiles(manufacturer);
CREATE INDEX IF NOT EXISTS idx_sync_runs_source    ON sync_runs(source, started_at DESC);
