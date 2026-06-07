-- ============================================================
-- HyperFlick CRM — Schema Supabase (Postgres)
-- Rode este arquivo no Supabase: SQL Editor > New query > Run
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- Trigger util: updated_at ----------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ============================================================
-- LEADS  (cada lead é um card do CRM)
-- ============================================================
create table if not exists leads (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text not null,                 -- só dígitos, com DDI: 5511999999999
  plan            text,                           -- mensal | semestral | anual | recomendado
  device          text,
  brand           text,
  app             text,
  quiz            jsonb default '{}'::jsonb,
  stage           text not null default 'lead'
                  check (stage in ('lead','testando','ganho','perdido','followup')),
  source          text default 'funil',
  test_username   text,
  test_password   text,
  test_dns        text,
  test_package    text,
  pay_url         text,
  test_expires_at timestamptz,
  last_contact_at timestamptz,
  lost_reason     text,
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create unique index if not exists leads_phone_key on leads (phone);
create index if not exists leads_stage_idx on leads (stage);
create index if not exists leads_created_idx on leads (created_at desc);

drop trigger if exists trg_leads_updated on leads;
create trigger trg_leads_updated before update on leads
for each row execute function set_updated_at();

-- Migração para bases já criadas (idempotente)
alter table leads add column if not exists test_dns        text;
alter table leads add column if not exists test_package    text;
alter table leads add column if not exists pay_url         text;
alter table leads add column if not exists test_created_at timestamptz;

-- ============================================================
-- PAYMENTS  (cobranças / financeiro — quem pagou, quem não)
-- ============================================================
create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references leads(id) on delete cascade,
  plan          text,
  amount        numeric(10,2) not null default 0,
  status        text not null default 'pendente'
                check (status in ('pendente','pago','atrasado','cancelado')),
  method        text,                            -- pix | cartao | boleto ...
  due_date      date,
  paid_at       timestamptz,
  period_start  date,
  period_end    date,
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists payments_lead_idx on payments (lead_id);
create index if not exists payments_status_idx on payments (status);
create index if not exists payments_due_idx on payments (due_date);

-- Mercado Pago (Pix) — migração idempotente
alter table payments add column if not exists mp_payment_id  text;
alter table payments add column if not exists pix_code       text;  -- copia e cola
alter table payments add column if not exists pix_ticket_url text;  -- link do Pix
create index if not exists payments_mp_idx on payments (mp_payment_id);

drop trigger if exists trg_payments_updated on payments;
create trigger trg_payments_updated before update on payments
for each row execute function set_updated_at();

-- ============================================================
-- WHATSAPP_INSTANCES  (instâncias uazapi gerenciadas pelo sistema)
-- ============================================================
create table if not exists whatsapp_instances (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  uazapi_id   text,
  token       text,                              -- token da instância (uazapi)
  phone       text,
  status      text default 'disconnected',
  is_default  boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

drop trigger if exists trg_inst_updated on whatsapp_instances;
create trigger trg_inst_updated before update on whatsapp_instances
for each row execute function set_updated_at();

-- ============================================================
-- MESSAGES  (histórico de conversa por lead)
-- ============================================================
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads(id) on delete set null,
  phone       text,
  direction   text check (direction in ('in','out')),
  body        text,
  message_id  text,
  status      text,
  created_at  timestamptz default now()
);
create index if not exists messages_lead_idx on messages (lead_id, created_at);

-- ============================================================
-- SETTINGS  (templates de mensagem, etc — key/value)
-- ============================================================
create table if not exists settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

drop trigger if exists trg_settings_updated on settings;
create trigger trg_settings_updated before update on settings
for each row execute function set_updated_at();

-- Template padrão da mensagem de teste grátis
insert into settings (key, value) values
  ('template_teste', '{"text":"🎬 *HyperFlick* — seu TESTE GRÁTIS está liberado, {nome}! 🧡\n\n📲 *App:* {app}\n🌐 *Servidor/URL:* {url}\n👤 *Usuário:* {usuario}\n🔑 *Senha:* {senha}\n⏳ *Validade:* {validade}\n\nÉ só abrir o app, colocar esses dados e aproveitar +800 canais, +60mil filmes e séries em 4K. Qualquer dúvida na instalação, chama aqui! 👇"}'),
  ('template_followup', '{"text":"Oi {nome}! Aqui é da HyperFlick 🧡 Conseguiu testar? Tô aqui pra te ajudar a deixar tudo funcionando e liberar seu acesso completo com desconto. Posso te mandar os planos?"}')
on conflict (key) do nothing;

-- ============================================================
-- FOLLOWUPS  (controle de disparos automáticos por lead — evita duplicar)
-- ============================================================
create table if not exists followups (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references leads(id) on delete cascade,
  type       text not null,            -- welcome | expiring | winback
  sent_at    timestamptz default now()
);
create unique index if not exists followups_lead_type on followups (lead_id, type);

-- ============================================================
-- VIEW: resumo financeiro
-- ============================================================
create or replace view financial_summary as
select
  coalesce(sum(amount) filter (where status = 'pago'), 0)                              as total_recebido,
  coalesce(sum(amount) filter (where status = 'pendente'), 0)                          as total_pendente,
  coalesce(sum(amount) filter (where status = 'atrasado'), 0)                          as total_atrasado,
  count(*) filter (where status = 'pago')                                              as qtd_pagos,
  count(*) filter (where status in ('pendente','atrasado'))                            as qtd_em_aberto
from payments;
