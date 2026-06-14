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

// Por quanto tempo seguimos re-checando um grupo que pediu aprovação do admin.
// Passou disso sem ser aprovado → desiste (marca erro).
const APPROVAL_EXPIRY_MS = 72 * 60 * 60 * 1000;

// Resolve a instância do job (com cache) — null se não estiver conectada.
async function resolveJobInstance(job, instCache) {
  const key = job.instance_id || '_default';
  if (!instCache.has(key)) {
    instCache.set(key, (await resolveInstance(job.instance_id || undefined)) || null);
  }
  return instCache.get(key);
}

// Extrai telefones dos participantes (ignora quem esconde o número → @lid).
// PhoneNumber/JID vêm no formato JID ("5511...@s.whatsapp.net").
function extractContacts(parts) {
  const seen = new Set();
  const contacts = [];
  for (const p of parts) {
    let raw = p.PhoneNumber || p.phone || '';
    const jid = String(p.JID || p.jid || '');
    if (!raw && /@s\.whatsapp\.net$/i.test(jid)) raw = jid; // número real, nunca @lid
    if (!raw) continue;
    if (/@lid$/i.test(String(raw))) continue; // número oculto
    const phone = normalizePhone(String(raw).split('@')[0]);
    if (!phone || phone.length < 12) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    contacts.push({ phone, name: p.DisplayName || p.displayName || null });
  }
  return contacts;
}

// Já estamos no grupo: puxa participantes → cadastra → sai → marca concluído.
async function exportAndFinish(inst, job, jid, name) {
  let parts = [];
  try {
    const info = await uazapi.groupInfo(inst.token, jid, { force: true });
    parts = info?.Participants || info?.participants || [];
  } catch (e) { console.warn('groupInfo:', e.message); }

  const contacts = extractContacts(parts);
  const imported = await importContacts(contacts, `grupo: ${name || job.invite_code}`);

  if (job.leave_after) { try { await uazapi.leaveGroup(inst.token, jid); } catch (e) { /* segue */ } }

  await sb().from('group_jobs').update({
    status: 'concluido', group_jid: jid, group_name: name,
    found: contacts.length, imported, finished_at: new Date().toISOString(), error: null,
  }).eq('id', job.id);
  return `${name || job.invite_code}:+${imported}/${contacts.length}`;
}

// Processa UM grupo pendente: entra → exporta. Se exigir aprovação do admin,
// envia a solicitação e deixa "aguardando" (re-checado depois).
async function processOneJob(job, instCache) {
  await sb().from('group_jobs').update({ status: 'processando' }).eq('id', job.id);
  try {
    const inst = await resolveJobInstance(job, instCache);
    if (!inst) throw new Error('Instância não conectada.');

    // Código mal interpretado (ex.: "invite" de um link /invite/) → erro claro.
    if (!isValidInviteCode(job.invite_code)) {
      throw new Error('Link inválido — copie o link completo do convite (chat.whatsapp.com/...) e cole de novo.');
    }

    // 0) prévia do convite: valida o link, pega o nome e descobre se exige aprovação.
    let previewName = '', previewJid = '', needsApproval = false;
    try {
      const info = await uazapi.groupInviteInfo(inst.token, job.invite_code);
      const g = info?.group || info || {};
      previewName = g.Name || g.name || '';
      previewJid = g.JID || g.jid || '';
      needsApproval = !!g.IsJoinApprovalRequired;
    } catch (e) { /* inviteInfo pode falhar em grupos válidos; segue pro join */ }

    // 1) entra (ou solicita entrada, se exigir aprovação)
    let jr = null;
    try {
      jr = await uazapi.joinGroup(inst.token, job.invite_code);
    } catch (e) {
      // Se exige aprovação, "falhar" aqui geralmente significa "solicitação enviada,
      // aguardando o admin" — então deixamos aguardando em vez de erro.
      if (needsApproval) return await markAwaiting(job, previewJid, previewName);
      if (/error joining group/i.test(e.message)) {
        throw new Error('Não foi possível entrar: link expirado/revogado, grupo cheio, exige aprovação, ou o número está limitado pelo WhatsApp.');
      }
      throw e;
    }
    const jid = jr?.group?.JID || jr?.JID || jr?.group?.jid || previewJid || null;
    const name = jr?.group?.Name || jr?.Name || previewName || job.group_name || '';

    // Grupo com aprovação: o join só ENVIA a solicitação — ainda não somos membros.
    // Guarda e re-checa depois (vale também caso a prévia tenha errado o flag).
    if (needsApproval) return await markAwaiting(job, jid, name);

    if (!jid) throw new Error(jr?.response || 'Não foi possível entrar (link inválido, expirado ou precisa de aprovação).');
    return await exportAndFinish(inst, job, jid, name);
  } catch (e) {
    await sb().from('group_jobs').update({
      status: 'erro', error: e.message, finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    return `erro:${e.message}`;
  }
}

// Marca o job como aguardando aprovação do admin (solicitação já enviada).
async function markAwaiting(job, jid, name) {
  const upd = await sb().from('group_jobs').update({
    status: 'aguardando', group_jid: jid || null, group_name: name || job.group_name || null,
    error: 'Solicitação enviada — aguardando o admin aprovar a entrada.',
  }).eq('id', job.id);
  // Banco antigo (sem o status 'aguardando' no CHECK) → degrada com aviso claro.
  if (upd.error && /status_check|check constraint/i.test(upd.error.message || '')) {
    await sb().from('group_jobs').update({
      status: 'erro', group_jid: jid || null, group_name: name || job.group_name || null,
      error: 'Grupo exige aprovação do admin. Rode o supabase/schema.sql pra ativar o acompanhamento automático da aprovação.',
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    return `aprovacao-sem-migracao:${name || job.invite_code}`;
  }
  return `aguardando-aprovacao:${name || job.invite_code}`;
}

// Re-checa um job "aguardando": se já fomos aprovados (groupInfo devolve membros),
// exporta. Se passou do prazo sem aprovação, desiste.
async function recheckAwaitingJob(job, instCache) {
  try {
    const inst = await resolveJobInstance(job, instCache);
    if (!inst) return null; // instância caiu agora; tenta na próxima
    if (!job.group_jid) return null; // sem JID não dá pra checar; deixa como está

    let parts = [];
    try {
      const info = await uazapi.groupInfo(inst.token, job.group_jid, { force: true });
      parts = info?.Participants || info?.participants || [];
    } catch (e) { /* ainda não aprovado / sem acesso ao grupo */ }

    if (parts.length) {
      // entrou! exporta normalmente
      return await exportAndFinish(inst, job, job.group_jid, job.group_name);
    }
    // ainda não aprovado: expira após o prazo
    if (Date.now() - new Date(job.created_at).getTime() > APPROVAL_EXPIRY_MS) {
      await sb().from('group_jobs').update({
        status: 'erro', error: 'Aprovação não concedida pelo admin no prazo.',
        finished_at: new Date().toISOString(),
      }).eq('id', job.id);
      return `aprovacao-expirada:${job.group_name || job.invite_code}`;
    }
    return null; // segue aguardando
  } catch (e) { return null; }
}

// Processa TODOS os pendentes de uma vez (sem espera) e re-checa os que aguardam
// aprovação. Limita pelo tempo de execução; o resto fica pra próxima chamada.
export async function processGroupJobs() {
  const t0 = Date.now();
  const instCache = new Map();
  const actions = [];
  let processed = 0;
  const overBudget = () => Date.now() - t0 > TIME_BUDGET_MS;

  // 1) re-checa quem está aguardando aprovação (exporta se já entrou)
  const { data: awaiting } = await sb().from('group_jobs')
    .select('*').eq('status', 'aguardando').order('created_at', { ascending: true });
  let stillAwaiting = (awaiting || []).length;
  for (const job of awaiting || []) {
    const r = await recheckAwaitingJob(job, instCache);
    if (r) { actions.push(r); processed++; stillAwaiting--; }
    if (overBudget()) return { processed, awaiting: stillAwaiting, pending: null, actions };
  }

  // 2) processa os pendentes
  const { data: jobs } = await sb().from('group_jobs')
    .select('*').eq('status', 'pendente').order('created_at', { ascending: true });
  let pending = (jobs || []).length;
  for (const job of jobs || []) {
    actions.push(await processOneJob(job, instCache));
    processed++; pending--;
    if (overBudget()) break; // resto na próxima execução
  }
  return { processed, awaiting: stillAwaiting, pending, actions };
}
