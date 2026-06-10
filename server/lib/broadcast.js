// Processa a fila de disparos em massa (broadcasts) — pensado para serverless.
//
// ANTI-BAN: cada broadcast tem um intervalo ALEATÓRIO entre mensagens
// (delay_min_s..delay_max_s, padrão 20–180s), controlado por `next_send_at`.
// A cada chamada do cron, cada broadcast ativo envia NO MÁXIMO 1 mensagem e
// sorteia o próximo horário — nunca dispara mais rápido que o sorteio, mesmo
// que o cron rode a cada minuto. (espaçamento real = max(intervalo do cron, sorteio))
import { sb } from '../supabase.js';
import { phoneVariants } from './helpers.js';
import { sendWhatsAppRich } from './service.js';

const randDelayMs = (bc) => {
  const min = Math.max(5, Number(bc.delay_min_s) || 20);
  const max = Math.max(min, Number(bc.delay_max_s) || 180);
  return (min + Math.random() * (max - min)) * 1000;
};

async function countByStatus(broadcastId, status) {
  const { count } = await sb().from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId).eq('status', status);
  return count || 0;
}

export async function processBroadcasts() {
  const now = Date.now();
  const { data: list } = await sb().from('broadcasts').select('*')
    .in('status', ['agendado', 'enviando'])
    .lte('scheduled_at', new Date(now).toISOString())
    .order('scheduled_at', { ascending: true });

  const actions = [];
  for (const bc of list || []) {
    // respeita o pacing: ainda não chegou a hora do próximo envio deste broadcast
    if (bc.next_send_at && new Date(bc.next_send_at).getTime() > now) {
      actions.push(`${bc.id.slice(0, 8)}:aguardando`);
      continue;
    }
    if (bc.status === 'agendado') {
      await sb().from('broadcasts').update({ status: 'enviando' }).eq('id', bc.id);
    }

    const { data: pend } = await sb().from('broadcast_recipients').select('*')
      .eq('broadcast_id', bc.id).eq('status', 'pendente')
      .order('created_at', { ascending: true }).limit(1);

    const r = (pend || [])[0];
    if (!r) {
      // nada pendente → conclui
      const [sent, failed] = await Promise.all([countByStatus(bc.id, 'enviado'), countByStatus(bc.id, 'falhou')]);
      await sb().from('broadcasts').update({ sent, failed, status: 'concluido', finished_at: new Date().toISOString() }).eq('id', bc.id);
      actions.push(`${bc.id.slice(0, 8)}:concluido`);
      continue;
    }

    const buttons = Array.isArray(bc.buttons) ? bc.buttons : [];
    let outcome;
    try {
      // vincula a um lead existente (mantém o histórico de conversa no CRM)
      const { data: lead } = await sb().from('leads').select('id')
        .in('phone', phoneVariants(r.phone)).limit(1).maybeSingle();
      // {nome} → primeiro nome da planilha (se houver)
      const text = String(bc.message_text || '').replaceAll('{nome}', (r.name || '').split(' ')[0] || '');
      await sendWhatsAppRich({
        leadId: lead?.id || null, phone: r.phone,
        text, image: bc.image || '', buttons, footer: bc.footer || '',
        instanceId: bc.instance_id || undefined,
      });
      await sb().from('broadcast_recipients')
        .update({ status: 'enviado', sent_at: new Date().toISOString(), error: null }).eq('id', r.id);
      outcome = 'enviado';
    } catch (e) {
      if (e.code === 'NO_INSTANCE') {
        // instância desconectada: não marca falha — tenta de novo no próximo cron
        actions.push(`${bc.id.slice(0, 8)}:sem-instancia`);
        continue;
      }
      await sb().from('broadcast_recipients')
        .update({ status: 'falhou', error: e.message }).eq('id', r.id);
      outcome = 'falhou';
    }

    // sorteia o próximo horário e atualiza contadores
    const [sent, failed, left] = await Promise.all([
      countByStatus(bc.id, 'enviado'), countByStatus(bc.id, 'falhou'), countByStatus(bc.id, 'pendente'),
    ]);
    await sb().from('broadcasts').update({
      sent, failed,
      next_send_at: new Date(Date.now() + randDelayMs(bc)).toISOString(),
      ...(left === 0 ? { status: 'concluido', finished_at: new Date().toISOString() } : {}),
    }).eq('id', bc.id);
    actions.push(`${bc.id.slice(0, 8)}:${outcome}${left === 0 ? ':concluido' : `:restam ${left}`}`);
  }
  return { processed: actions.length, actions };
}
