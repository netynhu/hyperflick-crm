import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { normalizePhone } from '../lib/helpers.js';
import { sendWhatsAppRich } from '../lib/service.js';
import { processBroadcasts } from '../lib/broadcast.js';

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
        await sendWhatsAppRich({ leadId: r.leadId, phone: r.phone, text, image, buttons, footer, instanceId: b.instanceId || undefined });
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

// ============================================================
// DISPAROS EM MASSA (planilha + agendamento, processados pelo cron)
// ============================================================

// Cria um disparo agendado.
// body: { name?, text, image?, footer?, buttons?, scheduledAt?(ISO), recipients:[{phone,name?}] }
router.post('/broadcasts', async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    const image = String(b.image || '').trim();
    const footer = String(b.footer || '').trim();
    const buttons = Array.isArray(b.buttons)
      ? b.buttons.map((x) => ({ text: String(x?.text ?? x ?? '').trim() })).filter((x) => x.text).slice(0, 3)
      : [];
    if (!text && !image) return res.status(400).json({ error: 'Escreva um texto ou anexe uma imagem.' });

    // normaliza + remove duplicados/inválidos
    const seen = new Set();
    const recipients = [];
    let invalid = 0;
    for (const r of Array.isArray(b.recipients) ? b.recipients : []) {
      const phone = normalizePhone(r?.phone);
      if (!phone || phone.length < 12) { invalid++; continue; }
      if (seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ phone, name: String(r?.name || '').trim() || null });
    }
    if (!recipients.length) return res.status(400).json({ error: 'Nenhum número válido na lista.' });

    const scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) return res.status(400).json({ error: 'Data de agendamento inválida.' });

    // Intervalo aleatório anti-ban entre mensagens (padrão 20–180s)
    let delayMin = Math.round(Number(b.delayMinS));
    let delayMax = Math.round(Number(b.delayMaxS));
    if (!Number.isFinite(delayMin) || delayMin < 5) delayMin = 20;
    if (!Number.isFinite(delayMax) || delayMax < delayMin) delayMax = Math.max(180, delayMin);

    const { data: bc, error } = await sb().from('broadcasts').insert({
      name: String(b.name || '').trim() || `Disparo ${new Date().toLocaleDateString('pt-BR')}`,
      message_text: text, image, footer, buttons,
      status: 'agendado', scheduled_at: scheduledAt.toISOString(),
      total: recipients.length, sent: 0, failed: 0,
      instance_id: b.instanceId || null,
      delay_min_s: delayMin, delay_max_s: delayMax,
    }).select().single();
    if (error) throw error;

    // insere destinatários em blocos (planilhas grandes)
    for (let i = 0; i < recipients.length; i += 500) {
      const chunk = recipients.slice(i, i + 500).map((r) => ({ ...r, broadcast_id: bc.id }));
      const { error: e2 } = await sb().from('broadcast_recipients').insert(chunk);
      if (e2) throw e2;
    }

    res.json({ ok: true, id: bc.id, total: recipients.length, invalid, scheduledAt: bc.scheduled_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista os disparos (com progresso)
router.get('/broadcasts', async (_req, res) => {
  try {
    const { data, error } = await sb().from('broadcasts').select('*')
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Detalhe + falhas (para diagnosticar números que não receberam)
router.get('/broadcasts/:id', async (req, res) => {
  try {
    const { data: bc, error } = await sb().from('broadcasts').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const { data: fails } = await sb().from('broadcast_recipients').select('phone,name,error')
      .eq('broadcast_id', bc.id).eq('status', 'falhou').limit(100);
    res.json({ ...bc, failures: fails || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pausar / retomar / cancelar
router.post('/broadcasts/:id/pause', async (req, res) => {
  try {
    await sb().from('broadcasts').update({ status: 'pausado' })
      .eq('id', req.params.id).in('status', ['agendado', 'enviando']);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/broadcasts/:id/resume', async (req, res) => {
  try {
    await sb().from('broadcasts').update({ status: 'agendado' })
      .eq('id', req.params.id).eq('status', 'pausado');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/broadcasts/:id/cancel', async (req, res) => {
  try {
    await sb().from('broadcasts').update({ status: 'cancelado' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/broadcasts/:id', async (req, res) => {
  try {
    const { error } = await sb().from('broadcasts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Processa a fila AGORA (o painel chama após criar um disparo imediato —
// manda a 1ª mensagem na hora; o restante segue o pacing pelo cron).
router.post('/broadcasts/process', async (_req, res) => {
  try {
    const r = await processBroadcasts();
    res.json({ ok: true, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
