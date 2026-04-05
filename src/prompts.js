import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

let versions = [];
let current = null;

function scanVersions() {
  const files = readdirSync(PROMPTS_DIR)
    .filter(f => /^v\d+\.txt$/.test(f))
    .sort();

  versions = files.map(f => {
    const version = basename(f, extname(f));
    const filePath = join(PROMPTS_DIR, f);
    const stat = statSync(filePath);
    return { version, filePath, createdAt: stat.mtime.toISOString() };
  });

  if (versions.length > 0) {
    const latest = versions[versions.length - 1];
    current = {
      version: latest.version,
      content: readFileSync(latest.filePath, 'utf-8'),
      createdAt: latest.createdAt,
    };
  }
}

export function init() {
  scanVersions();
  if (!current) {
    throw new Error('No prompt files found in prompts/ directory');
  }
  console.log(`Loaded prompt version: ${current.version}`);
}

export function getLatest() {
  return current;
}

export function reload() {
  scanVersions();
  console.log(`Reloaded prompts. Current version: ${current?.version}`);
  return current;
}

export function listVersions() {
  return versions.map(v => ({ version: v.version, createdAt: v.createdAt }));
}

export function getVersion(version) {
  const entry = versions.find(v => v.version === version);
  if (!entry) return null;
  return {
    version: entry.version,
    content: readFileSync(entry.filePath, 'utf-8'),
    createdAt: entry.createdAt,
  };
}
