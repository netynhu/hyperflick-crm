import { config } from './config.js';
import { sb, hasSupabase } from './supabase.js';

// Protege as rotas do CRM.
// 1) Supabase Auth: header `Authorization: Bearer <access_token>` (validado no Supabase)
// 2) Fallback: chave simples via `x-admin-key` (se CRM_ADMIN_KEY estiver definido)
export async function requireAdmin(req, res, next) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer && hasSupabase()) {
    try {
      const { data, error } = await sb().auth.getUser(bearer);
      if (!error && data?.user) { req.user = data.user; return next(); }
    } catch (e) { /* cai pro fallback */ }
  }
  if (config.crmAdminKey) {
    const key = req.get('x-admin-key') || req.query.key;
    if (key === config.crmAdminKey) return next();
  }
  return res.status(401).json({ error: 'Não autorizado.' });
}
