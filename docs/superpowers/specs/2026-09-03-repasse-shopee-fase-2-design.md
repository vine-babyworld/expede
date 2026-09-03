# Repasse do marketplace — fase 2: Shopee

**Data:** 2026-09-03
**Status:** aprovado (design)
**Escopo:** Shopee. Estende a fase 1 (`2026-09-02-repasse-marketplace-modal-design.md`), que entregou o Mercado Livre.

## Problema

O modal de repasse existe e funciona para pedidos do Mercado Livre desde 03/09/2026.
Para os 42 pedidos Shopee ele mostra "Repasse indisponível para este marketplace".
A fase 1 desenhou a camada normalizada justamente para receber esta fase: escrever
`normalizarRepasseShopee` devolvendo o mesmo `RepasseMarketplace`.

## Evidência que determinou o desenho

Medida em **42 de 42** pedidos Shopee do banco em 03/09/2026, via chamadas reais a
`GET /api/v2/payment/get_escrow_detail` e `GET /api/v2/order/get_order_detail`.

### O Bling não serve, de novo

`taxas` chega zerado em **42/42** (`valorBase`, `custoFrete`, `taxaComissao` todos 0) —
exatamente como os 233/233 do ML. E o `total` do Bling diverge do bruto da Shopee
(pedido 9080: R$ 446,03 contra R$ 393,00). Mesma conclusão da fase 1: o bruto exibido
vem do marketplace.

### A fórmula, com 0 divergências em 42/42

```
escrow_amount = order_selling_price
              − commission_fee
              − service_fee
              − ads_escrow_top_up_fee_or_technical_support_fee
              − order_ams_commission_fee
              − voucher_from_seller
              − shipping_seller_protection_fee_amount
              − (actual_shipping_fee − buyer_paid_shipping_fee − shopee_shipping_rebate)
```

### Duas armadilhas que só apareceram por checar os 42

1. **`order_ams_commission_fee` existe em 5 de 42 pedidos.** Foi ele que produziu as 5
   divergências da primeira passada (10,08 / 7,83 / 5,56 / 3,55 / 11,45 — batendo ao
   centavo). Validar em 3 pedidos teria produzido um modal errado em ~12% dos casos,
   sem sintoma visível.
2. **`net_commission_fee` / `net_service_fee` vêm preenchidos em 42/42 e parecem os
   corretos — não são.** O que a Shopee debita é o bruto (`commission_fee` /
   `service_fee`); o `seller_product_rebate` que gera o "net" já está refletido em
   `voucher_from_shopee`, bancado pela Shopee. Usar os "net" superestimaria o líquido
   nos 42.

### Preenchimento medido

| campo | em quantos dos 42 |
|---|---|
| `order_selling_price`, `commission_fee`, `service_fee`, `voucher_from_seller`, `shipping_seller_protection_fee_amount`, `escrow_amount`, `actual_shipping_fee` | 42 |
| `ads_escrow_top_up_fee_or_technical_support_fee` | 40 |
| `shopee_shipping_rebate` | 37 |
| `buyer_paid_shipping_fee` | 21 |
| `pix_discount` | 16 |
| `coins` | 8 |
| `order_ams_commission_fee` | 5 |

`pix_discount` e `coins` **não** entram na conta: são bancados pela Shopee, não pelo
vendedor. Confirmado pelos 42 fecharem sem eles.

### Frete R$ 0,00 é o caso normal, não a exceção

Só 2 dos 42 têm custo real de frete para o vendedor (9036: R$ 4,87; 9077: R$ 6,08).
Sob o Programa de Frete Grátis a Shopee cobre o frete via `shopee_shipping_rebate` e
cobra caro na comissão: a tarifa efetiva fica em ~23% (pedido 9080: R$ 90,53 sobre
R$ 393,00), contra 16,5% + taxa fixa do ML. **A linha "custo do envio" vai mostrar zero
em quase todo pedido Shopee, e isso está certo** — o desenho trata o rótulo.

### Status e congelamento

Distribuição real: **COMPLETED 19 · TO_CONFIRM_RECEIVE 15 · SHIPPED 7 · TO_RETURN 1**.
`escrow_amount_after_adjustment == escrow_amount` e `total_adjustment_amount` zerado em
42/42 — nenhum ajuste ocorreu ainda.

## Decisões

| Decisão | Escolha | Motivo |
|---|---|---|
| Transporte até a API | Reusa o gateway de IP fixo existente | O ingress do cloudflared libera `^/api/v2/.*` e o nginx faz `location /api/v2/` com GET+POST. **Nenhuma edge function nova.** A restrição do ML (Worker não alcança `api.mercadolibre.com`) não se aplica |
| Líquido | `escrow_amount` informado pela Shopee | Diferente do ML, aqui existe gabarito. Nós calculamos em paralelo e **conferimos** |
| Quebra de taxas | Lista genérica de linhas rotuladas | `order_ams_commission_fee` só existe em 5/42; colunas fixas por tipo fariam cada taxa nova da Shopee virar migration |
| Congelamento | `order_status === 'COMPLETED'` | Na Shopee entregue ≠ liquidado. Congelar em "entregue" gravaria valor ainda sujeito a mudança |
| Status Shopee | Coluna nova `shopee_order_status` | `ml_shipment_status` está nulo nos 42; reusá-la faria `repasse_final` nunca virar `true` e o cron re-consultaria os 42 para sempre |
| Cron | `cronRepasseShopee` irmão do `cronRepasseMl` | Orçamento e gate próprios: uma indisponibilidade da Shopee não consome os slots do ML |

## Arquitetura

```
Bling (ingestão) → pedido no banco (marketplace='shopee')
                        ↓
        cronRepasseShopee (gate de 5 min, 4 por execução)
                        ↓
   shopee.ts → gateway de IP fixo → Escrow API + Order API
                        ↓
        repasse.ts / normalizarRepasseShopee (puro)
                        ↓
               colunas repasse_* em pedidos
                        ↓
              RepasseDialog (leitura pura)
```

Igual à fase 1, **menos a edge function** — que aqui não existe.

### a) `src/lib/repasse.ts` — o tipo cresce

```ts
export type LinhaRepasse = {
  chave: string;    // campo de origem na API, para rastreabilidade
  rotulo: string;   // texto exibido
  valor: number;    // positivo = desconta do bruto
};

export type RepasseMarketplace = {
  marketplace: "mercado_livre" | "shopee";
  valor_bruto: number;
  tarifa_venda: number;
  tarifa_percentual: number | null;
  custo_envio: number;
  valor_liquido: number;
  final: boolean;
  // fase 2:
  linhas: LinhaRepasse[];
  liquido_informado: number | null;
  envio_coberto_pelo_marketplace: boolean;
  divergencia: number | null;
};
```

**`normalizarRepasseMl` também passa a devolver `linhas`** — uma única linha
(`sale_fee` / "Tarifa de venda"), com `liquido_informado: null`,
`envio_coberto_pelo_marketplace: false` e `divergencia: null`. Assim a UI renderiza a
quebra quando `linhas.length > 1` e **não precisa de nenhum `if (marketplace === ...)`
para decidir layout** — a promessa da fase 1 de manter a UI agnóstica continua valendo.
Os 6 testes existentes usam asserts campo a campo, não `deepStrictEqual`, então
continuam passando sem alteração.

### b) `normalizarRepasseShopee`

Entrada: um recorte estreito de `order_income` mais o `order_status`. Módulo puro, sem
I/O, no mesmo padrão de `normalizarRepasseMl`.

Linhas emitidas, nesta ordem, **omitindo as de valor zero**:

| chave | rótulo |
|---|---|
| `commission_fee` | Comissão |
| `service_fee` | Taxa de serviço |
| `ads_escrow_top_up_fee_or_technical_support_fee` | Taxa de suporte técnico |
| `order_ams_commission_fee` | Comissão de anúncios (AMS) |
| `voucher_from_seller` | Cupom do vendedor |
| `shipping_seller_protection_fee_amount` | Proteção de envio |

Regras:

- `valor_bruto = order_selling_price`
- `tarifa_venda` = soma das linhas
- `custo_envio = actual_shipping_fee − buyer_paid_shipping_fee − shopee_shipping_rebate`
  (sem clamp: um valor negativo é crédito e a conta continua fechando)
- `envio_coberto_pelo_marketplace = custo_envio === 0 && shopee_shipping_rebate > 0`
- `liquido_informado` = `escrow_amount_after_adjustment` quando
  `total_adjustment_amount !== 0`; senão `escrow_amount`
- `valor_liquido = liquido_informado` — a Shopee é a fonte da verdade
- `divergencia = arredondar((bruto − tarifa − envio) − liquido_informado)`; **é a
  auto-conferência que teria pego o `order_ams_commission_fee` sozinha**
- `final = order_status === "COMPLETED"`
- `tarifa_percentual = tarifa_venda ÷ valor_bruto × 100`, `null` se bruto zero

O `voucher_from_seller` é desconto dado pelo vendedor, não tarifa da Shopee — mas
reduz o repasse, então entra nas linhas. O rótulo agregado trata isso (ver UI).

### c) Migration

| Coluna | Tipo |
|---|---|
| `repasse_linhas` | `JSONB` |
| `repasse_liquido_informado` | `NUMERIC(12,2)` |
| `repasse_divergencia` | `NUMERIC(12,2)` |
| `shopee_order_status` | `TEXT` |

As colunas agregadas da fase 1 continuam sendo colunas separadas — são elas que se
somam num relatório mensal. A quebra vai em JSONB porque ninguém soma linha de quebra
entre pedidos.

Índice parcial para a rotação, espelhando o da fase 1, agora sobre `marketplace='shopee'`.

⚠️ Aplicar **só esta migration**, via MCP `apply_migration`. Não usar
`supabase db push` / `migration up`: o histórico do CLI está dessincronizado
(ver `CURRENT-STATE.md`, "Bloqueios atuais").

### d) `src/lib/repasse.functions.ts`

- `selecionarCandidatosRepasse(marketplace, orcamento)` — ganha o parâmetro; a query
  do ML fica idêntica com `marketplace='mercadolivre'`.
- `atualizarRepassePedido(pedido)` — despacha por `pedido.marketplace`: ML pela edge
  function, Shopee pela chamada direta. Continua sendo o **único** caminho de escrita,
  usado por cron e backfill, pela mesma razão da fase 1: os dois não podem divergir.
- Busca Shopee: `get_escrow_detail` + `get_order_detail` para o mesmo `order_sn`.
  Contrato `{ ok: false, error }`, nunca lança — igual ao ML.
- `repasse_checked_at` sempre avança, tenha dado certo ou não.

### e) `src/lib/shopee.ts`

`shopeeFetch` é privado do módulo. A chamada de escrow mora **dentro** de `shopee.ts`,
exportada como `buscarRepasseShopee(orderSn)` — não exportar `shopeeFetch`, para não
abrir o caminho de rede autenticado para o resto do código.

### f) Cron

`cronRepasseShopee`, registrado em `plugins/cloudflare-scheduled.ts` ao lado dos
demais (o `scheduled` exportado em `src/server.ts` é código morto — não confundir).
Gate de 5 min via `cron_state`, orçamento próprio `MAX_CANDIDATOS_REPASSE_SHOPEE = 4`.

Candidato: `marketplace='shopee'`, tem `numero_loja`, não cancelado (`situacao_id <> 12`),
`repasse_final = false`. Prioriza `repasse_checked_at IS NULL`, depois os mais antigos.

### g) UI — o modal muda pouco

Mesmo componente, mesmo esqueleto. Em repouso, um pedido Shopee tem exatamente as
mesmas quatro linhas de um pedido ML. As diferenças:

1. **Quebra sob a tarifa.** Quando `linhas.length > 1`, as linhas aparecem indentadas
   e em texto menor logo abaixo do total de tarifa. No ML `linhas.length === 1` e nada
   muda — o modal do ML fica **byte a byte o que está em produção hoje**.
2. **Rótulo do agregado.** ML: "Tarifa de venda total (16,5%)". Shopee: "Tarifas e
   descontos (23,0%)" — porque `voucher_from_seller` é desconto do vendedor, não tarifa
   da Shopee, e chamar tudo de "tarifa" seria impreciso.
3. **Frete zero explicado.** Com `envio_coberto_pelo_marketplace`, a linha vira
   "Custo do envio (coberto pela Shopee)" com R$ 0,00 sem estilo de negativo. Sem isso,
   40 dos 42 pedidos exibiriam um zero que parece defeito.
4. **Rodapé do não-final.** ML: "O envio ainda não foi entregue". Shopee: "A Shopee
   ainda não liberou o pagamento — estes valores podem mudar."
5. **Aviso de divergência.** Se `repasse_divergencia` for diferente de zero, uma linha
   discreta: "Conferência: nossa soma difere em R$ X,XX do valor informado pela Shopee."
   Não bloqueia nem esconde o valor — a Shopee continua sendo a fonte.

O estado "Repasse indisponível para este marketplace" **permanece** para `marketplace`
nulo ou desconhecido; some só para a Shopee.

`PedidoRow` e o `select` de `listarPedidos` ganham `repasse_linhas`,
`repasse_liquido_informado`, `repasse_divergencia` e `shopee_order_status`. O modal
continua **leitura pura**, sem nenhuma chamada de rede.

**Mobile:** o modal é aberto pela coluna `numero` da `<ResponsiveTable>` — quem mexer
altera a definição da coluna, não markup solto (herança do PR #5). A quebra acrescenta
altura; verificar em 320/344/390px.

### h) Backfill

`/api/admin/backfill-repasse` ganha `?marketplace=shopee`. Sequencial, 2 chamadas por
pedido, 84 no total para os 42 — bem abaixo do limite de subrequests do Worker, e o
mesmo padrão que a fase 1 usou para 382 chamadas. Idempotente: só pega
`repasse_checked_at IS NULL`.

`get_escrow_detail_batch` (até 50 `order_sn`) fica registrado como otimização
disponível, **não implementada** — não vale a complexidade para 42 pedidos.

## Erros

Falha na Shopee grava `repasse_error` e não derruba o cron, mesmo contrato da fase 1.
Sem conexão Shopee retorna `shopee_no_connection` e o pedido segue candidato.
`refreshShopeeTokenIfNeeded` já trata a renovação do token e está em produção desde
18/08/2026.

## Testes

`test/repasse.test.mjs`, Node test runner, sem rede. Rodar com
`node --test test/*.test.mjs` (a forma `node --test test/` falha no Windows).
Todos os casos usam **números reais medidos**, não inventados:

- pedido 9080 — caso comum: 393,00 bruto, 6 linhas, frete 0,00, escrow 301,98
- pedido 8912 — **com `order_ams_commission_fee`**: 214,00 / 10,08 de AMS / escrow 140,13
- pedido 9077 — **com frete real**: 316,72 / frete 6,08 / escrow 231,81
- linhas de valor zero são omitidas da quebra
- `final` só é `true` em `COMPLETED` (testar `SHIPPED` e `TO_CONFIRM_RECEIVE` como false)
- `divergencia` diferente de zero quando falta uma linha na soma
- `envio_coberto_pelo_marketplace` verdadeiro só com rebate e frete zero
- `normalizarRepasseMl` continua devolvendo `linhas.length === 1` e
  `liquido_informado === null` (não-regressão da fase 1)

## Fora de escopo

- **Devoluções e estornos.** 1 dos 42 pedidos está em `TO_RETURN` (8922, escrow ainda
  positivo em R$ 443,96). O caso é real, não hipotético, mas tratá-lo é fase própria.
- Demais marketplaces (Amazon, Magalu, TikTok Shop).
- Relatório agregado de "quanto sobrou no mês" — o schema fica pronto, a tela não.
- `get_escrow_detail_batch`.
- Badges de status Shopee na listagem, embora `shopee_order_status` passe a existir.

## Critérios de aceite

1. Clicar no número de um pedido Shopee abre o modal com valor da venda, tarifas
   quebradas, custo do envio e líquido.
2. O líquido exibido é igual ao `escrow_amount` da Shopee para os 42 pedidos.
3. `repasse_divergencia` é zero em 42/42 após o backfill.
4. O modal de um pedido ML permanece idêntico ao que está em produção hoje.
5. Pedido com frete coberto exibe "coberto pela Shopee", não um zero solto.
6. Pedido em `COMPLETED` fica com `repasse_final = true` e sai da rotação; os 19
   atuais congelam no primeiro ciclo.
7. Pedido Shopee novo é preenchido pelo cron sem intervenção manual.
8. Falha na Shopee não interrompe o `cronRepasseMl` nem os demais crons.
9. `tsc --noEmit` sem erro novo — baseline é o único erro pré-existente em
   `src/lib/shopee.ts(458,79)`.
