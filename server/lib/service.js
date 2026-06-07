// Camada de serviço: WhatsApp (uazapi) + geração de teste, reutilizada
// pelo funil (captura automática) e pelo CRM (ações manuais).
import { sb } from '../supabase.js';
import { uazapi } from '../uazapi.js';
import { config } from '../config.js';
import {
  genTestCredentials, renderTemplate, formatDateTimeBR, normalizePhone,
} from './helpers.js';

// Retorna a instância conectada a usar (default primeiro, senão a primeira conectada).
export async function getActiveInstance() {
  const { data } = await sb()
    .from('whatsapp_instances')
    .select('*')
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (!data || !data.length) return null;
  const connected = data.filter((i) => i.status === 'connected');
  return connected.find((i) => i.is_default) || connected[0] || null;
}

// Envia texto e registra na tabela messages. Lança erro se não houver instância conectada.
export async function sendWhatsApp({ leadId, phone, text }) {
  const inst = await getActiveInstance();
  if (!inst) {
    const e = new Error('Nenhuma instância WhatsApp conectada.');
    e.code = 'NO_INSTANCE';
    throw e;
  }
  const number = normalizePhone(phone);
  let result, status = 'sent';
  try {
    result = await uazapi.sendText(inst.token, number, text);
  } catch (err) {
    status = 'failed';
    await logMessage({ leadId, phone: number, direction: 'out', body: text, status });
    throw err;
  }
  await logMessage({
    leadId, phone: number, direction: 'out', body: text,
    messageId: result?.messageid || result?.id || null, status,
  });
  return result;
}

export async function logMessage({ leadId, phone, direction, body, messageId = null, status = null }) {
  await sb().from('messages').insert({
    lead_id: leadId || null, phone, direction, body, message_id: messageId, status,
  });
  if (leadId) {
    await sb().from('leads').update({ last_contact_at: new Date().toISOString() }).eq('id', leadId);
  }
}

// Gera o teste para um lead: cria credenciais, define validade, move para "testando"
// e dispara a mensagem no WhatsApp. Retorna { lead, whatsappSent, error }.
export async function generateTestForLead(lead) {
  const creds = genTestCredentials();
  const expires = new Date(Date.now() + config.test.durationHours * 3600 * 1000);

  await sb().from('leads').update({
    stage: 'testando',
    test_username: creds.username,
    test_password: creds.password,
    test_expires_at: expires.toISOString(),
  }).eq('id', lead.id);

  // Monta a mensagem a partir do template salvo em settings
  const { data: setting } = await sb()
    .from('settings').select('value').eq('key', 'template_teste').maybeSingle();
  const tpl = setting?.value?.text || 'Olá {nome}! Seu teste: usuário {usuario}, senha {senha}.';
  const text = renderTemplate(tpl, {
    nome: (lead.name || '').split(' ')[0],
    app: lead.app || 'seu app de IPTV',
    url: config.test.panelUrl || 'enviado pelo suporte',
    usuario: creds.username,
    senha: creds.password,
    validade: formatDateTimeBR(expires),
  });

  let whatsappSent = false, error = null;
  try {
    await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text });
    whatsappSent = true;
  } catch (err) {
    error = err.message;
  }
  return { credentials: creds, expires, whatsappSent, error };
}
