# CLAUDE.md — Living Fractal Project Knowledge

This file is the single source of truth for any AI working on this codebase. It bridges the gap between the strategic design work (done in Claude chat conversations with the project founder) and the implementation work (done here in code). If you're reading this, you have the full picture. Act on it.

---

## What Living Fractal Is

Living Fractal (livingfractal.com) is a service that translates human intent into sovereign, personal NixOS operating system configurations. A user describes what they want their computer to do in plain language. The service generates a complete, validated, documented NixOS configuration they can download and deploy.

It is not a Linux distribution. It is not a hosting company. It is a translation layer between human intention and system reality.

The founder is not fluent in NixOS. This is intentional — they are representative of the target audience. They contribute product instincts, strategic direction, brand voice, and prompt engineering. The engineering is built with AI assistance and will eventually include hired developers.

## The Product Philosophy

**Computing sovereignty**: your computer should answer to you and no one else. Every generated configuration is transparent (documented in plain language), sovereign (no ongoing dependency on Living Fractal), and personal (shaped by what the user asked for, not by defaults someone else chose).

**LLM output is untrusted by default.** The model is a translator, not an authority. Everything it produces must be validated before delivery. There is no code path where LLM output reaches the user without passing through the validation engine. This is the foundational security principle.

**The data flywheel is the moat.** The prompt is not defensible — it's text that can be extracted or replicated. What's defensible is: the accumulated dataset of real-world intent-to-configuration mappings, the validation results, the failure patterns, and the curated patterns that emerge from analyzing them. Every generation teaches the system something. The free tier exists to start this flywheel.

**Configuration, not circumvention.** The product generates configurations. The liability and sovereignty framework depends on this distinction.

**Open-source commitment.** The generation toolchain will be open-sourced. A sovereignty product that creates lock-in is a contradiction. The service exists for convenience, not control.

---

## Current State of the Codebase

### Architecture

```
Nginx (TLS termination, ports 80/443)
  └─► Express/Node.js (port 3120)
        ├── Static frontend (public/)
        ├── /api/generate — intent → OpenRouter → NixOS config
        ├── /api/health — status check
        └── /manifesto — serves manifesto page
```

- **Server**: Hetzner VPS, Ubuntu, systemd service running as www-data
- **App location**: `/opt/livingfractal`
- **Environment**: `.env` file with `OPENROUTER_API_KEY`, loaded by systemd `EnvironmentFile`
- **Default model**: DeepSeek V3 via OpenRouter (configurable via `LF_MODEL` env var)
- **Frontend**: Static HTML/JS in `public/`, Living Fractal brand (dark theme, JetBrains Mono + Source Serif 4)

### What Exists

- Working prototype: user types intent, gets NixOS config back from OpenRouter
- Rate limiting (in-memory, per-IP)
- Input sanitization (injection pattern detection)
- System prompt with NixOS generation instructions, output format spec, anti-extraction rules
- Response parsing (splits on `=== CONFIGURATION ===` / `=== DOCUMENTATION ===` delimiters)
- Landing page (`public/index.html`) and manifesto page (`public/manifesto.html`)

### What Does NOT Exist Yet

- **No database.** No persistence of any kind. Every generation is fire-and-forget.
- **No session logging.** No record of what was asked, what was generated, or whether it was any good.
- **No validation engine.** LLM output goes directly to the user without checking whether packages exist, options are valid, or the config is dangerous.
- **No prompt versioning.** The system prompt is a hardcoded string in server.js. No way to track which prompt version produced which results.
- **No NixOS package/option database.** The RAG retrieval layer described in the architecture docs is not implemented. The model generates from its training knowledge, not from verified data.
- **No curated patterns.** No library of tested, verified Nix configuration snippets.
- **No admin interface.** No way to review generation history, failure rates, or prompt performance.

---

## What Needs to Be Built Next

### Priority 1: Session Logging + Prompt Versioning

Every generation must be logged to SQLite so the founder can analyze prompt performance and identify failure patterns. This is the prerequisite for everything else — you can't improve what you can't measure.

**Database**: SQLite via `better-sqlite3` in `data/sessions.db`

**Schema**:

```sql
-- Prompt versions: track which prompt text was used
CREATE TABLE IF NOT EXISTS prompt_versions (
  version TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

-- Sessions: one per generation request
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'guided',
  FOREIGN KEY (prompt_version) REFERENCES prompt_versions(version)
);

-- What the user asked for
CREATE TABLE IF NOT EXISTS session_intents (
  session_id TEXT PRIMARY KEY,
  raw_intent TEXT NOT NULL,
  sanitized_intent TEXT,
  input_flagged INTEGER DEFAULT 0,
  hardware_keywords TEXT,
  usecase_keywords TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- What the model produced and how it validated
CREATE TABLE IF NOT EXISTS session_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  raw_output TEXT,
  config_text TEXT,
  docs_text TEXT,
  validation_passed INTEGER,
  validation_errors TEXT,
  validation_warnings TEXT,
  config_hash TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

**Prompt files**: Extract the system prompt from server.js into `prompts/v001.txt`. New versions are `v002.txt`, `v003.txt`, etc. The server loads the latest on startup and can hot-reload via admin endpoint.

**Admin API** (bearer token auth via `LF_ADMIN_TOKEN` env var):
- `GET /api/admin/sessions` — recent sessions with intent and validation results
- `GET /api/admin/sessions/:id` — full session detail with all attempts
- `GET /api/admin/stats` — generation count, pass rate, avg latency, failure breakdown
- `GET /api/admin/prompts` — list prompt versions
- `GET /api/admin/prompts/:version` — get prompt text
- `POST /api/admin/prompts/reload` — rescan prompts/ directory without restart

### Priority 2: Lightweight Validator

A module that checks LLM output before delivery. At this stage it logs findings but does NOT block delivery — the founder is the only user and wants to see what the model produces, good or bad. Enforcement comes later.

**Structure checks**: presence of config/docs delimiters, non-empty config section, starts with `{` after comments

**Nix plausibility checks**: balanced braces and brackets, contains expected markers like `environment.systemPackages` or `system.stateVersion`, not truncated

**Security pattern flags**: firewall disabled, password SSH enabled, root login enabled, fetchurl/fetchgit usage

**Character break detection**: conversational preamble before the config delimiter ("Sure!", "Here's", "Let me"), markdown code fences wrapping the output

The validator returns: `{ passed, configText, docsText, errors[], warnings[], securityFlags[] }`. `passed` is false only for structural/plausibility failures. Security flags produce warnings, not failures.

### Priority 3: NixOS Validation Database (Future)

A second SQLite database (`data/validation.db`) populated by sync scripts that pull real package names, option paths, and hardware profiles from NixOS channels. This enables:
- **RAG retrieval**: feed the model verified NixOS data as context instead of relying on training knowledge
- **Reference validation**: check that every package name and option path in the generated config actually exists
- **Allowlist enforcement**: only permit modules that have been reviewed and tested

This is designed but not yet implemented. The schema is documented in `Living_Fractal_System_Prompt_and_Database_Schema.docx` in the project files.

---

## Architecture Documents (Reference)

These documents live in the Claude chat project files and contain the full design thinking. They are the authoritative reference for architectural decisions:

| Document | Contains |
|----------|----------|
| `Living_Fractal_Vision_Document.docx` | Product strategy, tier structure, roadmap, target audience |
| `Living_Fractal_System_Prompt_and_Database_Schema.docx` | Six-component prompt assembly architecture, five-table validation DB schema, RAG retrieval patterns, end-to-end generation example |
| `Living_Fractal_Security_Architecture.docx` | Threat model, attack surface analysis, mitigation strategies, trust boundary design |
| `Living_Fractal_Privacy_Policy.docx` | Data handling commitments, retention policy, anonymization timeline |
| `Living_Fractal_NixOS_Hardware_Collaboration.docx` | Upstream contribution strategy for nixos-hardware |
| `Living_Fractal_Manifesto_Complete_Draft.docx` | The founding statement (published on the site) |
| `builds.html` | Seven pre-configured build templates (Sovereign Workstation, Crypto Vault, Homelab Host, Dev Workstation, Family Terminal, Offline Workstation, Network Guardian) |
| `living_fractal_generation_pipeline.html` | Interactive visualization of the seven-stage generation pipeline with tier-specific behavior |

---

## Generation Pipeline Design (Seven Stages)

The full pipeline, as designed but not yet fully implemented:

1. **User intent input** — plain language description enters the system (IMPLEMENTED)
2. **Input sanitization + gate** — pattern matching, rate limiting (IMPLEMENTED)
3. **RAG retrieval** — query NixOS package/option/hardware database for relevant context (NOT IMPLEMENTED)
4. **LLM generation** — system prompt + user intent + RAG context → NixOS config (IMPLEMENTED, without RAG)
5. **Validation engine** — verify output against NixOS database + security policy (NOT IMPLEMENTED)
6. **Documentation generation** — plain-language explanation of every decision (PARTIALLY IMPLEMENTED — model generates docs inline)
7. **Output delivery** — package config + docs, hash for integrity, deliver to user (IMPLEMENTED, without hashing)

## Three-Tier Generation Model

The system prompt behavior varies by tier. All tiers share the same pipeline; the difference is in the prompt posture and validation policy:

| Tier | Prompt Posture | Validation Policy |
|------|---------------|-------------------|
| **Guided** | "Prioritize security defaults. Make safe choices." | Strict allowlist. Blocks dangerous patterns. |
| **Informed** | "Implement intent. Flag security implications." | Flag-and-document. Warns but doesn't block. |
| **Sovereign** | "Implement exactly what was described." | Document-only. Lists attack surface, doesn't prevent. |

Currently only the Guided posture is implemented. The tier system is a future feature.

---

## System Prompt Architecture

The system prompt is designed to be assembled from six components (documented in detail in `Living_Fractal_System_Prompt_and_Database_Schema.docx`):

1. **Role definition** — identity, output constraints, anti-extraction (static)
2. **Output format spec** — exact structure of .nix output (static)
3. **RAG context bundle** — real NixOS data for this request (dynamic, NOT IMPLEMENTED)
4. **Tier instruction** — behavioral posture (per tier, currently hardcoded to Guided)
5. **Security guardrails** — what the model must/must not do (per tier)
6. **User intent** — placed in user message role, structurally separated from system prompt

Currently components 1, 2, 4, and 5 are combined into a single hardcoded string in server.js. The prompt versioning system (Priority 1 above) externalizes this to files in `prompts/`.

---

## Key Technical Decisions

- **Node.js/Express** — already in place, no reason to change
- **SQLite via better-sqlite3** — synchronous API, single-file database, zero infrastructure, works with systemd sandboxing
- **OpenRouter** — model flexibility for experimentation (can swap DeepSeek, Claude, etc. without code changes)
- **LLM output is buffered, not streamed** — the full response is received, validated, then delivered. User sees a loading state. This is a security trade-off.
- **Nginx handles TLS** — Certbot/Let's Encrypt, proxy to localhost:3120
- **systemd hardening** — NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, ReadWritePaths=/opt/livingfractal

## File Conventions

- ES modules (`"type": "module"` in package.json)
- No build step, no bundler, no TypeScript — plain JavaScript
- Frontend is static HTML/JS/CSS in `public/`, no framework
- Fonts loaded from Google Fonts (noted in CSP headers)
- No em dashes in any user-facing text — the founder's style preference, enforced across all documents and generated content

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter LLM calls |
| `LF_MODEL` | No | Model string (default: `deepseek/deepseek-chat-v3-0324`) |
| `LF_PORT` | No | Server port (default: 3120) |
| `LF_ADMIN_TOKEN` | No | Bearer token for admin API endpoints (required to use admin API) |

---

## Competitive Landscape

**MyNixOS (mynixos.com)** — GUI builder for NixOS configurations. Structured form-based approach. Indexes 29,000+ options, 129,000+ packages. Closed source, freemium model. The strategic risk: if they add a natural-language AI layer, they have infrastructure advantages (existing package index, user base, build pipeline). Living Fractal's differentiation is the intent-translation model (conversation, not forms), the documentation layer, and the sovereignty philosophy.

**nixai (olafkfreund/nix-ai-help)** — CLI tool for AI-powered NixOS assistance. MIT licensed, archived February 2026. Go codebase. Forked for study only, not used as a foundation. Patterns of interest: prompt engineering, validation logic, hardware detection, configuration generation, template systems.

---

## The Founder's Workflow

The founder iterates on Living Fractal through two channels:

1. **Claude chat (this project)** — strategic thinking, document drafting, architecture design, product decisions. This is where the "why" and "what" are decided.
2. **Claude Code (this repo)** — implementation, code writing, deployment. This is where the "how" gets built.

This CLAUDE.md file exists to bridge those two channels. When the founder asks for something to be built, the context for why it matters and how it fits into the larger architecture is here. When architectural decisions are made in chat, they should be reflected back into this file so Claude Code stays informed.

**If you're in Claude Code and the founder references a decision or design that isn't in this file, ask them to update it or tell you what was decided. Don't guess.**
