// Motor de follow-up automático (chamado pelo cron).
// Sequência: welcome (~1h após teste) → expiring (~1h antes de expirar, com Pix)
//            → winback (dia seguinte, com Pix).
import { sb } from '../supabase.js';
import { config } from '../config.js';
import { planPrice } from './helpers.js';
import { createPixPayment } from './mercadopago.js';
import { sendWhatsApp } from './service.js';

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
  }).select().single();
  if (error) console.error('sendPixForLead insert:', error.message, '(rodou o schema atualizado?)');
  return { plan, amount, pix, payment };
}

function pixMessage({ nome, plan, amount, pix, kind, exp }) {
  const valor = Number(amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const head = kind === 'expiring'
    ? `${nome}, seu teste da HyperFlick *acaba às ${brTime(exp)}* ⏳\n\nPra não perder o acesso a +800 canais e +60 mil filmes e séries, garanta já seu *Plano ${plan}* por *R$ ${valor}*:`
    : `${nome}, seu teste expirou — mas dá tempo de continuar aproveitando! 🧡\n\nReative agora seu *Plano ${plan}* por *R$ ${valor}*:`;
  return `${head}\n\n💠 *Pix copia e cola:*\n${pix.pixCode}\n\n🔗 Ou pague pelo link:\n${pix.ticketUrl}\n\nAssim que o Pix cair, seu acesso é *liberado na hora*! 🚀`;
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
  const text = pixMessage({ nome: (lead.name || '').split(' ')[0], plan, amount, pix, kind, exp });
  await sendWhatsApp({ leadId: lead.id, phone: lead.phone, text });
  await markSent(lead.id, kind === 'expiring' ? 'expiring' : 'winback');
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
