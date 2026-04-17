"""Shared utilities for Living Fractal validation DB sync scripts."""
import logging
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# ── Path constants ────────────────────────────────────────────────────────────
_DATA_ROOT = Path(os.environ.get('LF_DATA_DIR', '/var/lib/livingfractal'))
VALIDATION_DIR = _DATA_ROOT / 'validation'
DB_PATH        = VALIDATION_DIR / 'nixos.db'
SOURCES_DIR    = VALIDATION_DIR / 'sources'
LOGS_DIR       = VALIDATION_DIR / 'logs'
SYNC_DIR       = VALIDATION_DIR / 'sync'
SCHEMA_PATH    = SYNC_DIR / 'schema.sql'

# ── Nix config ────────────────────────────────────────────────────────────────
# Nix is installed single-user as boss. The sync service runs as boss directly
# (User=boss in the systemd unit), so no sudo escalation is needed.
NIX_BIN_DIR = os.environ.get('NIX_BIN', '/home/boss/.nix-profile/bin')


def nix_bin(name: str) -> str:
    """Full path to a Nix binary."""
    return f'{NIX_BIN_DIR}/{name}'


def run_nix(args, **kwargs):
    """Run a Nix command.

    The sync service runs as boss; Nix is installed for boss, so commands
    work directly.  The first element of args is the bare binary name
    (e.g. 'nix-env'); remaining elements are passed through.

    Extra kwargs are forwarded to subprocess.run.
    """
    cmd = [nix_bin(args[0])] + list(args[1:])
    return subprocess.run(cmd, **kwargs)


# ── Database ──────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    VALIDATION_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA synchronous=NORMAL')
    return db


def init_schema(db: sqlite3.Connection) -> None:
    """Apply schema.sql idempotently."""
    schema = SCHEMA_PATH.read_text()
    db.executescript(schema)
    db.commit()


# ── Time helpers ──────────────────────────────────────────────────────────────

def now_utc() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


# ── Logging ───────────────────────────────────────────────────────────────────

def setup_logging(name: str) -> logging.Logger:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOGS_DIR / f'sync-{datetime.now().strftime("%Y%m%d")}.log'
    fmt = '%(asctime)s %(name)-18s %(levelname)-8s %(message)s'
    root = logging.getLogger()
    if not root.handlers:
        root.setLevel(logging.INFO)
        root.addHandler(logging.FileHandler(str(log_file)))
        root.addHandler(logging.StreamHandler())
        for h in root.handlers:
            h.setFormatter(logging.Formatter(fmt))
    return logging.getLogger(name)


# ── Sync audit ────────────────────────────────────────────────────────────────

def log_sync_run(db, source, started_at, finished_at, status,
                 rows_upserted=0, rows_deleted=0, error_message=None):
    db.execute(
        """INSERT INTO sync_runs
           (source, started_at, finished_at, status, rows_upserted, rows_deleted, error_message)
           VALUES (?,?,?,?,?,?,?)""",
        (source, started_at, finished_at, status,
         rows_upserted, rows_deleted, error_message),
    )
    db.commit()
