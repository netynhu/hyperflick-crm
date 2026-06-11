// Quiz de qualificação DENTRO do WhatsApp (tráfego pago + disparo em massa).
//
// FLUXO (sem atrito — pergunta o nome só DEPOIS da compra paga):
//   gatilho/disparo → ask_device → ask_brand|ask_mobile → (gera o teste) → browsing
//   browsing + intenção de compra → ask_plan (planos clicáveis, preço só na opção)
//   ask_plan + clique no plano → gera o Pix na hora → await_payment
//   Pix PAGO (billing.js) → post_sale_name (pede o nome) → done
//
// As perguntas usam botões/listas da uazapi; o texto da mensagem NÃO repete as
// opções (ficam só nos botões clicáveis). O parser ainda aceita número/texto
// como rede de segurança.
import { sb } from '../supabase.js';
import { config } from '../config.js';
import { isBuyIntent } from './helpers.js';
import { sendWhatsApp, sendWhatsAppRich, generateTestForLead, logMessage, insertLeadSafe } from './service.js';
import { deliverPixToLead } from './followup.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const money = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// Estados em que a resposta do cliente é consumida pelo quiz.
const ACTIVE_STATES = ['ask_device', 'ask_brand', 'ask_mobile', 'generating', 'browsing', 'ask_plan', 'await_payment', 'post_sale_name'];
export const isQuizActive = (state) => ACTIVE_STATES.includes(state);

// ---------- Configuração (settings.wa_quiz) ----------
export async function getWaQuizSettings() {
  try {
    const { data } = await sb().from('settings').select('value').eq('key', 'wa_quiz').maybeSingle();
    const v = data?.value || {};
    return {
      enabled: v.enabled !== false,
      trigger: v.trigger || 'Quero meu teste grátis da HyperFlick! 🧡',
      dispatchStartsQuiz: v.dispatchStartsQuiz !== false, // disparo que responde também entra no quiz
    };
  } catch { return { enabled: false, trigger: '', dispatchStartsQuiz: false }; }
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
// Planos: preço fica SÓ na opção clicável (config.prices mantém em sincronia).
function planOptions() {
  const p = config.prices;
  return [
    { label: `📅 Mensal — ${money(p.mensal)}`, v: 'mensal' },
    { label: `⭐ Semestral — ${money(p.semestral)}`, v: 'semestral' },
    { label: `👑 Anual — ${money(p.anual)}`, v: 'anual' },
  ];
}

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

// Interpreta a resposta: id da opção (número), valor (v) ou trecho do rótulo.
function matchOption(opts, text) {
  const t = norm(text);
  if (!t) return null;
  const byNum = t.match(/^[^\d]*(\d{1,2})[^\d]*$/);
  if (byNum) { const i = Number(byNum[1]) - 1; if (opts[i]) return opts[i]; }
  for (const o of opts) {
    const l = norm(o.label).replace(/^[^a-z0-9]+/, ''); // sem o emoji inicial
    if (t === norm(o.v) || t.includes(l) || l.includes(t)) return o;
  }
  for (const o of opts) { // palavras-chave (ex.: "samsung", "celular", "mensal")
    const words = norm(o.label).split(/\s+/).filter((w) => w.length >= 4 && !/^r\$?$/.test(w));
    if (words.some((w) => t.includes(w))) return o;
  }
  return null;
}

async function setState(leadId, patch) {
  await sb().from('leads').update(patch).eq('id', leadId);
}

// Pergunta com menu: ≤3 opções como botões; 4+ como lista. O texto NÃO lista as
// opções — elas vão só nos botões clicáveis (choice "label|id").
async function askMenu(lead, text, opts) {
  const buttons = opts.map((o, i) => `${o.label}|${i + 1}`);
  await sendWhatsAppRich({
    leadId: lead.id, phone: lead.phone,
    text, buttons, footer: 'HyperFlick • IPTV',
    ...(opts.length > 3 ? { listButton: 'Toque para escolher 👇' } : {}),
  });
}

const firstName = (lead) => (lead.name || '').split(' ')[0] || '';

// Primeira pergunta do funil: onde vai assistir (com a saudação embutida).
async function askDevice(lead, greet = true) {
  const head = greet
    ? 'Oi! Que bom te ver por aqui 🧡\n\nVocê garantiu um *teste grátis* da *HyperFlick* — +800 canais, +60 mil filmes e séries e futebol ao vivo, tudo num app só e sem travar. 📺⚽\n\n'
    : '';
  await askMenu(lead, `${head}Pra começar, *onde você vai assistir?*`, DEVICES);
}

// ---------- Entradas no quiz ----------
// Número novo (tráfego pago) que mandou a frase-gatilho.
export async function startWaQuiz({ phone, pushName, inboundText = '', inboundId = null, tag = 'trafego_pago', source = 'whatsapp' }) {
  const { data: lead, error } = await insertLeadSafe({
    name: pushName || 'Cliente',
    phone, stage: 'lead', source, tag,
    quiz: {}, wa_quiz_state: 'ask_device', name_confirmed: false,
  });
  if (error) {
    console.error('startWaQuiz insert:', error.message);
    return null;
  }
  if (inboundText) {
    try { await logMessage({ leadId: lead.id, phone, direction: 'in', body: inboundText, messageId: inboundId }); }
    catch (e) { console.error('startWaQuiz log:', e.message); }
  }
  try { await askDevice(lead, true); }
  catch (e) { console.error('startWaQuiz askDevice:', e.message); }
  return lead;
}

// Lead JÁ EXISTENTE entra/reinicia o quiz (clicou no anúncio de novo, veio do
// funil web, ou é lead de disparo que respondeu). Cliente GANHO não é re-quizado.
export async function enterQuiz(lead, { greet = true } = {}) {
  await setState(lead.id, { wa_quiz_state: 'ask_device', quiz: {} });
  try { await askDevice(lead, greet); } catch (e) { console.error('enterQuiz askDevice:', e.message); }
  return { handled: true };
}

// Mostra os planos (clicáveis, preço só na opção) e entra em ask_plan.
export async function offerPlans(lead, intro) {
  await setState(lead.id, { wa_quiz_state: 'ask_plan' });
  const head = intro || `${firstName(lead) ? firstName(lead) + ', q' : 'Q'}ue bom! 🧡\n\n*Qual plano combina com você?*`;
  await askMenu(lead, head, planOptions());
  return { handled: true };
}

// Cliente clicou num plano → grava o plano e gera o Pix na hora.
async function choosePlan(lead, planV) {
  await setState(lead.id, { plan: planV, wa_quiz_state: 'await_payment' });
  const nome = firstName(lead);
  const intro = `${nome ? nome + ', p' : 'P'}erfeito! 🧡 Bora liberar seu acesso *completo* da HyperFlick. Aqui está seu Pix:`;
  try {
    await deliverPixToLead({ ...lead, plan: planV }, intro);
  } catch (e) {
    console.error('choosePlan pix:', e.message);
    await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text: `${nome ? nome + ', t' : 'T'}ive um probleminha pra gerar o Pix agora 😅 Já tô resolvendo e te mando em instantes!` });
  }
  return { handled: true };
}

// Marca/brand definidos → grava o app recomendado, gera o teste e segue pro
// "browsing" (NÃO empurra os planos; deixa o cliente testar).
async function finishQuiz(lead, quiz, device, brand) {
  const app = APP_RULES[`${device}:${brand}`] || APP_RULES[`${device}:_`] || 'XC IPTV';
  quiz.device = device;
  if (brand !== '_') quiz.brand = brand;
  await setState(lead.id, { quiz, device, brand: brand === '_' ? null : brand, app, wa_quiz_state: 'generating' });
  const nome = firstName(lead);

  // mensagem de "gerando" é só cortesia — se falhar, NÃO impede o teste de sair
  try {
    await sendWhatsApp({
      leadId: lead.id, phone: lead.phone,
      text: `${nome ? 'Perfeito, ' + nome + '! ' : 'Perfeito! '}🚀 O app ideal pra você é o *${app}*.\n\nJá tô gerando seu *teste grátis*... um instante. ⏳`,
    });
  } catch (e) { console.error('finishQuiz gerando msg:', e.message); }

  try {
    await generateTestForLead({ ...lead, quiz, device, brand: brand === '_' ? null : brand, app });
    // Teste enviado. Convida a testar e ensina o "atalho" de compra — sem listar planos.
    await setState(lead.id, { wa_quiz_state: 'browsing' });
    await sendWhatsApp({
      leadId: lead.id, phone: lead.phone,
      text:
        'Seu acesso de teste chegou aí em cima 👆 É só instalar o app e entrar com os dados.\n\n' +
        'Qualquer dúvida na instalação, me chama! 🧡\n\nQuando quiser liberar seu acesso *completo*, é só mandar *"quero assinar"* que eu te mostro os planos. 😉',
    });
  } catch (e) {
    console.error('finishQuiz generateTest:', e.message);
    await setState(lead.id, { wa_quiz_state: 'browsing' });
    try {
      await sendWhatsApp({
        leadId: lead.id, phone: lead.phone,
        text: `${nome ? nome + ', t' : 'T'}ive um probleminha pra gerar seu teste agora 😅 Já tô resolvendo e te mando o acesso em instantes! 🧡`,
      });
    } catch { /* sem instância */ }
  }
  return { handled: true };
}

// ---------- Respostas durante o quiz ----------
// Retorna { handled } — true quando a mensagem foi consumida pelo quiz.
export async function handleQuizReply(lead, text) {
  const state = lead.wa_quiz_state;
  const quiz = lead.quiz || {};
  const buy = isBuyIntent(text);

  try {
    if (state === 'ask_device') {
      // mandou a frase-gatilho de novo? recomeça a pergunta
      if (quizTriggerMatch(text, '')) { await askDevice(lead, false); return { handled: true }; }
      const opt = matchOption(DEVICES, text);
      if (!opt) { await askMenu(lead, 'Toque numa opção pra eu saber *onde você vai assistir* 👇', DEVICES); return { handled: true }; }
      quiz.device = opt.v;
      if (opt.v === 'smarttv') {
        await setState(lead.id, { quiz, device: opt.v, wa_quiz_state: 'ask_brand' });
        await askMenu(lead, 'Boa! 📺 *Qual a marca da sua Smart TV?*', BRANDS);
        return { handled: true };
      }
      if (opt.v === 'celular') {
        await setState(lead.id, { quiz, device: opt.v, wa_quiz_state: 'ask_mobile' });
        await askMenu(lead, 'Show! 📱 *Seu celular é Android ou iPhone?*', MOBILES);
        return { handled: true };
      }
      return finishQuiz(lead, quiz, opt.v, '_');
    }

    if (state === 'ask_brand') {
      const opt = matchOption(BRANDS, text);
      if (!opt) { await askMenu(lead, 'Toque na *marca da sua TV* 👇', BRANDS); return { handled: true }; }
      return finishQuiz(lead, quiz, 'smarttv', opt.v);
    }

    if (state === 'ask_mobile') {
      const opt = matchOption(MOBILES, text);
      if (!opt) { await askMenu(lead, 'É *Android ou iPhone?* 👇', MOBILES); return { handled: true }; }
      return finishQuiz(lead, quiz, 'celular', opt.v);
    }

    if (state === 'generating') {
      // teste ainda saindo; segura a ansiedade sem duplicar
      return { handled: true };
    }

    if (state === 'browsing') {
      // está testando: só age se demonstrar intenção de compra → mostra os planos
      if (buy) return offerPlans(lead);
      return { handled: false }; // deixa a conversa fluir (atendimento humano)
    }

    if (state === 'ask_plan') {
      const opt = matchOption(planOptions(), text);
      if (opt) return choosePlan(lead, opt.v);
      if (buy) return offerPlans(lead, 'Claro! 🧡 *Escolha seu plano:*'); // reapresenta
      return { handled: false };
    }

    if (state === 'await_payment') {
      // já gerou o Pix; se pedir de novo, reenvia o mesmo Pix pendente
      if (buy || matchOption(planOptions(), text)) {
        const nome = firstName(lead);
        try { await deliverPixToLead(lead, `${nome ? nome + ', a' : 'A'}qui está seu Pix de novo 🧡`); }
        catch (e) { console.error('await_payment redeliver:', e.message); }
        return { handled: true };
      }
      return { handled: false };
    }

    if (state === 'post_sale_name') {
      const name = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (name.length < 2 || /^\d+$/.test(name)) {
        await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text: 'Pode me dizer seu *nome completo*? 😊' });
        return { handled: true };
      }
      await setState(lead.id, { name, name_confirmed: true, wa_quiz_state: 'done' });
      await sendWhatsApp({
        leadId: lead.id, phone: lead.phone,
        text: `Prontinho, ${name.split(' ')[0]}! ✅ Cadastro completo. Aproveite a HyperFlick e qualquer coisa é só chamar aqui. 🧡`,
      });
      return { handled: true };
    }
  } catch (e) {
    console.error('handleQuizReply:', e.message);
    return { handled: true };
  }
  return { handled: false };
}

// Chamado pelo billing quando o Pix é PAGO: pede o nome do cliente (1x).
export async function askNameAfterSale(lead) {
  if (!lead || lead.name_confirmed) return false;
  const tagOk = lead.source === 'whatsapp' || lead.tag === 'disparo' || lead.tag === 'trafego_pago';
  if (!tagOk) return false;
  await setState(lead.id, { wa_quiz_state: 'post_sale_name' });
  await sendWhatsApp({
    leadId: lead.id, phone: lead.phone,
    text: 'Pra finalizar seu cadastro, como é seu *nome completo*? 😊',
  });
  return true;
}
