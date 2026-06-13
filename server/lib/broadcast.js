// Processa a fila de disparos em massa (broadcasts) — pensado para serverless.
//
// ANTI-BAN: cada broadcast tem um intervalo ALEATÓRIO entre mensagens
// (delay_min_s..delay_max_s, padrão 20–180s), controlado por `next_send_at`.
// A cada chamada do cron, cada broadcast ativo envia NO MÁXIMO 1 mensagem e
// sorteia o próximo horário — nunca dispara mais rápido que o sorteio, mesmo
// que o cron rode a cada minuto. (espaçamento real = max(intervalo do cron, sorteio))
import { sb } from '../supabase.js';
import { phoneVariants, normalizePhone } from './helpers.js';
import { sendWhatsAppRich, insertLeadSafe } from './service.js';

// Garante um lead para o número disparado: reusa o existente ou cria com a
// etiqueta "disparo" na etapa Lead (todo cliente disparado vira lead). Mantém o
// histórico de conversa no CRM e permite o quiz quando ele responder.
async function ensureLeadForBroadcast(phone, name, instanceId) {
  const { data: existing } = await sb().from('leads').select('id,instance_id')
    .in('phone', phoneVariants(phone)).limit(1).maybeSingle();
  if (existing) {
    // fixa o "dono" da conversa = número que disparou (1ª resposta já vai certo)
    if (instanceId && existing.instance_id !== instanceId) {
      try { await sb().from('leads').update({ instance_id: instanceId }).eq('id', existing.id); } catch (e) { /* coluna pendente */ }
    }
    return existing.id;
  }
  const { data, error } = await insertLeadSafe({
    name: name || 'Cliente', phone: normalizePhone(phone), stage: 'lead',
    source: 'disparo', tag: 'disparo', name_confirmed: !!name,
    ...(instanceId ? { instance_id: instanceId } : {}),
  }, 'id');
  if (!error && data) return data.id;
  // corrida na unique(phone) ou outro erro: re-busca
  const { data: again } = await sb().from('leads').select('id').in('phone', phoneVariants(phone)).limit(1).maybeSingle();
  return again?.id || null;
}

const randDelayMs = (bc) => {
  const min = Math.max(5, Number(bc.delay_min_s) || 20);
  const max = Math.max(min, Number(bc.delay_max_s) || 180);
  return (min + Math.random() * (max - min)) * 1000;
};

// Hora (0-23) no fuso de São Paulo, de uma data qualquer — para a janela de envio.
const hourSP = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo',
}).format(d)) % 24;

function windowOf(bc) {
  const start = Number.isFinite(Number(bc.window_start)) ? Number(bc.window_start) : 8;
  const end = Number.isFinite(Number(bc.window_end)) ? Number(bc.window_end) : 21;
  return { start, end };
}

// Dentro da janela de envio? (start=8,end=21 → envia das 08:00 às 20:59).
// start === end → janela 24h; start > end → janela que atravessa a meia-noite.
function inWindow(bc, d = new Date()) {
  const { start, end } = windowOf(bc);
  if (start === end) return true;
  const h = hourSP(d);
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

// Próximo horário (ISO) em que a janela abre — agenda o envio pra lá.
function nextWindowOpen(bc) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  for (let i = 1; i <= 24; i++) {
    const probe = new Date(d.getTime() + i * 3600000);
    if (inWindow(bc, probe)) return probe.toISOString();
  }
  return new Date(Date.now() + 3600000).toISOString();
}

// Renderiza o texto por destinatário: {nome} → primeiro nome; {a|b|c} → sorteia
// uma variação (spintax anti-ban: cada mensagem sai um pouco diferente).
export function renderBroadcastText(tpl, name) {
  let t = String(tpl || '').replaceAll('{nome}', (name || '').split(' ')[0] || '');
  t = t.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
    const parts = opts.split('|');
    return parts[Math.floor(Math.random() * parts.length)].trim();
  });
  return t.replace(/ {2,}/g, ' ').replace(/ ([!?,.;:])/g, '$1').replace(/^ +| +$/gm, '');
}

// Registra o disparo na base de contatos: incrementa o contador do número e
// marca qual broadcast o incluiu (last_broadcast_id), pra outro disparo não
// repetir o mesmo contato. Tolerante: sem a tabela contacts, segue sem contar.
export async function bumpContactDispatch(phone, name, broadcastId) {
  try {
    const { data: c } = await sb().from('contacts').select('id,dispatch_count,name')
      .in('phone', phoneVariants(phone)).limit(1).maybeSingle();
    const nowIso = new Date().toISOString();
    if (c) {
      await sb().from('contacts').update({
        dispatch_count: (Number(c.dispatch_count) || 0) + 1,
        last_dispatched_at: nowIso,
        ...(broadcastId ? { last_broadcast_id: broadcastId } : {}),
        ...(c.name ? {} : (name ? { name } : {})),
      }).eq('id', c.id);
    } else {
      await sb().from('contacts').insert({
        phone: normalizePhone(phone), name: name || null, source: 'disparo',
        dispatch_count: 1, last_dispatched_at: nowIso,
        ...(broadcastId ? { last_broadcast_id: broadcastId } : {}),
      });
    }
  } catch (e) { /* tabela contacts ausente — rode o schema.sql */ }
}

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
    // fora da janela de envio (ex.: madrugada) → reagenda pra quando a janela abrir
    if (!inWindow(bc)) {
      const at = nextWindowOpen(bc);
      await sb().from('broadcasts').update({ next_send_at: at }).eq('id', bc.id);
      actions.push(`${bc.id.slice(0, 8)}:fora-da-janela→${at.slice(11, 16)}`);
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
      // todo número disparado vira lead (etiqueta "disparo"), dono = número que dispara
      const leadId = await ensureLeadForBroadcast(r.phone, r.name, bc.instance_id || null);
      // {nome} → primeiro nome; {a|b} → variação sorteada (anti-ban)
      const text = renderBroadcastText(bc.message_text, r.name);
      await sendWhatsAppRich({
        leadId, phone: r.phone,
        text, image: bc.image || '', buttons, footer: bc.footer || '',
        instanceId: bc.instance_id || undefined,
      });
      await sb().from('broadcast_recipients')
        .update({ status: 'enviado', sent_at: new Date().toISOString(), error: null }).eq('id', r.id);
      await bumpContactDispatch(r.phone, r.name, bc.id); // contador + marca o disparo
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
