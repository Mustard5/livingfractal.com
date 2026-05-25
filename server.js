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
const OPENROUTER_TIMEOUT_MS = 150_000; // 150s — keep below NGINX's 180s proxy_read_timeout

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

// ── OpenRouter call with hard timeout ──
// externalSignal: optional AbortSignal from the request lifecycle. Abort
// is forwarded via addEventListener/removeEventListener rather than
// AbortSignal.any() — the any() approach leaves a listener on externalSignal
// after the fetch settles, causing a DOMException [AbortError] in Node.js 22
// when the signal fires post-response (e.g. client closes after receiving data).
async function callOpenRouter(messages, sessionId, label, externalSignal) {
  const controller = new AbortController();

  const onExternalAbort = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });

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
      if (externalSignal?.aborted) {
        console.log(`[DISCONNECT] ${sessionId} ${label}: aborted — client disconnected`);
        const e = new Error('client_disconnected');
        e.name = 'client_disconnected';
        throw e;
      }
      console.error(`[TIMEOUT] ${sessionId} ${label}: timed out after ${OPENROUTER_TIMEOUT_MS}ms`);
      const e = new Error('upstream_timeout');
      e.name = 'upstream_timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
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

// ── Generation endpoint ──
app.post('/api/generate', async (req, res) => {
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

  // Abort signal shared across both OpenRouter calls in this request. Fired on
  // client disconnect so in-flight LLM calls are cancelled immediately rather
  // than running to completion and discarding their results.
  // Use res.on('close') not req.on('close') — nginx half-closes the upstream
  // connection after sending the proxied request body, which fires req.close
  // immediately and falsely on every request. res.close fires only when the
  // browser actually drops the connection (nginx propagates client abort).
  const reqAborter = new AbortController();
  res.on('close', () => { if (!res.writableEnded) reqAborter.abort(); });

  // Session tracking
  const sessionId = randomUUID();
  const prompt = prompts.getLatest();
  const startTime = Date.now();

  db.createSession(sessionId, MODEL, prompt.version);
  db.logIntent(sessionId, description, sanitized.text, sanitized.flagged);

  const wrappedInput = `<user_intent>\n${sanitized.text}\n</user_intent>`;

  try {
    const response = await callOpenRouter([
      { role: 'system', content: prompt.content },
      { role: 'user', content: wrappedInput },
    ], sessionId, 'attempt 1', reqAborter.signal);

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`OpenRouter error ${response.status}: ${errBody}`);
      return res.status(502).json({ error: 'Generation service temporarily unavailable.' });
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(502).json({ error: 'Empty response from generation model.' });
    }

    const { config, docs } = parseResponse(rawContent);
    const latencyMs = Date.now() - startTime;

    // Heuristic validation (unchanged)
    const validation = validate(rawContent);
    const configHash = config ? createHash('sha256').update(config).digest('hex') : null;

    db.logGeneration(
      sessionId, 1, rawContent, config, docs, validation, configHash,
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
          ], sessionId, 'retry', reqAborter.signal);

          if (retryResponse.ok) {
            const retryData = await retryResponse.json();
            const retryRaw = retryData.choices?.[0]?.message?.content;
            if (retryRaw) {
              const retryParsed = parseResponse(retryRaw);
              const retryValidation = validate(retryRaw);
              const retryHash = retryParsed.config ? createHash('sha256').update(retryParsed.config).digest('hex') : null;
              db.logGeneration(sessionId, 2, retryRaw, retryParsed.config, retryParsed.docs, retryValidation, retryHash,
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
          if (err.name === 'client_disconnected') throw err;
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

    return res.json({
      config: finalConfig,
      docs: finalDocs,
      model: data.model || MODEL,
      usage: data.usage || null,
    });

  } catch (err) {
    if (err.name === 'client_disconnected') {
      // callOpenRouter already logged the abort. Session exists in DB with no
      // generation record — identifiable in the admin dashboard as a disconnect.
      console.log(`[DISCONNECT] ${sessionId}: handler exiting — no response written`);
      return;
    }
    if (err.name === 'upstream_timeout') {
      return res.status(504).json({ error: 'Generation timed out. Please try again.' });
    }
    console.error('Generation error:', err);
    return res.status(500).json({ error: 'Internal server error during generation.' });
  }
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
