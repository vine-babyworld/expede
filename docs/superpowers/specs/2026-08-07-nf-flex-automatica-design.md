# Design: Controle de Emissão de NF para Pedidos ML Flex

**Data:** 2026-08-07
**Status:** Diagnóstico — aguardando decisão do Vinicius. Nenhum arquivo de código foi alterado nesta etapa.

---

## Contexto

Pedidos Mercado Envios Flex estão tendo a NF-e emitida automaticamente pelo
Bling (opção "Gerar NF-e ao incluir pedidos de venda"), e uma fração desses
pedidos é cancelada pelo comprador logo depois — a NF já foi pra SEFAZ antes
do cancelamento, gerando trabalho de estorno/cancelamento de nota.

Decisão do Vinicius (já tomada, fora do escopo deste documento): desligar a
emissão automática de NF-e para Mercado Livre dentro do Bling. A partir daí,
o Bling continua importando o pedido normalmente, mas ninguém mais dispara a
NF — esse controle passa a ser do EXPEDE, que deve esperar uma janela de
segurança, revalidar o pedido contra o Mercado Livre, e só então mandar o
Bling gerar e enviar a nota.

Este documento é o levantamento pedido antes de qualquer código: arquitetura
atual do EXPEDE, confirmação ao vivo das APIs do Bling e do Mercado Livre, e
a proposta técnica pra fazer isso com a menor mudança estrutural possível.

## Resumo executivo (achado principal)

O EXPEDE já tem ~80% da infraestrutura necessária construída e rodando em
produção — só nunca fechou o último passo (criar a NF). Concretamente, hoje
já existem:

- Importação de pedidos Flex **sem NF** (`reconciliarPedidos`, Query 2, loja
  ML Flex `idLoja=203482894`, `permitirSemNf: true`).
- Detecção de Flex (`isPedidoFlex()`), já usada em produção pra **isentar**
  esses pedidos da trava de "sem NF bloqueia bipagem" — ou seja, a expedição
  física do Flex **já não espera a NF hoje**. Isso reduz bastante o risco do
  projeto: nada no fluxo de bipagem/impressão de etiqueta precisa mudar.
- Cron que consulta a situação real da NF na SEFAZ (`cronNfStatus`, a cada 2
  min, `GET /nfe/{id}`) e grava em `pedidos.nf_situacao` — funciona pra
  qualquer NF, não importa quem criou. **Reaproveitável sem alteração.**
- Padrão de cron com lock distribuído via tabela `cron_state` (gate
  memória + banco, upsert antes de executar) — é o mecanismo de
  idempotência que os outros 3 crons já usam, e que este módulo replica em
  nível de linha.
- Confirmação, via OpenAPI oficial do Bling (baixado ao vivo nesta
  investigação), do endpoint exato pra gerar NF a partir de um pedido de
  venda existente **sem reconstruir tributação manualmente**:
  `POST /pedidos/vendas/{idPedidoVenda}/gerar-nfe`.

O que falta é 100% novo: nada no projeto hoje chama esse endpoint, nem
`POST /nfe` — confirmado por busca no código inteiro. O Bling sempre foi
quem criava a nota; o EXPEDE só observava.

---

## Arquitetura encontrada

### Stack

TanStack Start (React 19, SSR) + Vite, rodando como Cloudflare Worker
(`wrangler.jsonc`, projeto `babyworld`, preset Nitro `cloudflare-module`).
Banco: Supabase (Postgres + Auth + Edge Functions em Deno). Sem test suite —
verificação do projeto é `npm run build` (TS) + `npm run lint` + teste manual
(dev server / `wrangler tail` em produção). Deploy é sempre manual
(`npx wrangler deploy`), nunca automático.

### Autenticação / segredos

- **Bling:** OAuth2, `bling_connections` (`access_token`/`refresh_token`
  **criptografados** com AES-256-GCM via Web Crypto API,
  `src/lib/bling.functions.ts`). Auto-refresh em `getDecryptedAccessToken()`.
  API do Bling é acessada **diretamente** do Cloudflare Worker (sem proxy) —
  já usado assim em `pedidos.functions.ts`, `bling-pedidos.ts`, etc.
- **Mercado Livre:** OAuth2, `ml_connections` (`access_token`/`refresh_token`
  em **texto puro** — assimetria com o Bling, não é escopo mudar isso aqui).
  **Cloudflare Workers não alcançam `api.mercadolibre.com` diretamente**
  (erro 1016/530 — comentário explícito em
  `supabase/functions/ml-shipment-status/index.ts:2`). Toda chamada à API do
  ML precisa passar por uma **Supabase Edge Function (Deno)** como proxy,
  invocada via `supabaseAdmin.functions.invoke(fn, {body})`. Isso é uma
  restrição de infraestrutura real, não escolha de design — qualquer nova
  chamada ao ML neste projeto tem que seguir esse caminho.

### Tabela `pedidos` (schema atual relevante)

Colunas já existentes (via `supabase/migrations/20260531000000_pedidos-bling.sql`
+ ALTERs subsequentes): `id`, `bling_connection_id`, `bling_pedido_id`,
`numero`, `numero_loja`, `situacao_id`, `situacao_valor`, `data_pedido`,
`total`, `cliente` (jsonb), `bling_nota_fiscal_id`, `bling_nota_fiscal_numero`,
`raw_json` (jsonb, payload bruto do Bling), `marketplace` (default
`'mercadolivre'`, também `'mercadolivreflex'`/`'shopee'`),
`marketplace_order_id`, `printed_at`, `etiqueta_zpl`, `etiqueta_tipo`,
`ml_shipment_status`, `ml_shipment_substatus`, `ml_status_checked_at`,
`bling_divergente`, `arquivado`, `arquivado_motivo`, `arquivado_em`,
`nf_situacao`, `nf_situacao_motivo`, `nf_situacao_checked_at`,
`situacao_checked_at`. Constraint única `(bling_connection_id, bling_pedido_id)`.
`pedido_itens` tem `quantidade_bipada`.

### Ingestão de pedidos — dois caminhos, comportamento diferente

1. **Webhook** `POST /api/public/hooks/bling-pedidos`
   (`src/routes/api/public/hooks/bling-pedidos.ts`): Bling dispara em
   eventos do pedido. Hoje **filtra fora** (`skipped: "no_invoice"`) qualquer
   pedido sem `notaFiscal.id` (linha 71-75) — não é o caminho que hoje traz
   Flex sem NF pro banco.
2. **Reconciliador** `reconciliarPedidos()` (`src/lib/pedidos.functions.ts:445`),
   rodando a cada 1 min via `cronReconciliar()`. Faz 3 buscas em paralelo na
   API do Bling (Q1 faturados loja ML, **Q2 = loja ML Flex, `idLoja=203482894`,
   sempre com `permitirSemNf: true`**, Q5 faturados Shopee). É o Q2 que hoje
   importa Flex **sem NF nenhuma** pro banco (`processarPedidoBling`,
   linha 186, aceita `d.notaFiscal?.id` ausente quando `permitirSemNf`).
   Depois, "Passo 2" (`atualizarSituacoesExistentes`, linha 788) revisita
   pedidos dos últimos 30 dias e detecta quando uma NF **"surgiu"**
   (`nfSurgiu`, linha 859) — hoje isso só acontece porque o Bling cria a NF
   sozinho depois. É exatamente esse ponto que o novo módulo substitui: em
   vez de só esperar o Bling criar a nota, o EXPEDE mesmo vai criá-la quando
   as condições de segurança forem satisfeitas.

### Detecção de Flex — já existe, é do lado do Bling, não do ML

`isPedidoFlex()` (`src/lib/pedidos.functions.ts:95-99`): `true` se
`marketplace === "mercadolivreflex"` OU
`raw_json.transporte.volumes[0].servico` contém "flex" (case-insensitive).
Já usada em `ExpedicaoPage.tsx`, `a-expedir.tsx`, `historico.tsx`,
`dashboard.functions.ts` — inclusive pra **isentar Flex da trava de NF na
bipagem** (`ExpedicaoPage.tsx:233,279,283,310`; `historico.tsx:94`). Ou seja:
**hoje o operador já bipa e despacha o Flex sem esperar NF nenhuma.** O
módulo novo não precisa (e não deve) tocar nesse fluxo — é puramente sobre
o ciclo de vida da nota fiscal, desacoplado da expedição física.

### Situação da NF — já rastreada, reaproveitável 100%

Todo o vocabulário já existe em `pedidos.functions.ts` (linhas 897-981):
`fetchNfSituacaoBling()` (`GET /nfe/{id}`), `NF_SITUACOES_AUTORIZADAS =
{5, 6}`, `nfSituacaoLabel()`, `nfNaoAutorizada()`. O cron `cronNfStatus`
(`src/server.ts:229-359`, a cada 2 min) já mantém `nf_situacao` /
`nf_situacao_motivo` / `nf_situacao_checked_at` atualizados pra **qualquer**
pedido com `bling_nota_fiscal_id` preenchido — não importa se a NF foi criada
pelo Bling automaticamente ou pelo novo módulo. **Não precisa mudar nada
aqui**, só garantir que o novo módulo grava `bling_nota_fiscal_id` do mesmo
jeito que o fluxo atual grava.

### Padrão de cron — reaproveitar, não inventar

4 jobs hoje (`src/server.ts` + `plugins/cloudflare-scheduled.ts`), todos com
o mesmo esqueleto: gate em memória (evita round-trip ao banco no mesmo
isolate) → gate durável via `cron_state` (upsert **antes** de executar,
protege contra isolates concorrentes) → busca de candidatos em dois baldes
("nunca verificados", ordenado por mais antigo; "retry", ordenado por
`*_checked_at` ascendente) → processa até um limite por execução, respeitando
rate limit do Bling (`await sleep(350ms)` = ~3 req/s). Esse padrão de
"balde nunca-visto vs retry rotativo por checked_at" é chamado de "Lição #16"
nos comentários do código — existe porque um bug real de starvation já
aconteceu com ordenação estática. **O novo cron deve seguir exatamente esse
padrão.**

### O que não existe (confirmado por busca no código inteiro)

Nenhuma chamada a `POST /nfe` ou a qualquer endpoint de criação de NF em
lugar nenhum do projeto. `danfe.functions.ts` só faz `GET /nfe` (lista, pra
achar `chaveAcesso` e renderizar um DANFE customizado). O Bling sempre foi
quem criou a nota; o EXPEDE só leu.

---

## APIs confirmadas ao vivo (não presumidas)

### Bling API v3 — OpenAPI oficial

Baixei o spec oficial (`developer.bling.com.br` expõe o JSON puro em
`/build/assets/openapi-*.json`) e confirmei os endpoints relevantes:

**`POST /pedidos/vendas/{idPedidoVenda}/gerar-nfe`** — esta é a resposta pra
pergunta que você queria confirmada antes de qualquer código: **existe, sim,
uma forma nativa de converter o pedido de venda já existente em NF-e sem
reconstruir tributação manualmente.**

- Sem corpo de requisição — só o `idPedidoVenda` na URL.
- `x-api-action: GerarNotaFiscal`. Descrição oficial: "Gera nota fiscal
  eletrônica a partir do pedido de venda pelo ID."
- Resposta `201`: `{ "idNotaFiscal": number }`.
- Resposta `400`/`404`: `ErrorResponse` (schema abaixo).
- Reaproveita 100% da configuração fiscal já resolvida pelo Bling no pedido
  (CFOP, natureza, tributação, cliente, itens) — exatamente o "não
  reconstruir manualmente" que você pediu pra verificar antes de prosseguir.

**`POST /nfe/{idNotaFiscal}/enviar`** (já conhecido, só a confirmação do
detalhe): query param `enviarEmail` (boolean) — **default já é `false`**, não
precisa ser passado explicitamente (mas não faz mal ser explícito). Resposta
`200`: `{ data: { xml: string } }`. Isso dispara o envio pra SEFAZ.

**`GET /nfe/{idNotaFiscal}`** — já usado hoje (`fetchNfSituacaoBling`), sem
mudança necessária.

**Schema de erro (`Error`)** — importante pra classificação de erro (ver
seção "Tratamento de erros"):

```json
{
  "type": "VALIDATION_ERROR",  // enum abaixo
  "message": "string",
  "description": "string",
  "fields": [ /* ErrorField[], quando aplicável */ ]
}
```

`type` ∈ `BAD_REQUEST | VALIDATION_ERROR | MISSING_REQUIRED_FIELD_ERROR |
EMPTY_REQUEST_BODY | INVALID_REQUEST_BODY | INVALID_APIKEY_ERROR |
UNAUTHORIZED | UNAUTHENTICATED | FORBIDDEN | RESOURCE_NOT_FOUND |
METHOD_NOT_ALLOWED | TOO_MANY_REQUESTS | UNKNOWN_ERROR | SERVER_ERROR |
NOT_IMPLEMENTED`.

### Mercado Livre API — documentação oficial (última atualização 24/06/2026)

**`GET /orders/{id}`** — status possíveis, oficiais:

| status | significado |
|---|---|
| `confirmed` | inicial, ainda sem pagamento |
| `payment_required` | aguardando confirmação de pagamento |
| `payment_in_process` | pagamento em processamento |
| `partially_paid` | pagamento parcial creditado (insuficiente) |
| `paid` | pagamento aprovado |
| `partially_refunded` | devolução parcial |
| `pending_cancel` | cancelada mas com dificuldade de devolver o pagamento |
| `cancelled` | pedido não concluído |
| `invalid` | invalidado — veio de comprador malicioso |

Campo `tags` (array): inclui `fraud_risk_detected` quando o ML detecta
fraude pós-pagamento — nesse caso também dispara notificação no tópico
`orders_v2`. Texto oficial: *"após identificado, o pedido deve ser
cancelado"*.

Campo `cancel_detail` (mais rico que só a tag, útil pro log/auditoria):
`{ group, code, description, requested_by, date }`, onde `group` ∈
`mediations | fiscal | buyer | fraud | item | shipment | delivery | seller |
internal`.

Header `x-format-new: true` é documentado como necessário especificamente
pro cálculo combinado `total_amount_with_shipping` (`GET /orders` +
`GET /shipments`) — não é claramente obrigatório só pra checar `status`, mas
não custa nada mandar sempre.

**Shipment status** — o projeto já tem, em produção, uma função que resolve
isso (`supabase/functions/ml-shipment-status/index.ts`): `GET
/orders/{id}/shipments` (com fallback via `/packs/{id}` → `orders[0].id` →
`/orders/{orderId}/shipments` quando o primeiro dá 404), extraindo `status`,
`substatus`, `logistic_type`. Valores `shipped`/`delivered` já são usados e
validados em produção (`ML_DESPACHADO_STATUSES`, `ml.functions.ts:177`). Não
encontrei, nas páginas oficiais acessíveis nesta sessão, um catálogo
autoritativo e atual de todos os substatus pra Mercado Envios 2/Flex — a
página "Status de pedidos e rastreamento" documenta o modo ME1 (mais antigo),
que não é necessariamente o mesmo catálogo. **Recomendo validar os valores
reais de `status`/`substatus` contra um shipment Flex real durante a
implementação**, em vez de travar regras de bloqueio em valores não
confirmados.

---

## Decisões de arquitetura recomendadas

1. **Detecção de Flex continua sendo `isPedidoFlex()` (lado Bling), não o
   `logistic_type` do ML.** É a função já validada em produção; trocar a
   fonte de verdade adicionaria uma chamada ML no caminho crítico só pra
   detecção, sem necessidade — o ML é consultado depois, só pra validação de
   segurança antes de emitir.
2. **Bipagem/expedição não muda.** Confirmado que Flex já despacha sem
   esperar NF hoje — o módulo novo é aditivo, isolado no ciclo de vida
   fiscal.
3. **`cronNfStatus` não muda.** Já cobre "acompanhar autorização SEFAZ" pra
   qualquer NF, incluindo as criadas pelo novo módulo.
4. **Config `flexInvoiceDelayMinutes` muda sem deploy** → precisa de uma
   tabela nova (`app_config`, chave/valor), lida uma vez no início de cada
   execução do novo cron — o projeto hoje só tem `vars` fixas no
   `wrangler.jsonc` (exigem deploy pra mudar) ou colunas de tabelas
   específicas (nenhuma genérica). Ver "Dúvidas" — é a única peça de infra
   genuinamente nova proposta aqui, o resto reaproveita padrões existentes.

---

## Modelo de dados proposto

### Novas colunas em `pedidos` (mesma tabela, mesmo padrão das colunas `nf_situacao`/`ml_shipment_status` já existentes)

| Coluna | Tipo | Uso |
|---|---|---|
| `nf_flex_status` | TEXT | Máquina de estado própria do EXPEDE: `waiting \| eligible \| validating \| creating \| created \| sending \| authorized \| blocked \| error`. Distinta de `nf_situacao` (que é o código de situação da SEFAZ/Bling). |
| `nf_flex_bloqueio_motivo` | TEXT | Motivo quando `status = blocked` ou `error` (ex.: `ML_ORDER_NOT_ELIGIBLE:fraud_risk_detected`). |
| `nf_flex_eligible_at` | TIMESTAMPTZ | `data_pedido + flexInvoiceDelayMinutes` — calculado na importação. |
| `nf_flex_last_validated_at` | TIMESTAMPTZ | Última vez que o pedido foi revalidado contra o ML (cron ou ação manual). |
| `nf_flex_locked_at` | TIMESTAMPTZ | Usado pelo claim atômico (ver "Idempotência"). |
| `nf_flex_attempts` | INT DEFAULT 0 | Contador de tentativas, pra alertar se um pedido está preso. |
| `ml_order_status` | TEXT | Cache do último `status` de `GET /orders/{id}`. |
| `ml_order_tags` | JSONB | Cache do array `tags` (auditoria + decisão). |
| `ml_order_checked_at` | TIMESTAMPTZ | Quando a order (não o shipment) foi checada por último. |

Índice parcial nos moldes do já existente em `nf_situacao`:

```sql
CREATE INDEX idx_pedidos_nf_flex_status
  ON public.pedidos (nf_flex_eligible_at ASC NULLS FIRST)
  WHERE nf_flex_status IN ('waiting', 'eligible');
```

### Nova tabela `nf_flex_eventos` (log/auditoria, append-only)

```sql
CREATE TABLE public.nf_flex_eventos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id     UUID NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,   -- ORDER_IMPORTED, FLEX_IDENTIFIED, INVOICE_WAIT_STARTED,
                                  -- ML_ORDER_VALIDATED, ML_SHIPMENT_VALIDATED, INVOICE_BLOCKED,
                                  -- INVOICE_CREATE_STARTED, INVOICE_CREATED, INVOICE_SEND_STARTED,
                                  -- INVOICE_AUTHORIZED, INVOICE_ERROR
  status_anterior TEXT,
  status_novo     TEXT,
  motivo          TEXT,
  detalhe         JSONB,          -- resumo de request/response, nunca token
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nf_flex_eventos_pedido ON public.nf_flex_eventos(pedido_id, created_at DESC);
```

RLS: mesmo padrão de `pedidos` (SELECT autenticado, escrita só `service_role`).

### Nova tabela `app_config` (proposta — ver "Dúvidas")

```sql
CREATE TABLE public.app_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seed: insert into app_config (key, value) values ('flex_invoice_delay_minutes', '20');
```

---

## Serviços / arquivos novos

| Arquivo | Operação | Responsabilidade |
|---|---|---|
| `supabase/migrations/2026XXXX_nf-flex.sql` | Create | Colunas em `pedidos`, tabela `nf_flex_eventos`, tabela `app_config` |
| `supabase/functions/ml-order-status/index.ts` | Create | Proxy Deno pra `GET /orders/{id}` (mesmo padrão de `ml-shipment-status/index.ts`) — CF Worker não alcança a API do ML diretamente |
| `src/lib/ml.functions.ts` | Modify (append) | `checarStatusPedidoML()`, espelhando `checarStatusEnvioML()` |
| `src/lib/nf-flex.functions.ts` | Create | `canIssueInvoice()`, `gerarNfBling()`, `enviarNfBling()`, `processarFilaNfFlex()`, server functions de leitura/ação manual pra tela |
| `src/lib/pedidos.functions.ts` | Modify | Em `processarPedidoBling`, quando `isPedidoFlex && !notaFiscal.id`: grava `nf_flex_status='waiting'` e `nf_flex_eligible_at` |
| `src/server.ts` | Modify (append) | `cronNfFlex()`, mesmo esqueleto de `cronNfStatus`/`cronMLStatus` |
| `plugins/cloudflare-scheduled.ts` | Modify | Registra `cronNfFlex` no hook `cloudflare:scheduled` |
| `src/routes/_app/nf-flex.tsx` | Create | Rota da nova tela |
| `src/features/nf-flex/NfFlexPage.tsx` | Create | Componente da tela (tabela + indicadores + ações) |
| `src/components/layout/AppShell.tsx` | Modify | Novo item de menu "NF Flex" no array `items` (linha 6-13) |

---

## Mecanismo de fila

**Sem infraestrutura nova.** O projeto não usa Redis/SQS/pg-boss em lugar
nenhum — a "fila" dos 3 crons existentes é a própria tabela Postgres,
consultada por polling a cada execução do cron (1-5 min), com priorização em
dois baldes (nunca-visto vs retry). O novo cron `cronNfFlex` segue
exatamente esse molde:

```
baldeA = pedidos com nf_flex_status IN ('waiting') e nf_flex_eligible_at <= now()
         ORDER BY data_pedido ASC LIMIT N
baldeB = pedidos com nf_flex_status IN ('eligible', 'blocked' com motivo retryable)
         ORDER BY nf_flex_last_validated_at ASC NULLS FIRST LIMIT (restante)
```

Introduzir uma fila de verdade (Cloudflare Queues, por exemplo) seria mudança
estrutural desnecessária — o volume (pedidos Flex/dia) e a cadência (cron de
1 min já rodando) não justificam.

---

## Estratégia de idempotência

Duas camadas, nenhuma delas exige infraestrutura nova:

**1. Claim atômico por linha** (mesmo princípio do `cron_state`, em
granularidade de pedido em vez de job): antes de processar um candidato, o
worker tenta

```sql
UPDATE pedidos
SET nf_flex_status = 'validating', nf_flex_locked_at = now()
WHERE id = $1
  AND nf_flex_status IN ('waiting', 'eligible')
  AND (nf_flex_locked_at IS NULL OR nf_flex_locked_at < now() - interval '5 minutes')
RETURNING id;
```

Se retornar 0 linhas, outro isolate já pegou (ou está em andamento) — pula.
O `UPDATE ... WHERE ... RETURNING` é atômico no Postgres; não precisa de lock
explícito nem de tabela de lock separada. O timeout de 5 min destrava
automaticamente um pedido preso por um isolate que morreu no meio (ex.:
Worker reciclado) sem exigir intervenção manual.

**2. Defesa final antes de criar a NF**: mesmo com o claim, o worker
reconsulta `bling_nota_fiscal_id IS NULL` imediatamente antes de chamar
`gerar-nfe` — se já não for nulo (outra via preencheu, ex. alguém emitiu
manualmente no Bling nesse meio-tempo), aborta e sincroniza o estado em vez
de criar uma segunda nota.

**3. A confirmar empiricamente** (ver "Dúvidas"): se `POST
/pedidos/vendas/{id}/gerar-nfe` chamado duas vezes pro mesmo pedido já
faturado é idempotente do lado do Bling (provavelmente retorna erro
`RESOURCE_NOT_FOUND`/`VALIDATION_ERROR` na segunda chamada, já que o pedido
muda de situação após faturado) — mas não dá pra assumir isso sem testar em
homologação, então as camadas 1 e 2 acima são a proteção real, não uma
suposição sobre o comportamento do Bling.

---

## Regras de bloqueio (`canIssueInvoice`)

Usando os enums confirmados nesta investigação (não os supostos):

```ts
function canIssueInvoice(order: MLOrder, shipment: MLShipment): { ok: true } | { ok: false; motivo: string } {
  if (order.status !== "paid") {
    return { ok: false, motivo: `ML_ORDER_STATUS:${order.status}` };
  }
  if (order.tags?.includes("fraud_risk_detected")) {
    return { ok: false, motivo: "ML_ORDER_FRAUD_RISK" };
  }
  if (shipment.status === "cancelled" || shipment.status === "not_delivered") {
    return { ok: false, motivo: `ML_SHIPMENT_STATUS:${shipment.status}` };
  }
  return { ok: true };
}
```

Nota: `order.status !== "paid"` já cobre `cancelled`, `pending_cancel` e
`invalid` (são todos diferentes de `"paid"`) — não precisa de uma lista de
exclusão separada. Em caso de dúvida (campo ausente, resposta inesperada,
erro de rede na consulta ML) → **bloquear e marcar `nf_flex_status='blocked'`
com motivo `VALIDATION_INCONCLUSIVE`**, nunca seguir em frente sem
confirmação — mesmo espírito conservador do resto do projeto (ver
`nfNaoAutorizada`, que também trata `null` como "não confirmado" e não deixa
passar silenciosamente pra emissão).

---

## Fluxo exato — Bling

```
1. pedido já existe em `pedidos` com nf_flex_status = 'eligible'
   (nf_flex_eligible_at <= now(), claimado atomicamente)
2. GET /pedidos/vendas/{bling_pedido_id}  — não deveria ter mudado de
   depósito/itens desde a importação, mas revalida por segurança (mesmo
   padrão de `processarPedidoBling`)
3. valida bling_nota_fiscal_id IS NULL no banco (defesa final)
4. POST /pedidos/vendas/{bling_pedido_id}/gerar-nfe
   → 201 { idNotaFiscal }  → grava bling_nota_fiscal_id, nf_flex_status='created'
   → 400/404 { error }     → classifica (ver "Tratamento de erros"), grava
                              nf_flex_status='error' ou 'blocked', loga evento
5. POST /nfe/{idNotaFiscal}/enviar?enviarEmail=false
   → 200 { data: { xml } } → nf_flex_status='sending'
   → erro                  → nf_flex_status='error', loga evento (a NF já
                              existe no Bling nesse ponto — não tenta criar
                              de novo, só reenviar)
6. cronNfStatus (já existente, sem mudança) assume a partir daqui — consulta
   GET /nfe/{idNotaFiscal} a cada 2 min até nf_situacao ∈ {5,6}
7. quando nf_situacao autorizada → nf_flex_status='authorized'
```

Rate limit: mesmo respeito de 350ms entre chamadas já usado em
`reconciliarPedidos`/`atualizarSituacoesExistentes` (Bling = 3 req/s).

## Fluxo exato — Mercado Livre

```
1. checarStatusPedidoML(numero_loja)
   → supabaseAdmin.functions.invoke("ml-order-status", { ml_order_id, access_token })
   → edge function faz GET https://api.mercadolibre.com/orders/{id}
     com header x-format-new: true
   → retorna { ok, status, tags, cancel_detail, shipping_id }
2. checarStatusEnvioML(numero_loja)  — já existe, sem mudança
   → status/substatus/logistic_type do shipment
3. canIssueInvoice(order, shipment) — ver regras acima
4. grava ml_order_status, ml_order_tags, ml_order_checked_at
   independente do resultado (auditoria)
```

Toda chamada ao ML passa pela Supabase Edge Function — nunca direto do
Cloudflare Worker (restrição de infraestrutura confirmada no próprio
código do projeto).

---

## Tratamento de erros

Classificação baseada no `error.type` real do Bling (schema confirmado):

| `error.type` | Ação |
|---|---|
| `TOO_MANY_REQUESTS` | Retry com backoff (mesmo respeito de rate limit já usado) |
| `SERVER_ERROR`, `UNKNOWN_ERROR`, `NOT_IMPLEMENTED` | Retry com backoff — transitório |
| `UNAUTHORIZED`, `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_APIKEY_ERROR` | Não retry automático — sinaliza reconexão do Bling (mesmo padrão de `status: "expired"` já usado em `refreshConnectionById`) |
| `VALIDATION_ERROR`, `MISSING_REQUIRED_FIELD_ERROR`, `BAD_REQUEST`, `INVALID_REQUEST_BODY`, `EMPTY_REQUEST_BODY`, `RESOURCE_NOT_FOUND` | **Não retry** — `nf_flex_status='blocked'`, exige revisão manual (ex.: NCM faltante no cadastro do produto, mesmo caso real já documentado em `docs/superpowers/specs/2026-07-14-validador-nf-autorizada-design.md`) |
| erro de rede/timeout | Retry — mesmo tratamento de `refreshConnectionById` pra falha de rede no Bling |

Erros do ML (via edge function): timeout/5xx → retry; 4xx de negócio (pedido
não encontrado, token inválido) → bloqueia e loga, não assume "pode emitir"
por falta de informação.

---

## Interface — tela "NF Flex"

Nova rota `/nf-flex`, seguindo o padrão visual/estrutural de
`ExpedicaoPage.tsx` (tabela + modal de detalhe já existentes no projeto).

**Indicadores no topo** (mesmo padrão de cards do Dashboard,
`dashboard.functions.ts`): Pedidos Flex hoje, Aguardando NF, NF emitidas,
Cancelados antes da NF, NF bloqueadas, Erros, **NF evitadas por
cancelamento** (contagem de `nf_flex_status='blocked'` com motivo
`ML_ORDER_STATUS:cancelled` ou `ML_ORDER_FRAUD_RISK` — a métrica que mostra
o valor do projeto).

**Tabela**: Pedido ML / Pedido Bling / tempo desde pagamento / status ML /
status shipment / status NF / motivo de bloqueio / última validação /
horário previsto pra próxima avaliação.

**Ações por linha**:
- **Emitir agora** — chama o mesmo `processarFilaNfFlex` de um único pedido,
  **sempre** rodando as validações do zero (não é bypass — reusa
  `canIssueInvoice`, só ignora o `nf_flex_eligible_at` e o claim de
  concorrência normal continua valendo).
- **Revalidar** — só reconsulta ML/Bling e atualiza status, sem tentar
  emitir.
- **Abrir pedido** — link pro pedido em `/pedidos` ou `/expedicao`.
- **Ver log** — lista os eventos de `nf_flex_eventos` daquele pedido.

---

## Riscos e observações

1. **Ordem de operações**: só desligar a emissão automática no painel do
   Bling **depois** do módulo estar em produção e validado com pedidos
   reais — senão pedidos Flex ficam sem NF indefinidamente no intervalo. Essa
   ação é fora do EXPEDE (config do Bling), o Vinicius controla o timing.
2. **`CLAUDE.md` do projeto está corrompido** — achado incidental durante a
   investigação, sem relação com este módulo. O arquivo (28KB, único commit
   `310bce7`, 13/06/2026) está em UTF-16 e seu conteúdo real é um guia
   genérico de onboarding ("Playbook do Método — Elo/Marciano"), não
   instruções do projeto EXPEDE. Um plano anterior (`2026-07-14`) cita uma
   regra "Deploy é sempre manual" como estando em `CLAUDE.md`, mas essa regra
   não está no arquivo atual — ou nunca esteve (citação de uma sessão
   anterior que não confirmou a fonte), ou o arquivo foi sobrescrito depois.
   Não mexi nisso (fora de escopo do pedido), só flagando porque `CLAUDE.md`
   deveria ser a fonte de regras do projeto e hoje não cumpre esse papel.
3. **`cronMLStatus` hoje filtra `marketplace = 'mercadolivre'` e exclui
   `'mercadolivreflex'`** (`server.ts:144`) — o novo cron não deve depender
   dele nem reusar esse filtro; consulta seu próprio conjunto de candidatos.
4. **Idempotência do `gerar-nfe` do lado do Bling não testada** — as camadas
   de proteção descritas acima não dependem disso, mas vale confirmar em
   homologação antes de ir pra produção.
5. **Catálogo de `status`/`substatus` de shipment Flex (ME2)** não confirmado
   de forma exaustiva na documentação acessada nesta sessão — só os valores
   já usados em produção (`shipped`, `delivered`) são garantidos. Validar
   `cancelled`/`not_delivered` contra um shipment real antes de confiar
   cegamente neles na regra de bloqueio.
6. **Token do Mercado Livre em texto puro** (`ml_connections`) — assimetria
   com o Bling (criptografado). Não é escopo mudar aqui, só registrando.

---

## Fora de escopo (deliberado)

- Qualquer mudança em `ExpedicaoPage.tsx`, bipagem, impressão de etiqueta —
  Flex já despacha sem esperar NF, esse fluxo não muda.
- Shopee — hoje sempre exige NF (Q5 do reconciliador nunca usa
  `permitirSemNf`), não é Flex, fica fora.
- Trocar a fonte de detecção de Flex de Bling-side pra ML-side.
- Webhook `bling-pedidos.ts`: continua filtrando pedidos sem NF — o
  reconciliador (1×/min) já é quem traz Flex sem NF pro banco hoje; não achei
  necessidade de duplicar essa lógica no webhook, mas é uma decisão aberta
  (ver "Dúvidas").

---

## Dúvidas / decisões que precisam de você

1. **`app_config` (tabela nova) para `flexInvoiceDelayMinutes`** — você pediu
   explicitamente "sem deploy pra mudar". O projeto não tem hoje nenhuma
   tabela de configuração genérica; a alternativa seria uma var do
   `wrangler.jsonc` (exige deploy) ou um valor fixo no código (idem). Tudo
   bem criar essa tabela nova, ou prefere outra abordagem?
2. **Timing do desligamento no Bling** — confirma que só desliga a automação
   depois do módulo validado em produção (não em paralelo)?
3. **Testar `gerar-nfe` em homologação primeiro** — o Bling tem ambiente de
   teste (`developer.bling.com.br/como-testar`, visto no menu da doc). Quer
   que eu valide esse endpoint lá antes de qualquer código tocar produção?
4. **Webhook `bling-pedidos.ts`** — deixa como está (reconciliador de 1 min
   já cobre) ou quer que eu também remova o filtro `no_invoice` de lá pra
   reduzir a latência de importação de um Flex sem NF?
5. **Janela de segurança default** — 20 min como no seu rascunho, ou outro
   valor pra começar?
6. **CLAUDE.md corrompido** — quer que eu reconstrua o conteúdo real do
   projeto nele (separado deste trabalho), ou trata depois?

---

## Próximo passo

Com as respostas acima (ou "segue com as recomendações"), eu escrevo o plano
de implementação bite-sized (`docs/superpowers/plans/`, mesmo formato do
plano de `2026-07-14`), dividido em tarefas pequenas e testáveis
individualmente — migration → edge function ML → `nf-flex.functions.ts` →
cron → tela. Nenhuma etapa aplica migration nem faz deploy sem sua
confirmação explícita, mesmo padrão já em uso no projeto.
