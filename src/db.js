import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = process.env.LF_DATA_DIR
  ? join(process.env.LF_DATA_DIR, 'data')
  : join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'sessions.db');

let db = null;
let enabled = false;

// Prepared statements (initialized after db opens)
let stmts = {};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompt_versions (
  version TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'guided',
  FOREIGN KEY (prompt_version) REFERENCES prompt_versions(version)
);

CREATE TABLE IF NOT EXISTS session_intents (
  session_id TEXT PRIMARY KEY,
  raw_intent TEXT NOT NULL,
  sanitized_intent TEXT,
  input_flagged INTEGER DEFAULT 0,
  hardware_keywords TEXT,
  usecase_keywords TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS session_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  raw_output TEXT,
  config_text TEXT,
  docs_text TEXT,
  validation_passed INTEGER,
  validation_errors TEXT,
  validation_warnings TEXT,
  config_hash TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

function prepareStatements() {
  stmts.insertPromptVersion = db.prepare(
    `INSERT OR IGNORE INTO prompt_versions (version, content) VALUES (?, ?)`
  );
  stmts.createSession = db.prepare(
    `INSERT INTO sessions (id, model, prompt_version, tier) VALUES (?, ?, ?, ?)`
  );
  stmts.logIntent = db.prepare(
    `INSERT INTO session_intents (session_id, raw_intent, sanitized_intent, input_flagged, hardware_keywords, usecase_keywords) VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmts.logGeneration = db.prepare(
    `INSERT INTO session_generations (session_id, attempt, raw_output, config_text, docs_text, validation_passed, validation_errors, validation_warnings, config_hash, latency_ms, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmts.getRecentSessions = db.prepare(`
    SELECT s.id, s.created_at, s.model, s.prompt_version, s.tier,
           si.sanitized_intent, si.input_flagged,
           sg.validation_passed, sg.latency_ms
    FROM sessions s
    LEFT JOIN session_intents si ON si.session_id = s.id
    LEFT JOIN session_generations sg ON sg.session_id = s.id
    ORDER BY s.created_at DESC
    LIMIT ?
  `);
  stmts.getSessionDetail = db.prepare(`
    SELECT s.id, s.created_at, s.model, s.prompt_version, s.tier,
           si.raw_intent, si.sanitized_intent, si.input_flagged,
           si.hardware_keywords, si.usecase_keywords
    FROM sessions s
    LEFT JOIN session_intents si ON si.session_id = s.id
    WHERE s.id = ?
  `);
  stmts.getSessionGenerations = db.prepare(`
    SELECT * FROM session_generations WHERE session_id = ? ORDER BY attempt
  `);
}

// ---- Keyword extraction ----

const HARDWARE_PATTERNS = [
  'thinkpad', 'raspberry pi', 'rpi', 'dell', 'hp', 'lenovo', 'asus',
  'intel', 'amd', 'nvidia', 'arm', 'aarch64', 'x86', 'laptop', 'desktop',
  'server', 'nuc', 'mini pc', 'framework', 'system76', 'surface',
];

const USECASE_PATTERNS = [
  'server', 'workstation', 'gaming', 'development', 'dev', 'homelab',
  'router', 'firewall', 'nas', 'media', 'kiosk', 'terminal', 'crypto',
  'mining', 'ai', 'machine learning', 'docker', 'kubernetes', 'k8s',
  'web server', 'database', 'mail', 'vpn', 'tor', 'offline', 'air-gapped',
];

function extractKeywords(text, patterns) {
  const lower = text.toLowerCase();
  return patterns.filter(p => lower.includes(p));
}

// ---- Public API ----

export function init(promptVersion, promptContent) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    prepareStatements();
    if (promptVersion && promptContent) {
      stmts.insertPromptVersion.run(promptVersion, promptContent);
    }
    enabled = true;
    console.log(`Database initialized: ${DB_PATH}`);
  } catch (err) {
    console.error('Database initialization failed (continuing without persistence):', err.message);
    enabled = false;
  }
}

export function isEnabled() {
  return enabled;
}

export function registerPromptVersion(version, content) {
  if (!enabled) return;
  try {
    stmts.insertPromptVersion.run(version, content);
  } catch (err) {
    console.error('Failed to register prompt version:', err.message);
  }
}

export function createSession(id, model, promptVersion, tier = 'guided') {
  if (!enabled) return;
  try {
    stmts.createSession.run(id, model, promptVersion, tier);
  } catch (err) {
    console.error('Failed to create session:', err.message);
  }
}

export function logIntent(sessionId, rawIntent, sanitizedIntent, flagged) {
  if (!enabled) return;
  try {
    const hw = extractKeywords(rawIntent, HARDWARE_PATTERNS);
    const uc = extractKeywords(rawIntent, USECASE_PATTERNS);
    stmts.logIntent.run(
      sessionId,
      rawIntent,
      sanitizedIntent,
      flagged ? 1 : 0,
      hw.length ? JSON.stringify(hw) : null,
      uc.length ? JSON.stringify(uc) : null
    );
  } catch (err) {
    console.error('Failed to log intent:', err.message);
  }
}

export function logGeneration(sessionId, attempt, rawOutput, configText, docsText, validation, configHash, latencyMs, inputTokens, outputTokens) {
  if (!enabled) return;
  try {
    stmts.logGeneration.run(
      sessionId,
      attempt,
      rawOutput,
      configText,
      docsText,
      validation.passed ? 1 : 0,
      validation.errors.length ? JSON.stringify(validation.errors) : null,
      JSON.stringify([...validation.warnings, ...validation.securityFlags]) || null,
      configHash,
      latencyMs,
      inputTokens ?? null,
      outputTokens ?? null
    );
  } catch (err) {
    console.error('Failed to log generation:', err.message);
  }
}

export function getRecentSessions(limit = 50) {
  if (!enabled) return [];
  return stmts.getRecentSessions.all(limit);
}

export function getSessionDetail(id) {
  if (!enabled) return null;
  const session = stmts.getSessionDetail.get(id);
  if (!session) return null;
  const generations = stmts.getSessionGenerations.all(id);
  return { ...session, generations };
}

export function getStats() {
  if (!enabled) return null;
  const total = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  const last24h = db.prepare(
    `SELECT COUNT(*) as count FROM sessions WHERE created_at > datetime('now', '-1 day')`
  ).get().count;
  const passRate = db.prepare(
    `SELECT ROUND(AVG(validation_passed) * 100, 1) as rate FROM session_generations`
  ).get().rate;
  const avgLatency = db.prepare(
    `SELECT ROUND(AVG(latency_ms)) as avg FROM session_generations WHERE latency_ms IS NOT NULL`
  ).get().avg;
  const topErrors = db.prepare(`
    SELECT validation_errors, COUNT(*) as count
    FROM session_generations
    WHERE validation_errors IS NOT NULL
    GROUP BY validation_errors
    ORDER BY count DESC
    LIMIT 10
  `).all();
  const modelBreakdown = db.prepare(`
    SELECT model, COUNT(*) as count FROM sessions GROUP BY model
  `).all();

  return {
    totalSessions: total,
    last24h,
    validationPassRate: passRate ?? 0,
    avgLatencyMs: avgLatency ?? 0,
    topErrors,
    modelBreakdown: Object.fromEntries(modelBreakdown.map(r => [r.model, r.count])),
  };
}
