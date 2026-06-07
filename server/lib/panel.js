// Integração com o painel IPTV (uhdpainel) — gera o teste real.
// O endpoint de "chatbot" recebe uma mensagem (formato de webhook de WhatsApp)
// e responde com as credenciais do teste em JSON.
import { config } from '../config.js';

// "2026-06-07 14:54:20" (horário de Brasília) -> Date
function parseBrDate(s) {
  if (!s) return null;
  const dt = new Date(String(s).replace(' ', 'T') + '-03:00');
  return isNaN(dt.getTime()) ? null : dt;
}

export async function generatePanelTest({ name, phone }) {
  const url = config.panel.chatbotUrl;
  if (!url) {
    const e = new Error('PANEL_CHATBOT_URL não configurado no .env');
    e.code = 'NO_PANEL';
    throw e;
  }

  const payload = {
    appName: 'com.whatsapp',
    messageDateTime: Math.floor(Date.now() / 1000),
    devicePhone: 'hyperflick',
    deviceName: 'HyperFlick',
    senderName: name || 'Cliente',
    senderMessage: config.panel.trigger || 'teste',
    senderPhone: phone,
    userAgent: 'HyperFlick',
  };

  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (err) {
    const e = new Error('Falha ao contatar o painel: ' + err.message);
    e.code = 'NETWORK';
    throw e;
  }

  let d;
  try { d = JSON.parse(text); } catch { d = {}; }

  // O painel não gerou credenciais (ex.: HTTP 400 "Você já solicitou um teste").
  // Não lança exceção — devolve estruturado para o fluxo tratar com elegância.
  if (!d.username) {
    return {
      ok: false,
      message: d.reply || d.message || 'O painel não gerou um novo teste.',
      raw: d,
    };
  }

  return {
    ok: true,
    username: String(d.username),
    password: String(d.password || ''),
    dns: d.dns || '',
    package: d.package || '',
    payUrl: d.payUrl || '',
    connections: d.connections || 1,
    expiresAt: parseBrDate(d.expiresAt),
    expiresLabel: d.expiresAtFormatted || '',
    reply: d.reply || d?.data?.[0]?.message || '',
  };
}
