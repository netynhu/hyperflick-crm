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

// Marca paga / reabre (status: pago | pendente)
router.patch('/:id', async (req, res) => {
  try {
    const upd = {};
    if ('status' in req.body) {
      upd.status = req.body.status;
      upd.paid_at = req.body.status === 'pago' ? new Date().toISOString() : null;
    }
    const { data, error } = await sb().from('expenses').update(upd).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Duplica a despesa para o próximo mês (mesmo dia, status pendente)
router.post('/:id/next', async (req, res) => {
  try {
    const { data: exp, error } = await sb().from('expenses').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const d = new Date((exp.date || new Date().toISOString().slice(0, 10)) + 'T12:00:00');
    d.setMonth(d.getMonth() + 1);
    const { data, error: e2 } = await sb().from('expenses').insert({
      description: exp.description, amount: exp.amount, category: exp.category,
      date: d.toISOString().slice(0, 10), status: 'pendente',
    }).select().single();
    if (e2) throw e2;
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
