-- Idempotent seed for curated_patterns (Track 1 / Phase B).
-- Apply: sqlite3 /path/to/nixos.db < scripts/seed/curated_patterns.sql
-- Then restart livingfractal so the in-memory allowlist rebuilds.
-- Survives nightly sync; re-run after a full DB rebuild.
-- tier_minimum is ignored by the app (legacy); kept for schema compatibility.

INSERT OR IGNORE INTO curated_patterns (
  name,
  category,
  description,
  nix_snippet,
  requires_packages,
  requires_options,
  tier_minimum,
  tested,
  added_date
) VALUES (
  'lanzaboote',
  'secure-boot',
  'UEFI Secure Boot via the lanzaboote flake (boot.lanzaboote.* is flake-sourced, not in nixpkgs options).',
  'boot.loader.systemd-boot.enable = lib.mkForce false;
boot.lanzaboote.enable = true;
boot.lanzaboote.pkiBundle = "/etc/secureboot";',
  '["sbctl"]',
  '["boot.lanzaboote.enable","boot.lanzaboote.pkiBundle","boot.loader.systemd-boot.enable"]',
  'guided',
  0,
  datetime('now')
);
