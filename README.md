# 🧡 HyperFlick — Funil + CRM + WhatsApp

Sistema completo de conversão para o HyperFlick (Canais, Séries e Filmes):

- **Funil laranja** (`/`) — landing + quiz de conversão, prova visual do que entrega, planos reais e captura de lead.
- **CRM Kanban** (`/crm`) — etapas **Lead → Testando → Ganho → Perdido → Follow-up**, conversa por WhatsApp, geração de teste e financeiro.
- **WhatsApp (uazapi)** — cria e gerencia a instância pelo próprio painel (QR code), envia o teste automaticamente e registra as respostas dos clientes.
- **Supabase** — banco dos leads, clientes, cobranças e financeiro (quem pagou / quem não pagou).

---

## 1. Pré-requisitos

- [Node.js 18+](https://nodejs.org)
- Conta no [Supabase](https://supabase.com) (grátis)
- Conta na [uazapi](https://uazapi.com) (WhatsApp API) com **admin token**

## 2. Banco de dados (Supabase)

1. Crie um projeto no Supabase.
2. Vá em **SQL Editor → New query**, cole o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Em **Project Settings → API**, copie a **Project URL** e a **service_role key**.

## 3. Configuração

```bash
copy .env.example .env      # Windows (PowerShell: cp .env.example .env)
```

Edite o `.env`:

| Variável | O que é |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | do passo 2 (use a **service_role**, nunca exponha no front) |
| `SUPABASE_ANON_KEY` | chave **anon/public** (login do CRM via Supabase Auth) |
| `UAZAPI_URL` | servidor uazapi (ex: `https://free.uazapi.com` ou seu self-hosted) |
| `UAZAPI_ADMIN_TOKEN` | admin token da sua conta uazapi (cria/gerencia instâncias) |
| `PUBLIC_URL` | domínio público (usado no webhook). Local: use [ngrok](https://ngrok.com) |
| `PANEL_CHATBOT_URL` | endpoint de chatbot do painel (uhdpainel) que **gera o teste** e retorna usuário/senha |
| `IPTV_PANEL_URL` | DNS/URL de fallback (se o painel não devolver o DNS) |
| `TEST_DURATION_HOURS` | duração do teste (fallback, se o painel não devolver a validade) |
| `PRICE_*` | preços dos planos |
| `CRM_ADMIN_KEY` | senha para entrar no painel `/crm` |

## 4. Rodar

```bash
npm install
npm start
```

- Funil: **http://localhost:3000/**
- CRM:   **http://localhost:3000/crm**

### Acesso ao CRM (Supabase Auth)

1. No Supabase, vá em **Authentication → Users → Add user**, defina **e-mail + senha** e marque *Auto Confirm*.
2. Acesse `/crm` e entre com esse e-mail e senha.

> Sem `SUPABASE_ANON_KEY` configurada, o login usa a `CRM_ADMIN_KEY` como fallback (modo simples).

## 5. Conectar o WhatsApp

1. No CRM, aba **📱 WhatsApp → + Nova instância**.
2. Clique em **Conectar** e leia o **QR Code** no WhatsApp (Aparelhos conectados).
3. Quando ficar **connected**, o teste já é enviado automaticamente ao capturar um lead.

> Para receber as **respostas dos clientes** no CRM, o `PUBLIC_URL` precisa ser acessível pela internet. Em teste local, rode `ngrok http 3000` e coloque a URL do ngrok no `.env` (o webhook é registrado ao criar a instância).

---

## 6. Deploy na Vercel

O projeto já vem pronto pra Vercel (`vercel.json` + função serverless em `api/index.js`).

1. Em [vercel.com](https://vercel.com) → **Add New → Project → Import** o repositório do GitHub.
2. **Framework Preset:** *Other* (não precisa de build command).
3. Em **Settings → Environment Variables**, adicione as mesmas variáveis do `.env`:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `UAZAPI_URL`, `UAZAPI_ADMIN_TOKEN`,
   `IPTV_PANEL_URL`, `TEST_DURATION_HOURS`, `PRICE_MENSAL`, `PRICE_SEMESTRAL`, `PRICE_ANUAL`, `CRM_ADMIN_KEY`.
4. Clique em **Deploy**.
5. **Importante:** depois do 1º deploy, copie o domínio gerado (ex: `https://hyperflick.vercel.app`),
   coloque em `PUBLIC_URL` nas Environment Variables e faça **Redeploy**. Esse valor é usado no
   webhook da uazapi (respostas dos clientes chegam no CRM).
6. Reconecte a instância do WhatsApp no `/crm` (o webhook é registrado com a nova URL pública).

> Tudo roda em função serverless (sem servidor persistente): banco no Supabase, WhatsApp via uazapi.
> Os arquivos do funil/CRM (`public/`) são servidos pela própria função (`includeFiles` no `vercel.json`).

---

## Fluxo de conversão

```
Funil (quiz + prova visual) → escolhe plano → instala o app
        → preenche nome + WhatsApp
        → POST /api/leads  ──►  cria lead (Supabase)
                              ►  gera teste (usuário/senha)
                              ►  envia no WhatsApp (uazapi)
                              ►  card entra no CRM em "Testando"
CRM: acompanha conversa, marca Ganho (gera cobrança), Perdido ou Follow-up.
```

## Provisionamento do teste (painel uhdpainel)

O teste é criado **de verdade** no painel via o endpoint de chatbot configurado em `PANEL_CHATBOT_URL`
([`server/lib/panel.js`](server/lib/panel.js)). O painel responde com `username`, `password`, `dns`,
validade e `payUrl`. Em seguida o sistema:

1. salva usuário, senha, DNS, validade, link de pagamento e o **app instalado** no CRM;
2. envia as credenciais no WhatsApp do cliente via uazapi (template em `settings.template_teste`).

Se `PANEL_CHATBOT_URL` não estiver configurado, cai num gerador local de exemplo (para testes).

## Estrutura

```
server/            # API Express
  routes/          # leads, instances, payments, webhook, settings
  lib/             # helpers, serviço de WhatsApp + geração de teste
  uazapi.js        # cliente da API uazapi
  supabase.js      # cliente Supabase (service role)
public/            # funil (index.html + funnel.js)
  crm/             # painel CRM
supabase/schema.sql
```
