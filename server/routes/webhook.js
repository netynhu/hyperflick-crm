import { Router } from 'express';
import { sb } from '../supabase.js';
import { hasSupabase } from '../supabase.js';
import { normalizePhone, phoneVariants } from '../lib/helpers.js';
import { logMessage } from '../lib/service.js';
import { getPayment } from '../lib/mercadopago.js';
import { deliverPixToLead, sendMonthlyPix } from '../lib/followup.js';
import { applyApprovedPayment } from '../lib/billing.js';

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
    m.message?.conversation || m.message?.extendedTextMessage?.text ||
    // resposta de botão/lista (clique em "Quero pagar agora"): o texto
    // escolhido pode vir nesses campos, dependendo do tipo da mensagem
    m.buttonOrListid || m.content?.buttonOrListid ||
    m.message?.buttonsResponseMessage?.selectedDisplayText ||
    m.message?.templateButtonReplyMessage?.selectedDisplayText ||
    m.message?.listResponseMessage?.title || '';
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
        // Só processa mensagens de quem JÁ é lead (veio do quiz/funil ou de um disparo).
        // Conversas avulsas do WhatsApp (número desconhecido) NÃO entram no CRM.
        // Busca por VARIANTES do telefone: o JID do WhatsApp pode vir sem o
        // nono dígito, enquanto o lead foi salvo com ele (e vice-versa).
        const { data: lead } = await sb().from('leads').select('id,stage,name,phone,plan')
          .in('phone', phoneVariants(phone)).limit(1).maybeSingle();
        if (lead) {
          await logMessage({ leadId: lead.id, phone, direction: 'in', body: text, messageId });

          // Gatilho de compra: cliente demonstrou intenção (ou clicou "Quero pagar agora")
          if (isBuyIntent(text)) {
          try {
            if (lead.stage === 'ganho') {
              // cliente existente: clicou no botão da cobrança mensal → manda o Pix da cobrança em aberto
              await sendMonthlyPix(lead);
            } else {
              const nome = (lead.name || '').split(' ')[0];
              await deliverPixToLead(lead, `${nome}, show! 🧡 Bora liberar seu acesso completo da HyperFlick. Aqui está seu Pix:`);
              if (lead.stage === 'lead' || lead.stage === 'testando') {
                await sb().from('leads').update({ stage: 'followup' }).eq('id', lead.id);
              }
            }
          } catch (e) { console.error('buy-intent pix', e.message); }
          }
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
          // Marca pago + agenda próxima mensalidade + ativa o cliente + avisos
          // (lógica compartilhada com a conciliação do cron em lib/billing.js)
          const r = await applyApprovedPayment({ payment, leadId: pay.externalReference });
          if (r.duplicate) { res.json({ ok: true, duplicate: true }); return; }
        }
      }
    }
  } catch (err) {
    console.error('webhook mercadopago', err.message);
  }
  res.json({ ok: true });
});

export default router;
