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
  // opts: { phone?, proxyCity?, proxyState? } — cidade/estado ativam o PROXY
  // REGIONAL da uazapi (IP da mesma região do chip = menos risco de banimento).
  connect(token, opts = {}) {
    const o = typeof opts === 'string' ? { phone: opts } : (opts || {});
    const body = {};
    if (o.phone) body.phone = o.phone;
    if (o.proxyCity) {
      body.proxy_managed_country = 'br';
      body.proxy_managed_city = o.proxyCity;
      if (o.proxyState) body.proxy_managed_state = o.proxyState;
    }
    return call('/instance/connect', { method: 'POST', token, body });
  },
  // Cidades disponíveis para o proxy regional (autocomplete do modal Conectar).
  // Retorna { cities: [{ value, label, state, state_label }] }
  proxyCities(token, { country = 'br', search = '' } = {}) {
    const q = new URLSearchParams({ country, ...(search ? { search } : {}) });
    return call(`/proxy-managed/cities?${q}`, { method: 'GET', token });
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
  // delay (ms): durante o atraso o WhatsApp mostra "Digitando..." (mais humano).
  sendText(token, number, text, { delay } = {}) {
    return call('/send/text', { method: 'POST', token, body: { number, text, linkPreview: false, ...(delay ? { delay } : {}) } });
  },
  // Envia mídia (imagem/vídeo/documento). file = URL pública OU base64/data-uri.
  // type: 'image' | 'video' | 'document' | 'audio'
  sendMedia(token, number, { type = 'image', file, text = '', docName, delay } = {}) {
    return call('/send/media', {
      method: 'POST', token,
      body: { number, type, file, text, ...(docName ? { docName } : {}), ...(delay ? { delay } : {}) },
    });
  },
  // Envia menu com botões de resposta rápida ou lista de opções.
  // choices = ['Opção 1', 'Opção 2', ...]
  // type 'list' precisa de listButton (texto do botão que abre a lista).
  // imageButton: imagem EMBUTIDA nos botões (1 mensagem só, em vez de imagem + menu).
  sendMenu(token, number, { text, choices = [], footerText = '', type = 'button', listButton = '', imageButton = '', delay } = {}) {
    return call('/send/menu', {
      method: 'POST', token,
      body: {
        number, type, text, choices, footerText,
        ...(listButton ? { listButton } : {}),
        ...(imageButton ? { imageButton } : {}),
        ...(delay ? { delay } : {}),
      },
    });
  },
  // ---- Grupos (token da instância) ----
  // Entra num grupo pelo código/URL do convite. Retorna { response, group:{JID,Name}, needs_refresh }
  joinGroup(token, invitecode) {
    return call('/group/join', { method: 'POST', token, body: { invitecode } });
  },
  // Info do grupo (com participantes). Retorna { JID, Name, Participants:[{PhoneNumber,DisplayName,...}] }
  groupInfo(token, groupjid, { force = true } = {}) {
    return call('/group/info', { method: 'POST', token, body: { groupjid, force } });
  },
  // Info pelo convite (prévia sem entrar). Retorna { JID, Name, Participants? }
  groupInviteInfo(token, invitecode) {
    return call('/group/inviteInfo', { method: 'POST', token, body: { invitecode } });
  },
  // Sai do grupo.
  leaveGroup(token, groupjid) {
    return call('/group/leave', { method: 'POST', token, body: { groupjid } });
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
