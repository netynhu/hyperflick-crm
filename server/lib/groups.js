// "Entrar em grupo → exportar participantes → cadastrar nos contatos".
// Entrar em grupo (diferente de disparar mensagem) não costuma gerar ban, então
// processamos TODOS os grupos pendentes de uma vez — sem espera entre entradas.
import { sb } from '../supabase.js';
import { uazapi } from '../uazapi.js';
import { resolveInstance } from './service.js';
import { normalizePhone } from './helpers.js';

// Teto de tempo por execução (ms): evita estourar o timeout do serverless quando
// há MUITOS grupos. O que sobrar é processado na próxima chamada (cron/botão).
const TIME_BUDGET_MS = 45 * 1000;

// Extrai o código do convite de um link do WhatsApp (ou aceita o código puro).
// Formatos aceitos:
//   https://chat.whatsapp.com/CODE
//   https://chat.whatsapp.com/invite/CODE   (alguns compartilhamentos usam /invite/)
//   whatsapp://chat?code=CODE                (link interno do app)
//   CODE                                     (código puro, ~22 caracteres)
export function parseInviteCode(link) {
  const s = String(link || '').trim();
  // ?code=CODE (deep link do app)
  let m = s.match(/[?&]code=([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // chat.whatsapp.com/CODE  ou  chat.whatsapp.com/invite/CODE
  m = s.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // código puro (remove qualquer prefixo de caminho e lixo no fim)
  return s.replace(/^.*\//, '').replace(/[^A-Za-z0-9_-].*$/, '').trim();
}

// Um código de convite válido do WhatsApp tem 10+ caracteres (a uazapi recusa < 10).
// "invite", "chat", etc. são fragmentos de URL mal interpretados → inválidos.
export function isValidInviteCode(code) {
  return /^[A-Za-z0-9_-]{10,50}$/.test(String(code || ''));
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

// Processa UM grupo: entra → exporta participantes → cadastra → sai.
// `instCache` evita resolver o token da mesma instância várias vezes no lote.
async function processOneJob(job, instCache) {
  await sb().from('group_jobs').update({ status: 'processando' }).eq('id', job.id);
  try {
    let inst = instCache.get(job.instance_id || '_default');
    if (inst === undefined) {
      inst = await resolveInstance(job.instance_id || undefined);
      instCache.set(job.instance_id || '_default', inst || null);
    }
    if (!inst) throw new Error('Instância não conectada.');

    // Código mal interpretado (ex.: "invite" de um link /invite/) → erro claro.
    if (!isValidInviteCode(job.invite_code)) {
      throw new Error('Link inválido — copie o link completo do convite (chat.whatsapp.com/...) e cole de novo.');
    }

    // 0) prévia do convite: valida o link e já pega o nome ANTES de entrar.
    //    Se o grupo exigir aprovação de admin, avisamos sem gastar a entrada.
    let previewName = '';
    try {
      const info = await uazapi.groupInviteInfo(inst.token, job.invite_code);
      const g = info?.group || info || {};
      previewName = g.Name || g.name || '';
      if (g.IsJoinApprovalRequired) {
        throw new Error('Este grupo exige aprovação do admin para entrar — não dá pra entrar automaticamente.');
      }
    } catch (e) {
      // inviteInfo pode falhar em alguns grupos mesmo válidos; só aborta se for o erro de aprovação.
      if (/aprovação/.test(e.message)) throw e;
    }

    // 1) entra no grupo pelo convite
    let jr;
    try {
      jr = await uazapi.joinGroup(inst.token, job.invite_code);
    } catch (e) {
      // uazapi devolve "error joining group" pra QUALQUER falha — traduz pra algo útil.
      if (/error joining group/i.test(e.message)) {
        throw new Error('Não foi possível entrar: link expirado/revogado, grupo cheio, exige aprovação, ou o número está limitado pelo WhatsApp.');
      }
      throw e;
    }
    const jid = jr?.group?.JID || jr?.JID || jr?.group?.jid || null;
    const name = jr?.group?.Name || jr?.Name || previewName || job.group_name || '';
    if (!jid) throw new Error(jr?.response || 'Não foi possível entrar (link inválido, expirado ou precisa de aprovação).');

    // 2) puxa os participantes (force ignora cache)
    let parts = [];
    try {
      const info = await uazapi.groupInfo(inst.token, jid, { force: true });
      parts = info?.Participants || info?.participants || [];
    } catch (e) { console.warn('groupInfo:', e.message); }

    // 3) extrai telefones (alguns membros escondem o número → ignora)
    //    PhoneNumber/JID vêm no formato JID ("5511...@s.whatsapp.net"). Quem oculta
    //    o número aparece só com um "@lid" (id interno) — esses NÃO são telefone.
    const seen = new Set();
    const contacts = [];
    for (const p of parts) {
      let raw = p.PhoneNumber || p.phone || '';
      const jid = String(p.JID || p.jid || '');
      // só usa o JID como telefone se for um número real (s.whatsapp.net), nunca @lid
      if (!raw && /@s\.whatsapp\.net$/i.test(jid)) raw = jid;
      if (!raw) continue;
      if (/@lid$/i.test(String(raw))) continue; // número oculto
      const phone = normalizePhone(String(raw).split('@')[0]);
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
    return `${name || job.invite_code}:+${imported}/${contacts.length}`;
  } catch (e) {
    await sb().from('group_jobs').update({
      status: 'erro', error: e.message, finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    return `erro:${e.message}`;
  }
}

// Processa TODOS os grupos pendentes de uma vez (sem espera entre entradas).
// Limita pelo tempo de execução; o resto fica pendente pra próxima chamada.
export async function processGroupJobs() {
  const { data: jobs } = await sb().from('group_jobs')
    .select('*').eq('status', 'pendente').order('created_at', { ascending: true });
  if (!jobs?.length) return { processed: 0, actions: [] };

  const t0 = Date.now();
  const instCache = new Map();
  const actions = [];
  let processed = 0;
  for (const job of jobs) {
    actions.push(await processOneJob(job, instCache));
    processed++;
    if (Date.now() - t0 > TIME_BUDGET_MS) break; // resto na próxima execução
  }
  return { processed, pending: jobs.length - processed, actions };
}
