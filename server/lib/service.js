// Camada de serviço: WhatsApp (uazapi) + geração de teste, reutilizada
// pelo funil (captura automática) e pelo CRM (ações manuais).
import { sb } from '../supabase.js';
import { uazapi } from '../uazapi.js';
import { config } from '../config.js';
import {
  genTestCredentials, formatDateTimeBR, normalizePhone, planMonths,
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

// Resolve a instância de envio: a escolhida (se conectada) ou a padrão.
// instanceId permite disparar por OUTRO número (ex.: chip só de disparo).
export async function resolveInstance(instanceId) {
  if (instanceId) {
    const { data } = await sb().from('whatsapp_instances').select('*').eq('id', instanceId).maybeSingle();
    if (data && data.status === 'connected') return data;
    const e = new Error('A instância escolhida não está conectada.');
    e.code = 'NO_INSTANCE';
    throw e;
  }
  return getActiveInstance();
}

// Envia texto e registra na tabela messages. Lança erro se não houver instância conectada.
export async function sendWhatsApp({ leadId, phone, text, instanceId }) {
  const inst = await resolveInstance(instanceId);
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

// Envia mídia (imagem) e opcionalmente botões, registrando na tabela messages.
// Usa a instância conectada (ou a escolhida via instanceId). Lança erro (NO_INSTANCE) se não houver.
// listButton: se informado, envia como LISTA (suporta 4+ opções) em vez de botões.
export async function sendWhatsAppRich({ leadId, phone, text = '', image = '', buttons = [], footer = '', listButton = '', instanceId }) {
  const inst = await resolveInstance(instanceId);
  if (!inst) { const e = new Error('Nenhuma instância WhatsApp conectada.'); e.code = 'NO_INSTANCE'; throw e; }
  const number = normalizePhone(phone);
  // Converte botões para o formato de choices da uazapi:
  //  reply: "texto" ou "texto|id"  ·  copy: "texto|copy:código"  ·  url: "texto|url:link"  ·  call: "texto|call:+num"
  //  string passa direto (permite "[Seção]" e "texto|id|descrição" em listas)
  const choices = (buttons || []).map((b) => {
    if (typeof b === 'string') return b;
    if (!b || !b.text) return null;
    if (b.copy) return `${b.text}|copy:${b.copy}`;
    if (b.url) return `${b.text}|url:${b.url}`;
    if (b.call) return `${b.text}|call:${b.call}`;
    return b.text; // botão de resposta
  }).filter(Boolean);
  const logBody = text || (image ? '[imagem]' : '') || (choices.length ? '[menu]' : '');

  try {
    // 1) imagem (com legenda só se não houver botões)
    if (image) {
      await uazapi.sendMedia(inst.token, number, { type: 'image', file: image, text: choices.length ? '' : text });
    }
    // 2) botões/lista (com o texto) — ou texto puro se não houve imagem
    if (choices.length) {
      await uazapi.sendMenu(inst.token, number, {
        text, choices, footerText: footer,
        ...(listButton ? { type: 'list', listButton } : {}),
      });
    } else if (!image) {
      await uazapi.sendText(inst.token, number, text);
    }
  } catch (err) {
    await logMessage({ leadId, phone: number, direction: 'out', body: logBody, status: 'failed' });
    throw err;
  }
  await logMessage({ leadId, phone: number, direction: 'out', body: logBody, status: 'sent' });
  return { ok: true };
}

// Envia uma mensagem de pagamento Pix. O código Pix e o link ficam SOMENTE nos
// botões (copiar código + pagar pelo link) — nada no corpo, a pedido.
export async function sendPixMessage({ leadId, phone, intro, plan, amount, pixCode, ticketUrl, footer }) {
  const valor = Number(amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const planLine = plan ? `\n\n💠 *Plano ${plan}* — R$ ${valor}` : `\n\n💠 *Valor:* R$ ${valor}`;
  const text =
    `${intro}${planLine}\n\n` +
    `Toque em *📋 Copiar código Pix*, abra o app do seu banco e cole no Pix. Assim que o pagamento cair, seu acesso é liberado na hora! 🚀`;
  const buttons = [{ text: '📋 Copiar código Pix', copy: pixCode }];
  if (ticketUrl) buttons.push({ text: '🔗 Pagar pelo link', url: ticketUrl });
  return sendWhatsAppRich({ leadId, phone, text, buttons, footer: footer || 'HyperFlick • IPTV' });
}

// Apps pagos (cobrados pelo desenvolvedor, à parte da mensalidade HyperFlick).
export function isPaidApp(app) {
  const a = String(app || '').toLowerCase();
  return a.includes('ibo') || a.includes('assist');
}

// Quando o cliente fecha 6 meses (ou mais) E usa um app pago, a HyperFlick
// presenteia o app (1 dispositivo, ~R$ 20/ano) → lança como despesa, uma vez.
export async function addPaidAppExpenseIfNeeded({ lead, plan }) {
  try {
    if (!lead || !isPaidApp(lead.app)) return;
    if (planMonths(plan) < 6) return; // só ganha o app a partir do semestral
    // dedupe: já lançamos esse app pra esse cliente nos últimos 150 dias?
    const since = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
    const { data: ex } = await sb().from('expenses').select('id')
      .eq('category', 'app').gte('date', since).ilike('description', `%${lead.name}%`).limit(1);
    if (ex && ex.length) return;
    await sb().from('expenses').insert({
      description: `App ${lead.app} (1 dispositivo) — ${lead.name}`,
      amount: 20, category: 'app', status: 'pago',
      date: new Date().toISOString().slice(0, 10),
    });
  } catch (e) { console.error('addPaidAppExpenseIfNeeded', e.message); }
}

export async function logMessage({ leadId, phone, direction, body, messageId = null, status = null }) {
  await sb().from('messages').insert({
    lead_id: leadId || null, phone, direction, body, message_id: messageId, status,
  });
  if (leadId) {
    await sb().from('leads').update({ last_contact_at: new Date().toISOString() }).eq('id', leadId);
  }
}

// Mensagem padrão de NOVA VENDA para o admin — usada pelo webhook do
// Mercado Pago, pela conciliação do cron e pelo "marcar pago" do CRM.
export function buildSaleAlert({ name, username, plan, amount, method = 'Pix' }) {
  const valor = Number(amount || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const quando = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  }).format(new Date());
  return [
    '🧡 *HYPERFLICK* — 🎉 *NOVA VENDA CONFIRMADA!*',
    '━━━━━━━━━━━━━━━',
    `👤 *Cliente:* ${name || '—'}`,
    ...(username ? [`🔑 *Usuário:* ${username}`] : []),
    `📦 *Plano:* ${plan || '—'}`,
    `💰 *Valor:* R$ ${valor}`,
    `💳 *Pagamento:* ${method} ✅`,
    `🗓️ *Data:* ${quando}`,
    '━━━━━━━━━━━━━━━',
    '🚀 Acesso do cliente ativo. Lembre-se de renovar no painel!',
  ].join('\n');
}

// Notifica o número admin (configurado em settings.admin_phone) — sem registrar como conversa.
export async function notifyAdmin(text) {
  try {
    const { data } = await sb().from('settings').select('value').eq('key', 'admin_phone').maybeSingle();
    const phone = data?.value?.phone;
    if (!phone) return;
    const inst = await getActiveInstance();
    if (!inst) return;
    await uazapi.sendText(inst.token, normalizePhone(phone), text);
  } catch (e) { console.error('notifyAdmin', e.message); }
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
    test_created_at: new Date().toISOString(),
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
