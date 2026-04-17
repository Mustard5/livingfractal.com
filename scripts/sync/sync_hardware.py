#!/usr/bin/env python3
"""Sync nixos-hardware profiles into the validation DB (two-pass)."""
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    get_db, init_schema, now_utc,
    SOURCES_DIR, setup_logging, log_sync_run,
)

CHANNEL = 'stable'
HARDWARE_DIR  = SOURCES_DIR / 'nixos-hardware'
HARDWARE_REPO = 'https://github.com/NixOS/nixos-hardware.git'

# Directories to skip when walking the repo
SKIP_DIRS = {'common', 'tests', '.git', 'flake-modules', 'modules'}

# Known manufacturer slugs (lowercase, hyphenated)
KNOWN_MANUFACTURERS = {
    'lenovo', 'dell', 'framework', 'apple', 'asus', 'microsoft',
    'raspberry-pi', 'pine64', 'starlabs', 'system76', 'tuxedo',
    'hp', 'acer', 'msi', 'razer', 'samsung', 'sony', 'intel-nuc',
    'purism', 'clevo', 'gigabyte', 'hardkernel', 'pcengines',
    'supermicro', 'jetson', 'olimex', 'beelink', 'minisforum',
    'udoo', 'libre-computer', 'nanopi',
}

MANUFACTURER_DISPLAY = {
    'raspberry-pi': 'Raspberry Pi',
    'pine64':       'Pine64',
    'intel-nuc':    'Intel NUC',
    'system76':     'System76',
    'starlabs':     'Star Labs',
    'libre-computer': 'Libre Computer',
}


def display_name(slug: str) -> str:
    return MANUFACTURER_DISPLAY.get(slug, slug.title().replace('-', ' '))


def parse_profile_id(profile_id: str):
    """Split 'lenovo-thinkpad-t14s-gen4' → ('lenovo', 'thinkpad-t14s-gen4').

    Tries longest matching prefix first so 'raspberry-pi' beats 'raspberry'.
    """
    parts = profile_id.split('-')
    for end in range(len(parts), 0, -1):
        slug = '-'.join(parts[:end]).lower()
        if slug in KNOWN_MANUFACTURERS:
            model = '-'.join(parts[end:]) or profile_id
            return slug, model
    return None, profile_id


def enumerate_profiles(log):
    """Walk the nixos-hardware tree and return {profile_id: {'module_path', 'dir'}}."""
    profiles = {}
    for nix_file in sorted(HARDWARE_DIR.rglob('default.nix')):
        rel = nix_file.parent.relative_to(HARDWARE_DIR)
        parts = rel.parts
        # Skip top-level and utility directories
        if not parts or parts[0] in SKIP_DIRS or len(parts) < 2:
            continue
        profile_id  = '-'.join(parts)
        module_path = str(rel)
        profiles[profile_id] = {
            'module_path': module_path,
            'dir':         nix_file.parent,
        }
    log.info(f'Enumerated {len(profiles)} hardware profiles')
    return profiles


def parse_readme(readme_path: Path):
    """Extract description (≤500 chars) and model_aliases from a README.md."""
    try:
        text = readme_path.read_text(errors='replace')
        lines = text.splitlines()

        # First prose paragraph — skip headers and code blocks
        in_code = False
        prose = []
        for line in lines:
            s = line.strip()
            if s.startswith('```'):
                in_code = not in_code
                continue
            if in_code or s.startswith('#'):
                if prose:
                    break
                continue
            if s:
                prose.append(s)
            elif prose:
                break

        description = ' '.join(prose)[:500] or None

        # Alias patterns
        aliases = []
        for pat in (
            r'also\s+known\s+as[:\s]+([^\n.]{3,80})',
            r'marketed\s+as[:\s]+([^\n.]{3,80})',
            r'a\.k\.a\.?\s+([^\n.]{3,80})',
        ):
            for m in re.finditer(pat, text, re.IGNORECASE):
                alias = m.group(1).strip().rstrip('.,')
                if alias and alias not in aliases:
                    aliases.append(alias)

        return description, (', '.join(aliases[:4]) if aliases else None)

    except Exception:
        return None, None


def sync(log, db):
    started_at = now_utc()
    rows_upserted = 0
    rows_deleted  = 0
    try:
        # ── Clone / update the repo ─────────────────────────────────────────
        SOURCES_DIR.mkdir(parents=True, exist_ok=True)
        if not HARDWARE_DIR.exists():
            log.info('Cloning nixos-hardware...')
            subprocess.run(
                ['git', 'clone', '--depth', '1', HARDWARE_REPO, str(HARDWARE_DIR)],
                check=True, capture_output=True, text=True,
            )
        else:
            log.info('Updating nixos-hardware...')
            result = subprocess.run(
                ['git', '-C', str(HARDWARE_DIR), 'pull', '--ff-only'],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                # Detached HEAD or dirty — reset to origin
                log.warning('git pull failed; resetting to origin/main')
                subprocess.run(
                    ['git', '-C', str(HARDWARE_DIR), 'fetch', 'origin'],
                    check=True, capture_output=True,
                )
                subprocess.run(
                    ['git', '-C', str(HARDWARE_DIR), 'reset', '--hard', 'origin/HEAD'],
                    check=True, capture_output=True,
                )

        profiles = enumerate_profiles(log)
        ts = now_utc()
        existing = {row[0] for row in db.execute('SELECT id FROM hardware_profiles')}
        seen = set()

        # ── Pass 1: upsert all profiles ─────────────────────────────────────
        log.info('Pass 1: inserting/updating profiles...')
        with db:
            for pid, info in profiles.items():
                mfr_slug, model = parse_profile_id(pid)
                has_readme = 1 if (info['dir'] / 'README.md').exists() else 0
                db.execute(
                    """INSERT INTO hardware_profiles
                         (id, module_path, manufacturer, model,
                          model_aliases, description, has_readme, last_synced)
                       VALUES (?,?,?,?,NULL,NULL,?,?)
                       ON CONFLICT(id) DO UPDATE SET
                         module_path  = excluded.module_path,
                         manufacturer = excluded.manufacturer,
                         model        = excluded.model,
                         has_readme   = excluded.has_readme,
                         last_synced  = excluded.last_synced""",
                    (
                        pid,
                        info['module_path'],
                        display_name(mfr_slug) if mfr_slug else None,
                        model,
                        has_readme,
                        ts,
                    ),
                )
                seen.add(pid)
                rows_upserted += 1

            stale = existing - seen
            rows_deleted = len(stale)
            if stale:
                log.info(f'Removing {rows_deleted} stale profiles')
                db.executemany('DELETE FROM hardware_profiles WHERE id=?',
                               [(pid,) for pid in stale])

        # ── Pass 2: enrich with README data ─────────────────────────────────
        log.info('Pass 2: enriching with README data...')
        enriched = 0
        for pid, info in profiles.items():
            readme = info['dir'] / 'README.md'
            if readme.exists():
                description, aliases = parse_readme(readme)
                if description or aliases:
                    db.execute(
                        """UPDATE hardware_profiles
                           SET description=?, model_aliases=?, has_readme=1
                           WHERE id=?""",
                        (description, aliases, pid),
                    )
                    enriched += 1
        db.commit()
        log.info(f'Enriched {enriched} profiles with README content')

        # ── FTS5 ─────────────────────────────────────────────────────────────
        log.info('Rebuilding FTS5 index for hardware_profiles...')
        with db:
            db.execute("DELETE FROM search_index WHERE source_table='hardware_profiles'")
            db.execute("""
                INSERT INTO search_index (source_table, source_id, searchable_text)
                SELECT 'hardware_profiles', id,
                       COALESCE(manufacturer, '') || ' ' ||
                       COALESCE(model, '')        || ' ' ||
                       COALESCE(model_aliases, '') || ' ' ||
                       COALESCE(description, '')
                FROM hardware_profiles
            """)

        finished_at = now_utc()
        log.info(f'Hardware done: {rows_upserted} upserted, '
                 f'{rows_deleted} deleted, {enriched} README-enriched')
        log_sync_run(db, 'hardware', started_at, finished_at, 'success',
                     rows_upserted, rows_deleted)
        return True

    except Exception as exc:
        log.error(f'Hardware sync failed: {exc}', exc_info=True)
        log_sync_run(db, 'hardware', started_at, now_utc(), 'error',
                     rows_upserted, rows_deleted, str(exc))
        return False


if __name__ == '__main__':
    _log = setup_logging('sync_hardware')
    _db  = get_db()
    init_schema(_db)
    ok = sync(_log, _db)
    sys.exit(0 if ok else 1)
