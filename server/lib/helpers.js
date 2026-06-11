import { config } from '../config.js';

// Normaliza telefone para o formato uazapi: só dígitos, com DDI 55.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  // Remove zeros à esquerda
  d = d.replace(/^0+/, '');
  // Se já vier com DDI 55 (12-13 dígitos), mantém
  if (d.length >= 12 && d.startsWith('55')) return d;
  // 10 (fixo) ou 11 (celular) dígitos = DDD + número → prefixa 55
  if (d.length === 10 || d.length === 11) return '55' + d;
  // fallback: devolve como está
  return d;
}

// Variantes de um celular BR: com e sem o nono dígito. O JID do WhatsApp pode
// vir sem o 9 (ex.: 556299590736) enquanto o lead foi salvo com ele
// (5562999590736) — ao buscar o lead pelo telefone, use as duas formas.
export function phoneVariants(raw) {
  const p = normalizePhone(raw);
  const out = new Set(p ? [p] : []);
  if (p.startsWith('55')) {
    const rest = p.slice(2); // DDD + número
    if (rest.length === 11 && rest[2] === '9') out.add('55' + rest.slice(0, 2) + rest.slice(3));
    if (rest.length === 10) out.add('55' + rest.slice(0, 2) + '9' + rest.slice(2));
  }
  return [...out];
}

// Gera credenciais de teste (placeholder — troque pela API do seu painel IPTV).
export function genTestCredentials() {
  const rnd = (n) =>
    Array.from({ length: n }, () =>
      'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]
    ).join('');
  return {
    username: 'hf' + rnd(6),
    password: rnd(6),
  };
}

export function planPrice(plan) {
  const p = String(plan || '').toLowerCase();
  if (p.includes('semes')) return config.prices.semestral;
  if (p.includes('anu')) return config.prices.anual;
  return config.prices.mensal; // mensal / recomendado / default
}

// Equivalente mensal (para cálculo de MRR)
export function planMonthly(plan) {
  const p = String(plan || '').toLowerCase();
  if (p.includes('semes')) return config.prices.semestral / 6;
  if (p.includes('anu')) return config.prices.anual / 12;
  return config.prices.mensal;
}

export function planMonths(plan) {
  const p = String(plan || '').toLowerCase();
  if (p.includes('semes')) return 6;
  if (p.includes('anu')) return 12;
  return 1;
}

// Preenche template {nome} {app} {url} {usuario} {senha} {validade}
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? vars[k] : ''
  );
}

// Detecta intenção de compra na mensagem do cliente (clicou num botão de compra
// ou digitou algo demonstrando desejo de assinar). Compartilhado pelo webhook e quiz.
export function isBuyIntent(t) {
  const s = (t || '').toLowerCase();
  return /(quero comprar|comprar|quero assinar|assinar|assinatura|quero pagar|pagar|como pago|como assino|como fa[çc]o pra assinar|adquirir|renovar|me manda o pix|manda o pix|quero o pix|quero pix|gerar pix|quero o plano|quero plano|ver planos|quanto custa|pre[çc]o|valor|vou querer|quero sim|fechar|contratar)/.test(s);
}

export function formatDateTimeBR(date) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}
