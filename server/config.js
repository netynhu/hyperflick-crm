import dotenv from 'dotenv';
dotenv.config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
  },

  uazapi: {
    url: (process.env.UAZAPI_URL || 'https://free.uazapi.com').replace(/\/$/, ''),
    adminToken: process.env.UAZAPI_ADMIN_TOKEN || '',
  },

  test: {
    durationHours: num(process.env.TEST_DURATION_HOURS, 6),
    panelUrl: process.env.IPTV_PANEL_URL || '',
  },

  // Painel IPTV (uhdpainel) — gera o teste real via endpoint de chatbot
  panel: {
    chatbotUrl: process.env.PANEL_CHATBOT_URL || '',
    trigger: process.env.PANEL_TRIGGER || 'teste',
  },

  prices: {
    mensal: num(process.env.PRICE_MENSAL, 19.9),
    semestral: num(process.env.PRICE_SEMESTRAL, 79.9),
    anual: num(process.env.PRICE_ANUAL, 129.9),
  },

  crmAdminKey: process.env.CRM_ADMIN_KEY || '',
};

// Avisos de configuração ausente (não derruba o servidor — funil ainda abre)
export function configWarnings() {
  const w = [];
  if (!config.supabase.url || !config.supabase.serviceKey)
    w.push('Supabase não configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  if (!config.uazapi.adminToken)
    w.push('uazapi admin token ausente (UAZAPI_ADMIN_TOKEN) — não será possível criar instâncias.');
  return w;
}
