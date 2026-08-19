# Relatório de Migração — Supabase Lovable Cloud → Conta Própria

**Status: preparação completa, cutover NÃO executado.**
ORIGEM permanece 100% intocado e funcional como fallback.

| | Projeto | Ref | Org/Workspace |
|---|---|---|---|
| **ORIGEM** (read-only, intocado) | expede (Lovable) | `fjfiaxjeiugqlxtjtubn` | Vinicius's Lovable |
| **DESTINO** (preparado, não em uso) | EXPEDE | `faukznejkvdzmgualsnj` (sa-east-1) | `qaippkdssmnzpqomxrvr` |

---

## 1. Schema (Tarefas 1 e 2)

- `supabase/migrations/` tinha 12 arquivos; foi criada **1 migration nova**:
  `supabase/migrations/20260613120000_shopee-connections-marketplace.sql`
  - cria a tabela `shopee_connections` (com RLS + policy "authenticated read")
  - adiciona `pedidos.marketplace` e `pedidos.marketplace_order_id`
  - cria índice `idx_pedidos_marketplace_order_id`
- `npx supabase link --project-ref faukznejkvdzmgualsnj` + `db push` aplicados
  com sucesso no DESTINO. `supabase/config.toml` já aponta para
  `faukznejkvdzmgualsnj`.
- Usuário-seed criado automaticamente pela migration
  `20260526210940_...` (admin `vinicius@lojababyworld.com.br` com senha
  placeholder) foi **removido** após o push, antes da migração real de
  `auth.users` (Tarefa 6), para evitar conflito de e-mail único.
- **Validação Tarefa 8**: `npx supabase gen types typescript --project-id
  faukznejkvdzmgualsnj --schema public` gera um `types.ts` **byte-idêntico**
  (ignorando CRLF/LF) ao `src/integrations/supabase/types.ts` atual do
  repositório → schema do DESTINO tem paridade total com o ORIGEM. Nenhuma
  alteração foi necessária no arquivo.

### Tabelas/views no DESTINO (13 tabelas + 1 view) — todas com RLS habilitado

| Relação | RLS |
|---|---|
| bipagens | ✅ |
| bling_connections | ✅ |
| canais | ✅ |
| empresas | ✅ |
| ml_connections | ✅ |
| oauth_states | ✅ |
| pedido_itens | ✅ |
| pedidos | ✅ |
| produtos | ✅ |
| profiles | ✅ |
| shopee_connections | ✅ |
| sync_jobs | ✅ |
| user_roles | ✅ |
| bling_connections_status (view) | n/a (view, herda RLS das tabelas base) |

---

## 2. Edge Functions (Tarefa 4)

Únicas 2 functions existentes no repo, deployadas e ativas no DESTINO:

| Function | Status | Versão |
|---|---|---|
| `ml-label` | ACTIVE | v1 |
| `ml-token-exchange` | ACTIVE | v1 |

---

## 3. Secrets configurados no DESTINO (Tarefa 3) — 9/9

Apenas nomes, nenhum valor foi exposto/commitado:

| Secret | Status |
|---|---|
| `ADMIN_KEY` | ✅ configurado |
| `BLING_CLIENT_ID` | ✅ configurado |
| `BLING_CLIENT_SECRET` | ✅ configurado |
| `BLING_ENCRYPTION_KEY` | ✅ configurado (idêntico ao ORIGEM — crítico p/ descriptografar tokens migrados) |
| `BLING_REDIRECT_URI` | ✅ configurado |
| `ML_CLIENT_ID` | ✅ configurado |
| `ML_CLIENT_SECRET` | ✅ configurado |
| `QZ_TRAY_PRIVATE_KEY` | ✅ configurado |
| `QZ_TRAY_CERTIFICATE` | ✅ configurado |

Secrets auto-provisionados pelo Supabase (não configurados manualmente, já
existem em qualquer projeto novo): `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`.

---

## 4. Dados migrados (Tarefa 5) — contagem ORIGEM vs DESTINO

Migração feita em ordem FK-safe, via upsert idempotente
(`INSERT ... ON CONFLICT (id) DO UPDATE`).

| Tabela | ORIGEM | DESTINO | Status |
|---|---|---|---|
| `empresas` | 1 | 1 | ✅ |
| `canais` | 5 | 5 | ✅ |
| `profiles` | 2 | 2 | ✅ |
| `user_roles` | 2 | 2 | ✅ |
| `produtos` | 2746 | 2746 | ✅ (ver pendência `raw_data` abaixo) |
| `pedidos` | 153 | 153 | ✅ |
| `pedido_itens` | 171 | 171 | ✅ |
| `bipagens` | 164 | 164 | ✅ |
| `bling_connections` | 1 | 1 | ✅ (tokens migrados como texto opaco, sem decodificar) |
| `ml_connections` | 1 | 1 | ✅ (tokens migrados como texto opaco, sem decodificar) |
| `shopee_connections` | 0 | 0 | ✅ (tabela criada, sem dados em ambos) |
| `oauth_states` | 2 | 0 | ⏭️ não migrado — intencional, regenera no próximo login OAuth |
| `sync_jobs` | 36 | 0 | ⏭️ não migrado — intencional, são logs históricos de sync, regenera sozinho |

---

## 5. Auth (Tarefa 6)

- `auth.users`: 2/2 migrados, preservando `id`, `encrypted_password`
  (hash original), `email_confirmed_at`, `raw_user_meta_data`,
  `raw_app_meta_data`, `created_at`/`updated_at`.
- `auth.identities`: 2/2 migrados (provider `email`).
- Login com a senha original deve funcionar sem reset, **mas ainda não foi
  testado** (cutover não executado).

---

## 6. Referências ao ref do ORIGEM (Tarefa 7) — trocar no cutover

Busca por `fjfiaxjeiugqlxtjtubn` em todo o repo (exceto `node_modules`/`.git`):

| Arquivo | Linhas | Observação |
|---|---|---|
| `.env` | 1, 3, 4, 6 (`SUPABASE_PROJECT_ID`, `SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`) | precisa trocar para `faukznejkvdzmgualsnj` / `https://faukznejkvdzmgualsnj.supabase.co` no cutover |
| `supabase/config.toml` | — | **já atualizado** para `faukznejkvdzmgualsnj` (feito na Tarefa 2, `supabase link`) |

⚠️ **Achado à parte (pré-existente, não criado por esta migração)**: `.env`
está rastreado pelo git (`git ls-files .env` retorna o arquivo) e não há
entrada para ele em `.gitignore`. Vale avaliar remover do versionamento e
adicionar ao `.gitignore`, mas isso é uma decisão separada do cutover.

---

## 7. Pendências / itens abertos

1. **`produtos.raw_data` (jsonb)** — coluna existe no DESTINO mas está
   `NULL` em todas as 2746 linhas (no ORIGEM, todas as 2746 têm valor). É
   cache do sync com o Bling; **repopula automaticamente no próximo sync**,
   não foi migrado linha a linha.
2. **Rotação de PAT (Supabase Management API)** — nota do Obsidian: o PAT
   original `sbp_c09...` foi marcado como exposto/para rotacionar. O PAT
   atualmente configurado (`sbp_c376...`) é diferente, está funcionando e foi
   usado em toda esta migração — apenas FYI, nenhuma ação tomada aqui.
3. **`.env` versionado sem `.gitignore`** — ver seção 6, achado pré-existente.
4. **Cutover não executado** — `.env`, `supabase/config.toml` (já trocado) e
   qualquer client hardcoded ainda apontam efetivamente para o ORIGEM via
   `.env`. Para cutover real: atualizar `.env` (seção 6), testar login (item 5
   abaixo), e decidir sobre `produtos.raw_data` (item 1).
5. **Login com hash migrado** — não testado ainda (depende do cutover).
