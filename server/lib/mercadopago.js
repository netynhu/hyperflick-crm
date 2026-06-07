// Integração Mercado Pago — cria cobrança Pix e consulta status.
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';

const API = 'https://api.mercadopago.com';

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.mercadopago.accessToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Cria um pagamento Pix. Retorna { id, status, pixCode, ticketUrl, qrBase64 }.
export async function createPixPayment({ amount, description, payerName, payerEmail, externalReference, notificationUrl }) {
  if (!config.mercadopago.accessToken) {
    const e = new Error('MERCADOPAGO_ACCESS_TOKEN não configurado no .env');
    e.code = 'NO_MP';
    throw e;
  }

  const body = {
    transaction_amount: Number(amount),
    description: description || 'HyperFlick',
    payment_method_id: 'pix',
    payer: {
      email: payerEmail || 'cliente@hyperflick.app',
      first_name: (payerName || 'Cliente').split(' ')[0],
    },
  };
  if (externalReference) body.external_reference = String(externalReference);
  if (notificationUrl) body.notification_url = notificationUrl;

  const res = await fetch(`${API}/v1/payments`, {
    method: 'POST',
    headers: authHeaders({ 'X-Idempotency-Key': randomUUID() }),
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('Mercado Pago: ' + (d.message || `erro ${res.status}`));
    e.data = d;
    throw e;
  }

  const tx = d.point_of_interaction?.transaction_data || {};
  return {
    id: d.id,
    status: d.status,
    pixCode: tx.qr_code || '',
    qrBase64: tx.qr_code_base64 || '',
    ticketUrl: tx.ticket_url || '',
  };
}

// Consulta um pagamento pelo id. Retorna { id, status, externalReference, amount }.
export async function getPayment(id) {
  const res = await fetch(`${API}/v1/payments/${id}`, { headers: authHeaders() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('Mercado Pago: ' + (d.message || `erro ${res.status}`));
    e.data = d;
    throw e;
  }
  return {
    id: d.id,
    status: d.status, // approved | pending | rejected | cancelled ...
    externalReference: d.external_reference || '',
    amount: d.transaction_amount,
  };
}
