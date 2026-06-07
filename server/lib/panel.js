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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch { d = {}; }

  if (!res.ok || !d.username) {
    const e = new Error('O painel não retornou as credenciais do teste.');
    e.data = d;
    throw e;
  }

  return {
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
