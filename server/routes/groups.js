// Captura de contatos por grupo: cola links → entra → exporta participantes →
// deduplica → cadastra na base de contatos. Processado em fila pelo cron.
import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { processGroupJobs, parseInviteCode } from '../lib/groups.js';

const router = Router();
router.use(requireAdmin);

const tableMissing = (e) => /group_jobs.*(does not exist|schema cache)|relation .group_jobs/i.test(e?.message || '');
const HINT = 'Tabela de grupos ainda não existe — rode o supabase/schema.sql no SQL Editor.';

// Cria 1 job por link colado.
// body: { links: "url1\nurl2..." OU [..], instanceId, leaveAfter? }
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const list = Array.isArray(b.links) ? b.links : String(b.links || '').split(/[\n,;]+/);
    const seen = new Set();
    const rows = [];
    for (const l of list) {
      const code = parseInviteCode(l);
      if (!code || code.length < 5 || seen.has(code)) continue;
      seen.add(code);
      rows.push({ invite_code: code, instance_id: b.instanceId || null, leave_after: b.leaveAfter !== false });
    }
    if (!rows.length) return res.status(400).json({ error: 'Cole pelo menos um link de grupo válido (chat.whatsapp.com/...).' });
    const { data, error } = await sb().from('group_jobs').insert(rows).select();
    if (error) throw error;
    res.json({ ok: true, created: data.length });
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

// Lista os jobs (com progresso)
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await sb().from('group_jobs').select('*')
      .order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(tableMissing(e) ? 400 : 500).json({ error: tableMissing(e) ? HINT : e.message });
  }
});

// Processa o próximo grupo da fila AGORA (respeita o gap anti-ban).
router.post('/process', async (_req, res) => {
  try {
    const r = await processGroupJobs();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await sb().from('group_jobs').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
