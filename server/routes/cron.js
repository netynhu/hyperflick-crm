import { Router } from 'express';
import { config } from '../config.js';
import { runFollowups } from '../lib/followup.js';

const router = Router();

function authed(req) {
  if (!config.cronSecret) return true; // sem segredo = liberado (dev)
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return bearer === config.cronSecret || req.query.token === config.cronSecret;
}

// GET/POST /api/cron/followup?token=...  (chamado pelo cron externo ou Vercel)
router.all('/followup', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Não autorizado.' });
  try {
    const r = await runFollowups();
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('cron/followup', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
