import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { config } from '../config.js';
import { planMonthly, normalizePhone } from '../lib/helpers.js';
import { createPixPayment } from '../lib/mercadopago.js';
import { sendWhatsApp, notifyAdmin, sendPixMessage, addPaidAppExpenseIfNeeded } from '../lib/service.js';

const router = Router();
router.use(requireAdmin);

// Lista cobranças com dados do lead. Opcional ?status=
router.get('/', async (req, res) => {
  try {
    let q = sb().from('payments')
      .select('*, lead:leads(id,name,phone,plan,stage)')
      .order('due_date', { ascending: true });
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.from) q = q.gte('due_date', req.query.from);
    if (req.query.to) q = q.lte('due_date', req.query.to);
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

// Adiciona cliente + cobrança manualmente (nome, telefone, valor, vencimento)
router.post('/manual', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Informe o nome do cliente.' });
    const amount = Number(b.amount);
    if (!amount) return res.status(400).json({ error: 'Informe o valor.' });
    const phone = b.phone ? normalizePhone(b.phone) : null;

    // Cobrança manual NÃO entra no funil do CRM: o caminho é sempre CRM → cobrança,
    // nunca o contrário. Reaproveita lead pelo telefone só pra vincular a cobrança;
    // se não existir, cria um registro avulso marcado como manual (oculto do board).
    let lead = null;
    if (phone) {
      const { data: ex } = await sb().from('leads').select('*').eq('phone', phone).maybeSingle();
      lead = ex;
    }
    if (!lead) {
      const { data } = await sb().from('leads').insert({
        name, phone: phone || `manual-${Date.now()}`, plan: b.plan || null,
        stage: 'ganho', source: 'manual',
      }).select().single();
      lead = data;
    } else {
      // lead já existe no CRM: apenas atualiza dados básicos, sem mexer na etapa do funil
      await sb().from('leads').update({ name, plan: b.plan || lead.plan }).eq('id', lead.id);
    }

    const { data: payment, error } = await sb().from('payments').insert({
      lead_id: lead.id, plan: b.plan || null, amount, status: 'pendente', method: b.method || null,
      due_date: b.due_date || new Date().toISOString().slice(0, 10), notes: b.notes || null,
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, lead_id: lead.id, payment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Gera Pix (Mercado Pago) para ESTA cobrança e envia no WhatsApp do cliente
router.post('/:id/pix', async (req, res) => {
  try {
    const { data: payment, error } = await sb().from('payments')
      .select('*, lead:leads(id,name,phone,plan)').eq('id', req.params.id).single();
    if (error) throw error;
    const lead = payment.lead;
    if (!lead) return res.status(400).json({ error: 'Cobrança sem cliente vinculado.' });

    const pix = await createPixPayment({
      amount: payment.amount,
      description: `HyperFlick - ${payment.plan || 'Mensalidade'}`,
      payerName: lead.name,
      payerEmail: `c${lead.phone}@hyperflick.app`,
      externalReference: lead.id,
      notificationUrl: `${config.publicUrl}/api/webhook/mercadopago`,
    });
    await sb().from('payments').update({
      method: 'pix', mp_payment_id: String(pix.id), pix_code: pix.pixCode,
      pix_ticket_url: pix.ticketUrl, last_charged_at: new Date().toISOString(),
    }).eq('id', payment.id);

    const nome = (lead.name || '').split(' ')[0];
    const venc = payment.due_date ? new Date(payment.due_date + 'T12:00:00').toLocaleDateString('pt-BR') : '';
    let whatsappSent = false;
    try {
      await sendPixMessage({ leadId: lead.id, phone: lead.phone, intro: `${nome}, segue o Pix da sua mensalidade HyperFlick 🧡${venc ? ` (vencimento ${venc})` : ''}`, plan: payment.plan, amount: payment.amount, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl });
      whatsappSent = true;
    } catch (e) { /* ignore */ }

    res.json({ ok: true, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl, whatsappSent });
  } catch (err) {
    res.status(err.code === 'NO_MP' ? 400 : 500).json({ error: err.message });
  }
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
    // avisa o admin quando uma cobrança é marcada como paga manualmente
    if (upd.status === 'pago' && data.lead_id) {
      const { data: lead } = await sb().from('leads').select('name,test_username,app').eq('id', data.lead_id).maybeSingle();
      const valor = Number(data.amount || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      const usuario = lead?.test_username ? `\nUsuário: ${lead.test_username}` : '';
      await notifyAdmin(`💰 NOVA VENDA HyperFlick\nCliente: ${lead?.name || '-'}${usuario}\nPlano: ${data.plan || '-'}\nValor: R$ ${valor}`);
      // 6 meses+ com app pago → lança o custo do app (R$ 20) nas despesas
      if (lead) await addPaidAppExpenseIfNeeded({ lead, plan: data.plan });
    }
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
    // Funil só conta leads do CRM (exclui clientes de cobrança manual).
    const { data: leads } = await sb().from('leads').select('stage,plan,source').neq('source', 'manual');
    const { data: expenses } = await sb().from('expenses').select('amount');

    const fin = { recebido: 0, pendente: 0, atrasado: 0, pagos: 0, emAberto: 0 };
    for (const p of payments || []) {
      const amt = Number(p.amount) || 0;
      if (p.status === 'pago') { fin.recebido += amt; fin.pagos++; }
      else if (p.status === 'atrasado') { fin.atrasado += amt; fin.emAberto++; }
      else if (p.status === 'pendente') { fin.pendente += amt; fin.emAberto++; }
    }
    const despesas = (expenses || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    fin.despesas = Math.round(despesas * 100) / 100;
    fin.lucro = Math.round((fin.recebido - despesas) * 100) / 100;

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

// Relatório de um período (mês). ?month=YYYY-MM  → receita, despesas, sobra
router.get('/reports/monthly', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
    const start = `${month}-01`;
    const endD = new Date(start); endD.setMonth(endD.getMonth() + 1);
    const end = endD.toISOString().slice(0, 10);

    // receita = pagamentos PAGOS no mês (paid_at)
    const { data: pays } = await sb().from('payments').select('amount,status,paid_at,plan')
      .eq('status', 'pago').gte('paid_at', start).lt('paid_at', end);
    const receita = (pays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const { data: exps } = await sb().from('expenses').select('amount,category,description,date')
      .gte('date', start).lt('date', end);
    const despesas = (exps || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);

    // despesas por categoria
    const porCategoria = {};
    for (const e of exps || []) {
      const c = e.category || 'Outros';
      porCategoria[c] = (porCategoria[c] || 0) + (Number(e.amount) || 0);
    }

    res.json({
      month,
      receita: Math.round(receita * 100) / 100,
      despesas: Math.round(despesas * 100) / 100,
      sobra: Math.round((receita - despesas) * 100) / 100,
      qtdPagamentos: (pays || []).length,
      qtdDespesas: (exps || []).length,
      porCategoria,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
