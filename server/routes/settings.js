import { Router } from 'express';
import { sb } from '../supabase.js';
import { config } from '../config.js';
import { requireAdmin } from '../middleware.js';

const router = Router();
router.use(requireAdmin);

// Lê todas as settings + preços/config do .env (para o painel exibir)
router.get('/', async (_req, res) => {
  try {
    const { data } = await sb().from('settings').select('*');
    const map = {};
    for (const row of data || []) map[row.key] = row.value;
    res.json({
      settings: map,
      prices: config.prices,
      testDurationHours: config.test.durationHours,
      panelUrl: config.test.panelUrl,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Atualiza um template/sett (key/value jsonb)
router.put('/:key', async (req, res) => {
  try {
    const { data, error } = await sb().from('settings')
      .upsert({ key: req.params.key, value: req.body.value })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
