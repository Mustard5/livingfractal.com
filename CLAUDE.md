# Living Fractal Prototype

## What This Is

A working prototype of livingfractal.com — a service that translates plain-language system descriptions into complete, documented NixOS configurations. This is the first concrete step toward a production service. It runs on a Hetzner VPS behind Caddy.

## Architecture

```
User (browser) → Caddy (TLS, headers) → Node.js/Express (port 3120) → OpenRouter API → DeepSeek V3
```

- **Frontend:** Single static HTML file (`public/index.html`). No build step, no framework. Source Serif 4 + JetBrains Mono fonts. Dark theme with green accent. Brand-adjacent to the existing builds.html page.
- **Backend:** `server.js` — Express server (ES modules, `"type": "module"` in package.json). Proxies generation requests to OpenRouter. API key stays server-side only.
- **Model:** DeepSeek V3 via OpenRouter (`deepseek/deepseek-chat-v3-0324`). Configurable via `LF_MODEL` env var.
- **Deployment:** systemd service (`livingfractal.service`), Caddy reverse proxy (`Caddyfile.example`), env file (`.env`).

## Key Design Decisions

- **LLM output is untrusted.** The response is buffered completely, never streamed to the user. All LLM output is rendered as `textContent`, never `innerHTML` (except the documentation panel which uses a lightweight markdown renderer on the parsed docs section only).
- **System/user prompt separation.** The system prompt goes in the `system` role, user input goes in the `user` role. User input is never interpolated into the system prompt.
- **Input sanitization.** The API gateway strips control characters, enforces length limits (4000 chars), and pattern-matches for common prompt injection phrases. Flagged inputs are logged but not blocked (to avoid false positives).
- **Rate limiting.** Simple in-memory per-IP rate limiting (10 requests per 60 seconds). Sufficient for prototype scale.
- **Response parsing.** The LLM is instructed to delimit output with `=== CONFIGURATION ===` and `=== DOCUMENTATION ===` markers. The parser has fallbacks for when the model uses code fences instead, or produces no delimiters at all.

## File Structure

```
server.js                 Express backend — the only server-side code
public/index.html         Complete frontend — HTML, CSS, JS in one file
package.json              Dependencies (express only)
.env.example              Environment variable template
livingfractal.service     systemd unit file
Caddyfile.example         Caddy site block with security headers
README.md                 Deployment instructions
```

## Running Locally

```bash
cp .env.example .env
# Edit .env — set OPENROUTER_API_KEY to your key
npm install
npm run dev
# Open http://localhost:3120
```

## Deploying to VPS

```bash
# From local machine
rsync -avz --exclude node_modules ./ user@vps:/opt/livingfractal/

# On the VPS
cd /opt/livingfractal
npm install
cp .env.example .env
nano .env  # set OPENROUTER_API_KEY

# systemd
sudo cp livingfractal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now livingfractal

# Caddy — add the site block from Caddyfile.example to your Caddyfile
sudo systemctl reload caddy
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key (starts with `sk-or-v1-`) |
| `LF_MODEL` | No | `deepseek/deepseek-chat-v3-0324` | OpenRouter model string |
| `LF_PORT` | No | `3120` | Port the Express server listens on |

## API Endpoints

- `POST /api/generate` — Takes `{ "description": "..." }`, returns `{ "config": "...", "docs": "...", "model": "...", "usage": {...} }`
- `GET /api/health` — Returns `{ "status": "ok", "model": "..." }`

## System Prompt

The system prompt is defined inline in `server.js` (the `SYSTEM_PROMPT` constant). It implements the Guided tier behavioral posture from the Living Fractal prompt architecture:

- Role-locked to NixOS configuration generation only
- Anti-extraction instructions
- Anti-hallucination instructions (no invented packages or option paths)
- Structured output format (config + documentation sections)
- Security-first defaults (firewall on, key-only SSH, LUKS recommended, no open ports unless asked)

## What's Not Here Yet

This is a prototype. The following are documented in the project's design docs but not implemented:

- **Validation engine.** No NixOS package/option database check on the output. The LLM is instructed not to hallucinate, but there's no verification. This is the highest-priority addition.
- **RAG retrieval.** No local NixOS knowledge base. The model generates from its training data, not from a grounded context bundle. Adding this will significantly improve output quality.
- **Tier selection.** Only the Guided tier posture is implemented. Informed and Sovereign tiers exist in the design but aren't wired up.
- **Multi-turn conversation.** Single-shot generation only. The conversational intake flow (asking clarifying questions to refine the description) is designed but not built.
- **Persistent storage.** No database. No user accounts. No generation history. In-memory rate limiting only.
- **Analytics.** No tracking. No logging beyond console output and injection flagging.

## Conventions

- ES modules (`import`/`export`), not CommonJS
- No TypeScript — plain JS for now
- No frontend build toolchain — vanilla HTML/CSS/JS
- Single-file frontend (all CSS and JS inline in index.html)
- No external JS dependencies in the frontend (fonts loaded from Google Fonts CDN only)
- Backend dependency: express only
- Prefer `const` over `let`, never `var`
- Template literals for string building, not concatenation

## Brand Reference

The visual identity matches the existing Living Fractal assets:

- **Background:** `#0a0c0f` with subtle radial gradient overlays in green and blue
- **Cards/panels:** `#0f1216` with `#1a1f28` borders
- **Text:** Primary `#c8cdd5`, secondary `#6b7280`, muted `#3d4554`
- **Accent green:** `#4ade80` — used for brand mark, buttons, active states, code highlights
- **Fonts:** JetBrains Mono (UI labels, code, monospace elements), Source Serif 4 (body text, headings)
- **Tone:** Clean, dark, restrained. No gradients on buttons. No shadows. Subtle hover transitions.

## Project Context

Living Fractal is a sovereignty-focused NixOS configuration generation service. The founder is not a NixOS expert — that's intentional alignment with the target user. The core value proposition is intent-to-configuration translation: describe what you want in plain language, get a validated NixOS config back with documentation explaining every decision.

Key project documents (not in this repo, held separately):
- Manifesto (six sections, drafted)
- Vision Document (product roadmap, tier structure, go-to-market)
- System Prompt & Database Schema (prompt assembly architecture, SQLite schema, RAG design)
- Security Architecture & Threat Model (attack surface analysis, validation engine design)
- Privacy Policy
- NixOS Hardware Collaboration Proposal
- Builds showcase page (seven pre-configured archetypes)
- Generation pipeline interactive visualization
