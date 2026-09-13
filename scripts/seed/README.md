# curated_patterns seed

Idempotent `INSERT OR IGNORE` seed for the validation DB `curated_patterns` table.
Survives nightly sync; **re-run after any full DB rebuild**.

```bash
sqlite3 /var/lib/livingfractal/validation/nixos.db < scripts/seed/curated_patterns.sql
# then restart so the in-memory allowlist rebuilds
sudo systemctl restart livingfractal
```

Track 1 ships a single `lanzaboote` row so flake-sourced `boot.lanzaboote.*`
passes grounded validation. Full pattern catalog is Track 2.
