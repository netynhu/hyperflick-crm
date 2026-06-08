import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { normalizePhone, planPrice, planMonths } from '../lib/helpers.js';
import { generateTestForLead, sendWhatsApp, sendPixMessage } from '../lib/service.js';
import { sendPixForLead, deliverPixToLead } from '../lib/followup.js';

const router = Router();

// ============================================================
// PÚBLICO — captura do funil
// POST /api/leads  { name, phone, plan, device, brand, app, quiz, generateTest }
// ============================================================
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = normalizePhone(b.phone);
    if (name.length < 2) return res.status(400).json({ error: 'Nome inválido.' });
    if (phone.length < 12) return res.status(400).json({ error: 'WhatsApp inválido.' });

    const payload = {
      name, phone,
      plan: b.plan || null,
      device: b.device || null,
      brand: b.brand && b.brand !== '_' ? b.brand : null,
      app: b.app || null,
      quiz: b.quiz || {},
      source: b.source || 'funil',
      stage: 'lead',
    };

    // upsert por telefone (não duplica lead que voltou)
    const { data: existing } = await sb().from('leads').select('*').eq('phone', phone).maybeSingle();

    // Número já cadastrado E que JÁ recebeu teste → não gera outro: avisa e manda comprar.
    // (Só quando há intenção de gerar teste; atualização de plano com generateTest:false não dispara isso.)
    if (existing && existing.test_username && b.generateTest !== false) {
      const { data: lead } = await sb().from('leads')
        .update({ name, plan: payload.plan || existing.plan, app: payload.app || existing.app })
        .eq('id', existing.id).select().single();
      const nome = name.split(' ')[0];
      let whatsappSent = false;
      try {
        await deliverPixToLead(lead, `${nome}, vi que você já testou a HyperFlick! 🧡 Que tal liberar seu acesso completo agora? Aqui está seu Pix:`);
        whatsappSent = true;
      } catch (e) {
        console.error('alreadyRegistered pix:', e.message);
        try {
          await sendWhatsApp({ leadId: lead.id, phone, text: `${nome}, vi que você já testou a HyperFlick! 🧡 Quer liberar seu acesso completo? Me chama aqui que te passo como assinar.` });
          whatsappSent = true;
        } catch (_) { /* sem instância */ }
      }
      return res.json({ ok: true, id: lead.id, alreadyRegistered: true, test: { whatsappSent } });
    }

    let lead;
    if (existing) {
      const { data } = await sb().from('leads')
        .update({ name, plan: payload.plan, device: payload.device, brand: payload.brand, app: payload.app, quiz: payload.quiz })
        .eq('id', existing.id).select().single();
      lead = data;
    } else {
      const { data, error } = await sb().from('leads').insert(payload).select().single();
      if (error) throw error;
      lead = data;
    }

    // Gera o teste e envia no WhatsApp. NÃO retorna credenciais ao front
    // (elas vão apenas para o WhatsApp do cliente).
    let test = null;
    if (b.generateTest !== false) {
      try {
        const r = await generateTestForLead(lead);
        test = { whatsappSent: r.whatsappSent };
      } catch (e) {
        console.error('generateTest (funil):', e.message);
        test = { whatsappSent: false, pending: true };
      }
    }

    res.json({ ok: true, id: lead.id, test });
  } catch (err) {
    console.error('POST /api/leads', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// A partir daqui: protegido (CRM)
// ============================================================
router.use(requireAdmin);

// Lista (board). Opcional ?stage=
router.get('/', async (req, res) => {
  try {
    let q = sb().from('leads').select('*').order('updated_at', { ascending: false });
    if (req.query.stage) q = q.eq('stage', req.query.stage);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Detalhe + mensagens + pagamentos
router.get('/:id', async (req, res) => {
  try {
    const { data: lead, error } = await sb().from('leads').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const { data: messages } = await sb().from('messages').select('*')
      .eq('lead_id', lead.id).order('created_at', { ascending: true });
    const { data: payments } = await sb().from('payments').select('*')
      .eq('lead_id', lead.id).order('created_at', { ascending: false });
    res.json({ ...lead, messages: messages || [], payments: payments || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Atualiza (stage, notes, lost_reason, plan...)
router.patch('/:id', async (req, res) => {
  try {
    const allow = ['stage', 'notes', 'lost_reason', 'plan', 'name'];
    const upd = {};
    for (const k of allow) if (k in req.body) upd[k] = req.body[k];
    const { data, error } = await sb().from('leads').update(upd).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await sb().from('leads').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// (Re)gerar teste e enviar no WhatsApp
router.post('/:id/test', async (req, res) => {
  try {
    const { data: lead, error } = await sb().from('leads').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const r = await generateTestForLead(lead);
    res.json({
      ok: true,
      username: r.credentials.username,
      password: r.credentials.password,
      expiresAt: r.expires,
      whatsappSent: r.whatsappSent,
      whatsappError: r.error,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enviar mensagem manual
router.post('/:id/message', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });
    const { data: lead, error } = await sb().from('leads').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text });
    res.json({ ok: true });
  } catch (err) { res.status(err.code === 'NO_INSTANCE' ? 409 : 500).json({ error: err.message }); }
});

// Gerar Pix (Mercado Pago) e enviar no WhatsApp
router.post('/:id/pix', async (req, res) => {
  try {
    const { data: lead, error } = await sb().from('leads').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const { plan, amount, pix } = await sendPixForLead(lead);
    const nome = (lead.name || '').split(' ')[0];
    await sendPixMessage({ leadId: lead.id, phone: lead.phone, intro: `${nome}, aqui está o Pix do seu acesso completo na HyperFlick 🧡`, plan, amount, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl });
    res.json({ ok: true, plan, amount, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl });
  } catch (e) {
    const code = e.code === 'NO_MP' ? 400 : (e.code === 'NO_INSTANCE' ? 409 : 500);
    res.status(code).json({ error: e.message });
  }
});

// Marcar como GANHO → cria cobrança pendente do plano
router.post('/:id/won', async (req, res) => {
  try {
    const { data: lead, error } = await sb().from('leads').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const plan = req.body?.plan || lead.plan || 'mensal';
    await sb().from('leads').update({ stage: 'ganho', plan }).eq('id', lead.id);

    const now = new Date();
    const end = new Date(now); end.setMonth(end.getMonth() + planMonths(plan));
    const { data: payment } = await sb().from('payments').insert({
      lead_id: lead.id,
      plan,
      amount: planPrice(plan),
      status: 'pendente',
      due_date: now.toISOString().slice(0, 10),
      period_start: now.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
    }).select().single();

    res.json({ ok: true, payment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
