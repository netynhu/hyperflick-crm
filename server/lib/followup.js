// Motor de follow-up automático (chamado pelo cron).
// Sequência: welcome (~1h após teste) → expiring (~1h antes de expirar, com Pix)
//            → winback (dia seguinte, com Pix).
import { sb } from '../supabase.js';
import { config } from '../config.js';
import { planPrice, normalizePhone } from './helpers.js';
import { createPixPayment } from './mercadopago.js';
import { sendWhatsApp, sendWhatsAppRich, sendPixMessage } from './service.js';

const H = 3600 * 1000;

function brTime(ts) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(ts));
}

// Cria a cobrança Pix (Mercado Pago) e salva no financeiro. Reutilizável no CRM.
export async function sendPixForLead(lead) {
  const plan = lead.plan || 'Mensal';
  const amount = planPrice(plan);
  const pix = await createPixPayment({
    amount,
    description: `HyperFlick - Plano ${plan}`,
    payerName: lead.name,
    payerEmail: `c${lead.phone}@hyperflick.app`,
    externalReference: lead.id,
    notificationUrl: `${config.publicUrl}/api/webhook/mercadopago`,
  });
  // cancela Pix pendentes antigos do lead (evita várias cobranças abertas)
  await sb().from('payments').update({ status: 'cancelado' })
    .eq('lead_id', lead.id).eq('status', 'pendente');
  const { data: payment, error } = await sb().from('payments').insert({
    lead_id: lead.id, plan, amount, status: 'pendente', method: 'pix',
    due_date: new Date().toISOString().slice(0, 10),
    mp_payment_id: String(pix.id), pix_code: pix.pixCode, pix_ticket_url: pix.ticketUrl,
    last_charged_at: new Date().toISOString(),
  }).select().single();
  if (error) console.error('sendPixForLead insert:', error.message, '(rodou o schema atualizado?)');
  return { plan, amount, pix, payment };
}

// Entrega um Pix ao lead: reusa um Pix pendente recente (<60min) ou cria um novo,
// e envia a mensagem no WhatsApp. Usado pelos gatilhos de compra e pelo "já cadastrado".
export async function deliverPixToLead(lead, intro) {
  const { data: recent } = await sb().from('payments').select('*')
    .eq('lead_id', lead.id).eq('status', 'pendente').not('pix_code', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  let plan, amount, pix;
  const reusar = recent && (Date.now() - new Date(recent.created_at).getTime() < 60 * 60 * 1000);
  if (reusar) {
    plan = recent.plan; amount = recent.amount;
    pix = { pixCode: recent.pix_code, ticketUrl: recent.pix_ticket_url };
  } else {
    ({ plan, amount, pix } = await sendPixForLead(lead));
  }

  const nome = (lead.name || '').split(' ')[0];
  const head = intro || `${nome}, perfeito! Aqui está o Pix pra liberar seu acesso 🧡`;
  await sendPixMessage({ leadId: lead.id, phone: lead.phone, intro: head, plan, amount, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl });
  return { plan, amount, pix };
}

// Cliente GANHO clicou "Quero pagar agora" na cobrança mensal → gera o Pix da
// cobrança em aberto e envia com botões (copiar código + link).
export async function sendMonthlyPix(lead) {
  const { data: pay } = await sb().from('payments').select('*')
    .eq('lead_id', lead.id).in('status', ['pendente', 'atrasado'])
    .order('due_date', { ascending: true }).limit(1).maybeSingle();
  const nome = (lead.name || '').split(' ')[0];
  if (!pay) return deliverPixToLead(lead, `${nome}, aqui está seu Pix:`);
  const pix = await createPixPayment({
    amount: pay.amount,
    description: `HyperFlick - ${pay.plan || 'Mensalidade'}`,
    payerName: lead.name,
    payerEmail: `c${lead.phone}@hyperflick.app`,
    externalReference: lead.id,
    notificationUrl: `${config.publicUrl}/api/webhook/mercadopago`,
  });
  await sb().from('payments').update({
    method: 'pix', mp_payment_id: String(pix.id), pix_code: pix.pixCode,
    pix_ticket_url: pix.ticketUrl, last_charged_at: new Date().toISOString(),
  }).eq('id', pay.id);
  await sendPixMessage({
    leadId: lead.id, phone: lead.phone,
    intro: `Perfeito, ${nome}! Aqui está o Pix da sua mensalidade HyperFlick 🧡`,
    plan: pay.plan, amount: pay.amount, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl,
  });
  return { ok: true };
}

function pixHead({ nome, plan, amount, kind, exp }) {
  const valor = Number(amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  return kind === 'expiring'
    ? `${nome}, seu teste da HyperFlick *acaba às ${brTime(exp)}* ⏳\n\nPra não perder o acesso a +800 canais e +60 mil filmes e séries, garanta já seu *Plano ${plan}* por *R$ ${valor}*:`
    : `${nome}, seu teste expirou — mas dá tempo de continuar aproveitando! 🧡\n\nReative agora seu *Plano ${plan}* por *R$ ${valor}*:`;
}

async function markSent(leadId, type) {
  const { error } = await sb().from('followups').upsert({ lead_id: leadId, type }, { onConflict: 'lead_id,type', ignoreDuplicates: true });
  if (error) console.error('markSent (followups):', error.message, '(rodou o schema atualizado?)');
}

async function doWelcome(lead) {
  const nome = (lead.name || '').split(' ')[0];
  const text = `Oi ${nome}! Aqui é da HyperFlick 🧡\nConseguiu instalar e já está assistindo? Se tiver qualquer dificuldade, me chama aqui que eu te ajudo a deixar tudo 100%. 📺`;
  await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text });
  await markSent(lead.id, 'welcome');
}

async function doPix(lead, kind, exp) {
  const { plan, amount, pix } = await sendPixForLead(lead);
  const intro = pixHead({ nome: (lead.name || '').split(' ')[0], plan, amount, kind, exp });
  await sendPixMessage({ leadId: lead.id, phone: lead.phone, intro, plan, amount, pixCode: pix.pixCode, ticketUrl: pix.ticketUrl });
  await markSent(lead.id, kind === 'expiring' ? 'expiring' : 'winback');
}

// Cobrança recorrente: para clientes GANHO com mensalidade vencida (não paga),
// gera o Pix e envia no WhatsApp — no máximo 1x a cada 20h por cobrança.
export async function runBilling() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: pays } = await sb().from('payments')
    .select('*, lead:leads(id,name,phone,plan,stage)')
    .in('status', ['pendente', 'atrasado'])
    .lte('due_date', today);

  const actions = [];
  for (const p of pays || []) {
    if (!p.lead || p.lead.stage !== 'ganho') continue; // só clientes
    // Cobra cada mensalidade automaticamente UMA única vez (atrasado inclusive).
    if (p.dunning_done) continue;
    // Sem WhatsApp válido: não dispara cobrança (será cobrada de outra forma).
    if (normalizePhone(p.lead.phone).length < 12) {
      await sb().from('payments').update({ dunning_done: true }).eq('id', p.id);
      actions.push(`${p.id}:sem-whatsapp`);
      continue;
    }
    try {
      // 1º passo (#12): avisa o vencimento e oferece o botão "Quero pagar agora".
      // O Pix só é gerado quando o cliente clicar (tratado no webhook → sendMonthlyPix).
      const valor = Number(p.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      const nome = (p.lead.name || '').split(' ')[0];
      const venc = p.due_date ? new Date(p.due_date + 'T12:00:00').toLocaleDateString('pt-BR') : '';
      await sendWhatsAppRich({
        leadId: p.lead.id, phone: p.lead.phone,
        text: `${nome}, sua mensalidade HyperFlick está disponível 💳\n\n💠 *Plano:* ${p.plan || 'Mensal'}\n📅 *Vencimento:* ${venc}\n💰 *Valor:* R$ ${valor}\n\nÉ rapidinho — toque no botão abaixo pra receber seu Pix 👇`,
        buttons: [{ text: '💰 Quero pagar agora' }],
        footer: 'HyperFlick • IPTV',
      });
      await sb().from('payments').update({
        last_charged_at: new Date().toISOString(), dunning_done: true,
      }).eq('id', p.id);
      actions.push(`${p.id}:cobranca`);
    } catch (e) {
      actions.push(`${p.id}:erro:${e.message}`);
    }
  }
  return { billed: actions.length, actions };
}

export async function runFollowups() {
  const now = Date.now();
  const { data: leads } = await sb().from('leads').select('*')
    .in('stage', ['testando', 'followup'])
    .not('test_expires_at', 'is', null);
  if (!leads || !leads.length) return { processed: 0, actions: [] };

  const ids = leads.map((l) => l.id);
  const { data: fus } = await sb().from('followups').select('lead_id,type').in('lead_id', ids);
  const sentMap = {};
  for (const f of fus || []) (sentMap[f.lead_id] ||= new Set()).add(f.type);

  const actions = [];
  for (const l of leads) {
    const sent = sentMap[l.id] || new Set();
    const exp = new Date(l.test_expires_at).getTime();
    const created = l.test_created_at ? new Date(l.test_created_at).getTime() : exp - config.test.durationHours * H;
    try {
      if (now < exp) {
        if (!sent.has('expiring') && now >= exp - 70 * 60 * 1000) {
          await doPix(l, 'expiring', exp); actions.push(`${l.id}:expiring`);
        } else if (!sent.has('welcome') && now >= created + H && now < exp - 70 * 60 * 1000) {
          await doWelcome(l); actions.push(`${l.id}:welcome`);
        }
      } else {
        if (l.stage === 'testando') await sb().from('leads').update({ stage: 'followup' }).eq('id', l.id);
        if (!sent.has('winback') && now >= exp + 18 * H && now <= exp + 48 * H) {
          await doPix(l, 'winback', exp); actions.push(`${l.id}:winback`);
        }
      }
    } catch (e) {
      actions.push(`${l.id}:erro:${e.message}`);
    }
  }
  return { processed: leads.length, actions };
}
