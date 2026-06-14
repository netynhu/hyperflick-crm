// Fila de "entrar em grupo → exportar participantes → cadastrar nos contatos".
// Processa 1 grupo por execução do cron, com um GAP mínimo entre entradas
// (anti-ban: entrar em vários grupos de uma vez é o caminho mais curto pro ban).
import { sb } from '../supabase.js';
import { uazapi } from '../uazapi.js';
import { resolveInstance } from './service.js';
import { normalizePhone } from './helpers.js';

// Intervalo mínimo entre entradas em grupo (ms). Mesmo com cron de 1 min, segura.
const GAP_MS = 3 * 60 * 1000;

// Extrai o código do convite de um link do WhatsApp (ou aceita o código puro).
export function parseInviteCode(link) {
  const s = String(link || '').trim();
  const m = s.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  return s.replace(/^.*\//, '').replace(/[^A-Za-z0-9_-].*$/, '').trim();
}

// Cadastra contatos novos na base (não sobrescreve existentes). Retorna nº de novos.
async function importContacts(contacts, source) {
  if (!contacts.length) return 0;
  try {
    const phones = contacts.map((c) => c.phone);
    const existing = new Set();
    for (let i = 0; i < phones.length; i += 500) {
      const { data } = await sb().from('contacts').select('phone').in('phone', phones.slice(i, i + 500));
      for (const d of data || []) existing.add(d.phone);
    }
    const news = contacts.filter((c) => !existing.has(c.phone))
      .map((c) => ({ phone: c.phone, name: c.name, source }));
    for (let i = 0; i < news.length; i += 500) {
      const { error } = await sb().from('contacts').insert(news.slice(i, i + 500));
      if (error) throw error;
    }
    return news.length;
  } catch (e) { console.warn('importContacts (grupos):', e.message, '(rode o schema.sql)'); return 0; }
}

export async function processGroupJobs() {
  // respeita o GAP: olha quando o último grupo terminou de ser processado
  const { data: recent } = await sb().from('group_jobs')
    .select('finished_at').not('finished_at', 'is', null)
    .order('finished_at', { ascending: false }).limit(1);
  const last = recent?.[0]?.finished_at ? new Date(recent[0].finished_at).getTime() : 0;
  if (Date.now() - last < GAP_MS) return { processed: 0, actions: ['aguardando-gap'] };

  const { data: jobs } = await sb().from('group_jobs')
    .select('*').eq('status', 'pendente').order('created_at', { ascending: true }).limit(1);
  const job = jobs?.[0];
  if (!job) return { processed: 0, actions: [] };

  await sb().from('group_jobs').update({ status: 'processando' }).eq('id', job.id);
  try {
    const inst = await resolveInstance(job.instance_id || undefined);
    if (!inst) throw new Error('Instância não conectada.');

    // 1) entra no grupo pelo convite
    const jr = await uazapi.joinGroup(inst.token, job.invite_code);
    const jid = jr?.group?.JID || jr?.JID || jr?.group?.jid || null;
    const name = jr?.group?.Name || jr?.Name || job.group_name || '';
    if (!jid) throw new Error(jr?.response || 'Não foi possível entrar (link inválido, expirado ou precisa de aprovação).');

    // 2) puxa os participantes (force ignora cache)
    let parts = [];
    try {
      const info = await uazapi.groupInfo(inst.token, jid, { force: true });
      parts = info?.Participants || info?.participants || [];
    } catch (e) { console.warn('groupInfo:', e.message); }

    // 3) extrai telefones (alguns membros escondem o número → ignora)
    const seen = new Set();
    const contacts = [];
    for (const p of parts) {
      const raw = p.PhoneNumber || p.phone || String(p.JID || p.jid || '').split('@')[0];
      const phone = normalizePhone(raw);
      if (!phone || phone.length < 12) continue;
      if (seen.has(phone)) continue;
      seen.add(phone);
      contacts.push({ phone, name: p.DisplayName || p.displayName || null });
    }

    // 4) cadastra na base de contatos (origem = nome do grupo)
    const imported = await importContacts(contacts, `grupo: ${name || job.invite_code}`);

    // 5) sai do grupo (decisão do usuário: sair após exportar)
    if (job.leave_after) { try { await uazapi.leaveGroup(inst.token, jid); } catch (e) { /* segue */ } }

    await sb().from('group_jobs').update({
      status: 'concluido', group_jid: jid, group_name: name,
      found: contacts.length, imported, finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    return { processed: 1, actions: [`${name || job.invite_code}:+${imported}/${contacts.length}`] };
  } catch (e) {
    await sb().from('group_jobs').update({
      status: 'erro', error: e.message, finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    return { processed: 1, actions: [`erro:${e.message}`] };
  }
}
