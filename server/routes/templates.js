// Modelos de mensagem pré-configurados para disparo (CRUD).
// Os modelos do plano de vendas são semeados pelo supabase/schema.sql.
import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';

const router = Router();
router.use(requireAdmin);

const tableMissing = (e) => /message_templates.*(does not exist|schema cache)|relation .message_templates/i.test(e?.message || '');
const HINT = 'Tabela de modelos ainda não existe — rode o supabase/schema.sql no SQL Editor.';

function cleanBody(b) {
  return {
    name: String(b.name || '').trim(),
    message_text: String(b.text ?? b.message_text ?? '').trim(),
    image: String(b.image || '').trim() || null,
    footer: String(b.footer || '').trim() || null,
    buttons: Array.isArray(b.buttons)
      ? b.buttons.map((x) => ({ text: String(x?.text ?? x ?? '').trim() })).filter((x) => x.text).slice(0, 3)
      : [],
  };
}

router.get('/', async (_req, res) => {
  try {
    const { data, error } = await sb().from('message_templates').select('*').order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const row = cleanBody(req.body || {});
    if (!row.name) return res.status(400).json({ error: 'Dê um nome ao modelo.' });
    if (!row.message_text && !row.image) return res.status(400).json({ error: 'Modelo precisa de texto ou imagem.' });
    const { data, error } = await sb().from('message_templates')
      .upsert(row, { onConflict: 'name' }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const row = cleanBody(req.body || {});
    if (!row.name) return res.status(400).json({ error: 'Dê um nome ao modelo.' });
    const { data, error } = await sb().from('message_templates').update(row).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await sb().from('message_templates').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
