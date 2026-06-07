import { Router } from 'express';
import { sb } from '../supabase.js';
import { hasSupabase } from '../supabase.js';
import { normalizePhone, planMonths } from '../lib/helpers.js';
import { logMessage, sendWhatsApp } from '../lib/service.js';
import { getPayment } from '../lib/mercadopago.js';
import { deliverPixToLead } from '../lib/followup.js';

const router = Router();

// Detecta intenção de compra na mensagem do cliente
function isBuyIntent(t) {
  const s = (t || '').toLowerCase();
  return /(quero comprar|comprar|quero assinar|assinar|assinatura|quero pagar|pagar|como pago|como assino|como faço pra assinar|adquirir|renovar|me manda o pix|manda o pix|quero o pix|quero pix|gerar pix|quero o plano|vou querer|quero sim|fechar)/.test(s);
}

// Extrai telefone + texto de forma tolerante (o payload da uazapi pode variar)
function parseInbound(body) {
  const m = body?.message || body?.data || body?.messages?.[0] || body || {};
  const fromMe = m.fromMe ?? m.key?.fromMe ?? body?.fromMe ?? false;
  const rawJid =
    m.chatid || m.sender || m.from || m.number ||
    m.key?.remoteJid || m.remoteJid || body?.chatid || '';
  const phone = normalizePhone(String(rawJid).split('@')[0].split(':')[0]);
  const text =
    m.text || m.body || m.content?.text || m.caption ||
    (typeof m.content === 'string' ? m.content : '') ||
    m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  const name = m.senderName || m.pushName || m.notifyName || null;
  const messageId = m.id || m.messageid || m.key?.id || null;
  return { fromMe, phone, text, name, messageId };
}

// POST /api/webhook/uazapi  — recebe mensagens de entrada
// IMPORTANTE: na Vercel (serverless) o processamento precisa terminar ANTES de
// responder, senão a função congela e nada é salvo. Por isso: processa → responde.
router.post('/uazapi', async (req, res) => {
  try {
    if (hasSupabase()) {
      const { fromMe, phone, text, name, messageId } = parseInbound(req.body);
      if (!fromMe && phone) {
        // encontra o lead; se não existir, cria como novo lead vindo do WhatsApp
        let { data: lead } = await sb().from('leads').select('id,stage,name,phone,plan').eq('phone', phone).maybeSingle();
        if (!lead) {
          const { data } = await sb().from('leads').insert({
            name: name || `Contato ${phone.slice(-4)}`, phone, stage: 'lead', source: 'whatsapp',
          }).select('id,stage,name,phone,plan').single();
          lead = data;
        }
        await logMessage({ leadId: lead?.id, phone, direction: 'in', body: text, messageId });

        // Gatilho de compra: cliente demonstrou intenção → dispara o Pix
        if (lead && isBuyIntent(text)) {
          try {
            const nome = (lead.name || '').split(' ')[0];
            await deliverPixToLead(lead, `${nome}, show! 🧡 Bora liberar seu acesso completo da HyperFlick. Aqui está seu Pix:`);
            if (lead.stage === 'lead' || lead.stage === 'testando') {
              await sb().from('leads').update({ stage: 'followup' }).eq('id', lead.id);
            }
          } catch (e) { console.error('buy-intent pix', e.message); }
        }
      }
    }
  } catch (err) {
    console.error('webhook uazapi', err.message);
  }
  res.json({ ok: true });
});

// POST /api/webhook/mercadopago — confirmação de pagamento Pix
// (processa → responde, por causa do serverless da Vercel)
router.post('/mercadopago', async (req, res) => {
  try {
    if (hasSupabase()) {
      const topic = req.body?.type || req.query.topic || req.query.type;
      const id = req.body?.data?.id || req.query['data.id'] || req.query.id || req.body?.id;
      if (id && (!topic || topic === 'payment')) {
        const pay = await getPayment(id);
        if (pay.status === 'approved') {
          const { data: payment } = await sb().from('payments').select('*').eq('mp_payment_id', String(id)).maybeSingle();
          if (!(payment && payment.status === 'pago')) { // idempotente
            const leadId = payment?.lead_id || pay.externalReference;
            if (payment) {
              await sb().from('payments').update({ status: 'pago', paid_at: new Date().toISOString() }).eq('id', payment.id);
              const months = planMonths(payment.plan) || 1;
              const next = new Date((payment.due_date || new Date().toISOString().slice(0, 10)) + 'T12:00:00');
              next.setMonth(next.getMonth() + months);
              await sb().from('payments').insert({
                lead_id: payment.lead_id, plan: payment.plan, amount: payment.amount,
                status: 'pendente', due_date: next.toISOString().slice(0, 10),
                period_start: new Date().toISOString().slice(0, 10), period_end: next.toISOString().slice(0, 10),
              });
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
          }
        }
      }
    }
  } catch (err) {
    console.error('webhook mercadopago', err.message);
  }
  res.json({ ok: true });
});

export default router;
