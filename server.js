import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';

import * as prompts from './src/prompts.js';
import * as db from './src/db.js';
import { validate } from './src/validator.js';
import { router as adminRouter } from './src/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Config ──
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.LF_MODEL || 'deepseek/deepseek-chat-v3-0324';
const PORT = process.env.LF_PORT || 3120;

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

  // Session tracking
  const sessionId = randomUUID();
  const prompt = prompts.getLatest();
  const startTime = Date.now();

  db.createSession(sessionId, MODEL, prompt.version);
  db.logIntent(sessionId, description, sanitized.text, sanitized.flagged);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://livingfractal.com',
        'X-Title': 'Living Fractal',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: prompt.content },
          { role: 'user', content: sanitized.text },
        ],
        temperature: 0.3,
        max_tokens: 8000,
      }),
    });

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

    // Validate and log
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

    return res.json({
      config,
      docs,
      model: data.model || MODEL,
      usage: data.usage || null,
    });

  } catch (err) {
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

// ── Health check ──
app.get('/api/health', (req, res) => {
  const prompt = prompts.getLatest();
  res.json({ status: 'ok', model: MODEL, promptVersion: prompt?.version });
});

// ── Start ──
prompts.init();
const prompt = prompts.getLatest();
db.init(prompt.version, prompt.content);

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Living Fractal running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Prompt: ${prompt.version}`);
  console.log(`Database: ${db.isEnabled() ? 'active' : 'disabled'}`);
});
