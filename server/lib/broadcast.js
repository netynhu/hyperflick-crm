// Processa a fila de disparos em massa (broadcasts) em LOTES — pensado para
// serverless: cada chamada envia no máximo `batch` mensagens e retorna.
// O cron (/api/cron/followup ou /api/cron/broadcast) chama isto repetidamente
// até a fila esvaziar.
import { sb } from '../supabase.js';
import { phoneVariants } from './helpers.js';
import { sendWhatsAppRich } from './service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countByStatus(broadcastId, status) {
  const { count } = await sb().from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId).eq('status', status);
  return count || 0;
}

export async function processBroadcasts({ batch = 10, delayMs = 1100 } = {}) {
  const nowIso = new Date().toISOString();
  const { data: list } = await sb().from('broadcasts').select('*')
    .in('status', ['agendado', 'enviando'])
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true });

  const actions = [];
  let budget = batch;

  for (const bc of list || []) {
    if (budget <= 0) break;
    if (bc.status === 'agendado') {
      await sb().from('broadcasts').update({ status: 'enviando' }).eq('id', bc.id);
    }

    const { data: pend } = await sb().from('broadcast_recipients').select('*')
      .eq('broadcast_id', bc.id).eq('status', 'pendente')
      .order('created_at', { ascending: true }).limit(budget);

    const buttons = Array.isArray(bc.buttons) ? bc.buttons : [];
    let sentNow = 0, failedNow = 0, noInstance = false;

    for (const r of pend || []) {
      try {
        // vincula a um lead existente (mantém o histórico de conversa no CRM)
        const { data: lead } = await sb().from('leads').select('id')
          .in('phone', phoneVariants(r.phone)).limit(1).maybeSingle();
        // {nome} → primeiro nome da planilha (se houver)
        const text = String(bc.message_text || '').replaceAll('{nome}', (r.name || '').split(' ')[0] || '');
        await sendWhatsAppRich({
          leadId: lead?.id || null, phone: r.phone,
          text, image: bc.image || '', buttons, footer: bc.footer || '',
        });
        await sb().from('broadcast_recipients')
          .update({ status: 'enviado', sent_at: new Date().toISOString(), error: null }).eq('id', r.id);
        sentNow++;
      } catch (e) {
        if (e.code === 'NO_INSTANCE') { noInstance = true; break; } // sem WhatsApp: tenta no próximo cron
        await sb().from('broadcast_recipients')
          .update({ status: 'falhou', error: e.message }).eq('id', r.id);
        failedNow++;
      }
      budget--;
      if (budget > 0) await sleep(delayMs); // pausa anti-bloqueio entre envios
    }

    // atualiza contadores e conclui quando não restar pendente
    const [left, sent, failed] = await Promise.all([
      countByStatus(bc.id, 'pendente'),
      countByStatus(bc.id, 'enviado'),
      countByStatus(bc.id, 'falhou'),
    ]);
    await sb().from('broadcasts').update({
      sent, failed,
      ...(left === 0 ? { status: 'concluido', finished_at: new Date().toISOString() } : {}),
    }).eq('id', bc.id);

    actions.push(`${bc.id.slice(0, 8)}:+${sentNow}${failedNow ? `/-${failedNow}` : ''}${left === 0 ? ':concluido' : `:restam ${left}`}`);
    if (noInstance) { actions.push('sem-instancia'); break; }
  }
  return { processed: actions.length, actions };
}
