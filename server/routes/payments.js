import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { planMonthly } from '../lib/helpers.js';

const router = Router();
router.use(requireAdmin);

// Lista cobranças com dados do lead. Opcional ?status=
router.get('/', async (req, res) => {
  try {
    let q = sb().from('payments')
      .select('*, lead:leads(id,name,phone,plan,stage)')
      .order('due_date', { ascending: true });
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;

    // marca como atrasado os pendentes vencidos (em memória, e persiste)
    const today = new Date().toISOString().slice(0, 10);
    for (const p of data) {
      if (p.status === 'pendente' && p.due_date && p.due_date < today) {
        p.status = 'atrasado';
        await sb().from('payments').update({ status: 'atrasado' }).eq('id', p.id);
      }
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { data, error } = await sb().from('payments').insert(req.body).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Marcar pago / atualizar
router.patch('/:id', async (req, res) => {
  try {
    const allow = ['status', 'method', 'amount', 'due_date', 'paid_at', 'notes', 'plan'];
    const upd = {};
    for (const k of allow) if (k in req.body) upd[k] = req.body[k];
    if (upd.status === 'pago' && !upd.paid_at) upd.paid_at = new Date().toISOString();
    const { data, error } = await sb().from('payments').update(upd).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await sb().from('payments').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resumo / dashboard financeiro + funil
router.get('/summary/all', async (_req, res) => {
  try {
    const { data: payments } = await sb().from('payments').select('amount,status');
    const { data: leads } = await sb().from('leads').select('stage,plan');

    const today = new Date().toISOString().slice(0, 10);
    const fin = { recebido: 0, pendente: 0, atrasado: 0, pagos: 0, emAberto: 0 };
    for (const p of payments || []) {
      const amt = Number(p.amount) || 0;
      if (p.status === 'pago') { fin.recebido += amt; fin.pagos++; }
      else if (p.status === 'atrasado') { fin.atrasado += amt; fin.emAberto++; }
      else if (p.status === 'pendente') { fin.pendente += amt; fin.emAberto++; }
    }

    const stages = { lead: 0, testando: 0, ganho: 0, perdido: 0, followup: 0 };
    let mrr = 0;
    for (const l of leads || []) {
      if (stages[l.stage] !== undefined) stages[l.stage]++;
      if (l.stage === 'ganho') mrr += planMonthly(l.plan);
    }

    const totalLeads = (leads || []).length;
    const conversao = totalLeads ? (stages.ganho / totalLeads) * 100 : 0;

    res.json({ financeiro: fin, funil: stages, mrr: Math.round(mrr * 100) / 100, conversao: Math.round(conversao * 10) / 10, totalLeads });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
