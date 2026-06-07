/* ===================== HyperFlick — Funil (fluxo em etapas) ===================== */
const SUPPORT_WHATSAPP = "5500000000000"; // opcional: número de suporte com DDI

/* ---------- COUNTDOWN ---------- */
let t = 23 * 3600 + 46 * 60 + 30;
setInterval(() => {
  if (t > 0) t--;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  document.getElementById('timer').textContent = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}, 1000);

/* ---------- POSTERS (fundo) ---------- */
(function () {
  const grad = ['#7c2d12', '#f15a24', '#581c87', '#1e3a8a', '#831843', '#0c4a6e', '#3f1d1d', '#422006'];
  const wrap = document.getElementById('posters');
  for (let i = 0; i < 35; i++) {
    const d = document.createElement('div');
    d.style.background = `linear-gradient(135deg,${grad[i % grad.length]},#120b1c)`;
    wrap.appendChild(d);
  }
})();

/* ---------- SHELL ---------- */
const card = () => document.getElementById('card');
function show(id) {
  ['home', 'flow'].forEach(s => document.getElementById(s).classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  window.scrollTo(0, 0);
}
function setProg(pct, label) {
  document.getElementById('fill').style.width = pct + '%';
  document.getElementById('plbl').textContent = label || '';
}
/* Jornada com 10 etapas reais. A sub-escolha (marca da TV / sistema) compartilha
   o passo 6 com "dispositivo", por ser a mesma decisão. */
const TOTAL_STEPS = 10;
function setStep(n) { setProg(Math.round((n / TOTAL_STEPS) * 100), `Passo ${n} de ${TOTAL_STEPS}`); }

/* Feedback de seleção: destaca o item clicado e só então avança */
function flashSel(then) {
  const el = window.event && window.event.currentTarget;
  if (el && el.classList) { el.classList.add('sel'); setTimeout(then, 210); }
  else then();
}
/* Contagem animada dos números */
function countUp(el) {
  const to = +el.dataset.to || 0, pre = el.dataset.pre || '', suf = el.dataset.suf || '';
  const steps = 26; let i = 0;
  const t = setInterval(() => {
    i++; const v = Math.min(to, Math.round(to * i / steps));
    el.textContent = pre + v.toLocaleString('pt-BR') + suf;
    if (i >= steps) { clearInterval(t); el.textContent = pre + to.toLocaleString('pt-BR') + suf; }
  }, 24);
}
function restartAll() { for (const k in answers) delete answers[k]; show('home'); }
function paint(html) { const c = card(); c.style.animation = 'none'; void c.offsetWidth; c.style.animation = ''; c.innerHTML = html; }

/* ===================== QUIZ ===================== */
const answers = {};
const QUESTIONS = [
  { key: 'situacao', spark: '📺', q: 'Como você assiste seus canais, filmes e jogos hoje?', hint: 'Escolha o que mais combina 👇', opts: [
    { t: 'Pago caro na TV por assinatura', cls: 'ic-no', ic: '💸', v: 'paga_caro' },
    { t: 'Uso um IPTV que vive travando', cls: 'ic-no', ic: '⚠️', v: 'iptv_ruim' },
    { t: 'Assino vários streamings separados', cls: 'ic-rocket', ic: '🧩', v: 'varios' },
    { t: 'Ainda não tenho nada fixo', cls: 'ic-rocket', ic: '🚀', v: 'nada' } ] },
  { key: 'dor', spark: '😤', q: 'O que mais te incomoda na sua TV hoje?', hint: 'Pode escolher sua maior dor 👇', opts: [
    { t: 'Travamentos na hora do jogo', cls: 'ic-no', ic: '🔁', v: 'trava' },
    { t: 'Pagar muito por pouca coisa', cls: 'ic-no', ic: '💰', v: 'caro' },
    { t: 'Conteúdo espalhado em vários apps', cls: 'ic-no', ic: '📱', v: 'espalhado' },
    { t: 'Suporte que nunca resolve', cls: 'ic-no', ic: '🙄', v: 'suporte' } ] },
  { key: 'desejo', spark: '✨', q: 'Quer ter tudo num app só — canais ao vivo, jogos, filmes e séries, em 2 telas, sem travar?', hint: '👇', opts: [
    { t: 'Sim! É o que eu quero', cls: 'ic-yes', ic: '✓', v: 'sim' },
    { t: 'Quero, mas preciso ver funcionando', cls: 'ic-yes', ic: '👀', v: 'mostra' } ] },
];

function startQuiz() { show('flow'); renderQuestion(0); }
function renderQuestion(i) {
  const Q = QUESTIONS[i];
  paint(`
    <div class="spark">${Q.spark}</div>
    <h2>${Q.q}</h2>
    <p class="hint">${Q.hint}</p>
    <div class="opts">${Q.opts.map((o, idx) => `<div class="opt" onclick="answer(${i},${idx})"><span class="ic ${o.cls}">${o.ic}</span> ${o.t}</div>`).join('')}</div>
    ${i > 0 ? `<button class="back" onclick="renderQuestion(${i - 1})">← Voltar</button>` : ''}`);
  setStep(i + 1);
}
function answer(qi, oi) {
  answers[QUESTIONS[qi].key] = QUESTIONS[qi].opts[oi].v;
  flashSel(() => { if (qi + 1 < QUESTIONS.length) renderQuestion(qi + 1); else renderReveal(); });
}
function dorHeadline() {
  const map = { trava: 'Chega de travar na hora do gol ⚽', caro: 'Muito mais conteúdo pagando bem menos 💰', espalhado: 'Tudo num app só, sem pular entre vários 📱', suporte: 'Suporte humano e rápido no WhatsApp 🤝' };
  return map[answers.dor] || 'É exatamente isso que a HyperFlick entrega ✨';
}

/* ===================== REVEAL — o que você recebe ===================== */
const DELIVER = [
  { e: '🎬', b: '+50.000 filmes', s: 'Lançamentos e clássicos' },
  { e: '📺', b: 'Séries e novelas', s: 'Temporadas completas' },
  { e: '⚽', b: 'Esportes ao vivo', s: 'Futebol, UFC, NBA...' },
  { e: '🧒', b: 'Canais infantis', s: 'Diversão pra família' },
  { e: '🗡️', b: 'Animes em HD', s: 'Episódios atualizados' },
  { e: '🔞', b: 'Adultos (opcional)', s: 'Com senha de acesso' },
];
function renderReveal() {
  setStep(4);
  paint(`
    <div class="spark">🎉</div>
    <h2>${dorHeadline()}</h2>
    <p class="hint">Tudo isso num app só, em qualidade até 4K 👇</p>
    <div class="deliver">${DELIVER.map(d => `<div class="dchip"><span class="e">${d.e}</span><div><b>${d.b}</b><span>${d.s}</span></div></div>`).join('')}</div>
    <div class="stats">
      <div class="s"><div class="n" data-to="800" data-pre="+">+800</div><div class="l">canais</div></div>
      <div class="s"><div class="n" data-to="60" data-pre="+" data-suf="mil">+60mil</div><div class="l">filmes e séries</div></div>
      <div class="s"><div class="n" data-to="500" data-pre="+">+500</div><div class="l">novelas</div></div>
    </div>
    <button class="btn btn-primary btn-block" onclick="renderPlans()">Ver meu plano ideal →</button>
    <button class="back" onclick="renderQuestion(${QUESTIONS.length - 1})">← Voltar</button>`);
  setTimeout(() => document.querySelectorAll('.stats .n').forEach(countUp), 120);
}

/* ===================== PLANOS (etapa) ===================== */
const PLANS = [
  { id: 'Mensal', name: 'Mensal', sub: 'cobrança mensal', price: '19', cents: '90', best: false },
  { id: 'Semestral', name: 'Semestral', sub: '6 meses · R$ 13,32/mês', from: '119,40', off: '40% OFF', price: '79', cents: '90', best: true },
  { id: 'Anual', name: 'Anual', sub: '12 meses · R$ 10,82/mês', from: '238,80', off: '58% OFF', price: '129', cents: '90', best: false },
];
function renderPlans() {
  setStep(5);
  paint(`
    <div class="spark">💎</div>
    <h2>Escolha seu <span class="y">plano</span></h2>
    <p class="hint">Sem fidelidade • Ativação imediata • Cancele quando quiser</p>
    <div class="plans">
      ${PLANS.map(p => `
        <div class="plan ${p.best ? 'best' : ''}" onclick="flashSel(()=>startTest('${p.id}'))">
          ${p.best ? '<span class="ribbon">⭐ Mais escolhido</span>' : ''}
          <div class="pl-l"><b>${p.name}</b><span>${p.sub}</span>${p.off ? `<br><span class="off">🎁 ${p.off}</span>` : ''}</div>
          <div class="pl-r">${p.from ? `<div class="from">R$ ${p.from}</div>` : ''}<div class="price">R$ ${p.price}<small>,${p.cents}</small></div></div>
        </div>`).join('')}
    </div>
    <p class="hint mt" style="margin-bottom:0">🎁 Antes de assinar, você ganha um <b style="color:var(--orange-2)">teste grátis</b>.</p>
    <button class="back" onclick="renderReveal()">← Voltar</button>`);
}

/* ===================== TESTE: DISPOSITIVO → APP → LEAD ===================== */
let chosenPlan = 'Recomendado';
let flow = { device: null, brand: null, app: null };

const DEVICES = [
  { id: 'smarttv', name: 'Smart TV', sub: 'Samsung, LG, Roku...', svg: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="m17 2-5 5-5-5"/>' },
  { id: 'tvbox', name: 'TV Box', sub: 'Android para TV', svg: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="17" cy="12" r="1"/>' },
  { id: 'firestick', name: 'Fire Stick', sub: 'Amazon Fire TV', svg: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>' },
  { id: 'celular', name: 'Celular / Tablet', sub: 'Android e iPhone', svg: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>' },
  { id: 'pc', name: 'Notebook / PC', sub: 'Windows, Mac', svg: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>' },
];
const TV_BRANDS = [
  { id: 'samsung', name: 'Samsung', sub: 'Tizen' }, { id: 'lg', name: 'LG', sub: 'webOS' },
  { id: 'roku', name: 'Roku TV', sub: 'Roku OS' }, { id: 'android', name: 'Android TV', sub: 'Play Store' },
  { id: 'outras', name: 'Outra marca', sub: 'TCL, Philco...' },
];
const APP_RULES = {
  'smarttv:samsung': { apps: ['IPTV Smarters', 'IBO Player'], fallback: 'XC IPTV', store: 'Samsung Apps (Tizen)' },
  'smarttv:lg': { apps: ['IPTV Smarters', 'Assist Plus'], fallback: 'XC IPTV', store: 'LG Content Store (webOS)' },
  'smarttv:roku': { apps: ['Assist Plus'], fallback: 'XC IPTV', store: 'Roku Channel Store' },
  'smarttv:android': { apps: ['RP725'], fallback: 'XC IPTV', store: 'Google Play Store' },
  'smarttv:outras': { apps: ['XC IPTV'], fallback: null, store: 'loja da sua TV' },
  'tvbox:_': { apps: ['RP725', 'XC IPTV'], fallback: null, store: 'Google Play Store' },
  'firestick:_': { apps: ['Assist Plus'], fallback: null, store: 'Amazon Appstore' },
  'celular:android': { apps: ['RP725'], fallback: null, store: 'Google Play Store' },
  'celular:iphone': { apps: ['VU IPTV Player'], fallback: null, store: 'App Store' },
  'pc:_': { apps: ['Smarters IPTV'], fallback: null, store: 'navegador' },
};
const INSTALL_STEPS = {
  'IPTV Smarters': [['Abra a loja de apps da TV', 'Procure por "IPTV Smarters"'], ['Instale e abra', 'Escolha "Login Xtream Codes"'], ['Use os dados do teste', 'Enviados no seu WhatsApp']],
  'RP725': [['Abra a Play Store', 'Procure por "RP725"'], ['Instale o app', 'Abra e insira os dados'], ['Dados do teste', 'No seu WhatsApp']],
  'XC IPTV': [['Instale o XC IPTV', 'Funciona em várias marcas'], ['Selecione Xtream Codes', 'No app'], ['Usuário, senha e URL', 'No WhatsApp']],
  'Assist Plus': [['Instale o Assist Plus', 'Loja do aparelho'], ['Adicione lista (Xtream)', 'No app'], ['Dados do teste', 'No WhatsApp']],
  'IBO Player': [['Instale o IBO Player', 'Anote a Device Key'], ['Abra o app', 'Veja o código'], ['Use os dados', 'No WhatsApp']],
  'VU IPTV Player': [['Baixe na App Store', '"VU IPTV Player"'], ['Adicione playlist Xtream', 'No app'], ['Dados do teste', 'No WhatsApp']],
  'Smarters IPTV': [['Acesse pelo navegador', 'No PC'], ['Escolha Xtream Codes', 'Login'], ['Dados do teste', 'No WhatsApp']],
};

// Extras exclusivos do Assist Plus (app pago: 7 dias grátis + vídeo tutorial)
const ASSIST_PLUS = {
  buyUrl: 'https://ativeapp.com/index/ativaappagora',
  videoUrl: 'https://s3.cloudbot-ia.cloud/typebot/public/workspaces/cmgjx1hhy0000qk13vmaetfsv/typebots/cmnz8dh7s0004td0wtow1pnad/blocks/rj6alc5e24wg5e5icyigbgle?v=1780851200028',
};
function assistPlusExtra() {
  if (flow.app !== 'Assist Plus') return '';
  return `
    <div class="fallback" style="margin:12px 0 6px">
      <b>⚠️ O Assist Plus é um app pago</b>
      <span>Mas você tem <b style="color:#fff">7 dias grátis</b> pra testar! Para liberar 1 ano, ative em <a href="${ASSIST_PLUS.buyUrl}" target="_blank" style="color:var(--orange-2)">ativeapp.com</a>.</span>
    </div>
    <p class="hint" style="text-align:left;margin:0 0 8px">🎥 Veja o tutorial de instalação:</p>
    <video controls playsinline preload="metadata" style="max-height:300px;max-width:100%;width:auto;display:block;margin:0 auto 6px;border-radius:12px;background:#000">
      <source src="${ASSIST_PLUS.videoUrl}" type="video/mp4">
    </video>`;
}

function startTest(plan) {
  chosenPlan = plan || 'Recomendado';
  flow = { device: null, brand: null, app: null };
  show('flow');
  renderDevice();
}
function renderDevice() {
  setStep(6);
  paint(`
    <div class="spark">🎁</div>
    <h2>Seu <span class="y">teste grátis</span> está liberado!</h2>
    <p class="hint">Onde você vai assistir? 👇</p>
    <div class="grid2">${DEVICES.map(d => `<div class="dev" onclick="flashSel(()=>pickDevice('${d.id}'))"><div class="dic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d.svg}</svg></div><div class="dt"><b>${d.name}</b><span>${d.sub}</span></div></div>`).join('')}</div>
    <button class="back" onclick="renderPlans()">← Voltar aos planos</button>`);
}
function pickDevice(id) {
  flow.device = id;
  if (id === 'smarttv') return renderTvBrand();
  if (id === 'celular') return renderMobileOs();
  flow.brand = '_'; renderApp();
}
function renderTvBrand() {
  setStep(6);
  paint(`
    <div class="spark">📺</div>
    <h2>Qual a marca da sua Smart TV?</h2>
    <p class="hint">Cada marca usa um app diferente 👇</p>
    <div class="grid2">${TV_BRANDS.map(b => `<div class="dev" onclick="flashSel(()=>pickBrand('${b.id}'))"><div class="dic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="m17 2-5 5-5-5"/></svg></div><div class="dt"><b>${b.name}</b><span>${b.sub}</span></div></div>`).join('')}</div>
    <button class="back" onclick="renderDevice()">← Voltar</button>`);
}
function pickBrand(id) { flow.brand = id; renderApp(); }
function renderMobileOs() {
  setStep(6);
  paint(`
    <div class="spark">📱</div>
    <h2>Seu celular é Android ou iPhone?</h2>
    <p class="hint">Pra indicar o app certo 👇</p>
    <div class="grid2">
      <div class="dev" onclick="flashSel(()=>pickBrand('android'))"><div class="dic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg></div><div class="dt"><b>Android</b><span>Samsung, Xiaomi...</span></div></div>
      <div class="dev" onclick="flashSel(()=>pickBrand('iphone'))"><div class="dic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg></div><div class="dt"><b>iPhone / iPad</b><span>iOS</span></div></div>
    </div>
    <button class="back" onclick="renderDevice()">← Voltar</button>`);
}
function renderApp() {
  setStep(7);
  const key = `${flow.device}:${flow.brand}`;
  const rule = APP_RULES[key] || APP_RULES[`${flow.device}:_`];
  flow.app = rule.apps[0];
  const apps = rule.apps.map(a => `<div class="app" onclick="flashSel(()=>selectApp('${a}'))"><div><b>${a}</b><span>Toque para instalar</span></div><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px;stroke:var(--orange)"><path d="m9 18 6-6-6-6"/></svg></div>`).join('');
  const fb = rule.fallback ? `<div class="fallback"><b>Não encontrou na loja?</b><span>Procure por <b style="color:#fff">${rule.fallback}</b> — funciona em outras marcas.</span></div>` : '';
  paint(`
    <div class="spark">📥</div>
    <h2>App recomendado pra você</h2>
    <p class="hint">Disponível em: ${rule.store}</p>
    <div class="opts">${apps}</div>${fb ? '<div class="mt">' + fb + '</div>' : ''}
    <button class="back" onclick="${flow.device === 'smarttv' ? 'renderTvBrand()' : (flow.device === 'celular' ? 'renderMobileOs()' : 'renderDevice()')}">← Voltar</button>`);
}
function selectApp(app) { flow.app = app; renderInstall(); }
function renderInstall() {
  setStep(8);
  const steps = INSTALL_STEPS[flow.app] || [];
  const html = steps.length
    ? steps.map((s, i) => `<div class="step"><div class="num">${i + 1}</div><div class="st"><b>${s[0]}</b><span>${s[1] || ''}</span></div></div>`).join('')
    : `<div class="fallback"><b>Passo a passo do ${flow.app}</b><span>Instale o app e siga para o próximo passo.</span></div>`;
  paint(`
    <div class="spark">🛠️</div>
    <h2>Como instalar o ${flow.app}</h2>
    <p class="hint">Siga os passos 👇</p>
    <div class="steps">${html}</div>
    ${assistPlusExtra()}
    <button class="btn btn-primary btn-block mt" onclick="renderInstalled()">Continuar →</button>
    <button class="back" onclick="renderApp()">← Voltar</button>`);
}
function renderInstalled() {
  setStep(9);
  paint(`
    <div class="spark">✅</div>
    <h2>Você já instalou o ${flow.app}?</h2>
    <p class="hint">Confirme pra liberar seu acesso 👇</p>
    <div class="opts">
      <div class="opt" onclick="renderLeadForm()"><span class="ic ic-yes">✓</span> Sim, já instalei!</div>
      <div class="opt" onclick="renderInstall()"><span class="ic ic-no">↺</span> Ainda não — ver os passos</div>
    </div>
    <button class="back" onclick="renderApp()">← Trocar de app</button>`);
}
function renderLeadForm() {
  setStep(10);
  paint(`
    <div class="spark">🚀</div>
    <h2>Receba seu <span class="y">acesso grátis</span></h2>
    <p class="hint">Os dados do teste chegam no seu WhatsApp 👇</p>
    <div class="form">
      <input id="leadName" type="text" placeholder="Seu nome" autocomplete="name" />
      <input id="leadPhone" type="tel" placeholder="WhatsApp com DDD — ex: (11) 91234-5678" autocomplete="tel" inputmode="numeric" maxlength="16" oninput="maskPhone(this)" />
      <p id="leadErr" class="err"></p>
      <button class="btn btn-primary btn-block" id="leadBtn" onclick="submitLead()">🔓 Receber meu acesso grátis</button>
      <p style="font-size:11.5px;color:var(--muted);text-align:center">🔒 Usamos seus dados apenas para liberar o teste.</p>
    </div>
    <button class="back" onclick="renderInstalled()">← Voltar</button>`);
}

// Máscara: só dígitos, formata (DD) XXXXX-XXXX, limita a 11 dígitos
function maskPhone(el) {
  let d = el.value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) el.value = d;
  else if (d.length <= 6) el.value = `(${d.slice(0, 2)}) ${d.slice(2)}`;
  else if (d.length <= 10) el.value = `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  else el.value = `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

async function submitLead() {
  const name = (document.getElementById('leadName').value || '').trim();
  const err = document.getElementById('leadErr');
  if (name.length < 2) { err.textContent = 'Digite seu nome.'; return; }

  // Só DDD + número. Se faltar DDD, avisa e NÃO continua.
  let digits = (document.getElementById('leadPhone').value || '').replace(/\D/g, '').replace(/^0+/, '');
  const local = (digits.startsWith('55') && digits.length >= 12) ? digits.slice(2) : digits;
  if (local.length < 10) {
    err.textContent = local.length >= 8
      ? '⚠️ Faltou o DDD! Use DDD + número — ex: (11) 91234-5678'
      : 'Digite seu WhatsApp com DDD — ex: (11) 91234-5678';
    return;
  }
  if (local.length > 11) { err.textContent = 'Número inválido. Use DDD + número.'; return; }
  const phoneRaw = local;
  err.textContent = '';
  renderLoading();

  const payload = { name, phone: phoneRaw, plan: chosenPlan, device: flow.device, brand: flow.brand, app: flow.app, quiz: answers, generateTest: true };
  try {
    const r = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erro ao registrar.');
    renderThanks(name, data.test, null, data.alreadyRegistered);
  } catch (e) { renderThanks(name, null, e.message); }
}
function renderLoading() {
  setProg(100, 'Liberando...');
  paint(`<div class="spark">⚡</div><h2>Liberando seu teste...</h2><p class="hint">Gerando seu acesso e enviando no WhatsApp 👇</p><div class="spinner"></div>`);
}
function renderThanks(name, test, error, alreadyRegistered) {
  setProg(100, 'Concluído ✓');
  const first = name.split(' ')[0];
  const sent = test && test.whatsappSent;
  const wa = SUPPORT_WHATSAPP && SUPPORT_WHATSAPP !== '5500000000000'
    ? `<a class="btn btn-primary btn-block mt" href="https://wa.me/${SUPPORT_WHATSAPP}" target="_blank">📲 Abrir meu WhatsApp</a>` : '';

  if (alreadyRegistered) {
    paint(`
      <div class="spark">🧡</div>
      <h2>${first}, você já testou a <span class="y">HyperFlick</span>!</h2>
      <p class="hint">${sent
        ? 'Acabamos de te enviar no WhatsApp como <b style="color:var(--orange-2)">liberar seu acesso completo</b>. Corre lá! 🚀'
        : 'Esse número já fez um teste. Chama a gente no WhatsApp pra assinar e liberar tudo. 🧡'}</p>
      <div class="fallback" style="text-align:center"><b>👉 Olhe a conversa no seu WhatsApp</b><span>Seu Pix de assinatura está lá.</span></div>
      ${wa}
      <button class="back" onclick="restartAll()">← Início</button>`);
    return;
  }

  paint(`
    <div class="spark">📲</div>
    <h2>Tudo certo, ${first}! <span class="y">Confira seu WhatsApp</span></h2>
    <p class="hint">${sent
      ? `Acabamos de enviar seu <b style="color:var(--orange-2)">usuário, senha e link de acesso</b> no WhatsApp que você informou. Abra o ${flow.app || 'app'}, faça login e aproveite! 🧡`
      : 'Recebemos seu cadastro! Em instantes enviamos seu acesso de teste no WhatsApp que você informou. 🧡'}</p>
    <div class="fallback" style="text-align:center"><b>👉 Olhe a conversa no seu WhatsApp</b><span>Se não chegar em 1 minuto, confira sua caixa de mensagens ou chame o suporte.</span></div>
    ${wa}
    <button class="back" onclick="restartAll()">← Início</button>`);
}
