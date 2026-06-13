import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { normalizePhone, phoneVariants } from '../lib/helpers.js';
import { sendWhatsAppRich } from '../lib/service.js';
import { processBroadcasts, renderBroadcastText, bumpContactDispatch } from '../lib/broadcast.js';

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
        // vincula ao lead pelo telefone (a mensagem aparece na conversa do CRM)
        let leadId = r.leadId;
        if (!leadId) {
          const { data: lm } = await sb().from('leads').select('id').in('phone', phoneVariants(r.phone)).limit(1).maybeSingle();
          leadId = lm?.id || null;
        }
        // {nome} → primeiro nome; {a|b} → variação sorteada (mesmo motor do disparo em massa)
        await sendWhatsAppRich({ leadId, phone: r.phone, text: renderBroadcastText(text, r.name), image, buttons, footer, instanceId: b.instanceId || undefined });
        // número que ainda não é lead = prospecção → entra na base com contagem
        if (!leadId) await bumpContactDispatch(r.phone, r.name);
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
// body: { name?, text, image?, footer?, buttons?, scheduledAt?(ISO),
//         recipients:[{phone,name?}]            — lista direta (planilha/etapa/todos)
//         OU audience:'contacts' + contactFilter:'ativos'|'never'|'cold' (+coldDays)
//         saveToContacts?: true, source?        — grava a planilha na base de contatos
//         windowStart?, windowEnd?              — janela de envio (hora SP, padrão 8–21)
//         instanceId?, delayMinS?, delayMaxS? }
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

    // -------- monta a lista de destinatários --------
    let rawRecipients = Array.isArray(b.recipients) ? b.recipients : [];
    if (b.audience === 'contacts') {
      // público vem da BASE DE CONTATOS (sempre excluindo opt-out)
      let q = sb().from('contacts').select('phone,name').eq('opt_out', false).limit(10000);
      if (b.contactFilter === 'never') q = q.eq('dispatch_count', 0);
      if (b.contactFilter === 'cold') {
        const days = Math.max(1, Number(b.coldDays) || 30);
        q = q.lt('last_dispatched_at', new Date(Date.now() - days * 86400000).toISOString());
      }
      const { data, error } = await q;
      if (error) {
        const miss = /contacts.*(does not exist|schema cache)/i.test(error.message);
        return res.status(400).json({ error: miss ? 'Base de contatos ainda não existe — rode o supabase/schema.sql.' : error.message });
      }
      rawRecipients = data || [];
    }

    // normaliza + remove duplicados/inválidos
    const seen = new Set();
    let recipients = [];
    let invalid = 0;
    for (const r of rawRecipients) {
      const phone = normalizePhone(r?.phone);
      if (!phone || phone.length < 12) { invalid++; continue; }
      if (seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ phone, name: String(r?.name || '').trim() || null });
    }
    if (!recipients.length) return res.status(400).json({ error: 'Nenhum número válido na lista.' });

    // respeita o opt-out: remove da lista quem pediu pra sair (qualquer público)
    let optedOut = 0;
    try {
      const phones = recipients.map((r) => r.phone);
      const out = new Set();
      for (let i = 0; i < phones.length; i += 500) {
        const { data } = await sb().from('contacts').select('phone')
          .eq('opt_out', true).in('phone', phones.slice(i, i + 500));
        for (const d of data || []) out.add(d.phone);
      }
      if (out.size) { optedOut = out.size; recipients = recipients.filter((r) => !out.has(r.phone)); }
    } catch (e) { /* tabela contacts ausente — segue sem filtro */ }
    if (!recipients.length) return res.status(400).json({ error: 'Todos os números da lista pediram pra não receber (opt-out).' });

    // planilha nova → salva os números na base de contatos (não sobrescreve existentes)
    if (b.saveToContacts) {
      try {
        const phones = recipients.map((r) => r.phone);
        const existing = new Set();
        for (let i = 0; i < phones.length; i += 500) {
          const { data } = await sb().from('contacts').select('phone').in('phone', phones.slice(i, i + 500));
          for (const d of data || []) existing.add(d.phone);
        }
        const news = recipients.filter((r) => !existing.has(r.phone))
          .map((r) => ({ phone: r.phone, name: r.name, source: String(b.source || '').trim() || 'planilha' }));
        for (let i = 0; i < news.length; i += 500) {
          await sb().from('contacts').insert(news.slice(i, i + 500));
        }
      } catch (e) { console.warn('saveToContacts:', e.message, '(rode o schema.sql)'); }
    }

    const scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) return res.status(400).json({ error: 'Data de agendamento inválida.' });

    // Intervalo aleatório anti-ban entre mensagens (padrão 20–180s)
    let delayMin = Math.round(Number(b.delayMinS));
    let delayMax = Math.round(Number(b.delayMaxS));
    if (!Number.isFinite(delayMin) || delayMin < 5) delayMin = 20;
    if (!Number.isFinite(delayMax) || delayMax < delayMin) delayMax = Math.max(180, delayMin);

    // Janela de envio (hora de São Paulo). Padrão 8–21; iguais = 24h.
    let winS = Math.round(Number(b.windowStart)); let winE = Math.round(Number(b.windowEnd));
    if (!Number.isFinite(winS) || winS < 0 || winS > 23) winS = 8;
    if (!Number.isFinite(winE) || winE < 0 || winE > 23) winE = 21;

    const insertRow = {
      name: String(b.name || '').trim() || `Disparo ${new Date().toLocaleDateString('pt-BR')}`,
      message_text: text, image, footer, buttons,
      status: 'agendado', scheduled_at: scheduledAt.toISOString(),
      total: recipients.length, sent: 0, failed: 0,
      instance_id: b.instanceId || null,
      delay_min_s: delayMin, delay_max_s: delayMax,
      window_start: winS, window_end: winE,
    };
    let { data: bc, error } = await sb().from('broadcasts').insert(insertRow).select().single();
    if (error && /window_start|window_end/.test(error.message)) {
      // banco ainda sem as colunas de janela — cria sem elas (rode o schema.sql)
      const { window_start, window_end, ...rest } = insertRow;
      ({ data: bc, error } = await sb().from('broadcasts').insert(rest).select().single());
    }
    if (error) throw error;

    // insere destinatários em blocos (planilhas grandes)
    for (let i = 0; i < recipients.length; i += 500) {
      const chunk = recipients.slice(i, i + 500).map((r) => ({ ...r, broadcast_id: bc.id }));
      const { error: e2 } = await sb().from('broadcast_recipients').insert(chunk);
      if (e2) throw e2;
    }

    res.json({ ok: true, id: bc.id, total: recipients.length, invalid, optedOut, scheduledAt: bc.scheduled_at });
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
