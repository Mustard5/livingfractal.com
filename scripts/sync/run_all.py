#!/usr/bin/env python3
"""Living Fractal validation DB sync orchestrator.

Runs packages → options → hardware in sequence.
A failure in one source does not abort the others.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from common import get_db, init_schema, setup_logging, LOGS_DIR
import sync_packages
import sync_options
import sync_hardware

LOG_RETENTION_DAYS = 14


def prune_logs(log):
    if not LOGS_DIR.exists():
        return
    cutoff = time.time() - LOG_RETENTION_DAYS * 86400
    for f in LOGS_DIR.glob('sync-*.log'):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                log.info(f'Pruned log: {f.name}')
        except OSError:
            pass


def main():
    log = setup_logging('run_all')
    log.info('=' * 60)
    log.info('Living Fractal sync starting')
    log.info('=' * 60)
    wall_start = time.time()

    db = get_db()
    init_schema(db)

    steps = [
        ('packages', sync_packages),
        ('options',  sync_options),
        ('hardware', sync_hardware),
    ]
    results = {}

    for name, module in steps:
        log.info(f'--- {name} sync starting ---')
        t0 = time.time()
        try:
            ok = module.sync(log, db)
            elapsed = time.time() - t0
            results[name] = ('ok' if ok else 'failed', elapsed)
            log.info(f'--- {name} {"OK" if ok else "FAILED"} in {elapsed:.1f}s ---')
        except Exception as exc:
            elapsed = time.time() - t0
            results[name] = ('error', elapsed)
            log.error(f'--- {name} ERROR in {elapsed:.1f}s: {exc} ---',
                      exc_info=True)

    total = time.time() - wall_start
    log.info('=' * 60)
    log.info(f'Sync complete in {total:.1f}s')
    for name, (status, elapsed) in results.items():
        log.info(f'  {name:<12s}  {status:<8s}  {elapsed:.1f}s')
    log.info('=' * 60)

    prune_logs(log)

    failed = [n for n, (s, _) in results.items() if s != 'ok']
    if failed:
        log.error(f'Failed sources: {", ".join(failed)}')
        sys.exit(1)


if __name__ == '__main__':
    main()
