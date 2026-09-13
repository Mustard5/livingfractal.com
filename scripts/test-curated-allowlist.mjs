#!/usr/bin/env node
/**
 * Fixture: curated_patterns allowlist (Track 1).
 *
 * Proves:
 *   - allowlisted option/package absent from options/packages tables → valid
 *   - normal option/package present in tables → valid
 *   - unknown reference → invalid
 *   - [ALLOWLIST] is logged on allowlist hits
 *
 * Run from repo root:
 *   node scripts/test-curated-allowlist.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dir = mkdtempSync(join(tmpdir(), 'lf-allowlist-'));
const dbPath = join(dir, 'nixos.db');

const db = new Database(dbPath);
db.exec(`
CREATE TABLE packages (
  name TEXT PRIMARY KEY,
  version TEXT,
  description TEXT,
  homepage TEXT,
  license TEXT,
  channel TEXT NOT NULL,
  last_synced DATETIME NOT NULL,
  is_alias INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE options (
  path TEXT PRIMARY KEY,
  type TEXT,
  default_value TEXT,
  description TEXT,
  example TEXT,
  declared_by TEXT,
  channel TEXT NOT NULL,
  last_synced DATETIME NOT NULL
);
CREATE TABLE curated_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  nix_snippet TEXT NOT NULL,
  requires_packages TEXT,
  requires_options TEXT,
  tier_minimum TEXT NOT NULL DEFAULT 'guided',
  tested INTEGER NOT NULL DEFAULT 0,
  added_date DATETIME NOT NULL
);
`);

db.prepare(
  `INSERT INTO packages (name, channel, last_synced) VALUES (?, 'nixos-25.11', datetime('now'))`
).run('vim');
db.prepare(
  `INSERT INTO options (path, channel, last_synced) VALUES (?, 'nixos-25.11', datetime('now'))`
).run('networking.hostName');

// JSON array form (preferred) — options/packages intentionally NOT in tables
db.prepare(`
  INSERT INTO curated_patterns
    (name, category, description, nix_snippet, requires_packages, requires_options, tested, added_date)
  VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
`).run(
  'lanzaboote',
  'secure-boot',
  'fixture',
  'boot.lanzaboote.enable = true;',
  '["sbctl"]',
  '["boot.lanzaboote.enable","boot.lanzaboote.pkiBundle"]'
);

// Comma-separated fallback row
db.prepare(`
  INSERT INTO curated_patterns
    (name, category, description, nix_snippet, requires_packages, requires_options, tested, added_date)
  VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
`).run(
  'comma-fallback',
  'test',
  'fixture for comma parsing',
  '# noop',
  'extraPkgA, extraPkgB',
  'services.demo.enable, services.demo.port'
);

db.close();

// Child process so LF_VALIDATION_DB is set before src/db.js evaluates the const.
const child = `
import { initValidationDb, isValidationEnabled, validatePackages, validateOptions, getAllowlistStats, parseRequiresList } from './src/db.js';

const logs = [];
const origLog = console.log;
console.log = (...args) => { logs.push(args.join(' ')); origLog(...args); };

initValidationDb();
if (!isValidationEnabled()) {
  console.error('FAIL: validation DB did not enable');
  process.exit(1);
}

const stats = getAllowlistStats();
if (stats.options < 4 || stats.packages < 3) {
  console.error('FAIL: allowlist sizes unexpected', stats);
  process.exit(1);
}

// parseRequiresList unit checks
const jsonParsed = parseRequiresList('["a","b"]');
const csvParsed = parseRequiresList('a, b ,c');
if (JSON.stringify(jsonParsed) !== JSON.stringify(['a','b'])) {
  console.error('FAIL: JSON parse', jsonParsed);
  process.exit(1);
}
if (JSON.stringify(csvParsed) !== JSON.stringify(['a','b','c'])) {
  console.error('FAIL: CSV parse', csvParsed);
  process.exit(1);
}

const pkgs = validatePackages(['vim', 'sbctl', 'extraPkgA', 'totally-fake-pkg']);
const opts = validateOptions([
  'networking.hostName',
  'boot.lanzaboote.enable',
  'services.demo.enable',
  'services.madeUp.option',
]);

const expect = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
};

expect(pkgs.valid.includes('vim'), 'table package vim should pass');
expect(pkgs.valid.includes('sbctl'), 'allowlisted package sbctl should pass');
expect(pkgs.valid.includes('extraPkgA'), 'comma-allowlisted package should pass');
expect(pkgs.invalid.includes('totally-fake-pkg'), 'unknown package should fail');
expect(!pkgs.invalid.includes('sbctl'), 'sbctl must not be invalid');

expect(opts.valid.includes('networking.hostName'), 'table option should pass');
expect(opts.valid.includes('boot.lanzaboote.enable'), 'allowlisted option should pass');
expect(opts.valid.includes('services.demo.enable'), 'comma-allowlisted option should pass');
expect(opts.invalid.includes('services.madeUp.option'), 'unknown option should fail');

const allowLogs = logs.filter(l => l.includes('[ALLOWLIST]'));
expect(allowLogs.some(l => l.includes('sbctl')), '[ALLOWLIST] should mention sbctl');
expect(allowLogs.some(l => l.includes('boot.lanzaboote.enable')), '[ALLOWLIST] should mention lanzaboote option');

origLog('OK: curated allowlist fixture passed');
origLog('allowlist stats:', JSON.stringify(stats));
origLog('pkg valid=', pkgs.valid.join(','), 'invalid=', pkgs.invalid.join(','));
origLog('opt valid=', opts.valid.join(','), 'invalid=', opts.invalid.join(','));
`;

writeFileSync(join(dir, 'run.mjs'), child.replace("from './src/db.js'", `from '${join(process.cwd(), 'src/db.js')}'`));

const result = spawnSync(process.execPath, [join(dir, 'run.mjs')], {
  env: { ...process.env, LF_VALIDATION_DB: dbPath },
  encoding: 'utf8',
  cwd: process.cwd(),
});

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);
