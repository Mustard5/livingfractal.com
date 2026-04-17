#!/usr/bin/env python3
"""Sync NixOS module options from nixpkgs into the validation DB."""
import json
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    get_db, init_schema, now_utc, run_nix,
    SOURCES_DIR, setup_logging, log_sync_run,
)

CHANNEL = 'stable'
OPTIONS_JSON = SOURCES_DIR / 'options.json'
TIMEOUT_SECS = 1800   # 30 min — first run cold; subsequent runs near-instant (derivation cached)

# Nix expression to produce the NixOS options JSON derivation.
# Evaluated on the host; pkgs.path resolves to the nixpkgs channel store path.
# _module.check=false suppresses assertion failures during cross-host evaluation.
NIX_EXPR = '''
let
  pkgs  = import <nixpkgs> { system = "x86_64-linux"; };
  eval  = import (pkgs.path + "/nixos/lib/eval-config.nix") {
    system  = "x86_64-linux";
    modules = [ { _module.check = false; } ];
    pkgs    = pkgs;
  };
in (pkgs.nixosOptionsDoc { inherit (eval) options; }).optionsJSON
'''


def extract_value(v):
    """Stringify an option default or example value."""
    if v is None:
        return None
    if isinstance(v, dict):
        t = v.get('_type', '')
        if t in ('literalExpression', 'literalMD', 'literalDocBook'):
            return v.get('text')
        return json.dumps(v)
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return json.dumps(v)
    return str(v)


def strip_markup(text):
    """Remove DocBook/XML tags and normalise whitespace."""
    if not text:
        return text
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text or None


def _find_options_in_store(store_path_str: str):
    """Return the options.json Path inside a store output, or None."""
    p = Path(store_path_str)
    if not p.exists():
        return None
    candidate = p / 'share' / 'doc' / 'nixos' / 'options.json'
    if candidate.exists():
        return candidate
    hits = list(p.rglob('options.json'))
    return hits[0] if hits else None


def fetch_options(log):
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    log.info('Building NixOS options JSON via nix-build (first run: cold cache)...')
    t0 = time.time()

    result = run_nix(
        ['nix-build', '--no-out-link', '-E', NIX_EXPR],
        capture_output=True, text=True, timeout=TIMEOUT_SECS,
    )

    store_path = result.stdout.strip()
    candidate = None

    if result.returncode == 0 and store_path:
        # Happy path
        candidate = _find_options_in_store(store_path)
    else:
        # nix-build may exit 1 with a "manual depends on nixpkgs location"
        # warning-as-error, but still write the output to the store.
        # Parse the "Output paths:" section from stderr to find the path.
        stderr = result.stderr or ''
        for line in stderr.splitlines():
            line = line.strip()
            if line.startswith('/nix/store/') and 'options' in line:
                candidate = _find_options_in_store(line)
                if candidate:
                    log.warning(
                        f'nix-build exited {result.returncode} but output exists '
                        f'at {line} — using it (nixpkgs-location warning is benign)'
                    )
                    break
        if candidate is None:
            raise RuntimeError(
                f'nix-build failed (exit {result.returncode}) and no usable '
                f'output found:\n{stderr[-2000:]}'
            )

    if candidate is None:
        raise RuntimeError(f'options.json not found under store path: {store_path!r}')

    shutil.copy2(str(candidate), str(OPTIONS_JSON))
    elapsed = time.time() - t0
    size_mb = OPTIONS_JSON.stat().st_size / 1024 / 1024
    log.info(f'options.json ready in {elapsed:.1f}s ({size_mb:.1f} MB)')


def sync(log, db):
    started_at = now_utc()
    rows_upserted = 0
    rows_deleted = 0
    try:
        if not OPTIONS_JSON.exists():
            fetch_options(log)
        else:
            age_h = (time.time() - OPTIONS_JSON.stat().st_mtime) / 3600
            if age_h > 23:
                log.info(f'Cache {age_h:.1f}h old — refreshing')
                fetch_options(log)
            else:
                log.info(f'Using cached options.json ({age_h:.1f}h old)')

        log.info('Parsing options.json...')
        with open(str(OPTIONS_JSON)) as fh:
            data = json.load(fh)
        log.info(f'Parsed {len(data):,} options')

        ts = now_utc()
        existing = {row[0] for row in db.execute('SELECT path FROM options')}
        seen = set()

        log.info('Upserting options...')
        with db:
            for path, opt in data.items():
                # type may be a string or dict with a 'name' key
                type_raw = opt.get('type')
                type_str = (
                    type_raw.get('name') if isinstance(type_raw, dict)
                    else type_raw
                )

                # declared_by: first declaration, relativised to nixpkgs root
                declared_by = None
                decls = opt.get('declarations', [])
                if decls and isinstance(decls[0], str):
                    d = decls[0]
                    m = re.search(r'(?:nixpkgs/?)?(nixos/.*)', d)
                    declared_by = m.group(1) if m else d

                db.execute(
                    """INSERT INTO options
                         (path, type, default_value, description, example,
                          declared_by, channel, last_synced)
                       VALUES (?,?,?,?,?,?,?,?)
                       ON CONFLICT(path) DO UPDATE SET
                         type          = excluded.type,
                         default_value = excluded.default_value,
                         description   = excluded.description,
                         example       = excluded.example,
                         declared_by   = excluded.declared_by,
                         last_synced   = excluded.last_synced""",
                    (
                        path,
                        type_str,
                        extract_value(opt.get('default')),
                        strip_markup(opt.get('description')),
                        extract_value(opt.get('example')),
                        declared_by,
                        CHANNEL,
                        ts,
                    ),
                )
                seen.add(path)
                rows_upserted += 1

            stale = existing - seen
            rows_deleted = len(stale)
            if stale:
                log.info(f'Removing {rows_deleted} stale options')
                db.executemany('DELETE FROM options WHERE path=?',
                               [(p,) for p in stale])

        log.info('Rebuilding FTS5 index for options...')
        with db:
            db.execute("DELETE FROM search_index WHERE source_table='options'")
            db.execute("""
                INSERT INTO search_index (source_table, source_id, searchable_text)
                SELECT 'options', path,
                       path || ' ' || COALESCE(description, '')
                FROM options
                WHERE channel = ?
            """, (CHANNEL,))

        finished_at = now_utc()
        log.info(f'Options done: {rows_upserted:,} upserted, {rows_deleted} deleted')
        log_sync_run(db, 'options', started_at, finished_at, 'success',
                     rows_upserted, rows_deleted)
        return True

    except Exception as exc:
        log.error(f'Options sync failed: {exc}', exc_info=True)
        log_sync_run(db, 'options', started_at, now_utc(), 'error',
                     rows_upserted, rows_deleted, str(exc))
        return False


if __name__ == '__main__':
    _log = setup_logging('sync_options')
    _db = get_db()
    init_schema(_db)
    ok = sync(_log, _db)
    sys.exit(0 if ok else 1)
