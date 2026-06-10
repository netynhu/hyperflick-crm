// Cliente uazapi (WhatsApp API) — endpoints confirmados na API v2.
// Auth: header `admintoken` (admin) | header `token` (instância).
import { config } from './config.js';

const BASE = config.uazapi.url;

async function call(path, { method = 'GET', body, token, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers.admintoken = config.uazapi.adminToken;
  if (token) headers.token = token;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.message || data?.error || `uazapi ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const uazapi = {
  // ---- Admin (admintoken) ----
  // Cria/inicializa uma nova instância. Retorna { instance: { id, token, ... } }
  createInstance(name) {
    return call('/instance/init', { method: 'POST', admin: true, body: { name } });
  },
  listInstances() {
    return call('/instance/all', { method: 'GET', admin: true });
  },

  // ---- Instância (token) ----
  // Conecta gerando QR Code / pair code. Retorna { qrcode, paircode, instance }
  connect(token, phone) {
    return call('/instance/connect', { method: 'POST', token, body: phone ? { phone } : {} });
  },
  status(token) {
    return call('/instance/status', { method: 'GET', token });
  },
  disconnect(token) {
    return call('/instance/disconnect', { method: 'POST', token });
  },
  deleteInstance(token) {
    return call('/instance/delete', { method: 'DELETE', token });
  },
  // Envia mensagem de texto. number = 5511999999999
  sendText(token, number, text) {
    return call('/send/text', { method: 'POST', token, body: { number, text, linkPreview: false } });
  },
  // Envia mídia (imagem/vídeo/documento). file = URL pública OU base64/data-uri.
  // type: 'image' | 'video' | 'document' | 'audio'
  sendMedia(token, number, { type = 'image', file, text = '', docName } = {}) {
    return call('/send/media', {
      method: 'POST', token,
      body: { number, type, file, text, ...(docName ? { docName } : {}) },
    });
  },
  // Envia menu com botões de resposta rápida ou lista de opções.
  // choices = ['Opção 1', 'Opção 2', ...]
  // type 'list' precisa de listButton (texto do botão que abre a lista).
  sendMenu(token, number, { text, choices = [], footerText = '', type = 'button', listButton = '' } = {}) {
    return call('/send/menu', {
      method: 'POST', token,
      body: { number, type, text, choices, footerText, ...(listButton ? { listButton } : {}) },
    });
  },
  // Registra o webhook para receber mensagens de entrada
  setWebhook(token, url) {
    return call('/webhook', {
      method: 'POST',
      token,
      body: { enabled: true, url, events: ['messages'], excludeMessages: ['fromMe'] },
    });
  },
};
