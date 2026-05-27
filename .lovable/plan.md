## Plano — Fase 3.2: Importação de Produtos do Bling

### Escopo

Importar produtos do Bling pra dentro do EXPEDE com suporte a multi-empresa, variações, batches grandes (>500 SKUs), peso/dimensões, sync manual + diário, e resolver o débito do `bling_account_name`.

### ⚠️ Conflito de schema detectado

A tabela `produtos` JÁ EXISTE no banco com schema diferente (campos: `empresa_id`, `eans_alternativos`, `localizacao`, `foto_url`, `bling_product_id text`). O novo schema pede recriação completa (campos diferentes, tipos diferentes, FK para `bling_connections`). 

**Decisão:** vou **DROPAR e recriar** `produtos` — não há dados de produção relevantes ainda nessa tabela (Fase 3 acabou de começar), e a `pedido_itens.produto_id` faz referência sem FK explícita então não bloqueia. Vou avisar isso no commit da migração.

Mesma decisão para qualquer dependência: `pedido_itens.produto_id` continua UUID, mas o produto referenciado terá novo schema.

### Mudanças

**1. Migrações DB**
- Habilitar extensão `pg_trgm`
- DROP TABLE `produtos` (schema antigo) + recriar conforme spec
- CREATE TABLE `sync_jobs`
- Índices, GRANTs, RLS (SELECT autenticado; writes só service_role)

**2. Server functions (TanStack, `src/lib/produtos.functions.ts`)**
- `syncProductsStart({ connectionId })` — admin only, idempotente, cria job pendente e dispara run
- `syncProductsRun({ jobId })` — workhorse, processa até 5 páginas (100 produtos/página) por execução, 350ms entre requests, fire-and-forget de continuação
- `updateBlingAccountName({ connectionId })` — busca `/Api/v3/empresas/me` e atualiza
- `listProdutos({ search, connectionId, status, tipo, page })` — paginado 50/pg
- `getActiveSyncJob({ connectionId? })` — polling do banner
- `getLastSyncedAt()` — header subtitle

**3. Server route `/api/public/hooks/bling-sync-products`**
- Cron diário (04:00): para cada `bling_connections` status='connected', cria sync_job e dispara run

**4. Bling callback (`src/routes/oauth/bling/callback.ts`)**
- Após `exchangeCodeAndStore` bem-sucedido, disparar `updateBlingAccountName` (best-effort, sem await crítico). Mexer só nesta linha.

**5. UI `/produtos`** (`src/routes/_app/produtos.tsx`)
- Substituir EmConstrucao por tela real
- Header com título + "última sync" + botão "Sincronizar agora" (admin only)
- Banner de progresso (polling 3s)
- Filtros: busca (debounce 300ms), conta Bling, status, tipo
- Tabela paginada 50/pg
- Estado vazio

**6. Cron pg_cron**
- Adicionar `daily_products_sync` chamando endpoint público
- Botão "Atualizar nome" em `/configuracoes/bling` para conexões existentes

### Não mudar
Tudo que está na lista do usuário: configurações/bling layout, crypto AES, edge functions OAuth existentes (exceto adicionar 1 linha), schema bling_connections/oauth_states, cron refresh, checkout, auth, navegação atual.

### Testes pós-implementação
Validar os 8 testes solicitados e reportar status.
