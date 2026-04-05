import { Router } from 'express';
import * as db from './db.js';
import * as prompts from './prompts.js';

export const router = Router();

// Bearer token auth middleware
router.use((req, res, next) => {
  const token = process.env.LF_ADMIN_TOKEN;
  if (!token) {
    return res.status(403).json({ error: 'Admin API not configured. Set LF_ADMIN_TOKEN.' });
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Invalid or missing admin token.' });
  }
  next();
});

// GET /api/admin/sessions?limit=50
router.get('/sessions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const sessions = db.getRecentSessions(limit);
  res.json({ sessions });
});

// GET /api/admin/sessions/:id
router.get('/sessions/:id', (req, res) => {
  const session = db.getSessionDetail(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  res.json({ session });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const stats = db.getStats();
  if (!stats) {
    return res.status(503).json({ error: 'Database not available.' });
  }
  res.json(stats);
});

// GET /api/admin/prompts
router.get('/prompts', (req, res) => {
  const versions = prompts.listVersions();
  const current = prompts.getLatest();
  res.json({ current: current?.version, versions });
});

// GET /api/admin/prompts/:version
router.get('/prompts/:version', (req, res) => {
  const prompt = prompts.getVersion(req.params.version);
  if (!prompt) {
    return res.status(404).json({ error: 'Prompt version not found.' });
  }
  res.json(prompt);
});

// POST /api/admin/prompts/reload
router.post('/prompts/reload', (req, res) => {
  const current = prompts.reload();
  if (current) {
    db.registerPromptVersion(current.version, current.content);
  }
  res.json({ reloaded: true, current: current?.version });
});
