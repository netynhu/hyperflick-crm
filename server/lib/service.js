// Camada de serviço: WhatsApp (uazapi) + geração de teste, reutilizada
// pelo funil (captura automática) e pelo CRM (ações manuais).
import { sb } from '../supabase.js';
import { uazapi } from '../uazapi.js';
import { config } from '../config.js';
import {
  genTestCredentials, formatDateTimeBR, normalizePhone,
} from './helpers.js';
import { generatePanelTest } from './panel.js';
import { buildTestMessage } from './message.js';

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

// Gera o teste para um lead:
//  1) cria o teste REAL no painel (uhdpainel) e pega usuário/senha/DNS/validade
//  2) salva tudo no CRM e move o lead para "testando"
//  3) envia as credenciais no WhatsApp via uazapi
// Retorna { credentials, expires, whatsappSent, error, payUrl }.
export async function generateTestForLead(lead) {
  // 1) painel gera o teste real (se PANEL_CHATBOT_URL não estiver setado, cai no gerador local)
  let test;
  try {
    test = await generatePanelTest({ name: lead.name, phone: lead.phone });
  } catch (err) {
    if (err.code === 'NO_PANEL') {
      const creds = genTestCredentials();
      test = { ok: true, ...creds, dns: config.test.panelUrl, package: '', payUrl: '', expiresAt: null, expiresLabel: '' };
    } else {
      throw err; // erro de rede → leads.js trata como pendente
    }
  }

  // 1b) painel NÃO gerou novo teste (ex.: "Você já solicitou um teste").
  // Move para "testando" e reenvia o acesso que o lead já tem (se houver).
  if (test && test.ok === false) {
    await sb().from('leads').update({ stage: 'testando' }).eq('id', lead.id);
    let text;
    if (lead.test_username) {
      text = buildTestMessage({
        app: lead.app, name: lead.name,
        username: lead.test_username, password: lead.test_password,
        expiresLabel: lead.test_expires_at ? formatDateTimeBR(new Date(lead.test_expires_at)) : '',
        reply: '', dns: lead.test_dns,
      });
    } else {
      text = `Olá ${(lead.name || '').split(' ')[0]}! ${test.message}\n\nQualquer dúvida, é só chamar aqui. 🧡`;
    }
    let whatsappSent = false, error = null;
    try { await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text }); whatsappSent = true; }
    catch (err) { error = err.message; }
    return {
      credentials: { username: lead.test_username, password: lead.test_password },
      expires: lead.test_expires_at ? new Date(lead.test_expires_at) : null,
      whatsappSent, error, alreadyRequested: true,
    };
  }

  const expires = test.expiresAt || new Date(Date.now() + config.test.durationHours * 3600 * 1000);

  // 2) salva no CRM (usuário, senha, DNS, validade, pacote, link de pagamento, app instalado)
  await sb().from('leads').update({
    stage: 'testando',
    test_username: test.username,
    test_password: test.password,
    test_dns: test.dns || null,
    test_package: test.package || null,
    pay_url: test.payUrl || null,
    test_expires_at: expires.toISOString(),
  }).eq('id', lead.id);

  // 3) monta a mensagem CONFORME O APP escolhido (extrai do reply do painel) e envia via uazapi
  const text = buildTestMessage({
    app: lead.app,
    name: lead.name,
    username: test.username,
    password: test.password,
    expiresLabel: test.expiresLabel || formatDateTimeBR(expires),
    reply: test.reply,
    dns: test.dns,
  });

  let whatsappSent = false, error = null;
  try {
    await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text });
    whatsappSent = true;
  } catch (err) {
    error = err.message;
  }
  return {
    credentials: { username: test.username, password: test.password },
    expires, whatsappSent, error, payUrl: test.payUrl,
  };
}
