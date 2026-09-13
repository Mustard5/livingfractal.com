# Living Fractal — agent rules

NixOS config generator at [livingfractal.com](https://livingfractal.com).
Plain English in, a documented `configuration.nix` out.

**Grok Bot desktop teammate:** paste the profile in [`GROK-BOT.md`](GROK-BOT.md)
into **Bot actions → Edit Profile**. This file is the repo contract for any
agent (Grok Bot, Grok Build, Cursor) working the code.

Vision and roadmap live in `~/lab-infra/livingfractal/VISION.md`.
Deploy and ops live in `~/lab-infra/services/hetzner/livingfractal.md`.
Read both before feature work.

## What this is

Front door of a three-part product: website → free NixOS assistant agent
(not started) → grounding layer (`nixos.db`). Distribution is a free give-away.
Do not build paywalls.

North star: a non-technical person describes a machine in plain English and
gets a config that actually evaluates, grounded against real nixpkgs.

## Layout

```
server.js          Express app (ES modules, no bundler, no TypeScript)
src/db.js          SQLite sessions + grounded package/option checks
src/validator.js   Heuristic validation (log-only; does not block delivery)
src/prompts.js     Versioned prompts in prompts/ (hot-reload)
src/admin.js       Bearer-token admin API
public/            Static HTML (index, manifesto, admin, referrals)
scripts/sync/      nixos.db nightly sync (packages, options, hardware)
```

Live: Hetzner `ssh hetzner`, app `/opt/livingfractal`, data `/var/lib/livingfractal`.
systemd `livingfractal`. Model `deepseek/deepseek-v4-flash` via OpenRouter.
Prompt on production: `v003`. Health: `GET /api/health`.

`CLAUDE.md` is a compatibility stub. Do not treat its "what does not exist"
list as current — session logging, prompt files, heuristic + grounded
validation, and the admin UI are already live.

## Conventions

- `git pull` before editing. Branch `task/<descriptive-name>`. Never commit to `master`/`main`.
- Plain JavaScript, 2-space indent, ES modules. Frontend is static HTML.
- No em dashes in user-facing copy.
- Prompt changes: add `prompts/vNNN.txt` and bump. Never edit a deployed prompt in place.
- LLM output is untrusted. It must pass through the validator before the user sees it.
- Stay on well-trodden nixpkgs patterns. Ground package names and option paths against `nixos.db`.
- Scripts: `set -euo pipefail`.

## Deploy

`/opt/livingfractal` is `www-data`-owned. rsync to `~/livingfractal-staging/`
on Hetzner, then sudo rsync into `/opt`. Full commands are in the runbook.
Do not rsync `.env`, `node_modules`, `.git`, or data dirs.
Restart `livingfractal` after app changes. Prompt-only: hot-reload via admin API.

Verify after deploy:

```bash
curl -sS https://livingfractal.com/api/health
ssh hetzner 'sudo systemctl is-active livingfractal'
```

## Local

```bash
cp .env.example .env   # OPENROUTER_API_KEY
# optional: scp hetzner:/var/lib/livingfractal/validation/nixos.db local-dev/nixos.db
# LF_VALIDATION_DB=./local-dev/nixos.db LF_DATA_DIR=./data npm run dev
```

`local-dev/` and `.env` are gitignored.

## Next work

Default to the top unchecked **Phase A** item in VISION.md unless asked
otherwise. Remaining Phase A: curated-pattern allowlist; prompt v004 +
validator nested-path fixes from `~/lab-infra/livingfractal/api-test-report-2026-06-23.md`.

Phase B (empty `curated_patterns` / `security_policy`) is scoped in
`~/lab-infra/livingfractal/phase-b-curated-patterns.md`.

## Do not

- Put secrets, `.env`, or `LF_ADMIN_TOKEN` in git, chat, or the Grok Bot cloud computer
- Deploy or restart production without an explicit ask
- Contact users or post to X as the site
- Enable Second Brain MCP for this repo
