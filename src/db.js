import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
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

CREATE TABLE IF NOT EXISTS validation_results (
  session_id TEXT PRIMARY KEY,
  first_attempt_valid_packages INTEGER,
  first_attempt_invalid_packages INTEGER,
  first_attempt_invalid_package_names TEXT,
  first_attempt_valid_options INTEGER,
  first_attempt_invalid_options INTEGER,
  first_attempt_invalid_option_paths TEXT,
  retry_attempted INTEGER DEFAULT 0,
  retry_still_invalid INTEGER,
  retry_invalid_packages TEXT,
  retry_invalid_options TEXT,
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
           sg.validation_passed, sg.latency_ms,
           vr.first_attempt_invalid_packages, vr.first_attempt_invalid_options,
           vr.retry_attempted, vr.retry_still_invalid
    FROM sessions s
    LEFT JOIN session_intents si ON si.session_id = s.id
    LEFT JOIN session_generations sg ON sg.id = (
      SELECT MAX(id) FROM session_generations WHERE session_id = s.id
    )
    LEFT JOIN validation_results vr ON vr.session_id = s.id
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
  stmts.getValidationResult = db.prepare(`
    SELECT * FROM validation_results WHERE session_id = ?
  `);
  stmts.logValidationResult = db.prepare(`
    INSERT OR REPLACE INTO validation_results (
      session_id,
      first_attempt_valid_packages, first_attempt_invalid_packages, first_attempt_invalid_package_names,
      first_attempt_valid_options, first_attempt_invalid_options, first_attempt_invalid_option_paths,
      retry_attempted, retry_still_invalid, retry_invalid_packages, retry_invalid_options
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const validationResult = stmts.getValidationResult.get(id) || null;
  return { ...session, generations, validationResult };
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

  const groundedTotal = db.prepare(`SELECT COUNT(*) as count FROM validation_results`).get().count;
  const groundedClean = db.prepare(
    `SELECT COUNT(*) as count FROM validation_results WHERE first_attempt_invalid_packages = 0 AND first_attempt_invalid_options = 0`
  ).get().count;
  const retryCount = db.prepare(`SELECT COUNT(*) as count FROM validation_results WHERE retry_attempted = 1`).get().count;
  const retryFixed = db.prepare(
    `SELECT COUNT(*) as count FROM validation_results WHERE retry_attempted = 1 AND retry_still_invalid = 0`
  ).get().count;

  return {
    totalSessions: total,
    last24h,
    validationPassRate: passRate ?? 0,
    avgLatencyMs: avgLatency ?? 0,
    topErrors,
    modelBreakdown: Object.fromEntries(modelBreakdown.map(r => [r.model, r.count])),
    groundedValidation: {
      sessionsValidated: groundedTotal,
      firstPassClean: groundedClean,
      retriesAttempted: retryCount,
      retriesFixed: retryFixed,
    },
  };
}

export function logValidationResult(sessionId, data) {
  if (!enabled) return;
  try {
    stmts.logValidationResult.run(
      sessionId,
      data.firstValidPkgs,
      data.firstInvalidPkgs,
      data.firstInvalidPkgNames ?? null,
      data.firstValidOpts,
      data.firstInvalidOpts,
      data.firstInvalidOptPaths ?? null,
      data.retryAttempted,
      data.retryStillInvalid ?? null,
      data.retryInvalidPkgs ?? null,
      data.retryInvalidOpts ?? null
    );
  } catch (err) {
    console.error('Failed to log validation result:', err.message);
  }
}

// ── Validation DB (nixos.db) ──

const VALIDATION_DB_PATH = process.env.LF_VALIDATION_DB
  || '/var/lib/livingfractal/validation/nixos.db';

let validationDb = null;
let validationEnabled = false;

export function initValidationDb() {
  try {
    if (!existsSync(VALIDATION_DB_PATH)) {
      console.warn(`[VALIDATION] nixos.db not found at ${VALIDATION_DB_PATH} — running in log-only mode`);
      return;
    }
    validationDb = new Database(VALIDATION_DB_PATH, { readonly: true, fileMustExist: true });
    validationEnabled = true;
    console.log(`Validation database: ${VALIDATION_DB_PATH}`);
  } catch (err) {
    console.warn(`[VALIDATION] Failed to open nixos.db (log-only mode): ${err.message}`);
  }
}

export function isValidationEnabled() {
  return validationEnabled;
}

export function validatePackages(packages) {
  if (!validationEnabled || !packages.length) return { valid: [], invalid: packages.slice() };
  try {
    const placeholders = packages.map(() => '?').join(',');
    const rows = validationDb.prepare(
      `SELECT name FROM packages WHERE name IN (${placeholders})`
    ).all(...packages);
    const validSet = new Set(rows.map(r => r.name));
    return {
      valid: packages.filter(p => validSet.has(p)),
      invalid: packages.filter(p => !validSet.has(p)),
    };
  } catch (err) {
    console.error(`[VALIDATION] Package query failed: ${err.message}`);
    return { valid: [], invalid: packages.slice() };
  }
}

// Options DB stores dynamic-segment paths as users.users.<name>.foo.
// generatePathVariants produces fallback paths with <name> substituted
// so alice → <name> matches correctly.
function generatePathVariants(path) {
  const parts = path.split('.');
  const variants = [path];
  for (let i = 1; i < parts.length - 1; i++) {
    variants.push([...parts.slice(0, i), '<name>', ...parts.slice(i + 1)].join('.'));
  }
  return variants;
}

export function validateOptions(options) {
  if (!validationEnabled || !options.length) return { valid: [], invalid: options.slice() };
  try {
    const pathToVariants = new Map();
    const allPaths = new Set();
    for (const path of options) {
      const variants = generatePathVariants(path);
      pathToVariants.set(path, variants);
      variants.forEach(v => allPaths.add(v));
    }
    const allArr = [...allPaths];
    const placeholders = allArr.map(() => '?').join(',');
    const rows = validationDb.prepare(
      `SELECT path FROM options WHERE path IN (${placeholders})`
    ).all(...allArr);
    const matchedPaths = new Set(rows.map(r => r.path));
    return {
      valid: options.filter(p => pathToVariants.get(p).some(v => matchedPaths.has(v))),
      invalid: options.filter(p => !pathToVariants.get(p).some(v => matchedPaths.has(v))),
    };
  } catch (err) {
    console.error(`[VALIDATION] Options query failed: ${err.message}`);
    return { valid: [], invalid: options.slice() };
  }
}
