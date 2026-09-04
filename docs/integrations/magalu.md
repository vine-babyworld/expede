# Magalu Marketplace API — base de conhecimento (EXPEDE)

> Mantido por: subagente `magalu-specialist` (`.claude/agents/magalu-specialist.md`).
> Leia este arquivo por inteiro antes de pesquisar de novo — ele é a memória entre sessões.

## 1. Visão geral e URLs oficiais

- Última verificação: **2026-09-04** (pesquisa técnica completa, specs OpenAPI extraídos dos chunks JS do portal)
- Verificação anterior: 2026-08-19 (só viabilidade)

### Correção da verificação anterior: os "dois portais" NÃO são duas versões da mesma API

A verificação de 2026-08-19 registrou dúvida sobre qual portal era canônico. **Resolvido: são duas
plataformas distintas, com hosts e contratos totalmente diferentes.**

| | Nova — `developers.magalu.com` | Legada — `acelera.magalu.com` (IntegraCommerce) |
|---|---|---|
| Host produção | `https://api.magalu.com` | `https://in.integracommerce.com.br` |
| Host homologação | `https://api-sandbox.magalu.com` | `https://api.integracommerce.com.br` |
| Etiqueta | `POST /seller/v1/logistics/shipping-labels` | `POST /api/Order/ShippingLabels` |
| Pedidos | `GET /seller/v1/orders` | `GET /api/Order`, `/api/Order/GetAllV2` |
| Fila | webhooks | `GET/PUT /api/OrderQueue` |
| Paginação | `_limit`/`_offset` + envelope `meta` | `page`/`perPage` |

**Veredito: usar exclusivamente `developers.magalu.com`.** A legada não está formalmente marcada como
descontinuada (conteúdo de 2024, sem aviso de deprecation), mas todo o desenvolvimento ativo está na nova —
release notes até maio/2026, webhooks v1 com HMAC, sandbox.

> O famoso limite de **20 pedidos por request** na geração de etiqueta é da API **legada**. Não existe no
> spec novo (o array `deliveries` não tem `maxItems`). Não presumir que vale — testar empiricamente.

### Ambientes

| Tipo | Ambiente | URL |
|---|---|---|
| Marketplace | Produção | `https://api.magalu.com` |
| Sandbox | Homologação | `https://api-sandbox.magalu.com` |
| Complementar | Produção | `https://services.magalu.com` |

Configurar as três como audience do client de uma vez, para não travar depois:
`idm client update --uuid "<uuid>" --audience "https://api.magalu.com https://api-sandbox.magalu.com https://services.magalu.com"`

### Channel IDs (produção diferente de sandbox)

| Canal | Channel ID |
|---|---|
| **Magazine Luiza (produção)** | `9fe0d853-732b-4e4a-a0b0-cff988ed043d` |
| Magalu (sandbox) | `5f62650a-0039-4d65-9b96-266d498c03bd` |

## 2. Autenticação

OAuth2 Authorization Code via **IDMagalu**.

- Authorize: `https://id.magalu.com/login` — `client_id`, `redirect_uri`, `scope`, `response_type=code`, `state`
- Token: `https://id.magalu.com/oauth/token`
- **Assimetria real do contrato**: troca do code em `Content-Type: application/json`; refresh em
  `application/x-www-form-urlencoded`. Está assim nos dois cURL da doc — não é erro de leitura.
- `access_token` com `expires_in: 7200` (2h), `token_type: Bearer`. Code válido 10 min, uso único.
- `choose_tenants=true` **não aparece mais** na doc atual; o portal recomenda o widget
  `openapi.magalu.com/script/script.js`.

### BREAKING CHANGE de março/2026 — o consentimento tem que ser ADMIN

> *"O sistema de autenticação passará a exigir que o usuário vinculado ao Token de Acesso ou Chave de API
> possua, obrigatoriamente, o nível de consentimento de perfil ADMIN. Usuários com perfis inferiores terão
> requisições negadas... HTTP 403 (Forbidden)."*

Quem der o consentimento OAuth **tem que ser ADMIN da loja (pessoa jurídica)**. A doc reforça que login com
PF pode não ter os escopos necessários. **Armadilha:** com uma conta operacional tudo autentica normalmente
e só estoura 403 depois, em produção.

### Escopos

| Escopo | Para quê |
|---|---|
| `open:order-order-seller:read` | ler pedidos |
| `open:order-order-seller:write` | escrever pedidos |
| `open:order-delivery-seller:read` | ler entregas |
| `open:order-delivery-seller:write` | escrever entregas (expedir) |
| `open:order-invoice-seller:read` | consultar NF-e |
| `open:order-logistics-seller:read` + `:write` | **etiquetas** |

## 3. API de pedidos

Hierarquia: **Order -> deliveries[] -> items[]**. A **entrega (delivery) é a unidade de expedição**, não o pedido.

### `GET /seller/v1/orders`

| Param | Default | Notas |
|---|---|---|
| `status` | — | `new`, `approved`, `cancelled`, `finished` |
| `purchased_at__gte` / `__lte` | — | ISO 8601 |
| `updated_at__gte` / `__lte` | — | **usar este para polling incremental** |
| `code` | — | código do pedido |
| `_offset` | 0 | teto rígido de **5.000** (`PAGE_MAX_OFFSET`) |
| `_limit` | **20** | ler `meta.page.max_limit` em runtime, não hardcodar |
| `_sort` | — | `purchased_at:asc` ou `purchased_at:desc` |

Atenção: em `/orders` os filtros de data usam `__gte`/`__lte`; em `/deliveries/{id}` e `/orders/{code}` usam
**`updated_at__ge`** (sem o "t"). Inconsistência real do contrato — não normalizar.

### `GET /seller/v1/deliveries` — é aqui que mora a fila de expedição

Params: `code`, `id`, `status`, `purchased_at__gte/__lte`, `_offset`, `_limit` (20), `_sort`.
**Mais o header `X-Channel-Id`, obrigatório.**

Outros: `GET /seller/v1/deliveries/{id}`, `GET /seller/v1/deliveries/{id}/histories`,
`GET /seller/v1/deliveries/{id}/invoices`, `GET /seller/v1/invoices/fulfillment`.

### Envelope de resposta

```json
{ "meta": { "page": { "limit": 10, "offset": 10, "count": 9, "max_limit": 100 },
            "links": { "self": "...", "next": "...", "previous": "..." } },
  "results": [ ] }
```

### Status

**Pedido** (4): `new`, `approved`, `cancelled`, `finished`.
**Entrega** (7): `new`, `approved`, `invoiced`, `shipped`, `delivered`, `cancelled`, `frozen`.

**Filtrar por entrega, nunca por pedido.** `status=approved` em `/orders` inclui também pedidos já
`invoiced`, `shipped` e `delivered` — porque em todos o pagamento foi aprovado. Como fila de expedição é
inútil. A fila é `GET /seller/v1/deliveries?status=approved`.

`frozen` é status intermediário sem transição definida, pode aparecer entre quaisquer dois. Tratar como
"não mexe, re-consulta".

**Não existe diagrama de transições na doc.** Ordem prática derivada do sandbox:
`new -> approved -> invoiced -> shipped -> delivered` (mais `cancelled` a qualquer momento). Transições
disparadas por `POST /invoices` (vira `invoiced`), `POST /shippings` (vira `shipped`) e `POST /finishing`
(vira `delivered`).

### Campos que importam para a expedição

```
results[].deliveries[].id        <- UUID: usar em TODOS os endpoints de entrega e na etiqueta
results[].deliveries[].code      <- "9999999999999999-1"
results[].deliveries[].items[].info.sku / .quantity / .unit_price.{value,currency,normalizer}
results[].deliveries[].items[].info.dimensions.{height,width,length,weight}.{value,unit}
results[].deliveries[].shipping.recipient.address.{street,number,complement,district,city,state,zipcode,country,reference}
results[].deliveries[].shipping.provider.extras.{is_mle,is_fulfillment,shipping_type,shipping_name}
results[].deliveries[].shipping.tracking.{code,url}      <- nó NOVO (dez/2025)
results[].deliveries[].shipping.tracking_url             <- LEGADO, sai por volta de jun/2026
results[].deliveries[].invoices[].{key,issued_at,status}
```

### Duas armadilhas de dado

**Fuso do SLA.** `shipping.handling_time.limit_date` vem em **UTC**, mas o Portal do Seller exibe em
**GMT-3**. Exemplo do próprio spec: a API devolve `2025-07-22T00:00:00Z` e o Portal mostra **21/07/2025**.
Sem converter para America/Sao_Paulo, o painel discorda do Magalu em um dia inteiro e estoura SLA achando
que tem folga. `handling_time` é limite de **postagem**; `deadline` é limite de **entrega ao cliente** —
campos diferentes.

**Valores em centavos.** Todo `amounts.*.total` é integer com `normalizer: 100`. Dividir pelo `normalizer`,
nunca por 100 hardcoded.

## 4. API de etiquetas (Magalu Entregas)

### `POST https://api.magalu.com/seller/v1/logistics/shipping-labels`

Escopos: `open:order-logistics-seller:read` e `:write`.

```json
{ "channel":    { "id": "<channel_id>", "extras": {} },
  "deliveries": [ { "id": "6c764444-436d-4659-8cec-304414b05259" } ],
  "label":      { "format": "pdf", "type": "summary", "extras": {} } }
```

- `label.format` — enum **`["zpl","pdf"]`** (obrigatório). ZPL confirmado, bate com `src/lib/zpl-to-pdf.ts`
- `label.type` — enum **`["summary","full"]`** (obrigatório)
- `deliveries[].id` — **UUID da entrega**, não o código do pedido

Response 200:

```json
{ "label": { "signed_url": "https://...", "expires_on": "2023-06-31T10:17:07.000Z", "extras": {} },
  "deliveries": [ { "id": "...", "tracking": { "code": "SZ274430011BR", "url": "http://sro.luizalabs.com/tracking?id=..." } } ] }
```

**A etiqueta não vem no corpo** — vem uma `signed_url` temporária com `expires_on`. Diferente do padrão
Shopee (`download_shipping_document` devolve o PDF binário direto). É preciso baixar o arquivo e persistir;
a URL não pode ser tratada como permanente.

Bônus (release note de dez/2025): o endpoint devolve `tracking.code` e `tracking.url` na hora. Gerar a
etiqueta já entrega o rastreio, que pode alimentar o `POST /shippings`.

### Como distinguir Magalu Entregas de frete próprio

`shipping.provider.extras` traz discriminadores explícitos:

```json
{"is_mle": true, "is_fulfillment": false, "shipping_type": "Retira loja", "shipping_name": "Magalu Entregas"}
```

**Regra de roteamento:** `is_mle === true` chama `shipping-labels`. `is_mle === false` (transportadora
própria) imprime a etiqueta própria e só reporta rastreio via `POST /shippings` com `carrier.name`.

### Escrita de volta (write-back)

**`POST /seller/v1/deliveries/{id}/shippings` -> 201** — pré-requisito: entrega em `approved`.

```
carrier.name                      ex "Magalu Entregas"
channel.id                        obrigatório
dates.estimated_delivery_at       obrigatório
dates.shipped_at                  obrigatório
labels[].{id,value}
protocol                          "Protocolo do rastreio"
tracking_url                      obrigatório
```

**Não existe campo `tracking.code`.** O código de rastreio só entra embutido na `tracking_url` ou via
`protocol`. Limitação real do contrato — confirmar com o suporte qual é o lugar canônico.

**`POST /seller/v1/deliveries/{id}/invoices` -> 201**

```
key        obrigatório  chave de 44 dígitos
xml        obrigatório  XML inteiro inline
amount     obrigatório  valor
issued_at  obrigatório
issuer                  só números
channel    obrigatório  { id, extras }
```

Não há campos separados de série, número ou DANFE — tudo vem do XML. O `status` é **assíncrono**
(`validating` -> `approved` ou `invalid`), então é preciso polling em `GET /deliveries/{id}/invoices`.
Pedidos **Fulfillment** já têm NF emitida pelo CD — enviar NF neles é ignorado.

**`PUT /seller/v1/deliveries/{id}/invoices/{key}` -> 204** — body sem `key` e sem `issuer`.
**`POST /seller/v1/deliveries/{id}/finishing` -> 201** — `channel` obrigatório, `delivered_at` opcional.

## 5. Webhooks

Registro: **`PUT /v1/onboarding/signup`** (usar v1 — HTTPS obrigatório e HMAC; a v0 aceita HTTP e não assina).

```json
{ "webhook": "https://seu.dominio/webhooks", "topic_id": "orders_delivery", "filter_by": {} }
```

HTTP puro devolve **422**. `filter_by` suporta `and`, `or`, `eq`, `neq`, `in`, `gte`, `lte`.
Consulta `GET /v0/onboarding/signup` (`_limit` 50, max 100). Exclusão `DELETE /v0/onboarding/signup/{id}`.
Histórico `GET /v0/queues/history`.

**O `secret` (`whsec_...`) aparece uma única vez**, no response do PUT. Não é recuperável. Se perder, um
novo PUT gera outro secret, com **1h de período de graça** em que as duas assinaturas valem.

**Validação:** header `X-Signature-256: sha256=<hex>` (pode vir com **múltiplas assinaturas separadas por
vírgula** durante rotação — iterar sobre todas) e `X-Timestamp` (Unix em segundos, anti-replay).
HMAC-SHA256 sobre **`{timestamp}.{body}`**, com o body **raw exatamente como recebido**, nunca
re-serializado. Comparar com `timingSafeEqual`.

Payload — é só um sino, não traz o dado:

```json
{ "data": { "status": "shipped", "params": { "id": "..." },
            "resource": "/seller/v1/deliveries/<id>?updated_at__ge=..." },
  "tenant_id": "...", "topic": "orders_delivery" }
```

Usar `data.resource` (já vem montado) para buscar o registro completo. `tenant_id` identifica o seller.

Tópicos: `orders_order` (`new`, `approved`) e `orders_delivery` (`approved`, `invoiced`, `shipped`,
`cancelled`, `delivered`).

**Política de retry não é documentada em lugar nenhum** — nem tentativas, nem backoff, nem qual status code
conta como sucesso. Projetar o endpoint idempotente e responder 2xx rápido.

## 6. Rate limits

Por minuto e por seller. Excedeu, devolve 429.

| Módulo | Limite/min |
|---|---|
| Pedidos — consulta | 850 |
| Entregas — cadastro / consulta | 850 / 850 |
| Notas fiscais — consulta | 850 |
| Produtos — cadastro / consulta | 650 / 550 |
| Estoques — cadastro / consulta | 650 / 850 |

**O módulo de Logística/Etiquetas não está na tabela** — o limite da geração de etiqueta é desconhecido.
Tratar com cautela e backoff.

Comparação útil: 850/min é cerca de 14 req/s, muito folgado perto dos **3 req/s do Bling**, que hoje ditam
todos os orçamentos de cron do EXPEDE. O gargalo do Magalu é volume de dados, não taxa — preferir
webhook mais fetch pontual a varredura.

## 7. Headers

| Header | Onde | Obrigatório |
|---|---|---|
| `Authorization: Bearer <token>` | tudo | Sim |
| `Content-Type: application/json` | POST/PUT | Sim |
| **`X-Channel-Id: <uuid>`** | **GETs de `/deliveries`, `/deliveries/{id}`, `/histories`** | **Sim** |
| `X-Request-Id: <uuid>` | tudo | Não, mas mandar sempre |

**`X-Channel-Id` é a pegadinha mais provável.** Está `required` no spec dos GETs de entrega e **não aparece
nos exemplos cURL nem nas páginas de overview**. Sem ele esses endpoints falham. Nos POST/PUT o canal vai no
**body** (`channel.id`), não no header — as duas convenções coexistem.

`X-Request-Id`: logar sempre — é o que o suporte Magalu pede para investigar qualquer problema.
Não existe `X-Tenant-Id` de request (`tenant_id` só aparece no payload de webhook).

Desabilitar o follow automático de redirect: o portal recomenda tratar `303 See Other` manualmente, porque
o auto-redirect esconde erros de fluxo.

## 8. Sandbox

Base `https://api-sandbox.magalu.com`. Onboarding: `PUT /v1/samples/onboarding` com channel
`5f62650a-0039-4d65-9b96-266d498c03bd` — cria um seller fictício e devolve credenciais.
Cobre Produtos, Pedidos, Promoções, SAC, Perguntas e Respostas, Chat. Dados apagados a cada 3 meses de uso.

O portal ainda diz *"apenas o ambiente Produção disponível, Sandbox em desenvolvimento"* — **frase
desatualizada**, o sandbox de Pedidos/Entregas está ativo.

## 9. Homologação/aprovação

Cadastro de parceiro, registro do app no IDMagalu, homologação **módulo a módulo** e ticket no portal de
suporte pedindo liberação para produção. Trabalho administrativo do Vinicius, mas é dependência externa de
prazo incerto — sinalizar sempre no planejamento.

## 10. Riscos técnicos conhecidos

- **Bloqueio de IP de datacenter/Cloudflare Workers: não confirmado nem descartado.** ML precisou de Edge
  Function e Shopee de gateway de IP fixo. Testar cedo — se passar direto, o Magalu é o primeiro canal do
  EXPEDE sem proxy.
- Consentimento por perfil não-ADMIN autentica e só depois estoura 403 (seção 2).
- `X-Channel-Id` ausente da doc de overview mas obrigatório no spec (seção 7).
- A `signed_url` da etiqueta expira — validade típica não documentada.
- Sem retry policy documentada de webhook.

## 11. Changelog observado

- **2026-09-04**: pesquisa técnica completa. Resolvida a dúvida dos "dois portais" — `acelera.magalu.com` é
  outra plataforma (IntegraCommerce), não uma versão antiga. Confirmados base URLs, endpoint de etiqueta,
  payloads de write-back, paginação, status, rate limits e webhooks v1 com HMAC. Descobertos o breaking
  change de perfil ADMIN (mar/2026) e o header obrigatório `X-Channel-Id`. Derrubado o mito do limite de 20
  etiquetas por request (é da API legada).
- 2026-08-19: primeira pesquisa de viabilidade, baseline.

## 12. Lacunas — a testar com a conta real

1. Limite de `deliveries[]` por request na geração de etiqueta (o "20" é da API legada)
2. NF-e aprovada é pré-requisito da etiqueta? Indício forte: o sandbox devolve
   `400 Package without approved invoice` ao mover para `invoiced` sem NF — mas isso não está documentado no
   endpoint de etiqueta
3. Diferença real entre `label.type: summary` e `full`; se algum deles é declaração de conteúdo
4. Rate limit do módulo de logística (ausente da tabela)
5. Retry policy dos webhooks (tentativas, backoff, timeout)
6. `max_limit` real de `/orders` e `/deliveries` (ler de `meta.page.max_limit`)
7. Cursor pagination (`_paginate=cursor`) funciona em `/orders` e `/deliveries`? Documentado só para
   financial-analysis. Importa se a fila passar de 5.000 registros
8. Onde vai o código de rastreio em `POST /shippings`: `protocol` ou embutido na `tracking_url`?
9. O sandbox usa `/v1/deliveries/{id}/shippings` (sem `/seller`) nos exemplos, contra `/seller/v1/...` em
   produção — confirmar se é erro de doc ou path real
10. Validade típica (`expires_on`) da `signed_url` da etiqueta

## 13. Plano de implementação no EXPEDE

Plano aprovado em 2026-09-04, por fases. Decisões tomadas com o Vinicius:

- Pedidos entram **pelo Bling** (híbrido, igual à Shopee — a Shopee **não** é fonte de pedidos, está escrito
  em `src/routes/_app/configuracoes.marketplaces.tsx:93`). A API do marketplace serve para etiqueta e repasse.
- Modalidade: **Magalu Entregas**.
- Validação técnica começa pelo **sandbox**.
- **NF-e manual no Bling**, como a Shopee — Magalu fica `out_of_scope` em `classificarEmissaoNf`.

**Descoberta que reordenou o plano:** o **Bling já gera a etiqueta do Magalu Entregas em PDF e ZPL**, depois
que a NF-e é emitida, e a cadeia de etiqueta do EXPEDE (`src/lib/etiqueta.functions.ts:42`) já tenta o Bling
**antes** do marketplace. Dá para expedir e imprimir etiqueta do Magalu **sem nenhuma chamada à API do
Magalu**.

- [ ] **Fase 0** — criar loja Magalu no Bling, ligar Magalu Entregas, **descobrir o `loja.id`** (bloqueia a
      Fase 1); registrar app no IDMagalu **com usuário ADMIN da PJ** e iniciar homologação (lead time)
- [ ] **Fase 1 (só Bling)** — `MAGALU_BLING_LOJA_ID`, `MarketplacePedido` e `marketplacePelaLojaBling` em
      `nf-emissao.policy.ts`; Q6 de reconciliação espelhando a Q5 da Shopee em `pedidos.functions.ts:660`;
      fechar o `else` implícito do ML em `etiqueta.functions.ts:69`; filtro e badge na UI (extrair
      `marketplace-labels.ts`, hoje duplicado em 4 telas); card "Em breve" em configurações
- [ ] **Fase 2 (API)** — testar alcance do Worker **antes de tudo**; `src/lib/magalu.ts` no molde de
      `shopee.ts` mas sem HMAC (OAuth2 puro), tokens cifrados com o AES-256-GCM do Bling;
      `normalizarRepasseMagalu` puro em `repasse.ts` mais `cronRepasseMagalu`; status de envio
- [ ] **Fase 3 (opcional)** — etiqueta direto do Magalu como fallback; write-back
      (`POST /shippings`, `POST /invoices`) **só se o Bling não estiver fazendo isso sozinho** — seria a
      primeira escrita do EXPEDE num marketplace; emissão automática de NF

## 14. Fontes

- [Ambientes](https://developers.magalu.com/docs/first-steps/environment) · [OAuth 2.0](https://developers.magalu.com/docs/first-steps/create-an-application/authentication-authorization) · [IDs dos canais](https://developers.magalu.com/docs/development-guide/sales-channel-id)
- [Gerar etiquetas](https://developers.magalu.com/docs/apis_logistic/labels/ref/seller-v-1-post-logistics-shipping-labels) · [Etiquetas — escopos](https://developers.magalu.com/docs/apis_logistic/labels/ref/overview) · [Magalu Entregas](https://developers.magalu.com/docs/apis_logistic/overview)
- [Consultar pedidos](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-get-order-list) · [Consultar entregas](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-get-deliveries-list) · [Marcar enviada](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-post-delivery-shippings) · [Enviar NF-e](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-post-delivery-invoice) · [Finalizar](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-post-delivery-finishing)
- [Webhooks — guia e HMAC](https://developers.magalu.com/docs/development-guide/webhooks) · [Webhooks de Pedidos](https://developers.magalu.com/docs/apis/orders/webhooks)
- [Rate limit](https://developers.magalu.com/docs/development-guide/rate-limit) · [Paginação e filtros](https://developers.magalu.com/docs/development-guide/pagination-filtering-sorting) · [X-Request-Id](https://developers.magalu.com/docs/development-guide/request-identifier-x-request-id)
- [Sandbox](https://developers.magalu.com/docs/apis/sandbox/overview) · [Release Notes](https://developers.magalu.com/docs/release-notes)
- Legado, não usar: [Acelera Magalu](https://acelera.magalu.com/pedidos.html) · [IntegraCommerce](https://api.integracommerce.com.br/Documentation/Orders)
