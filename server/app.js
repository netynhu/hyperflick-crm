// App Express reutilizável (sem listen) — usado tanto pelo servidor local
// (server/index.js) quanto pela função serverless da Vercel (api/index.js).
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configWarnings } from './config.js';

import leads from './routes/leads.js';
import instances from './routes/instances.js';
import payments from './routes/payments.js';
import webhook from './routes/webhook.js';
import settings from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// API
app.use('/api/leads', leads);
app.use('/api/instances', instances);
app.use('/api/payments', payments);
app.use('/api/webhook', webhook);
app.use('/api/settings', settings);

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, warnings: configWarnings() })
);

// Config pública para o frontend do CRM (login via Supabase Auth)
app.get('/api/config', (_req, res) =>
  res.json({
    supabaseUrl: config.supabase.url,
    supabaseAnonKey: config.supabase.anonKey,
    hasAdminKey: Boolean(config.crmAdminKey),
  })
);

// Frontend estático
const pub = path.join(__dirname, '..', 'public');
app.get('/', (_req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/crm', (_req, res) => res.sendFile(path.join(pub, 'crm', 'index.html')));
app.use(express.static(pub));

export { app };
