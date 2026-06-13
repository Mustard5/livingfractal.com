import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';

import * as prompts from './src/prompts.js';
import * as db from './src/db.js';
import { validate, extractPackageReferences, extractOptionReferences } from './src/validator.js';
import { router as adminRouter } from './src/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Config ──
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.LF_MODEL || 'deepseek/deepseek-v3.2';
const PORT = process.env.LF_PORT || 3120;
const ALLOWED_ORIGIN = process.env.LF_ALLOWED_ORIGIN || 'https://livingfractal.com';
const OPENROUTER_TIMEOUT_MS = 150_000; // 150s per LLM call. No longer bounded by
// nginx's proxy_read_timeout — generation is detached and the client polls, so
// the only request nginx sees is the instant 202 and the short status polls.

if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY environment variable is required.');
  process.exit(1);
}

// ── Rate limiting (simple in-memory) ──
const rateMap = new Map();
const RATE_LIMIT = 10;       // requests per window
const RATE_WINDOW = 60000;   // 1 minute

function rateCheck(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ── Input sanitization ──
function sanitizeInput(text) {
  if (typeof text !== 'string') return null;
  // Length limit
  if (text.length > 4000) return null;
  // Strip control characters except newlines and tabs
  const cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Basic injection pattern detection (log but don't block for now)
  const suspiciousPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /ignore\s+(all\s+)?above/i,
    /you\s+are\s+now\s+a/i,
    /pretend\s+you\s+are/i,
    /repeat\s+(your|the)\s+(system\s+)?instructions/i,
    /what\s+are\s+your\s+instructions/i,
    /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  ];
  const flagged = suspiciousPatterns.some(p => p.test(cleaned));
  return { text: cleaned, flagged };
}

// ── Parse LLM response into config and docs ──
function parseResponse(raw) {
  const configMatch = raw.match(/===\s*CONFIGURATION\s*===\s*([\s\S]*?)(?====\s*DOCUMENTATION\s*===)/);
  const docsMatch = raw.match(/===\s*DOCUMENTATION\s*===\s*([\s\S]*?)$/);

  let config = configMatch ? configMatch[1].trim() : null;
  let docs = docsMatch ? docsMatch[1].trim() : null;

  // If the model wrapped config in a code fence, strip it
  if (config) {
    config = config.replace(/^```(?:nix)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  if (docs) {
    docs = docs.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Fallback: if delimiters weren't used, try to split on code fences
  if (!config && !docs) {
    const fences = raw.match(/```nix\s*([\s\S]*?)```/);
    if (fences) {
      config = fences[1].trim();
      docs = raw.replace(fences[0], '').trim();
    } else {
      // Last resort: treat the whole thing as config
      config = raw;
      docs = '_Documentation could not be generated for this configuration._';
    }
  }

  return { config, docs };
}

// ── Silent refusal detection ──
// deepseek-v3.2 occasionally answers a valid intent with a one-line refusal
// ("I can only generate NixOS configurations.") instead of a config. It is a
// sampling fluke, not prompt non-compliance: the same input succeeds on retry.
// A genuine generation always carries both delimiters and runs to thousands of
// characters, so "no delimiters AND very short" is a reliable refusal signal.
function isLikelyRefusal(raw) {
  if (!raw) return false; // empty content is handled separately (502)
  const hasConfig = /===\s*CONFIGURATION\s*===/.test(raw);
  const hasDocs = /===\s*DOCUMENTATION\s*===/.test(raw);
  return !hasConfig && !hasDocs && raw.trim().length < 500;
}

// ── OpenRouter call with hard timeout ──
// Generation runs detached from the client request (see the async job model
// below), so there is no client AbortSignal to forward — the only abort source
// is the per-call timeout. Each LLM call is still bounded so a hung upstream
// can't pin a job in 'running' forever.
async function callOpenRouter(messages, sessionId, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    return await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://livingfractal.com',
        'X-Title': 'Living Fractal',
      },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.3, max_tokens: 8000 }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[TIMEOUT] ${sessionId} ${label}: timed out after ${OPENROUTER_TIMEOUT_MS}ms`);
      const e = new Error('upstream_timeout');
      e.name = 'upstream_timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── CORS policy ──
// Same-origin only. The public UI at livingfractal.com is the only permitted
// browser client. No third-party origins are allowed — integrators who need
// programmatic access from another origin should self-host the open-source
// toolchain. Non-browser callers (curl, server-to-server) send no Origin
// header and are unaffected by this policy.
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') {
    // Preflight with no Access-Control-Allow-Origin: browser blocks the request.
    return res.status(204).end();
  }
  const origin = req.headers['origin'];
  if (origin && origin !== ALLOWED_ORIGIN) {
    console.warn(`[CORS] Rejected cross-origin request from ${origin}`);
    return res.status(403).json({ error: 'cross-origin requests not permitted' });
  }
  next();
});

// ── Async job store ──
// A dense prompt (first LLM call + grounded validation + retry call) can run
// well past nginx's proxy_read_timeout, so the client never blocks on it. Instead
// /api/generate starts the work detached, returns a sessionId immediately (202),
// and the client polls /api/status/:id. Jobs live here only long enough to be
// collected; the DB remains the durable record of every session for the admin
// dashboard. A server restart mid-generation orphans the job — the client's poll
// then 404s and it surfaces a "please retry" message. That is the accepted
// degradation; we do not resume in-flight LLM calls across restarts.
const jobs = new Map(); // sessionId -> { status:'running'|'done'|'error', result?, error?, finishedAt? }
const JOB_TTL_MS = 10 * 60 * 1000;   // keep finished jobs pollable for 10 min
const JOB_SWEEP_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}, JOB_SWEEP_MS).unref();

// Map an internal generation error to the user-facing message + the structured
// status payload the client polls for.
function jobErrorMessage(err) {
  if (err.name === 'upstream_timeout') return 'Generation timed out. Please try again.';
  if (err.userMessage) return err.userMessage;
  return 'Internal server error during generation.';
}
function userError(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

// ── Generation pipeline (detached) ──
// Runs the full first-call → refusal-retry → grounded-validation → grounded-retry
// flow and returns the response payload. Throws on unrecoverable failure; the
// caller stores the outcome in the job store. No client request/response is in
// scope here — this runs after the 202 has already been sent.
async function runGeneration(sessionId, prompt, wrappedInput, startTime) {
  // Monotonic generation-attempt counter so every logged generation row has a
  // distinct attempt number (refusal retry + grounded retry can both fire).
  let genAttempt = 0;

  const response = await callOpenRouter([
    { role: 'system', content: prompt.content },
    { role: 'user', content: wrappedInput },
  ], sessionId, 'attempt 1');

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`OpenRouter error ${response.status}: ${errBody}`);
    throw userError('Generation service temporarily unavailable.');
  }

  let data = await response.json();
  let rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw userError('Empty response from generation model.');
  }

  // ── Silent refusal auto-retry ──
  // If the model returned a fluke refusal, log it (so it stays trackable in
  // the admin dashboard) and regenerate once with the identical request. The
  // retry is transparent: the user never sees the refusal.
  if (isLikelyRefusal(rawContent)) {
    console.warn(`[REFUSAL] ${sessionId}: silent refusal on attempt 1, regenerating once`);
    db.logGeneration(
      sessionId, ++genAttempt, rawContent, null, null,
      validate(rawContent), null, Date.now() - startTime,
      data.usage?.prompt_tokens ?? null, data.usage?.completion_tokens ?? null
    );

    const refusalRetry = await callOpenRouter([
      { role: 'system', content: prompt.content },
      { role: 'user', content: wrappedInput },
    ], sessionId, 'attempt 1 refusal-retry');

    if (refusalRetry.ok) {
      const refusalRetryData = await refusalRetry.json();
      const refusalRetryRaw = refusalRetryData.choices?.[0]?.message?.content;
      if (refusalRetryRaw) {
        data = refusalRetryData;
        rawContent = refusalRetryRaw;
      }
    } else {
      console.error(`[REFUSAL] ${sessionId}: refusal-retry API error ${refusalRetry.status}`);
    }
    // If the retry also refused or failed, fall through with the refusal text;
    // the heuristic validator flags it and the user can resubmit.
  }

  const { config, docs } = parseResponse(rawContent);
  const latencyMs = Date.now() - startTime;

  // Heuristic validation (unchanged)
  const validation = validate(rawContent);
  const configHash = config ? createHash('sha256').update(config).digest('hex') : null;

  db.logGeneration(
    sessionId, ++genAttempt, rawContent, config, docs, validation, configHash,
    latencyMs,
    data.usage?.prompt_tokens ?? null,
    data.usage?.completion_tokens ?? null
  );

  if (!validation.passed) {
    console.warn(`[VALIDATION] Session ${sessionId}: ${validation.errors.join('; ')}`);
  }
  if (validation.securityFlags.length) {
    console.warn(`[SECURITY] Session ${sessionId}: ${validation.securityFlags.join('; ')}`);
  }

  // Grounded validation against nixos.db
  let finalConfig = config;
  let finalDocs = docs;

  if (db.isValidationEnabled() && config) {
    let pkgResult, optResult;
    try {
      const packages = extractPackageReferences(config);
      const options = extractOptionReferences(config);
      pkgResult = db.validatePackages(packages);
      optResult = db.validateOptions(options);
      console.log(`[GROUNDED] ${sessionId}: pkgs=${packages.length} (${pkgResult.invalid.length} invalid) opts=${options.length} (${optResult.invalid.length} invalid)`);
    } catch (err) {
      console.error(`[GROUNDED] ${sessionId}: extraction error: ${err.message}`);
    }

    if (pkgResult && (pkgResult.invalid.length > 0 || optResult.invalid.length > 0)) {
      // Build retry prompt
      const retryLines = ['The previous generation referenced packages or options that do not exist in nixpkgs 25.11:'];
      if (pkgResult.invalid.length) retryLines.push(`- Invalid packages: ${pkgResult.invalid.join(', ')}`);
      if (optResult.invalid.length) retryLines.push(`- Invalid option paths: ${optResult.invalid.join(', ')}`);
      retryLines.push('', 'Regenerate the configuration using only real packages and options from nixpkgs 25.11. If you cannot fulfill a request because the required package does not exist, state that plainly in the documentation rather than inventing a name.');
      const retryMsg = retryLines.join('\n');

      let retryPkgResult = null, retryOptResult = null;
      let retryFailed = false;

      try {
        const retryStart = Date.now();
        const retryResponse = await callOpenRouter([
          { role: 'system', content: prompt.content },
          { role: 'user', content: wrappedInput },
          { role: 'assistant', content: rawContent },
          { role: 'user', content: retryMsg },
        ], sessionId, 'retry');

        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          const retryRaw = retryData.choices?.[0]?.message?.content;
          if (retryRaw) {
            const retryParsed = parseResponse(retryRaw);
            const retryValidation = validate(retryRaw);
            const retryHash = retryParsed.config ? createHash('sha256').update(retryParsed.config).digest('hex') : null;
            db.logGeneration(sessionId, ++genAttempt, retryRaw, retryParsed.config, retryParsed.docs, retryValidation, retryHash,
              Date.now() - retryStart, retryData.usage?.prompt_tokens, retryData.usage?.completion_tokens);

            if (retryParsed.config) {
              try {
                const rPkgs = extractPackageReferences(retryParsed.config);
                const rOpts = extractOptionReferences(retryParsed.config);
                retryPkgResult = db.validatePackages(rPkgs);
                retryOptResult = db.validateOptions(rOpts);
                console.log(`[GROUNDED] ${sessionId} retry: pkgs=${rPkgs.length} (${retryPkgResult.invalid.length} invalid) opts=${rOpts.length} (${retryOptResult.invalid.length} invalid)`);
              } catch (err) {
                console.error(`[GROUNDED] ${sessionId} retry extraction error: ${err.message}`);
              }
            }

            finalConfig = retryParsed.config || config;
            finalDocs = retryParsed.docs || docs;
          } else {
            retryFailed = true;
          }
        } else {
          retryFailed = true;
          console.error(`[GROUNDED] ${sessionId}: retry API error ${retryResponse.status}`);
        }
      } catch (err) {
        // A timeout on the grounded retry degrades gracefully: deliver the first
        // config with an unverified-references warning rather than failing the job.
        retryFailed = true;
        console.error(`[GROUNDED] ${sessionId}: retry failed: ${err.message}`);
      }

      const retryStillInvalid = retryFailed
        || (retryPkgResult !== null && (retryPkgResult.invalid.length > 0 || retryOptResult.invalid.length > 0));

      if (retryStillInvalid) {
        const warnPkgs = retryPkgResult?.invalid || pkgResult.invalid;
        const warnOpts = retryOptResult?.invalid || optResult.invalid;
        const warnLines = ['> **Validator notice.** This configuration references packages or options that could not be verified against the nixpkgs 25.11 database:', '>'];
        if (warnPkgs.length) warnLines.push(`> - Unverified packages: ${warnPkgs.join(', ')}`);
        if (warnOpts.length) warnLines.push(`> - Unverified option paths: ${warnOpts.join(', ')}`);
        warnLines.push('>', '> These may be valid under a different channel or result from recent nixpkgs changes, but they may also indicate model hallucination. Review carefully before building or deploying. Test in a VM first.');
        finalDocs = warnLines.join('\n') + '\n\n' + (finalDocs || '');
      }

      db.logValidationResult(sessionId, {
        firstValidPkgs: pkgResult.valid.length,
        firstInvalidPkgs: pkgResult.invalid.length,
        firstInvalidPkgNames: pkgResult.invalid.join(',') || null,
        firstValidOpts: optResult.valid.length,
        firstInvalidOpts: optResult.invalid.length,
        firstInvalidOptPaths: optResult.invalid.join(',') || null,
        retryAttempted: 1,
        retryStillInvalid: retryPkgResult !== null ? (retryStillInvalid ? 1 : 0) : (retryFailed ? 1 : null),
        retryInvalidPkgs: retryPkgResult?.invalid.join(',') || null,
        retryInvalidOpts: retryOptResult?.invalid.join(',') || null,
      });

    } else if (pkgResult) {
      db.logValidationResult(sessionId, {
        firstValidPkgs: pkgResult.valid.length,
        firstInvalidPkgs: 0,
        firstInvalidPkgNames: null,
        firstValidOpts: optResult.valid.length,
        firstInvalidOpts: 0,
        firstInvalidOptPaths: null,
        retryAttempted: 0,
        retryStillInvalid: null,
        retryInvalidPkgs: null,
        retryInvalidOpts: null,
      });
    }
  }

  return {
    config: finalConfig,
    docs: finalDocs,
    model: data.model || MODEL,
    usage: data.usage || null,
  };
}

// ── Generation endpoint (starts a detached job) ──
app.post('/api/generate', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!rateCheck(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
  }

  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: 'A system description is required.' });
  }

  const sanitized = sanitizeInput(description);
  if (!sanitized) {
    return res.status(400).json({ error: 'Input too long or contains invalid characters.' });
  }

  if (sanitized.flagged) {
    console.warn(`[FLAGGED] Suspicious input from ${clientIp}: ${sanitized.text.substring(0, 100)}...`);
  }

  // Session tracking
  const sessionId = randomUUID();
  const prompt = prompts.getLatest();
  const startTime = Date.now();

  db.createSession(sessionId, MODEL, prompt.version);
  db.logIntent(sessionId, description, sanitized.text, sanitized.flagged);

  const wrappedInput = `<user_intent>\n${sanitized.text}\n</user_intent>`;

  jobs.set(sessionId, { status: 'running' });
  runGeneration(sessionId, prompt, wrappedInput, startTime)
    .then(result => {
      jobs.set(sessionId, { status: 'done', result, finishedAt: Date.now() });
    })
    .catch(err => {
      if (err.name !== 'upstream_timeout' && !err.userMessage) {
        console.error(`Generation error ${sessionId}:`, err);
      }
      jobs.set(sessionId, { status: 'error', error: jobErrorMessage(err), finishedAt: Date.now() });
    });

  return res.status(202).json({ sessionId, status: 'running' });
});

// ── Status polling endpoint ──
app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ status: 'not_found', error: 'Unknown or expired session. Please generate again.' });
  }
  if (job.status === 'running') return res.json({ status: 'running' });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });
  return res.json({ status: 'done', ...job.result });
});

// ── Admin API ──
app.use('/api/admin', adminRouter);

// ── Static pages ──
app.get('/manifesto', (req, res) => {
  res.sendFile(join(__dirname, 'public/manifesto.html'));
});

app.get('/referrals', (req, res) => {
  res.sendFile(join(__dirname, 'public/referrals.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'public/admin.html'));
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  const prompt = prompts.getLatest();
  res.json({ status: 'ok', model: MODEL, promptVersion: prompt?.version });
});

// ── Start ──
prompts.init();
const prompt = prompts.getLatest();
db.init(prompt.version, prompt.content);
db.initValidationDb();

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Living Fractal running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Prompt: ${prompt.version}`);
  console.log(`Database: ${db.isEnabled() ? 'active' : 'disabled'}`);
});
