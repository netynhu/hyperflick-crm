// Confirmação de pagamento aprovado: marca como pago, agenda a próxima
// mensalidade, ativa o cliente e avisa (cliente + admin).
// Reutilizado pelo webhook do Mercado Pago e pela conciliação do cron —
// assim, mesmo que o webhook do MP se perca, o pagamento é detectado.
import { sb } from '../supabase.js';
import { planMonths } from './helpers.js';
import { getPayment } from './mercadopago.js';
import { sendWhatsApp, notifyAdmin, buildSaleAlert, addPaidAppExpenseIfNeeded } from './service.js';
import { askNameAfterSale } from './waquiz.js';

export async function applyApprovedPayment({ payment, leadId: leadIdHint }) {
  const leadId = payment?.lead_id || leadIdHint;

  // CLAIM ATÔMICO: o Mercado Pago reenvia o webhook várias vezes para o
  // mesmo pagamento (e o cron também pode vê-lo). Marcamos como pago em UMA
  // query condicional (status <> 'pago') e só seguimos se ESTA chamada fez a
  // transição — assim a próxima cobrança e o aviso ao admin não duplicam.
  let claimed = !payment; // sem linha de pagamento (fallback): segue uma vez
  if (payment) {
    const { data: rows } = await sb().from('payments')
      .update({ status: 'pago', paid_at: new Date().toISOString() })
      .eq('id', payment.id).neq('status', 'pago').select('id');
    claimed = Array.isArray(rows) && rows.length > 0;
  }
  if (!claimed) return { ok: true, duplicate: true };

  if (payment) {
    const months = planMonths(payment.plan) || 1;
    // Próximo vencimento NUNCA no passado: usa o maior entre hoje e o
    // vencimento atual, + meses do plano (evita recobrar na hora ao quitar atraso).
    const today = new Date().toISOString().slice(0, 10);
    const base = (payment.due_date && payment.due_date > today) ? payment.due_date : today;
    const next = new Date(base + 'T12:00:00');
    next.setMonth(next.getMonth() + months);
    await sb().from('payments').insert({
      lead_id: payment.lead_id, plan: payment.plan, amount: payment.amount,
      status: 'pendente', due_date: next.toISOString().slice(0, 10),
      period_start: new Date().toISOString().slice(0, 10), period_end: next.toISOString().slice(0, 10),
    });
  }
  if (leadId) {
    await sb().from('leads').update({ stage: 'ganho' }).eq('id', leadId);
    const { data: lead } = await sb().from('leads')
      .select('id,name,phone,test_username,app,source,tag,name_confirmed').eq('id', leadId).maybeSingle();
    if (lead) {
      // 6 meses+ com app pago → lança o custo do app (R$ 20) nas despesas
      await addPaidAppExpenseIfNeeded({ lead, plan: payment?.plan });
      const nome = (lead.name || '').split(' ')[0];
      try {
        await sendWhatsApp({ leadId, phone: lead.phone, text: `Pagamento confirmado${nome && lead.name_confirmed ? ', ' + nome : ''}! 🎉\nSeu acesso completo HyperFlick já está ativo. Bom divertimento!` });
      } catch (e) { /* ignore */ }
      // avisa o admin da venda (com o usuário de acesso, pra renovar no painel)
      await notifyAdmin(buildSaleAlert({
        name: lead.name, username: lead.test_username,
        plan: payment?.plan, amount: payment?.amount, method: 'Pix',
      }));
      // Quiz do WhatsApp: agora que a compra foi concluída, pede o nome do cliente (1x).
      try { await askNameAfterSale(lead); } catch (e) { console.error('askNameAfterSale', e.message); }
    }
  }
  return { ok: true };
}

// Conciliação (rede de segurança do cron): pagamentos ainda pendentes que já
// têm um Pix gerado → consulta o status direto no Mercado Pago. Se aprovou,
// aplica a renovação como se o webhook tivesse chegado.
export async function reconcilePendingPix() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: pays } = await sb().from('payments').select('*')
    .in('status', ['pendente', 'atrasado'])
    .not('mp_payment_id', 'is', null)
    .gte('last_charged_at', since);

  const actions = [];
  for (const p of pays || []) {
    try {
      const mp = await getPayment(p.mp_payment_id);
      if (mp.status === 'approved') {
        const r = await applyApprovedPayment({ payment: p });
        actions.push(`${p.id}:${r.duplicate ? 'ja-pago' : 'pago'}`);
      }
    } catch (e) {
      actions.push(`${p.id}:erro:${e.message}`);
    }
  }
  return { checked: (pays || []).length, actions };
}
