# Magalu Marketplace API — base de conhecimento (EXPEDE)

> Mantido por: subagente `magalu-specialist` (`.claude/agents/magalu-specialist.md`).
> Leia este arquivo por inteiro antes de pesquisar de novo — ele é a memória entre sessões.

## 1. Visão geral e URLs oficiais

- Última verificação: **2026-09-15** (primeiro pedido real do Magalu chegou sem etiqueta — levantamento de emissão/impressão)
- Verificação anterior: 2026-09-04 (pesquisa técnica completa) · 2026-08-19 (só viabilidade)

### DESCOBERTA 2026-09-15: os specs OpenAPI são públicos e baixáveis

Não é mais preciso raspar chunk JS do Docusaurus. O portal publica um índice para agentes:

| Recurso | URL |
|---|---|
| Índice em markdown (llms.txt) | `https://developers.magalu.com/llms.txt` |
| Índice em JSON | `https://developers.magalu.com/apis/index.json` |
| **Spec de Pedidos + Etiquetas** | `https://developers.magalu.com/apis/orders.openapi.yaml` (~300 KB) |
| Overview de Pedidos | `https://developers.magalu.com/apis/orders/overview.md` |
| Smart Label (Magalog, **outra API**) | `https://developers.magalu.com/apis/smartlabel.openapi.yaml` |

São 22 APIs no índice. **O endpoint de etiqueta do seller mora dentro de `orders.openapi.yaml`**, não em
spec próprio — por isso a página HTML de "Gerar etiquetas" renderiza vazia (o schema é client-side).
Sempre baixar o YAML; a página HTML não serve.

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

> 2026-09-15: o comando de exemplo oficial hoje recomenda só
> `--audience "https://api.magalu.com https://services.magalu.com"` (o sandbox saiu da receita).
> `services.magalu.com` importa porque é o host do **Smart Label/Magalog** (seção 4b).

### Infraestrutura de borda (medido em 2026-09-15)

`api.magalu.com` responde `Server: azion webserver` com `X-Azion-Request-Id` / `X-Azion-Edge-Location`.
**É Azion (CDN brasileira), não Cloudflare.** Uma request sem token volta `401` JSON limpo, com o header
diagnóstico `x-authorization-error: Authorization token not found or has invalid format.` — sem challenge,
sem bot-fight. `id.magalu.com` está atrás de Google LB (`via: 1.1 google`, Doorkeeper/Rails).
Indício favorável para chamar direto do Worker, **mas não é prova** — o teste foi de IP residencial.

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
- **CORREÇÃO 2026-09-15:** `choose_tenants=true` **está sim documentado e é obrigatório** para seller.
  A nota anterior estava errada. A doc: *"Deve sempre ser `true` para sellers. Se for `false`, o
  consentimento é aplicado apenas para a pessoa física que fez login."* O widget
  `openapi.magalu.com/script/script.js` é alternativa, não substituto.

### A regra de escopo que mais provavelmente quebra a etiqueta (2026-09-15)

Os escopos de um token são a **união** de dois conjuntos:

```
escopos do token = --scopes-default (gravado no client no IDMagalu) ∪ scope= (da URL de consentimento)
```

Doc literal: *"Estes escopos serão sempre incluídos no consentimento, sendo combinados com os escopos
definidos no parâmetro `scope` da Requisição de Consentimento. O seller verá: `--scopes-default` +
`scope` (da URL)."*

**Consequência:** se o client foi criado sem `open:order-logistics-seller:*` no `--scopes-default` e a URL
de consentimento também não pediu, o token autentica, lê pedidos normalmente e **nunca consegue emitir
etiqueta**. Corrigir exige `idm client update --scopes/--scopes-default` **e refazer o consentimento**
(token antigo não ganha escopo novo no refresh).

### Lista completa de escopos do comando oficial de criação de client

Copiada da doc (`create-application`), é o superconjunto recomendado para marketplace:

```
apiin:all
open:logistic-carrier-shippings:read
open:order-delivery-seller:read      open:order-delivery-seller:write
open:order-invoice-seller:read       open:order-invoice:read
open:order-logistics-seller:read     open:order-logistics-seller:write   <-- ETIQUETA
open:order-order-seller:read
open:portfolio-prices-seller:{read,write}   open:portfolio-prices:{read,write}
open:portfolio-scores-seller:read
open:portfolio-skus-seller:{read,write}     open:portfolio-skus:{read,write}
open:portfolio-stocks-seller:{read,write}   open:portfolio-stocks:{read,write}
open:sac-transaction-seller:read
open:ticket-events-seller:{read,write}      open:ticket-messages-seller:{read,write}
open:ticket-returns-seller:{read,write}     open:tickets-seller:{read,write}
services:conversations-seller:{read,write}  services:questions-seller:{read,write}
services:ticket-messages-seller:{read,write} services:tickets-seller:{read,write}
```

**`open:order-order-seller:write` NÃO existe** nessa lista (a versão anterior deste arquivo o listava —
erro). **`open:smart-label:write` também não está** — é de outro produto (seção 4b).

### BREAKING CHANGE de março/2026 — o consentimento tem que ser ADMIN

> *"O sistema de autenticação passará a exigir que o usuário vinculado ao Token de Acesso ou Chave de API
> possua, obrigatoriamente, o nível de consentimento de perfil ADMIN. Usuários com perfis inferiores terão
> requisições negadas... HTTP 403 (Forbidden)."*

Quem der o consentimento OAuth **tem que ser ADMIN da loja (pessoa jurídica)**. A doc reforça que login com
PF pode não ter os escopos necessários. **Armadilha:** com uma conta operacional tudo autentica normalmente
e só estoura 403 depois, em produção.

### Escopos

| Escopo | Para quê | Onde a doc declara |
|---|---|---|
| `open:order-order-seller:read` | ler pedidos | overview de Pedidos |
| `open:order-delivery-seller:read` | ler entregas | overview de Pedidos |
| `open:order-delivery-seller:write` | escrever entregas (`/shippings`, `/finishing`) | overview de Pedidos |
| `open:order-invoice-seller:read` | consultar NF-e | overview de Pedidos |
| **`open:order-logistics-seller:read`** | **ler operações de logística** | overview de **Etiquetas** |
| **`open:order-logistics-seller:write`** | **realizar operações de logística = emitir etiqueta** | overview de **Etiquetas** |

**O escopo de etiqueta é de outra família e está em outra página da doc.** O overview de Pedidos
(`/apis/orders/overview.md`) lista só os quatro primeiros — nenhum `logistics`. Quem integrou pedidos
lendo aquela página sai com um client que não emite etiqueta e não recebe nenhum aviso disso.

Curiosidade útil: a própria doc de sandbox exige `open:order-logistics-seller:read` até para **criar** um
pedido de teste — ou seja, o escopo de logística já é necessário cedo no fluxo.

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

Sem parâmetros de path/query e **sem nenhum header obrigatório além de `Authorization` e `Content-Type`**
(o spec declara `parameters:` vazio). Respostas documentadas: **só `200` e `422`**.

Request (`PostLogisticShippingLabelRequest`, todos os 3 campos obrigatórios):

```json
{
  "channel":    { "id": "9fe0d853-732b-4e4a-a0b0-cff988ed043d", "extras": {} },
  "deliveries": [ { "id": "6c764444-436d-4659-8cec-304414b05259" } ],
  "label":      { "format": "zpl", "type": "summary", "extras": {} }
}
```

- `label.format` — enum **`["zpl","pdf"]`** (obrigatório). ZPL confirmado, bate com `src/lib/zpl-to-pdf.ts`
- `label.type` — enum **`["summary","full"]`** (obrigatório)
- `deliveries[].id` — **UUID da entrega** (`deliveries[].id`), nunca o `code` do pedido
- **NOVO (visto em 2026-09-15):** `deliveries[].branch` — objeto `Branch { external_id, name }`, "Filial de
  origem da entrega". Opcional. Não existia na leitura de 2026-09-04
- `channel.extras` é `additionalProperties: string` — dá para carimbar o id interno do EXPEDE e recuperar
  no suporte

Response 200 (`PostLogisticShippingLabelResponse`) — **só tem `label`**:

```json
{ "label": { "signed_url": "https://.../jas9df8yadfjf0kasd09fausdf0kd0a9k",
             "expires_on": "2023-06-31T10:17:07.000Z",
             "extras": {} } }
```

**CORREÇÃO 2026-09-15:** a versão anterior deste arquivo dizia que a resposta trazia também
`deliveries[].tracking.{code,url}`. **Não traz.** No spec atual `PostLogisticShippingLabelResponse` tem
`required: [label]` e nenhuma outra propriedade; não há nenhuma ocorrência de `SZ274430011BR` nem de
`sro.luizalabs` em `orders.openapi.yaml`. Ou a release note de dez/2025 foi revertida, ou a leitura
anterior veio de fonte errada. **Não projetar o código contando com rastreio vindo da etiqueta.**

**A etiqueta não vem no corpo** — vem uma `signed_url` temporária com `expires_on`. Diferente do padrão
Shopee (`download_shipping_document` devolve o PDF binário direto). Baixar e persistir; a URL não é
permanente. Se `deliveries[]` tem N itens, a resposta continua sendo **uma única** `signed_url` — o arquivo
é o lote inteiro, não um por entrega.

Etiqueta do Magalu Entregas tem **validade de 7 dias para postagem** (doc de seller, não a de API).

### Como distinguir Magalu Entregas de frete próprio

**REBAIXADO em 2026-09-15.** Os discriminadores `is_mle` / `is_fulfillment` / `shipping_type` /
`shipping_name` **não existem em lugar nenhum de `orders.openapi.yaml`**. O que o spec realmente dá:

- `shipping.provider` (`ProviderField`): `id`, `name`, `description` (obrigatórios) + `extras`
  (`additionalProperties: string`, exemplo genérico `{"chave":"valor"}`). Exemplo dos três: `"integra"`,
  `"integra"`, `"Entrega pelo parceiro"` — nada de Magalu Entregas
- `shipping.logistic_network` (`PackageShippingLogisticNetworkDocumentOpen`, nullable) com `id` e
  `description`; **exemplo `id: "fulfillment"` / `description: "malha-fulfillment"`** — esse é o
  discriminador documentado de Fulfillment
- Em schemas internos não referenciados por nenhum path (`order_schema__ShippingProvider`) aparece
  `external_id: "magalu_entregas"`, `name: "magalu_entregas"`,
  `description: "Malha Magalu entregas"` — **forte indício** de qual valor procurar em
  `provider.id`/`provider.name`, mas esses schemas são resíduo de outra API

**Ação:** com a conta real, dumpar `shipping.provider` e `shipping.logistic_network` do primeiro pedido
Magalu Entregas e só então escrever a regra de roteamento. Não codar contra `is_mle`.

Os mesmos schemas internos trazem `shipping.shipping_label.status` com
`{ "status": "available", "description": "Etiqueta disponível para download" }` e
`{ "external_id": "Emitted", "description": "Etiqueta emitida com sucesso" }` — sugere que existe um estado
de etiqueta consultável, mas **nenhum endpoint público exposto o devolve**. Perguntar ao suporte.

## 4b. Smart Label / Magalog — API DIFERENTE, não confundir

O portal tem uma segunda API de etiqueta, **"Smart Label"**, e ela **não** é a do seller de marketplace:

| | Etiqueta do seller (seção 4) | Smart Label / Magalog |
|---|---|---|
| Host | `https://api.magalu.com` | `https://services.magalu.com/logistic` |
| Path | `POST /seller/v1/logistics/shipping-labels` | `POST /smart-label/v1/labels/generate` |
| Escopo | `open:order-logistics-seller:read`+`:write` | **`open:smart-label:write`** |
| Entrada | id da entrega (o Magalu monta a etiqueta) | **você monta tudo**: shipper.cnpj, origin, destination, invoice (chave, número, série, protocolo), package.tag.code, transport.service_id |
| Saída | `signed_url` para download | **`content` inline**: string ZPL ou PDF em base64 |
| Público | seller do marketplace | transportadora/embarcador (seção "APIs de Transportadora") |
| Erros | 200 / 422 | 200 / 400 / 401 / 500 / 503, com `slug`+`details[]` |

Spec: `https://developers.magalu.com/apis/smartlabel.openapi.yaml`.
Response: `{ tag_id, transaction_id, format: "ZPL"|"PDF", content, created_at }`.

Para o EXPEDE **a certa é a da seção 4**. Registrado aqui só para não cair na armadilha de achar que
"Smart Label" é a evolução da etiqueta do seller — não é, é o outro lado do balcão.

## 4c. Escrita de volta (write-back)

**`POST /seller/v1/deliveries/{id}/shippings` -> 201** — pré-requisito: entrega em `approved`.

```
channel                     OBRIGATÓRIO  { id, extras }
tracking_url                OBRIGATÓRIO  "http://url.de.acompanhamento.da.entrega/"
dates.estimated_delivery_at OBRIGATÓRIO  "2025-03-14T18:12:20.313554"
dates.shipped_at            OBRIGATÓRIO  "2025-03-14T18:12:20.313561"
carrier.name                opcional     ex "Magalu Entregas"
labels[].{id,value}         opcional     ex { "id": "12356", "value": "etiqueta" }
protocol                    opcional     "000111222" — "Protocolo do rastreio"
```

**CORREÇÃO 2026-09-15:** `required` é só `[channel, tracking_url, dates]`. `carrier` **não** é
obrigatório (a nota anterior implicava que era). Response 201: `{ id, created_at }`.

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
| ~~`X-Channel-Id: <uuid>`~~ | — | **ver abaixo** |
| `X-Request-Id: <uuid>` | tudo | Não, mas mandar sempre |

**CORREÇÃO 2026-09-15 sobre `X-Channel-Id`:** `grep -i "in: header"` em `orders.openapi.yaml` devolve
**zero ocorrências** — o spec atual não declara nenhum parâmetro de header em nenhum dos 11 paths, e não há
nenhuma string `channel-id`/`X-Channel` no arquivo. A afirmação de 2026-09-04 de que era obrigatório nos
GETs de entrega **não se sustenta no spec de hoje**. Pode ter sido removido, ou lido de fonte errada.
Tratar como: mandar é inofensivo, **não** depender dele, e se um GET de entrega falhar sem motivo, testar
com e sem. O canal vai no **body** (`channel.id`) em todos os POST/PUT — isso continua valendo.

`X-Request-Id`: logar sempre — é o que o suporte Magalu pede para investigar qualquer problema.
Não existe `X-Tenant-Id` de request (`tenant_id` só aparece no payload de webhook).

Desabilitar o follow automático de redirect: o portal recomenda tratar `303 See Other` manualmente, porque
o auto-redirect esconde erros de fluxo.

## 7b. Estrutura de erro padrão da plataforma

Todo erro vem como `{ slug, message, details[] }`, com `details[].{field, location, slug, message}` e
`location` ∈ `header|body|query|params|path|unknown`.

| HTTP | `slug` | Leitura para etiqueta |
|---|---|---|
| 400 | `BAD_REQUEST` | payload malformado; ver `details[]` |
| 401 | `UNAUTHORIZED` | token ausente/expirado/inválido |
| **403** | **`FORBIDDEN`** | **token válido mas SEM o escopo de logística, ou consentimento de perfil não-ADMIN** |
| 404 | `NOT_FOUND` | entrega inexistente / `id` trocado pelo `code` |
| 409 | `CONFLICT` | `ENTITY_WITH_SAME_KEY_ALREADY_EXISTS` |
| **422** | `UNPROCESSABLE_ENTITY` | **único erro de negócio documentado no endpoint de etiqueta** |
| **423** | **`LOCKED`** | **`Resource is locked`** — existe `PackageLockResponse` no spec; pacote travado (antifraude/SAC) provavelmente não emite etiqueta |
| 429 | `TOO_MANY_REQUESTS` | rate limit |
| 500/502/503/504 | `SERVER_ERROR`/`BAD_GATEWAY`/`SERVICE_UNAVAILABLE`/`GATEWAY_TIMEOUT` | retry com backoff |

O 401 do gateway ainda traz o header `x-authorization-error` com o motivo em texto — logar.

## 8. Sandbox

Base `https://api-sandbox.magalu.com`. Onboarding: `PUT /v1/samples/onboarding` com channel
`5f62650a-0039-4d65-9b96-266d498c03bd` — cria um seller fictício e devolve credenciais.
Cobre Produtos, Pedidos, Promoções, SAC, Perguntas e Respostas, Chat. Dados apagados a cada 3 meses de uso.

Criar pedido: `POST https://api-sandbox.magalu.com/v1/samples/orders`
Mover status: `PUT https://api-sandbox.magalu.com/v1/samples/orders/{id}` com
`{ "channel": {"id": "..."}, "deliveries": [{"id": ...}], "status": "approved" }`.
Status aceitos: `Approved`, `Invoiced`, `Shipped`, `Delivered`, `Cancelled`.

### BLOQUEIO 2026-09-15: a etiqueta NÃO existe no sandbox

A página do sandbox lista explicitamente os métodos liberados: *"Consultar pedidos, Consultar
pedidos_por_código, Consultar entregas, Consultar entregas_por_id, Consultar histórico"*.
**`POST /seller/v1/logistics/shipping-labels` não está na lista.** Ou seja: dá para ensaiar a leitura de
pedidos/entregas no sandbox, mas **a emissão de etiqueta só pode ser validada em produção**, com um pedido
real. Isso invalida a premissa da Fase 2 do plano ("validação técnica começa pelo sandbox") para a parte de
etiqueta.

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

- **2026-09-15** (gatilho: primeiro pedido real do Magalu chegou sem etiqueta emitida no EXPEDE):
  - **Descoberto** que os specs OpenAPI são públicos (`llms.txt` / `apis/index.json`). Fonte canônica
    daqui pra frente; parar de raspar HTML/JS do portal.
  - **Confirmado** que o escopo de etiqueta (`open:order-logistics-seller:*`) é de família diferente do de
    pedidos e está declarado em outra página da doc.
  - **Descoberto** que escopos do token = `--scopes-default` do client ∪ `scope=` da URL de consentimento.
  - **Corrigido**: a resposta de `shipping-labels` **não** traz `deliveries[].tracking` (a nota de
    2026-09-04 estava errada). Só `label.{signed_url,expires_on,extras}`.
  - **Corrigido**: `X-Channel-Id` não aparece em nenhum lugar do spec atual — rebaixado de "obrigatório"
    para "não depender".
  - **Corrigido**: `choose_tenants=true` está documentado e é obrigatório (a nota anterior dizia que tinha
    sumido).
  - **Corrigido**: `carrier` não é obrigatório em `POST /shippings`; `open:order-order-seller:write` não
    existe.
  - **Rebaixado**: `is_mle`/`is_fulfillment`/`shipping_type`/`shipping_name` não existem no spec atual.
  - **Novo**: campo `deliveries[].branch` no request de etiqueta; `shipping.logistic_network`
    (`id: "fulfillment"`) nos pedidos; `handling_time`/`deadline` agora são `TimeField` com
    `limit_date` em `format: date` (`"2021-07-22"`), não mais date-time — mas ainda em UTC.
  - **Novo**: existe uma segunda API de etiqueta, **Smart Label / Magalog** (seção 4b), que não é a nossa.
  - **Novo**: sandbox **não** cobre emissão de etiqueta.
  - **Novo**: `api.magalu.com` roda em **Azion**, não Cloudflare; 401 limpo sem challenge.
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
10. Validade típica (`expires_on`) da `signed_url` da etiqueta (a etiqueta em si vale 7 dias para
    postagem, mas isso é outra coisa: é o prazo da etiqueta, não da URL assinada)
11. **(2026-09-15)** Qual campo real distingue Magalu Entregas de frete próprio no pedido de produção —
    `provider.id`? `provider.name`? `logistic_network.id`? Dumpar o primeiro pedido real e decidir
12. **(2026-09-15)** A etiqueta exige a entrega em `invoiced`, ou basta `approved`? A doc do endpoint não
    diz. O 400 `Package without approved invoice` do sandbox é do endpoint de **status**, não do de
    etiqueta. Indício externo forte (doc de seller e do Bling: "emita a NF antes de imprimir a etiqueta"),
    mas não confirmado no contrato da API
13. **(2026-09-15)** `shipping.shipping_label.status` (`available`/`Emitted`) aparece em schema interno.
    Existe endpoint público para consultar o status da etiqueta sem reemitir? Se não, como saber se a
    etiqueta já foi emitida (e evitar duplicar)?
14. **(2026-09-15)** `POST /seller/v1/logistics/shipping-labels` é idempotente? Chamar duas vezes para a
    mesma entrega gera duas etiquetas/dois rastreios ou devolve a mesma?
15. **(2026-09-15)** O que `deliveries[].branch` faz na prática — é obrigatório para quem tem mais de um
    CD/filial? Influencia o CD de destino da coleta?
16. **(2026-09-15)** Quais `slug`s de erro 422 o endpoint de etiqueta devolve. A doc lista só o HTTP 422
    genérico

## 13. Plano de implementação no EXPEDE

Plano aprovado em 2026-09-04, por fases. Decisões tomadas com o Vinicius:

- Pedidos entram **pelo Bling** (híbrido, igual à Shopee — a Shopee **não** é fonte de pedidos, está escrito
  em `src/routes/_app/configuracoes.marketplaces.tsx:93`). A API do marketplace serve para etiqueta e repasse.
- Modalidade: **Magalu Entregas**.
- Validação técnica começa pelo **sandbox**.
- **NF-e manual no Bling**, como a Shopee — Magalu fica `out_of_scope` em `classificarEmissaoNf`.

**~~Descoberta que reordenou o plano:~~ PREMISSA REFUTADA EM 15/09/2026 — não confiar no parágrafo abaixo.**

> ~~O Bling já gera a etiqueta do Magalu Entregas em PDF e ZPL, depois que a NF-e é emitida, e a cadeia de
> etiqueta do EXPEDE (`src/lib/etiqueta.functions.ts:42`) já tenta o Bling antes do marketplace. Dá para
> expedir e imprimir etiqueta do Magalu sem nenhuma chamada à API do Magalu.~~

**Por que caiu.** O primeiro pedido Magalu real (9262, `numeroLoja 1570070104300104`, 14/09/2026) foi
expedido e a etiqueta **não saiu**: `etiqueta_zpl` ficou `NULL` e `buscarEtiquetaBling` retornou
`sem_fallback:magalu`. Confirmado pelo Vinicius que **o Bling nunca entrega a etiqueta de serviço do
marketplace** — é exatamente o que já tinha acontecido com a Shopee e obrigou a construir
`buscarEtiquetaShopee` chamando a API da Shopee direto (`05 - Erros e Soluções.md`, sessão do pedido #8912).
A premissa acima nasceu da documentação do **Bling**, não de teste real; a experiência operacional a
contradiz. **Regra que fica: para etiqueta de transporte de marketplace, o Bling não é fonte — só a API do
próprio canal é.**

Consequência prática: a **Fase 3 deixa de ser opcional**. Sem chamada à API do Magalu não há etiqueta, e o
canal não opera.

**Formato real da etiqueta (medido no PDF do pedido 9262, fornecido pelo Vinicius em 15/09/2026):**

| Propriedade | Valor |
|---|---|
| Página | **A4** — `MediaBox [0 0 595.28 841.89]` = 210 × 297 mm |
| Etiquetas por página | **3** |
| Conteúdo | **rasterizado** — 3 imagens de 304 × 892 px + 3 códigos de barras de 232 × 36 px, todos `FlateDecode` |
| Texto extraível | praticamente nenhum (15 tokens) — é imagem, não texto vetorial |

Três consequências de arquitetura:

1. **Precisa de recorte próprio.** `SHOPEE_A4_LABEL_CROP` (`useQzTray.ts:58`) **não serve** — a proporção é
   outra e aqui são três etiquetas por folha, não uma. Isso confirma a pendência que já estava anotada em
   `PROMPT-FASE-2-MAGALU.md`.
2. **Não dá para converter para ZPL via Labelary** (`zpl-to-pdf.ts`), porque não há texto a interpretar —
   o caminho é `imprimirPdf` com recorte, como a Shopee.
3. Vale testar `label.format: "zpl"` na API, que pelo contrato existe e evitaria o recorte inteiro. **Este
   PDF veio do portal, não da API** — não assumir que a API devolve o mesmo layout.

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

- **Specs OpenAPI crus (preferir sempre a estes HTMLs):**
  [llms.txt](https://developers.magalu.com/llms.txt) ·
  [index.json](https://developers.magalu.com/apis/index.json) ·
  [orders.openapi.yaml](https://developers.magalu.com/apis/orders.openapi.yaml) ·
  [orders/overview.md](https://developers.magalu.com/apis/orders/overview.md) ·
  [smartlabel.openapi.yaml](https://developers.magalu.com/apis/smartlabel.openapi.yaml)
- [Estrutura de erros](https://developers.magalu.com/docs/development-guide/error-structure) ·
  [Criar aplicação (lista completa de escopos)](https://developers.magalu.com/docs/first-steps/create-an-application/create-application) ·
  [Sandbox — criar pedido](https://developers.magalu.com/docs/apis/sandbox/orders/createorder) ·
  [Sandbox — atualizar status](https://developers.magalu.com/docs/apis/sandbox/orders/orderstatus)
- [Ambientes](https://developers.magalu.com/docs/first-steps/environment) · [OAuth 2.0](https://developers.magalu.com/docs/first-steps/create-an-application/authentication-authorization) · [IDs dos canais](https://developers.magalu.com/docs/development-guide/sales-channel-id)
- [Gerar etiquetas](https://developers.magalu.com/docs/apis_logistic/labels/ref/seller-v-1-post-logistics-shipping-labels) · [Etiquetas — escopos](https://developers.magalu.com/docs/apis_logistic/labels/ref/overview) · [Magalu Entregas](https://developers.magalu.com/docs/apis_logistic/overview)
- [Consultar pedidos](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-get-order-list) · [Consultar entregas](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-get-deliveries-list) · [Marcar enviada](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-post-delivery-shippings) · [Enviar NF-e](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-post-delivery-invoice) · [Finalizar](https://developers.magalu.com/docs/apis/orders/ref/seller-v-1-post-delivery-finishing)
- [Webhooks — guia e HMAC](https://developers.magalu.com/docs/development-guide/webhooks) · [Webhooks de Pedidos](https://developers.magalu.com/docs/apis/orders/webhooks)
- [Rate limit](https://developers.magalu.com/docs/development-guide/rate-limit) · [Paginação e filtros](https://developers.magalu.com/docs/development-guide/pagination-filtering-sorting) · [X-Request-Id](https://developers.magalu.com/docs/development-guide/request-identifier-x-request-id)
- [Sandbox](https://developers.magalu.com/docs/apis/sandbox/overview) · [Release Notes](https://developers.magalu.com/docs/release-notes)
- Legado, não usar: [Acelera Magalu](https://acelera.magalu.com/pedidos.html) · [IntegraCommerce](https://api.integracommerce.com.br/Documentation/Orders)

---

## 15. Medições em produção (15/09/2026) — o que deixou de ser suposição

Rota `src/routes/api/debug/magalu-ping.ts`, executada dentro do Cloudflare Worker `babyworld`
(version `a2f4e2be-e5cb-46c8-813f-952e45cfa799`), sem credencial.

| Alvo | Status | Tempo | Veredito |
|---|---|---|---|
| `https://api.magalu.com/seller/v1/deliveries` | **401** | **177 ms** | ✅ alcança |
| `https://api-sandbox.magalu.com/seller/v1/deliveries` | 401 | 218 ms | ✅ alcança |
| `https://id.magalu.com/oauth/token` | 404 | 294 ms | ⚠️ ver abaixo |

Corpo do 401, idêntico em prod e sandbox — é a prova de que a requisição chegou ao servidor do Magalu e
foi processada:

```json
{ "developerMessage": "Unauthorized",
  "userMessage": "You are not authorized to perform this operation. Invalid or expired token.",
  "moreInfo": "http://developer.apiluiza.com.br/errors/reference/30001",
  "errorCode": 30001 }
```

**Risco #1 da seção 10 está RESOLVIDO: não há bloqueio de IP de datacenter.** O Magalu é o **primeiro canal
do EXPEDE sem proxy** — o ML precisa de Edge Function (`supabase/functions/ml-label`) e a Shopee de gateway
de IP fixo (`ops/shopee-gateway/`). O cliente HTTP do Magalu pode viver direto em `src/lib/magalu.ts`.

Headers observados: `Server: cloudflare` **junto com** `x-azion-request-id` e `x-azion-edge-location: CGH`.
Há Cloudflare na borda e Azion atrás — medições anteriores, feitas de IP residencial, só tinham visto o
Azion. Não houve challenge nem bot-fight em nenhum dos três alvos.

> ⚠️ **`id.magalu.com/oauth/token` devolveu 404 — mas o teste foi um GET, e o endpoint de token é POST.**
> Um 404 em resposta a método errado é plausível e **não** prova que o path esteja errado. Fica como
> **item a confirmar no primeiro POST real** do fluxo OAuth: se o 404 persistir com POST, o path do token
> é outro e a seção 2 precisa de correção. Não tratar como confirmado em nenhuma direção.

### Estado do registro no IDMagalu (Fase 0 — concluída)

- Client criado, UUID `fe3df874-5759-4e43-8e94-7be72d49698d`, `client_id`
  `g91eMNEfVgQyPBNU7eRGq4yAuMoDNSMiqOwlkeTSuq8`. Secrets no Worker como `MAGALU_CLIENT_ID` /
  `MAGALU_CLIENT_SECRET`.
- **Os 6 escopos saíram `AVAILABLE` e `(default)`, com `PENDING` e `APPROVER` vazios** — incluindo
  `open:order-logistics-seller:read` e `:write`. **Nenhuma aprovação manual do Magalu foi necessária**; não
  há lead time de homologação bloqueando (seção 9).
- Consentimento tem de ser dado pelo tenant **`organization`** (Baby Magia LTDA,
  `94725b94-9532-4475-8c3a-299b0e685dde`), nunca pelo `person` (`23e801cc-…`) — daí `choose_tenants=true`
  ser obrigatório na URL de consentimento.
- ⚠️ **`idm client update` NÃO tem flag de escopos.** Escopo errado ⇒ criar client novo, com secret e
  consentimento novos. A afirmação contrária, que estava em `PROMPT-FASE-2-MAGALU.md`, foi corrigida.
- ⚠️ Pendente: `TOKEN EXPIRATION` saiu como **20 s** (o CLI aplica isso quando `--access-token-exp` é
  omitido), contra os 7200 s da doc. Renovar a cada chamada convida ao 429 — mesmo padrão da Lição #41 com
  o Bling.

---

## 16. Etapa 2 do spike (15/09/2026) — OAuth e rota de descoberta

Commit `aa22f0d` na branch `feat/magalu-etiqueta`. **Nada aqui muda o comportamento do galpão**:
`FALLBACK_POR_MARKETPLACE` continua com `magalu: null`, e expedição, impressão e QZ Tray estão intactos.

### O que passou a existir

| Peça | Arquivo | Papel |
|---|---|---|
| Lógica pura | `src/lib/magalu.ts` | URL de consentimento, margem de renovação, extração dos discriminadores de modalidade, detecção de formato do arquivo baixado. 23 testes em `test/magalu.test.mjs` |
| Cliente OAuth/HTTP | `src/lib/magalu.functions.ts` | OAuth2 puro — sem HMAC (≠ Shopee) e **sem proxy** (≠ ML e Shopee) |
| Cifra de token | `src/lib/token-crypto.ts` | AES-256-GCM extraído de `bling.functions.ts` **sem mudança de comportamento** |
| Consentimento | `src/routes/api/magalu/auth.ts` + `callback.ts` | `state` em cookie HttpOnly, conferido na volta |
| Descoberta | `src/routes/api/debug/magalu-etiqueta-teste.ts` | responde as 5 perguntas com o pedido 9262 |
| Conexão | migration `20260915120000_magalu-connections.sql` | token em `bytea` cifrado, RLS restritiva |

### Três decisões que valem como precedente

**1. Token cifrado em repouso.** `magalu_connections` guarda `access_token`/`refresh_token` em `bytea`
cifrado com o mesmo AES-256-GCM do Bling — não em `TEXT` puro como `shopee_connections` e `ml_connections`.
A chave é a **mesma** do Bling (`BLING_ENCRYPTION_KEY`), de propósito: o segredo já existe no Worker e o IV
é aleatório por registro. Não foi criada variável nova com precedência — uma segunda chave que divergisse
faria os tokens do Bling já gravados pararem de decriptar em produção.

**2. RLS restritiva, não `USING (true)`.** A tabela base não tem GRANT nenhum de tabela para
`authenticated`; só as 11 colunas sem segredo têm GRANT de coluna, e a policy de SELECT exige
`has_role(…, 'admin')`. `access_token` e `refresh_token` são inalcançáveis por chave anon/authenticated,
por GRANT, não só por policy. A view `magalu_connections_status` é o que a UI lê.

**3. A margem de renovação acompanha a validade do token, não é constante.**

```
margem = clamp(ttl × 10%, mínimo 5 s, máximo 300 s), nunca mais que metade do ttl
```

Com os 7200 s da doc dá 300 s; com os **20 s** que o client realmente tem, dá 5 s. Uma margem fixa de 60 s
faria **toda chamada renovar o token** — que é literalmente o caminho do 429 da Lição #41, já vivido com o
Bling. O `expires_in` da resposta é gravado em `access_ttl_seconds` justamente para alimentar essa conta.

### A rota de descoberta

```
/api/debug/magalu-etiqueta-teste
  ?code=1570070104300104   código do pedido no Magalu (default: o 9262)
  ?deliveryId=<uuid>       pula a busca e usa esta entrega direto
  ?emitir=zpl|pdf|ambos    EMITE ETIQUETA — escrita real; omitido = não emite
  ?tipo=summary|full       `label.type` (default summary)
  ?labelary=1              deriva o PDF do ZPL via Labelary (pergunta 5)
  ?raw=zpl|pdf|labelary    devolve o arquivo em vez do JSON
```

**Sem `?emitir=` a rota é leitura pura** — e isso já responde as perguntas 1 e 2. A emissão ficou atrás de
um parâmetro explícito porque **o sandbox não suporta `shipping-labels`**: não existe lugar para ensaiar, e
toda emissão é escrita de verdade num marketplace real. A lacuna #4 (chamar duas vezes gera duas etiquetas
ou dois rastreios?) continua aberta e é o motivo de `emitir=ambos` existir — usar **uma vez só**, de
propósito, e olhar o resultado.

A rota tenta três caminhos para achar a entrega (`/orders/{code}`, `/deliveries?code=`,
`/deliveries?code={code}-1`) e **reporta o status de cada um**: qual deles responde o quê ainda é suposição,
e descobrir isso é parte do resultado.

### O que a rota NÃO decide

`extrairDiscriminadoresDeModalidade` **dumpa** `shipping.provider` e `shipping.logistic_network` crus, mais
`Object.keys(shipping)` e `Object.keys(provider)`, e reporta os campos legados (`is_mle`, `is_fulfillment`,
`shipping_type`, `shipping_name`) como `undefined` quando não existem — distinto de `false`. A diferença
importa: `false` significaria "frete próprio", `undefined` significa "o spec não tem esse campo". **Nenhuma
regra de roteamento foi escrita**, por decisão: ela só sai depois de ver o dado real.

### Pista já disponível sem chamar a API

O `raw_json` do pedido 9262 no Bling traz `transporte.volumes[0].servico = "Agência Magalu"` — não
"Magalu Entregas". Se isso refletir a modalidade real, o 9262 pode ser justamente o caso **negativo** da
pergunta 2, e não o positivo que se esperava. `transporte.transportador.nome` é `null` e
`codigoRastreamento` é string vazia.

### O que falta para rodar (não foi feito nesta sessão)

1. **Deploy** — a rota só existe em produção depois de publicar. Deploy **não** pode sair de `main`.
2. **Consentimento** — abrir `/api/magalu/auth` logado e escolher o tenant **`organization`** (Baby Magia
   LTDA, `94725b94-9532-4475-8c3a-299b0e685dde`), nunca o `person`.
3. **Rodar a rota** e trazer o JSON. As respostas entram na seção 12 (lacunas) e aqui.

### Incógnita que a primeira chamada real resolve de graça

O `404` do `GET` em `id.magalu.com/oauth/token` (seção 15) não prova nada. `postToken` tenta o Content-Type
documentado e, se levar **404/405/415**, repete com o outro e grava em
`magalu_connections.token_endpoint_format` **qual funcionou**. Qualquer outro erro (credencial, code
expirado) não é repetido — repetir só queimaria o code, que é de uso único. Quando o dado aparecer, um dos
dois caminhos sai do código.
