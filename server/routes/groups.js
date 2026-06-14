// Captura de contatos por grupo: cola links → entra → exporta participantes →
// deduplica → cadastra na base de contatos. Processado em fila pelo cron.
import { Router } from 'express';
import { sb } from '../supabase.js';
import { requireAdmin } from '../middleware.js';
import { processGroupJobs, parseInviteCode, isValidInviteCode } from '../lib/groups.js';

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
    const invalid = [];
    for (const l of list) {
      const raw = String(l || '').trim();
      if (!raw) continue;
      const code = parseInviteCode(raw);
      if (!isValidInviteCode(code)) { invalid.push(raw); continue; }
      if (seen.has(code)) continue;
      seen.add(code);
      rows.push({ invite_code: code, raw_link: raw, instance_id: b.instanceId || null, leave_after: b.leaveAfter !== false });
    }
    if (!rows.length) {
      return res.status(400).json({
        error: 'Nenhum link válido. Cole o link completo do convite (ex.: https://chat.whatsapp.com/XXXXXXXX). Toque em "Convidar via link" no grupo e copie tudo.',
      });
    }
    // raw_link é opcional no schema; se a coluna não existir, reinsere sem ela.
    let ins = await sb().from('group_jobs').insert(rows).select();
    if (ins.error && /raw_link/.test(ins.error.message || '')) {
      ins = await sb().from('group_jobs').insert(rows.map(({ raw_link, ...r }) => r)).select();
    }
    if (ins.error) throw ins.error;
    res.json({ ok: true, created: ins.data.length, invalid: invalid.length });
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
