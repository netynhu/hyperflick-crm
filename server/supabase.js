import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let _sb = null;

export function sb() {
  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error('Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_KEY no .env');
  }
  if (!_sb) {
    _sb = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _sb;
}

export function hasSupabase() {
  return Boolean(config.supabase.url && config.supabase.serviceKey);
}
