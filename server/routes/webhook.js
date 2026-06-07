import { Router } from 'express';
import { sb } from '../supabase.js';
import { hasSupabase } from '../supabase.js';
import { normalizePhone } from '../lib/helpers.js';
import { logMessage } from '../lib/service.js';

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

export default router;
