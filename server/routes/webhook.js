import { Router } from 'express';
import { sb } from '../supabase.js';
import { hasSupabase } from '../supabase.js';
import { normalizePhone } from '../lib/helpers.js';
import { logMessage, sendWhatsApp } from '../lib/service.js';
import { getPayment } from '../lib/mercadopago.js';

const router = Router();

// Extrai telefone + texto de forma tolerante (o payload da uazapi pode variar)
function parseInbound(body) {
  const m = body?.message || body?.data || body?.messages?.[0] || body || {};
  const fromMe = m.fromMe ?? m.key?.fromMe ?? body?.fromMe ?? false;
  const rawJid =
    m.chatid || m.sender || m.from || m.number ||
    m.key?.remoteJid || m.remoteJid || body?.chatid || '';
  const phone = normalizePhone(String(rawJid).split('@')[0].split(':')[0]);
  const text =
    m.text || m.body || m.content || m.caption ||
    m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  const name = m.senderName || m.pushName || m.notifyName || null;
  const messageId = m.id || m.messageid || m.key?.id || null;
  return { fromMe, phone, text, name, messageId };
}

// POST /api/webhook/uazapi  — recebe mensagens de entrada
router.post('/uazapi', async (req, res) => {
  res.json({ ok: true }); // responde rápido; processa depois
  if (!hasSupabase()) return;
  try {
    const { fromMe, phone, text, name, messageId } = parseInbound(req.body);
    if (fromMe || !phone) return;

    // encontra o lead; se não existir, cria como novo lead vindo do WhatsApp
    let { data: lead } = await sb().from('leads').select('id,stage').eq('phone', phone).maybeSingle();
    if (!lead) {
      const { data } = await sb().from('leads').insert({
        name: name || `Contato ${phone.slice(-4)}`, phone, stage: 'lead', source: 'whatsapp',
      }).select('id,stage').single();
      lead = data;
    }
    await logMessage({ leadId: lead?.id, phone, direction: 'in', body: text, messageId });
  } catch (err) {
    console.error('webhook uazapi', err.message);
  }
});

// POST /api/webhook/mercadopago — confirmação de pagamento Pix
router.post('/mercadopago', async (req, res) => {
  res.json({ ok: true }); // responde rápido
  if (!hasSupabase()) return;
  try {
    const topic = req.body?.type || req.query.topic || req.query.type;
    const id = req.body?.data?.id || req.query['data.id'] || req.query.id || req.body?.id;
    if (!id || (topic && topic !== 'payment')) return;

    const pay = await getPayment(id);
    if (pay.status !== 'approved') return;

    const { data: payment } = await sb().from('payments').select('*').eq('mp_payment_id', String(id)).maybeSingle();
    const leadId = payment?.lead_id || pay.externalReference;
    if (payment) {
      await sb().from('payments').update({ status: 'pago', paid_at: new Date().toISOString() }).eq('id', payment.id);
    }
    if (leadId) {
      await sb().from('leads').update({ stage: 'ganho' }).eq('id', leadId);
      const { data: lead } = await sb().from('leads').select('name,phone').eq('id', leadId).maybeSingle();
      if (lead) {
        const nome = (lead.name || '').split(' ')[0];
        try {
          await sendWhatsApp({ leadId, phone: lead.phone, text: `Pagamento confirmado, ${nome}! 🎉🧡\nSeu acesso completo HyperFlick já está ativo. Bom divertimento! 📺` });
        } catch (e) { /* ignore */ }
      }
    }
  } catch (err) {
    console.error('webhook mercadopago', err.message);
  }
});

export default router;
