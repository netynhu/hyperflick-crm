import { Router } from 'express';
import { config } from '../config.js';
import { runFollowups, runBilling } from '../lib/followup.js';
import { reconcilePendingPix } from '../lib/billing.js';
import { processBroadcasts } from '../lib/broadcast.js';

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
    const followups = await runFollowups();
    const billing = await runBilling();
    // Conciliação: Pix gerados e ainda pendentes → consulta o Mercado Pago.
    // Se o pagamento aprovou e o webhook do MP não chegou, renova aqui mesmo.
    let payments = { checked: 0, actions: [] };
    try { payments = await reconcilePendingPix(); } catch (e) { payments = { error: e.message }; }
    // Disparos em massa agendados: envia um lote por execução.
    let broadcasts = { processed: 0, actions: [] };
    try { broadcasts = await processBroadcasts(); } catch (e) { broadcasts = { error: e.message }; }
    res.json({ ok: true, followups, billing, payments, broadcasts });
  } catch (e) {
    console.error('cron/followup', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET/POST /api/cron/broadcast?token=...  — só a fila de disparos em massa.
// Aponte um cron mais frequente (ex.: a cada 1 min) pra cá quando tiver
// disparos grandes; cada chamada envia um lote e retorna.
router.all('/broadcast', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Não autorizado.' });
  try {
    const r = await processBroadcasts();
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('cron/broadcast', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
