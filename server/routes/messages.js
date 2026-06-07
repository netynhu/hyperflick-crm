import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { normalizePhone } from '../lib/helpers.js';
import { sendWhatsAppRich } from '../lib/service.js';

const router = Router();
router.use(requireAdmin);

// Pequena pausa entre envios para não tomar bloqueio em disparos em massa.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Disparo manual de mensagem (texto + imagem + botões) para 1+ destinatários.
// body: {
//   text, image (url ou data-uri), footer,
//   buttons: [{ text }],
//   recipients: [{ leadId?, phone }]   // OU
//   stage: 'lead'|'testando'|...        // envia para todos os leads da etapa
//   allLeads: true                      // envia para todos os leads com telefone
// }
router.post('/send', async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    const image = String(b.image || '').trim();
    const footer = String(b.footer || '').trim();
    const buttons = Array.isArray(b.buttons)
      ? b.buttons.map((x) => ({ text: String(x?.text ?? x ?? '').trim() })).filter((x) => x.text).slice(0, 3)
      : [];

    if (!text && !image) return res.status(400).json({ error: 'Escreva um texto ou anexe uma imagem.' });

    // Monta a lista de destinatários
    let recipients = [];
    if (Array.isArray(b.recipients) && b.recipients.length) {
      recipients = b.recipients;
    } else if (b.stage || b.allLeads) {
      let q = sb().from('leads').select('id,name,phone');
      if (b.stage) q = q.eq('stage', b.stage);
      const { data } = await q;
      recipients = (data || []).map((l) => ({ leadId: l.id, phone: l.phone, name: l.name }));
    }
    recipients = recipients
      .map((r) => ({ leadId: r.leadId || null, phone: normalizePhone(r.phone), name: r.name }))
      .filter((r) => r.phone && r.phone.length >= 12);

    if (!recipients.length) return res.status(400).json({ error: 'Nenhum destinatário válido.' });

    let sent = 0;
    const errors = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      try {
        await sendWhatsAppRich({ leadId: r.leadId, phone: r.phone, text, image, buttons, footer });
        sent++;
      } catch (e) {
        errors.push({ phone: r.phone, name: r.name, error: e.message });
        if (e.code === 'NO_INSTANCE') break; // sem instância: não adianta continuar
      }
      if (i < recipients.length - 1) await sleep(900);
    }

    res.json({ ok: true, total: recipients.length, sent, failed: errors.length, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
