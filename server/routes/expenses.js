import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    let q = sb().from('expenses').select('*').order('date', { ascending: false });
    if (req.query.from) q = q.gte('date', req.query.from);
    if (req.query.to) q = q.lte('date', req.query.to);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.description || !b.amount) return res.status(400).json({ error: 'Descrição e valor são obrigatórios.' });
    const { data, error } = await sb().from('expenses').insert({
      description: b.description,
      amount: Number(b.amount),
      category: b.category || null,
      date: b.date || new Date().toISOString().slice(0, 10),
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await sb().from('expenses').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
