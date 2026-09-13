# Grok Bot team — livingfractal.com

Four named Bots, one group chat, one shared cloud computer. They advance
the roadmap without you routing every step. They do **not** merge to `main`,
deploy, or touch secrets.

Grok Bot is the desktop teammate. It is not Grok Build (`grok` CLI).
Repo contract for anyone writing code: [`AGENTS.md`](AGENTS.md).

| Bot | Title | Owns | Never |
|-----|--------|------|--------|
| **Fractal** | Dispatcher | Next slice, briefs, review vs VISION | Large patches, deploy |
| **Smith** | App engineer | Node/Express, UI, async generate, PRs | nixos.db schema, deploy |
| **Ground** | Grounding | validator, `curated_patterns`, prompts, RAG | Site chrome, deploy |
| **Watch** | Site sentry | Health, sessions, regression, deploy *ask* | Feature scope |

Profiles: [`bots/fractal.md`](bots/fractal.md), [`bots/smith.md`](bots/smith.md),
[`bots/ground.md`](bots/ground.md), [`bots/watch.md`](bots/watch.md).

## Why this split

Grok Bot 101: keep dirty product context out of the inner loop that writes code.
VISION.md is three pieces (front door, give-away agent, grounding moat). Smith
is the front door. Ground is the moat. Watch is production. Fractal is the
queue. Separate Bots are **not** a security boundary — they share `/workspace`,
browser sessions, and GitHub.

Do not add a fifth Bot until one of these has a stable second job.

## Autonomy (what "without me" means)

```
Watch (routine, after skill is proven)
  → group: health + last-day session warnings, or "all clear"
Fractal
  → one Phase A/B slice from VISION.md, brief in the group, @Smith or @Ground
Smith / Ground
  → task/<name> branch, PR, @Fractal
Fractal
  → review against AGENTS.md + VISION; @user to merge
You
  → merge PR; if deploy is needed, say so
Watch
  → after your deploy yes: verify /api/health and the changed path
```

Unattended they may: read the site, GitHub, `/workspace`, Thelio checkouts you
already approved; open `task/*` PRs; post in the group; ping you with a
decision.

They must stop for: merge to `main`, `ssh hetzner` / rsync / systemd,
`.env` / tokens / SSH keys, X/email as the site, DNS, money, new Bot creation
beyond this roster.

## Create in the app

Fractal already exists. Edit its profile from [`bots/fractal.md`](bots/fractal.md),
then send Fractal the "create teammates" message in that file.

Or: `Ctrl+N` → **Create new agent** → **Edit Profile** for Smith, Ground, Watch.

Then **New → group** with all four. Name it **Living Fractal**. Send the
kickoff at the bottom of this file.

## Shared rules (every Bot)

- Clone: `/workspace/livingfractal.com` on `task/grok-bot-setup` until `main`
  has these files, then `main`.
- `git pull` first. Branch `task/<descriptive-name>`. Never commit to `main`.
- GitHub plugin is account-wide. No Vaultwarden, no Second Brain, no `.env`
  on the cloud computer.
- Local computer: **Ask every time**. Approve git in `~/projects/livingfractal.com`
  and `~/lab-infra`, `curl` to the live site, and (Watch only, after you say
  deploy) `ssh hetzner` / runbook rsync.
- No em dashes in user-facing copy. Plain JavaScript, no bundler, no TypeScript.
- Default queue: top unchecked Phase A item in `~/lab-infra/livingfractal/VISION.md`.

## Skills then routines

Skills (create after one clean run):

| Skill | Owner | When |
|-------|--------|------|
| **Fractal status** | Watch (also Fractal) | Health + repo HEAD + prompt/model |
| **Next slice** | Fractal | Turn VISION checkbox into a one-PR brief |
| **Open task PR** | Smith / Ground | Branch, commit, PR, stop |
| **Session triage** | Watch | Admin/session warning patterns, no PII dump |

Routines — **off** until the matching skill has been run twice by hand:

| Routine | Owner | Schedule (America/Indiana/Indianapolis) |
|---------|--------|------------------------------------------|
| Morning status | Watch | Weekdays 08:00 — `/Fractal status` into the group, read-only |
| Queue | Fractal | Weekdays 08:30 — if Watch is all-clear and Phase A remains, post **one** brief |

No GitHub-webhook routine that implements every issue. Too broad, burns quota.

## Group kickoff (paste into Living Fractal)

```
Shared outcome: ship Phase A, then Phase B, as one-PR slices. Free give-away. No paywalls.

@Watch run /Fractal status. Read-only. Post health JSON, git HEAD of /workspace/livingfractal.com, and whether production needs us.

@Fractal after Watch reports, write one Next slice brief for the top unchecked Phase A item in VISION.md. Assign @Ground or @Smith. Do not write the patch yourself.

@Ground @Smith do not start coding until Fractal's brief is in this group. Then one task/* PR, then stop.

Nobody deploys, merges to main, or copies secrets. Ping me when a PR is ready to merge.
```
