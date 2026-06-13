import { Router } from 'express';
import { sb } from '../supabase.js';
import { hasSupabase } from '../supabase.js';
import { normalizePhone, phoneVariants, isBuyIntent } from '../lib/helpers.js';
import { logMessage } from '../lib/service.js';
import { getPayment } from '../lib/mercadopago.js';
import { sendMonthlyPix } from '../lib/followup.js';
import { applyApprovedPayment } from '../lib/billing.js';
import { getWaQuizSettings, quizTriggerMatch, isQuizActive, startWaQuiz, enterQuiz, offerPlans, handleQuizReply } from '../lib/waquiz.js';
import { sendWhatsApp } from '../lib/service.js';

const router = Router();

// Pedido de descadastro (opt-out): "parar", "sair", "pare", "não quero"...
const isOptOut = (t) => /^\s*(parar|pare|sair|stop|cancelar|remover|descadastrar|n[aã]o quero( mais)?( receber)?)\s*[.!]*\s*$/i.test(t || '');

// Marca opt-out na base de contatos e confirma. Retorna true se tratou.
async function handleOptOut(phone, text) {
  if (!isOptOut(text)) return false;
  try {
    const { data: c } = await sb().from('contacts').select('id,opt_out')
      .in('phone', phoneVariants(phone)).limit(1).maybeSingle();
    if (c && !c.opt_out) await sb().from('contacts').update({ opt_out: true }).eq('id', c.id);
    if (!c) {
      // não estava na base: registra já como opt-out pra nunca ser disparado
      await sb().from('contacts').insert({ phone: normalizePhone(phone), opt_out: true, source: 'opt-out' });
    }
  } catch (e) { /* tabela contacts ausente — rode o schema.sql */ }
  try {
    await sendWhatsApp({ leadId: null, phone, text: 'Tudo bem! Você não vai mais receber nossas mensagens. 🧡 Se mudar de ideia, é só mandar um oi.' });
  } catch (e) { /* sem instância */ }
  return true;
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
        // Busca por VARIANTES do telefone: o JID do WhatsApp pode vir sem o
        // nono dígito, enquanto o lead foi salvo com ele (e vice-versa).
        const { data: lead } = await sb().from('leads').select('*')
          .in('phone', phoneVariants(phone)).limit(1).maybeSingle();
        const qs = await getWaQuizSettings();
        if (lead) {
          await logMessage({ leadId: lead.id, phone, direction: 'in', body: text, messageId });
          // "PARAR"/"SAIR" → marca opt-out na base e confirma (antes de qualquer robô)
          if (await handleOptOut(phone, text)) { res.json({ ok: true }); return; }
          let consumed = false;
          const buy = isBuyIntent(text);

          if (lead.stage === 'ganho') {
            // Cliente ativo: clicou "Quero pagar agora" da cobrança mensal → manda o Pix em aberto.
            if (buy) { try { await sendMonthlyPix(lead); } catch (e) { console.error('monthly pix', e.message); } consumed = true; }
          } else if (qs.enabled && quizTriggerMatch(text, qs.trigger)) {
            // Frase-gatilho de novo (anúncio/funil web) → (re)inicia o quiz.
            consumed = (await enterQuiz(lead)).handled;
          } else if (isQuizActive(lead.wa_quiz_state)) {
            // No meio do quiz → a resposta é consumida pelo fluxo.
            consumed = (await handleQuizReply(lead, text)).handled;
          } else if (qs.enabled && buy) {
            // Lead fora do quiz (ex.: disparo concluído) demonstrou compra → mostra os planos.
            consumed = (await offerPlans(lead)).handled;
          } else if (qs.enabled && qs.dispatchStartsQuiz && lead.tag === 'disparo' && !lead.wa_quiz_state) {
            // Lead de DISPARO respondeu pela 1ª vez → entra no quiz.
            consumed = (await enterQuiz(lead)).handled;
          }
          void consumed;
        } else {
          // Número DESCONHECIDO: opt-out vale mesmo sem lead (contato de disparo);
          // fora isso, só entra no CRM se casar com a frase-gatilho do quiz.
          if (await handleOptOut(phone, text)) { res.json({ ok: true }); return; }
          if (qs.enabled && quizTriggerMatch(text, qs.trigger)) {
            await startWaQuiz({ phone, pushName: name, inboundText: text, inboundId: messageId });
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
