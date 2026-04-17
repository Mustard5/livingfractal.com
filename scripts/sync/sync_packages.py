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
        existing = {row[0] for row in db.execute('SELECT name FROM packages')}
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
                         (name, version, description, homepage, license, channel, last_synced)
                       VALUES (?,?,?,?,?,?,?)
                       ON CONFLICT(name) DO UPDATE SET
                         version       = excluded.version,
                         description   = excluded.description,
                         homepage      = excluded.homepage,
                         license       = excluded.license,
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
                db.executemany('DELETE FROM packages WHERE name=?',
                               [(n,) for n in stale])

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
