// Quiz de qualificação DENTRO do WhatsApp (substitui o quiz da página).
// Tráfego pago → link wa.me com a frase-gatilho → webhook cria o lead e
// conduz a conversa com botões/listas (uazapi /send/menu) até gerar o teste.
//
// Estados (leads.wa_quiz_state):
//   ask_name → ask_situacao → ask_device → ask_brand|ask_mobile → ask_plan → done
import { sb } from '../supabase.js';
import { sendWhatsApp, sendWhatsAppRich, generateTestForLead, logMessage } from './service.js';

// Normaliza para comparação: minúsculas e sem acentos.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------- Configuração (settings.wa_quiz) ----------
export async function getWaQuizSettings() {
  try {
    const { data } = await sb().from('settings').select('value').eq('key', 'wa_quiz').maybeSingle();
    const v = data?.value || {};
    return {
      enabled: v.enabled !== false,
      trigger: v.trigger || 'Quero meu teste grátis da HyperFlick! 🧡',
    };
  } catch { return { enabled: false, trigger: '' }; }
}

// A mensagem dispara o quiz? Compara sem acentos; basta conter a frase-gatilho
// (ou as palavras "teste" + "gratis", pro caso do cliente digitar de cabeça).
export function quizTriggerMatch(text, trigger) {
  const t = norm(text);
  if (!t) return false;
  if (trigger && t.includes(norm(trigger))) return true;
  return t.includes('teste') && (t.includes('gratis') || t.includes('hyperflick'));
}

// ---------- Perguntas ----------
const SITUACOES = [
  { label: '💸 Pago caro na TV por assinatura', v: 'paga_caro' },
  { label: '⚠️ Uso um IPTV que vive travando', v: 'iptv_ruim' },
  { label: '🧩 Assino vários streamings', v: 'varios' },
  { label: '🚀 Ainda não tenho nada fixo', v: 'nada' },
];
const DEVICES = [
  { label: '📺 Smart TV', v: 'smarttv' },
  { label: '📦 TV Box', v: 'tvbox' },
  { label: '🔥 Fire Stick', v: 'firestick' },
  { label: '📱 Celular / Tablet', v: 'celular' },
  { label: '💻 Notebook / PC', v: 'pc' },
];
const BRANDS = [
  { label: 'Samsung', v: 'samsung' },
  { label: 'LG', v: 'lg' },
  { label: 'Roku TV', v: 'roku' },
  { label: 'Android TV', v: 'android' },
  { label: 'Outra marca', v: 'outras' },
];
const MOBILES = [
  { label: '🤖 Android', v: 'android' },
  { label: '🍎 iPhone / iPad', v: 'iphone' },
];
const PLANS = [
  { label: 'Mensal — R$ 19,90', v: 'mensal' },
  { label: '⭐ Semestral — R$ 79,90', v: 'semestral' },
  { label: 'Anual — R$ 129,90', v: 'anual' },
];

// App recomendado por aparelho/marca (mesma regra do funil web).
const APP_RULES = {
  'smarttv:samsung': 'IPTV Smarters',
  'smarttv:lg': 'IPTV Smarters',
  'smarttv:roku': 'Assist Plus',
  'smarttv:android': 'RP725',
  'smarttv:outras': 'XC IPTV',
  'tvbox:_': 'RP725',
  'firestick:_': 'Assist Plus',
  'celular:android': 'RP725',
  'celular:iphone': 'VU IPTV Player',
  'pc:_': 'Smarters IPTV',
};

// Lista numerada para o corpo da mensagem (fallback caso a lista não renderize).
const numbered = (opts) => opts.map((o, i) => `${i + 1}️⃣ ${o.label}`).join('\n');

// Interpreta a resposta: número (1, 2...), id da opção ou trecho do rótulo.
function matchOption(opts, text) {
  const t = norm(text);
  if (!t) return null;
  const byNum = t.match(/^[^\d]*(\d{1,2})[^\d]*$/);
  if (byNum) { const i = Number(byNum[1]) - 1; if (opts[i]) return opts[i]; }
  for (const o of opts) {
    const l = norm(o.label).replace(/^[^a-z0-9]+/, ''); // sem o emoji
    if (t === norm(o.v) || t.includes(l) || l.includes(t)) return o;
  }
  // palavras-chave parciais (ex.: "samsung", "celular", "mensal")
  for (const o of opts) {
    const words = norm(o.label).split(/\s+/).filter((w) => w.length >= 4);
    if (words.some((w) => t.includes(w))) return o;
  }
  return null;
}

async function setState(leadId, patch) {
  await sb().from('leads').update(patch).eq('id', leadId);
}

// Pergunta com menu: ≤3 opções vão como botões; 4+ como lista.
async function askMenu(lead, text, opts) {
  const buttons = opts.map((o) => ({ text: o.label }));
  await sendWhatsAppRich({
    leadId: lead.id, phone: lead.phone,
    text: `${text}\n\n${numbered(opts)}\n\nToque numa opção ou responda com o número 👇`,
    buttons,
    footer: 'HyperFlick • IPTV',
    ...(opts.length > 3 ? { listButton: 'Ver opções 📋' } : {}),
  });
}

// ---------- Início do quiz (número novo com a frase-gatilho) ----------
export async function startWaQuiz({ phone, pushName, inboundText = '', inboundId = null }) {
  const { data: lead, error } = await sb().from('leads').insert({
    name: pushName || 'Cliente WhatsApp',
    phone,
    stage: 'lead',
    source: 'whatsapp',
    quiz: {},
    wa_quiz_state: 'ask_name',
  }).select().single();
  if (error) { console.error('startWaQuiz insert:', error.message, '(rodou o schema atualizado?)'); return null; }

  // registra a mensagem que iniciou a conversa ANTES da saudação (ordem do chat)
  if (inboundText) {
    try { await logMessage({ leadId: lead.id, phone, direction: 'in', body: inboundText, messageId: inboundId }); }
    catch (e) { console.error('startWaQuiz log:', e.message); }
  }

  await sendWhatsApp({
    leadId: lead.id, phone,
    text:
      'Oi! Que bom te ver por aqui 🧡\n\n' +
      'Você acaba de garantir um *teste grátis* da *HyperFlick* — +800 canais, +60 mil filmes e séries, futebol ao vivo, tudo num app só e sem travar. 📺⚽✨\n\n' +
      'Pra eu liberar seu acesso agorinha, me conta:\n\n*Qual é o seu nome?* 😊',
  });
  return lead;
}

// ---------- Respostas durante o quiz ----------
// Retorna { handled: true } quando a mensagem foi consumida pelo quiz.
export async function handleQuizReply(lead, text) {
  const state = lead.wa_quiz_state;
  const quiz = lead.quiz || {};
  const nome = () => (lead.name || '').split(' ')[0];

  try {
    if (state === 'ask_name') {
      const name = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (name.length < 2 || /^\d+$/.test(name)) {
        await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text: 'Não peguei seu nome 🙈 Pode digitar de novo?' });
        return { handled: true };
      }
      await setState(lead.id, { name, wa_quiz_state: 'ask_situacao' });
      lead.name = name;
      await askMenu(lead, `Prazer, *${name.split(' ')[0]}*! 🤝\n\n*Como você assiste seus canais, filmes e jogos hoje?*`, SITUACOES);
      return { handled: true };
    }

    if (state === 'ask_situacao') {
      const opt = matchOption(SITUACOES, text);
      if (!opt) { await askMenu(lead, 'Não entendi 🙈 *Como você assiste hoje?*', SITUACOES); return { handled: true }; }
      quiz.situacao = opt.v;
      await setState(lead.id, { quiz, wa_quiz_state: 'ask_device' });
      await askMenu(lead, 'Anotado! ✍️\n\n*Onde você vai assistir?*', DEVICES);
      return { handled: true };
    }

    if (state === 'ask_device') {
      const opt = matchOption(DEVICES, text);
      if (!opt) { await askMenu(lead, 'Não entendi 🙈 *Onde você vai assistir?*', DEVICES); return { handled: true }; }
      quiz.device = opt.v;
      if (opt.v === 'smarttv') {
        await setState(lead.id, { quiz, device: opt.v, wa_quiz_state: 'ask_brand' });
        await askMenu(lead, 'Boa! 📺\n\n*Qual a marca da sua Smart TV?* (cada marca usa um app diferente)', BRANDS);
        return { handled: true };
      }
      if (opt.v === 'celular') {
        await setState(lead.id, { quiz, device: opt.v, wa_quiz_state: 'ask_mobile' });
        await askMenu(lead, 'Show! 📱\n\n*Seu celular é Android ou iPhone?*', MOBILES);
        return { handled: true };
      }
      return finishQuiz(lead, quiz, opt.v, '_');
    }

    if (state === 'ask_brand') {
      const opt = matchOption(BRANDS, text);
      if (!opt) { await askMenu(lead, 'Não entendi 🙈 *Qual a marca da TV?*', BRANDS); return { handled: true }; }
      return finishQuiz(lead, quiz, 'smarttv', opt.v);
    }

    if (state === 'ask_mobile') {
      const opt = matchOption(MOBILES, text);
      if (!opt) { await askMenu(lead, 'Não entendi 🙈 *Android ou iPhone?*', MOBILES); return { handled: true }; }
      return finishQuiz(lead, quiz, 'celular', opt.v);
    }

    if (state === 'ask_plan') {
      const opt = matchOption(PLANS, text);
      if (!opt) return { handled: false }; // deixa o gatilho de compra/conversa normal agir
      await setState(lead.id, { plan: opt.v, wa_quiz_state: 'done' });
      await sendWhatsApp({
        leadId: lead.id, phone: lead.phone,
        text:
          `Boa escolha, ${nome()}! 🧡 *Plano ${opt.v.charAt(0).toUpperCase() + opt.v.slice(1)}* anotado.\n\n` +
          'Aproveita seu teste à vontade. Quando quiser liberar o acesso completo, é só me responder *"quero assinar"* que te mando o Pix na hora. 🚀',
      });
      return { handled: true };
    }
  } catch (e) {
    console.error('handleQuizReply:', e.message);
    return { handled: true };
  }
  return { handled: false };
}

// Marca/brand definidos → grava o app recomendado, gera o teste e oferece os planos.
async function finishQuiz(lead, quiz, device, brand) {
  const app = APP_RULES[`${device}:${brand}`] || APP_RULES[`${device}:_`] || 'XC IPTV';
  quiz.device = device;
  if (brand !== '_') quiz.brand = brand;
  await setState(lead.id, {
    quiz, device, brand: brand === '_' ? null : brand, app, wa_quiz_state: 'generating',
  });
  const nome = (lead.name || '').split(' ')[0];

  await sendWhatsApp({
    leadId: lead.id, phone: lead.phone,
    text: `Perfeito, ${nome}! 🚀 O app ideal pra você é o *${app}*.\n\nJá estou gerando seu *teste grátis*... me dá só um instante. ⏳`,
  });

  try {
    // gera o teste real e envia as credenciais (mesma rotina do funil/CRM)
    await generateTestForLead({ ...lead, quiz, device, brand: brand === '_' ? null : brand, app });
    await setState(lead.id, { wa_quiz_state: 'ask_plan' });
    await askMenu(
      { ...lead },
      'Seu acesso de teste chegou aí em cima 👆 É só instalar o app e entrar com os dados.\n\n' +
      'E me conta: *quando o teste acabar, qual plano combina mais com você?*\n_(pode responder depois de testar 😉)_',
      PLANS
    );
  } catch (e) {
    console.error('finishQuiz generateTest:', e.message);
    await setState(lead.id, { wa_quiz_state: 'done' });
    try {
      await sendWhatsApp({
        leadId: lead.id, phone: lead.phone,
        text: `${nome}, tive um probleminha pra gerar seu teste agora 😅 Mas fica tranquilo: já estou resolvendo e te mando o acesso em instantes! 🧡`,
      });
    } catch { /* sem instância */ }
  }
  return { handled: true };
}
