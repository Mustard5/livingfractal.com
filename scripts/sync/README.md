# Validation DB sync scripts

Populates `/var/lib/livingfractal/validation/nixos.db` with real NixOS data
for use by the Living Fractal generation pipeline.

## What gets synced

| Source | Table | Rows (approx) | Notes |
|--------|-------|---------------|-------|
| nixpkgs channel | `packages` | 100k–135k | `nix-env -qaP --json` |
| NixOS module options | `options` | 15k–22k | Evaluated via `nixosOptionsDoc` |
| nixos-hardware | `hardware_profiles` | 280–320 | Two-pass: enumerate + README enrich |

`curated_patterns` and `security_policy` stay empty until populated manually.

## Channel choice

Single channel: **NixOS 25.11 stable** only. The `channel` column is present in
all tables so adding unstable or future stable channels is trivial later. For now,
one source of truth keeps the DB small and the queries fast.

## Hardware profiles — two-pass approach

**Pass 1** walks the nixos-hardware git tree looking for `default.nix` files.
Each such file represents a hardware profile; the directory path becomes the
profile ID (e.g. `lenovo/thinkpad/t14s` → `lenovo-thinkpad-t14s`). Manufacturer
and model are extracted from the ID with a known-manufacturer prefix match.
`has_readme` is set to 0 or 1 based on whether a `README.md` exists alongside
`default.nix`.

**Pass 2** reads each README and extracts:
- First prose paragraph → `description` (≤500 chars)
- "Also known as" / "marketed as" patterns → `model_aliases`

The two-pass design means the DB is usable after pass 1 even if README parsing
fails; the enrichment is additive.

## Nix dependency

The sync scripts shell out to Nix commands via `sudo -u boss`. Nix is installed
single-user as the `boss` user on the Hetzner VPS. The sync service runs as
`www-data` with sudoers permission to invoke specific Nix binaries as boss.

Binary path: `/home/boss/.nix-profile/bin/`
Channel: `nixpkgs` → `/home/boss/.nix-defexpr/channels/nixpkgs`
Channel version: NixOS 25.11

## Regenerating from scratch

```bash
# Stop the service, delete the DB and cached JSON, run manually
ssh hetzner
sudo systemctl stop livingfractal-sync.service
sudo -u www-data rm /var/lib/livingfractal/validation/nixos.db
sudo -u www-data rm -f /var/lib/livingfractal/validation/sources/packages.json
sudo -u www-data rm -f /var/lib/livingfractal/validation/sources/options.json
# nixos-hardware dir can stay (just git pulled)
sudo systemctl start livingfractal-sync.service
sudo journalctl -u livingfractal-sync.service -f
```

## Running a single source manually

```bash
ssh hetzner
sudo -u www-data python3 /var/lib/livingfractal/validation/sync/sync_packages.py
sudo -u www-data python3 /var/lib/livingfractal/validation/sync/sync_options.py
sudo -u www-data python3 /var/lib/livingfractal/validation/sync/sync_hardware.py
```

## Querying the DB

```bash
ssh hetzner 'sudo -u www-data sqlite3 /var/lib/livingfractal/validation/nixos.db "SELECT COUNT(*) FROM packages;"'
```

## Memory notes

- `nix-env -qaP --json` transiently uses 2–4 GB RAM
- NixOS options evaluation transiently uses 1–2 GB RAM
- Scripts run sequentially so peaks don't overlap
- The cx33 has 8 GB RAM and no swap — if OOM events occur during scheduled
  runs, the options sync step is the first suspect
