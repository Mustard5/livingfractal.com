# Living Fractal

NixOS configuration generator. Takes plain-language system descriptions and generates
complete, documented NixOS configurations via DeepSeek V3 on OpenRouter.

Live at: https://livingfractal.com

## Stack

```
Browser → Nginx (TLS, reverse proxy) → Node.js/Express :3120 → OpenRouter → DeepSeek V3
```

- Runtime: Node.js 22
- Model: `deepseek/deepseek-chat-v3-0324` (configurable via `LF_MODEL`)
- Database: SQLite at `$LF_DATA_DIR/data/sessions.db` (WAL mode)
- Reverse proxy: Nginx with Let's Encrypt (Certbot)

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `LF_DATA_DIR` | No | `/var/lib/livingfractal` | Data directory root |
| `LF_MODEL` | No | `deepseek/deepseek-chat-v3-0324` | Model string |
| `LF_PORT` | No | `3120` | Server port |
| `LF_ADMIN_TOKEN` | No | — | Bearer token for admin API |

## Deploy

Deployment is via rsync from this working tree to the Hetzner VPS (`ssh hetzner`).
See `services/hetzner/livingfractal.md` in the lab-infra repo for the full deploy runbook.

## Local development

```bash
cp .env.example .env   # create if absent; set OPENROUTER_API_KEY
npm install
npm run dev            # starts with --watch
# Open http://localhost:3120
```

## Structure

```
server.js              Express backend
src/
  db.js                SQLite session logging
  admin.js             Admin API router (bearer token auth)
  prompts.js           Prompt versioning + hot-reload
  validator.js         LLM output validation (log-only)
prompts/v001.txt       System prompt (versioned)
public/
  index.html           Generator UI
  manifesto.html       Project manifesto
  admin.html           Admin dashboard UI (served at /admin)
livingfractal.service  systemd unit reference (deployed to /etc/systemd/system/)
Caddyfile.example      Historical — Caddy was replaced by Nginx (2026-03-21)
```

## Costs

DeepSeek V3 on OpenRouter: roughly $0.27/M input, $1.10/M output tokens.
A typical generation uses ~1K input + ~3K output tokens ≈ $0.004/generation.
