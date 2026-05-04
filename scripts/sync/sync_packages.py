#!/usr/bin/env python3
"""Sync NixOS packages from nixpkgs into the validation DB."""
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    get_db, init_schema, now_utc, run_nix, nix_bin,
    SOURCES_DIR, setup_logging, log_sync_run,
)

CHANNEL = 'stable'
PACKAGES_JSON = SOURCES_DIR / 'packages.json'
TIMEOUT_SECS = 600   # 10 minutes

# Alias attr_paths that nix-env -qaP does not enumerate because they are
# not exposed via lib.recurseIntoAttrs. These are valid attribute paths
# that users commonly write in NixOS configs. Resolved via nix-instantiate
# at sync time so the packages table stays current with the channel default.
NONSTD_ALIASES = [
    'python3',
    'python313',
    'nodejs',
    'nodejs_22',
]


def normalize_license(raw):
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        parts = []
        for item in raw:
            if isinstance(item, dict):
                parts.append(item.get('spdxId') or item.get('fullName') or str(item))
            else:
                parts.append(str(item))
        return ', '.join(parts) or None
    if isinstance(raw, dict):
        return raw.get('spdxId') or raw.get('fullName')
    return str(raw)


def ensure_alias_columns(db):
    """Idempotently add is_alias column to an existing packages table."""
    cols = {row[1] for row in db.execute('PRAGMA table_info(packages)')}
    if 'is_alias' not in cols:
        db.execute('ALTER TABLE packages ADD COLUMN is_alias INTEGER NOT NULL DEFAULT 0')
        db.commit()


def resolve_alias(alias_name, log):
    """Resolve an alias attr_path to (version, description) via nix-instantiate --eval.

    Returns (version_str, description_str_or_None) or None if resolution fails.
    """
    try:
        r = run_nix(
            ['nix-instantiate', '--eval', '-E',
             f'with import <nixpkgs> {{}}; {alias_name}.version'],
            capture_output=True, timeout=60,
        )
        if r.returncode != 0:
            log.warning(f'Alias {alias_name}: nix-instantiate exited {r.returncode}: '
                        f'{r.stderr.decode(errors="replace")[:200]}')
            return None
        version = r.stdout.decode().strip().strip('"')
        if not version:
            log.warning(f'Alias {alias_name}: empty version string')
            return None

        # Best-effort description — not all attrs expose meta.description cleanly
        description = None
        r_desc = run_nix(
            ['nix-instantiate', '--eval', '-E',
             f'with import <nixpkgs> {{}}; {alias_name}.meta.description'],
            capture_output=True, timeout=60,
        )
        if r_desc.returncode == 0:
            raw = r_desc.stdout.decode().strip().strip('"')
            description = raw if raw else None

        return version, description

    except Exception as exc:
        log.warning(f'Alias {alias_name}: resolution error: {exc}')
        return None


def sync_nonstd_aliases(log, db, ts):
    """Insert alias attr_paths that nix-env -qaP does not enumerate."""
    inserted = skipped = 0
    for alias in NONSTD_ALIASES:
        result = resolve_alias(alias, log)
        if result is None:
            log.warning(f'Alias {alias}: skipped (could not resolve)')
            skipped += 1
            continue
        version, description = result
        db.execute(
            """INSERT INTO packages
                 (name, version, description, homepage, license,
                  channel, last_synced, is_alias)
               VALUES (?,?,?,NULL,NULL,?,?,1)
               ON CONFLICT(name) DO UPDATE SET
                 version     = excluded.version,
                 description = COALESCE(excluded.description, packages.description),
                 is_alias    = 1,
                 last_synced = excluded.last_synced""",
            (alias, version, description, CHANNEL, ts),
        )
        log.info(f'Alias {alias}: v{version}')
        inserted += 1
    log.info(f'Nonstd aliases: {inserted} inserted/updated, {skipped} skipped')
    return inserted


def fetch_packages(log):
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    log.info('Running nix-env -qaP --json (2–4 min, 1–3 GB RAM)...')
    t0 = time.time()
    with open(str(PACKAGES_JSON), 'w') as fh:
        result = run_nix(
            ['nix-env', '-qaP', '--json', '-f', '<nixpkgs>'],
            stdout=fh,
            stderr=subprocess.PIPE,
            timeout=TIMEOUT_SECS,
        )
    if result.returncode != 0:
        PACKAGES_JSON.unlink(missing_ok=True)
        stderr_tail = (result.stderr or b'').decode(errors='replace')[-1000:]
        raise RuntimeError(f'nix-env exited {result.returncode}:\n{stderr_tail}')
    elapsed = time.time() - t0
    size_mb = PACKAGES_JSON.stat().st_size / 1024 / 1024
    log.info(f'nix-env done in {elapsed:.1f}s, {size_mb:.0f} MB written')


def sync(log, db):
    started_at = now_utc()
    rows_upserted = 0
    rows_deleted = 0
    try:
        # Migrate schema for existing DBs before any queries that use is_alias
        ensure_alias_columns(db)

        if not PACKAGES_JSON.exists():
            fetch_packages(log)
        else:
            age_h = (time.time() - PACKAGES_JSON.stat().st_mtime) / 3600
            if age_h > 23:
                log.info(f'Cache {age_h:.1f}h old — refreshing')
                fetch_packages(log)
            else:
                log.info(f'Using cached packages.json ({age_h:.1f}h old)')

        log.info('Parsing packages.json...')
        with open(str(PACKAGES_JSON)) as fh:
            data = json.load(fh)
        log.info(f'Parsed {len(data):,} packages')

        ts = now_utc()
        # Only track nix-env entries for stale detection — alias rows are
        # managed separately and must not be pruned by this loop.
        existing = {row[0] for row in db.execute(
            'SELECT name FROM packages WHERE is_alias=0'
        )}
        seen = set()

        log.info('Upserting packages...')
        with db:
            for attr_path, pkg in data.items():
                meta = pkg.get('meta') or {}
                homepage = meta.get('homepage')
                if isinstance(homepage, list):
                    homepage = homepage[0] if homepage else None
                db.execute(
                    """INSERT INTO packages
                         (name, version, description, homepage, license,
                          channel, last_synced, is_alias)
                       VALUES (?,?,?,?,?,?,?,0)
                       ON CONFLICT(name) DO UPDATE SET
                         version       = excluded.version,
                         description   = excluded.description,
                         homepage      = excluded.homepage,
                         license       = excluded.license,
                         is_alias      = 0,
                         last_synced   = excluded.last_synced""",
                    (
                        attr_path,
                        pkg.get('version') or '',
                        meta.get('description'),
                        homepage,
                        normalize_license(meta.get('license')),
                        CHANNEL,
                        ts,
                    ),
                )
                seen.add(attr_path)
                rows_upserted += 1

            stale = existing - seen
            rows_deleted = len(stale)
            if stale:
                log.info(f'Removing {rows_deleted} stale packages')
                # Only delete nix-env entries; alias rows are not in `seen`
                # and must not be treated as stale.
                db.executemany(
                    'DELETE FROM packages WHERE name=? AND is_alias=0',
                    [(n,) for n in stale],
                )

        # Resolve and insert alias attr_paths not present in nix-env output.
        # This runs after the nix-env upsert so that if an alias later
        # appears in nix-env it will already be is_alias=0 by the time we
        # reach here and the ON CONFLICT above will have set is_alias=0.
        log.info('Syncing nonstd aliases...')
        with db:
            sync_nonstd_aliases(log, db, ts)

        # Rebuild FTS5 index after both nix-env packages and aliases are in place.
        log.info('Rebuilding FTS5 index for packages...')
        with db:
            db.execute("DELETE FROM search_index WHERE source_table='packages'")
            db.execute("""
                INSERT INTO search_index (source_table, source_id, searchable_text)
                SELECT 'packages', name,
                       name || ' ' || COALESCE(description, '')
                FROM packages
                WHERE channel = ?
            """, (CHANNEL,))

        finished_at = now_utc()
        log.info(f'Packages done: {rows_upserted:,} upserted, {rows_deleted} deleted')
        log_sync_run(db, 'packages', started_at, finished_at, 'success',
                     rows_upserted, rows_deleted)
        return True

    except Exception as exc:
        log.error(f'Packages sync failed: {exc}', exc_info=True)
        log_sync_run(db, 'packages', started_at, now_utc(), 'error',
                     rows_upserted, rows_deleted, str(exc))
        return False


if __name__ == '__main__':
    _log = setup_logging('sync_packages')
    _db = get_db()
    init_schema(_db)
    ok = sync(_log, _db)
    sys.exit(0 if ok else 1)
