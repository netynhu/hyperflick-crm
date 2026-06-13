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

// Cidades do proxy regional (autocomplete do modal Conectar).
// A busca da uazapi casa também pelo ESTADO (ex.: "São Paulo" retorna as 250
// cidades de SP em ordem alfabética) — reordena por relevância do NOME antes
// de devolver, senão a própria capital não aparece no topo.
router.get('/:id/cities', async (req, res) => {
  try {
    const { data: inst, error } = await sb().from('whatsapp_instances').select('token').eq('id', req.params.id).single();
    if (error) throw error;
    const search = String(req.query.search || '');
    const r = await uazapi.proxyCities(inst.token, { search });
    let cities = r.cities || r || [];
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const q = norm(search);
    if (q) {
      const score = (c) => {
        const l = norm(c.label || c.value);
        if (l === q) return 0;          // nome exato
        if (l.startsWith(q)) return 1;  // começa com
        if (l.includes(q)) return 2;    // contém
        return 3;                       // casou só pelo estado
      };
      cities = [...cities].sort((a, b) =>
        score(a) - score(b) || String(a.label || '').localeCompare(String(b.label || ''), 'pt-BR'));
    }
    res.json({ cities: cities.slice(0, 30) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Conecta (gera QR code). body: { phone?, proxyCity?, proxyState? }
// Cidade/estado ativam o proxy regional da uazapi (anti-ban).
router.post('/:id/connect', async (req, res) => {
  try {
    const { data: inst, error } = await sb().from('whatsapp_instances').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const r = await uazapi.connect(inst.token, {
      phone: req.body?.phone || undefined,
      proxyCity: req.body?.proxyCity || undefined,
      proxyState: req.body?.proxyState || undefined,
    });
    const qr = r.qrcode || r.qr || r.base64 || r?.instance?.qrcode || null;
    const paircode = r.paircode || r.pairingCode || r?.instance?.paircode || null;
    await sb().from('whatsapp_instances').update({ status: 'connecting' }).eq('id', inst.id);
    // garante o webhook apontando para a URL pública atual
    try { await uazapi.setWebhook(inst.token, `${config.publicUrl}/api/webhook/uazapi`); } catch (e) { /* opcional */ }
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

// Re-registra o webhook com a PUBLIC_URL atual (corrige webhook em localhost)
router.post('/:id/webhook', async (req, res) => {
  try {
    const { data: inst } = await sb().from('whatsapp_instances').select('*').eq('id', req.params.id).single();
    const url = `${config.publicUrl}/api/webhook/uazapi`;
    await uazapi.setWebhook(inst.token, url);
    res.json({ ok: true, url });
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
