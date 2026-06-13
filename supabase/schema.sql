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
-- Quiz de qualificação dentro do WhatsApp (tráfego pago → wa.me → quiz por botões)
-- estados: ask_device | ask_brand | ask_mobile | generating | browsing | ask_plan | await_payment | post_sale_name | done
alter table leads add column if not exists wa_quiz_state   text;
-- Etiqueta de origem do lead: 'trafego_pago' (veio do anúncio) | 'disparo' (disparo em massa)
alter table leads add column if not exists tag             text;
-- Nome confirmado pelo próprio cliente? Quiz pede o nome só DEPOIS da compra paga.
-- Default true para não pedir nome a leads antigos/manuais; quiz cria com false.
alter table leads add column if not exists name_confirmed  boolean default true;
-- Instância "dona" da conversa: o número pelo qual o lead foi disparado/respondeu.
-- Toda resposta (quiz, Pix, follow-up) sai por ESTE número — nunca pelo padrão.
alter table leads add column if not exists instance_id     uuid;

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
alter table payments add column if not exists mp_payment_id   text;
alter table payments add column if not exists pix_code        text;  -- copia e cola
alter table payments add column if not exists pix_ticket_url  text;  -- link do Pix
alter table payments add column if not exists last_charged_at timestamptz; -- última cobrança Pix enviada
alter table payments add column if not exists dunning_done boolean default false; -- cobrança automática já enviada 1x (não reenviar)
create index if not exists payments_mp_idx on payments (mp_payment_id);

-- ============================================================
-- EXPENSES  (despesas — para o relatório de lucro)
-- ============================================================
create table if not exists expenses (
  id          uuid primary key default gen_random_uuid(),
  description text not null,
  amount      numeric(10,2) not null default 0,
  category    text,
  date        date not null default current_date,
  status      text default 'pendente',   -- pendente | pago
  paid_at     timestamptz,
  created_at  timestamptz default now()
);
create index if not exists expenses_date_idx on expenses (date);
alter table expenses add column if not exists status  text default 'pendente';
alter table expenses add column if not exists paid_at timestamptz;

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
-- CONTACTS  (base de números para disparo — quem é, quantas vezes
-- já recebeu disparo e se pediu pra sair)
-- ============================================================
create table if not exists contacts (
  id                 uuid primary key default gen_random_uuid(),
  phone              text not null unique,         -- só dígitos com DDI 55
  name               text,
  source             text,                          -- planilha/origem de onde veio
  dispatch_count     int default 0,                 -- quantos disparos já recebeu
  last_dispatched_at timestamptz,
  opt_out            boolean default false,         -- pediu pra não receber mais
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create index if not exists contacts_optout_idx on contacts (opt_out);
create index if not exists contacts_lastdisp_idx on contacts (last_dispatched_at);
-- Último disparo que incluiu este número (evita o MESMO contato em 2 disparos).
alter table contacts add column if not exists last_broadcast_id uuid;

drop trigger if exists trg_contacts_updated on contacts;
create trigger trg_contacts_updated before update on contacts
for each row execute function set_updated_at();

-- ============================================================
-- MESSAGE_TEMPLATES  (modelos prontos de mensagem para disparo)
-- ============================================================
create table if not exists message_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  message_text text,
  image        text,
  footer       text,
  buttons      jsonb default '[]'::jsonb,           -- [{"text":"..."}]
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

drop trigger if exists trg_templates_updated on message_templates;
create trigger trg_templates_updated before update on message_templates
for each row execute function set_updated_at();

-- Modelos do PLANO DE VENDAS (régua de 4 toques + recuperação).
-- SEM {nome}: planilha de prospecção normalmente não tem o nome do cliente.
-- {opção A|opção B} sorteia uma variação por mensagem (anti-ban).
insert into message_templates (name, message_text, footer, buttons) values
  ('🎁 Dia 1 · Abertura — teste grátis',
   E'{Oi|Olá|E aí}! Tudo {bem|certo} por aí? 😊\n\nAqui é da *HyperFlick* 🧡 A gente libera *+800 canais ao vivo, +60 mil filmes e séries* e todo o futebol num app só — sem travar e bem mais barato que TV por assinatura.\n\nLiberei um *TESTE GRÁTIS* pra você {conhecer|experimentar} sem pagar nada. Quer?',
   'HyperFlick • IPTV', '[{"text":"Quero meu teste grátis 🎁"}]'),
  ('⭐ Dia 3 · Prova social',
   E'{Oi|Olá}! 👋\n\nSó {hoje|essa semana} {3|4} pessoas saíram da TV por assinatura e vieram pra *HyperFlick* 🧡\n\n_"Saí da operadora cara, instalei em 5 minutos e nunca mais travou. Melhor decisão."_ — Rafael M. ⭐⭐⭐⭐⭐\n\nSeu *teste grátis* {continua disponível|ainda tá reservado} — quer que eu libere?',
   'HyperFlick • IPTV', '[{"text":"Quero meu teste grátis 🎁"}]'),
  ('🔥 Dia 5 · Oferta com urgência',
   E'{Olha só|Presta atenção} 👀\n\nTV por assinatura: *R$ 120+/mês* pra meia dúzia de canais.\n*HyperFlick:* a partir de *R$ 19,90/mês* com +800 canais, filmes, séries e futebol ao vivo. 🧡\n\nE no plano anual sai por menos de *R$ 0,40 por dia*. ☕\n\nBora ativar o seu?',
   'HyperFlick • IPTV', '[{"text":"Quero assinar 💳"},{"text":"Quero testar grátis antes 🎁"}]'),
  ('⏰ Dia 7 · Última chamada',
   E'{Última chamada|Vou liberar sua vaga}! ⏰\n\nSeu acesso de *teste grátis* da HyperFlick expira hoje e a vaga vai pra outra pessoa.\n\nSe quiser {garantir|continuar com} +800 canais e +60 mil filmes e séries sem travar, é só tocar abaixo 👇',
   'HyperFlick • IPTV', '[{"text":"Quero assinar agora 🔥"},{"text":"Quero meu teste grátis 🎁"}]'),
  ('🔄 Recuperação · sumiu depois do teste',
   E'{Oi|Olá}! 😊\n\nVi que você testou a *HyperFlick* e {sumiu|não voltou}... aconteceu {algo|alguma coisa}? Se tiver qualquer dúvida com o app, me chama que eu resolvo contigo na hora. 🧡\n\nE se quiser já ativar seu acesso completo, é só tocar abaixo 👇',
   'HyperFlick • IPTV', '[{"text":"Quero assinar 💳"},{"text":"Tive uma dúvida 🤔"}]')
on conflict (name) do nothing;

-- Correção pontual: remove o {nome} de modelos já semeados em bases antigas.
-- Só mexe se o texto ainda contém {nome} (não sobrescreve modelo editado sem ele).
update message_templates set message_text = replace(replace(replace(message_text,
  ' {nome}!', '!'), ' {nome},', ','), '{nome}, ', '')
where message_text like '%{nome}%';

-- ⚽ COPA DO MUNDO 2026 — anexe a IMAGEM com os jogos do dia na hora do disparo.
insert into message_templates (name, message_text, footer, buttons) values
  ('⚽ Copa do Mundo · Jogos de hoje',
   E'⚽ {É DIA DE COPA|HOJE TEM COPA DO MUNDO}! 🏆\n\n{Olha|Confere} na imagem os jogos de hoje 👆 Na *HyperFlick* você assiste *TODOS ao vivo, em 4K e sem travar* — nem no lance do gol. 🧡\n\n📺 Todos os jogos da Copa + 800 canais, futebol nacional, filmes e séries num app só — {bem mais barato|pagando muito menos} que TV por assinatura.\n\nQuer ver o jogo de hoje *de graça*? Libero seu teste {agora|na hora} 👇',
   'HyperFlick • Copa do Mundo 2026', '[{"text":"Quero meu teste grátis ⚽"},{"text":"Quero assinar 💳"}]')
on conflict (name) do nothing;

-- ============================================================
-- BROADCASTS  (disparos em massa: planilha de números + agendamento)
-- ============================================================
create table if not exists broadcasts (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  message_text  text,
  image         text,                              -- URL ou data-uri
  footer        text,
  buttons       jsonb default '[]'::jsonb,         -- [{"text":"..."}]
  status        text not null default 'agendado'
                check (status in ('agendado','enviando','pausado','concluido','cancelado')),
  scheduled_at  timestamptz default now(),
  total         int default 0,
  sent          int default 0,
  failed        int default 0,
  finished_at   timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists broadcasts_status_idx on broadcasts (status, scheduled_at);

-- Migração (idempotente): instância que dispara + intervalo aleatório anti-ban
alter table broadcasts add column if not exists instance_id  uuid;     -- whatsapp_instances.id (null = instância padrão)
alter table broadcasts add column if not exists delay_min_s  int default 20;
alter table broadcasts add column if not exists delay_max_s  int default 180;
alter table broadcasts add column if not exists next_send_at timestamptz;  -- próximo envio permitido (pacing)
-- Janela de envio (horário comercial, fuso São Paulo) — fora dela o disparo pausa sozinho
alter table broadcasts add column if not exists window_start int default 8;   -- hora (0-23)
alter table broadcasts add column if not exists window_end   int default 21;  -- hora (0-23)

drop trigger if exists trg_broadcasts_updated on broadcasts;
create trigger trg_broadcasts_updated before update on broadcasts
for each row execute function set_updated_at();

create table if not exists broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  broadcast_id  uuid references broadcasts(id) on delete cascade,
  phone         text not null,                     -- só dígitos com DDI
  name          text,                              -- usado no template {nome}
  status        text not null default 'pendente'
                check (status in ('pendente','enviado','falhou')),
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz default now()
);
create index if not exists bcast_rcpt_idx on broadcast_recipients (broadcast_id, status);

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
