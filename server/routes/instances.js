import { Router } from 'express';
import { sb } from '../supabase.js';
import { uazapi } from '../uazapi.js';
import { config } from '../config.js';
import { requireAdmin } from '../middleware.js';

const router = Router();
router.use(requireAdmin);

// Normaliza o status retornado pela uazapi
function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['connected', 'open', 'online'].includes(v)) return 'connected';
  if (['connecting', 'qr', 'qrcode', 'pairing'].includes(v)) return 'connecting';
  return 'disconnected';
}

// Lista instâncias
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await sb().from('whatsapp_instances').select('*').order('created_at');
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cria instância na uazapi e salva
router.post('/', async (req, res) => {
  try {
    if (!config.uazapi.adminToken)
      return res.status(400).json({ error: 'UAZAPI_ADMIN_TOKEN não configurado no .env' });
    const name = String(req.body?.name || '').trim() || `hyperflick-${Date.now()}`;
    const r = await uazapi.createInstance(name);
    const inst = r.instance || r;
    const token = inst.token;
    if (!token) throw new Error('uazapi não retornou token da instância.');

    const { count } = await sb().from('whatsapp_instances').select('*', { count: 'exact', head: true });
    const { data, error } = await sb().from('whatsapp_instances').insert({
      name, uazapi_id: inst.id || null, token,
      status: mapStatus(inst.status), is_default: (count || 0) === 0,
    }).select().single();
    if (error) throw error;

    // registra webhook para receber mensagens
    try { await uazapi.setWebhook(token, `${config.publicUrl}/api/webhook/uazapi`); } catch (e) { /* opcional */ }

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Conecta (gera QR code)
router.post('/:id/connect', async (req, res) => {
  try {
    const { data: inst, error } = await sb().from('whatsapp_instances').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const r = await uazapi.connect(inst.token, req.body?.phone);
    const qr = r.qrcode || r.qr || r.base64 || r?.instance?.qrcode || null;
    const paircode = r.paircode || r.pairingCode || r?.instance?.paircode || null;
    await sb().from('whatsapp_instances').update({ status: 'connecting' }).eq('id', inst.id);
    res.json({ qrcode: qr, paircode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Status (consulta uazapi e atualiza o banco)
router.get('/:id/status', async (req, res) => {
  try {
    const { data: inst, error } = await sb().from('whatsapp_instances').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const r = await uazapi.status(inst.token);
    const info = r.instance || r;
    const status = mapStatus(info.status);
    const phone = info.owner || info.phone || inst.phone;
    await sb().from('whatsapp_instances').update({ status, phone }).eq('id', inst.id);
    res.json({ status, phone });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/disconnect', async (req, res) => {
  try {
    const { data: inst } = await sb().from('whatsapp_instances').select('*').eq('id', req.params.id).single();
    await uazapi.disconnect(inst.token);
    await sb().from('whatsapp_instances').update({ status: 'disconnected' }).eq('id', inst.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/default', async (req, res) => {
  try {
    await sb().from('whatsapp_instances').update({ is_default: false }).neq('id', req.params.id);
    await sb().from('whatsapp_instances').update({ is_default: true }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { data: inst } = await sb().from('whatsapp_instances').select('*').eq('id', req.params.id).single();
    try { await uazapi.deleteInstance(inst.token); } catch (e) { /* segue */ }
    await sb().from('whatsapp_instances').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
