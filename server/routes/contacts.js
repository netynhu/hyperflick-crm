// Base de contatos para disparo em massa: quem é, de qual planilha veio,
// quantos disparos já recebeu e se pediu pra sair (opt-out).
import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { normalizePhone } from '../lib/helpers.js';

const router = Router();
router.use(requireAdmin);

const tableMissing = (e) => /contacts.*(does not exist|schema cache)|relation .contacts/i.test(e?.message || '');
const HINT = 'Tabela de contatos ainda não existe — rode o supabase/schema.sql no SQL Editor.';

// GET /api/contacts?search=&filter=all|never|cold|optout&days=30
router.get('/', async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const days = Math.max(1, Number(req.query.days) || 30);
    let q = sb().from('contacts').select('*').order('created_at', { ascending: false }).limit(1000);
    if (req.query.search) {
      const s = String(req.query.search).trim();
      q = q.or(`phone.ilike.%${s.replace(/\D/g, '') || s}%,name.ilike.%${s}%`);
    }
    if (filter === 'never') q = q.eq('opt_out', false).eq('dispatch_count', 0);
    if (filter === 'cold') q = q.eq('opt_out', false).lt('last_dispatched_at', new Date(Date.now() - days * 86400000).toISOString());
    if (filter === 'optout') q = q.eq('opt_out', true);
    if (filter === 'all') q = q.order('opt_out', { ascending: true });
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

// GET /api/contacts/stats — números da base (pro painel)
router.get('/stats', async (_req, res) => {
  try {
    // sonda a tabela com um SELECT real: count head:true numa tabela
    // inexistente devolve 204 sem erro e mascararia o problema com zeros
    const probe = await sb().from('contacts').select('id').limit(1);
    if (probe.error) throw probe.error;
    const count = async (mod) => {
      let q = sb().from('contacts').select('id', { count: 'exact', head: true });
      q = mod(q);
      const { count: c, error } = await q;
      if (error) throw error;
      return c || 0;
    };
    const cold30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const [total, optOut, never, cold] = await Promise.all([
      count((q) => q),
      count((q) => q.eq('opt_out', true)),
      count((q) => q.eq('opt_out', false).eq('dispatch_count', 0)),
      count((q) => q.eq('opt_out', false).gt('dispatch_count', 0).lt('last_dispatched_at', cold30)),
    ]);
    res.json({ total, optOut, never, cold, ativos: total - optOut });
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

// POST /api/contacts/import { contacts: [{phone,name?}], source? }
// Upsert: número novo entra; número existente só atualiza nome/origem se vazios.
router.post('/import', async (req, res) => {
  try {
    const b = req.body || {};
    const source = String(b.source || '').trim() || null;
    const seen = new Set();
    const rows = [];
    let invalid = 0;
    for (const c of Array.isArray(b.contacts) ? b.contacts : []) {
      const phone = normalizePhone(c?.phone);
      if (!phone || phone.length < 12) { invalid++; continue; }
      if (seen.has(phone)) continue;
      seen.add(phone);
      rows.push({ phone, name: String(c?.name || '').trim() || null, source });
    }
    if (!rows.length) return res.status(400).json({ error: 'Nenhum número válido para importar.' });

    // quem já existe? (não sobrescreve contagem nem opt-out)
    const phones = rows.map((r) => r.phone);
    const existing = new Set();
    for (let i = 0; i < phones.length; i += 500) {
      const { data } = await sb().from('contacts').select('phone').in('phone', phones.slice(i, i + 500));
      for (const d of data || []) existing.add(d.phone);
    }
    const news = rows.filter((r) => !existing.has(r.phone));
    for (let i = 0; i < news.length; i += 500) {
      const { error } = await sb().from('contacts').insert(news.slice(i, i + 500));
      if (error) throw error;
    }
    res.json({ ok: true, added: news.length, existing: existing.size, invalid, total: rows.length });
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

// PATCH /api/contacts/:id { opt_out?, name? }
router.patch('/:id', async (req, res) => {
  try {
    const upd = {};
    if ('opt_out' in req.body) upd.opt_out = !!req.body.opt_out;
    if ('name' in req.body) upd.name = String(req.body.name || '').trim() || null;
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nada para atualizar.' });
    const { data, error } = await sb().from('contacts').update(upd).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await sb().from('contacts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
