# Repasse do marketplace no modal de pedidos

**Data:** 2026-09-02
**Status:** aprovado (design)
**Escopo:** Mercado Livre. Shopee fica como fase 2.

## Problema

A tela de pedidos mostra o valor bruto da venda, mas não mostra quanto de fato
sobra na conta do marketplace. Hoje, para saber o líquido de um pedido, é preciso
abrir o detalhe da venda no painel do Mercado Livre, um pedido por vez.

O objetivo: clicar no número do pedido e ver, em um modal, a tarifa de venda
total, o percentual dessa tarifa, o custo do envio e o valor líquido.

## Evidência que determinou o desenho

O Bling **não** fornece esses valores. O pedido de venda da API v3 expõe o campo
`taxas`, mas ele chega zerado em 100% dos pedidos ingeridos:

```
taxas: { valorBase: 0, custoFrete: 0, taxaComissao: 0 }   // 233/233 pedidos
```

Verificado por consulta direta ao banco em 2026-09-02. `transporte.frete` e
`outrasDespesas` também não representam o custo do vendedor. Portanto os valores
precisam vir da API do marketplace.

No Mercado Livre os dados existem e reconciliam com o painel:

| Campo do painel | Origem na API | Exemplo |
|---|---|---|
| Valor da venda | `order_items[].unit_price × quantity` | R$ 31,20 |
| Tarifa de venda total | `order_items[].sale_fee × quantity` | R$ 5,15 |
| Percentual da tarifa | `sale_fee ÷ unit_price` | 16,5% |
| Tarifa do Mercado Envios | `/shipments/{id}/costs` → `senders[0].cost` | R$ 6,95 |
| Total | calculado: bruto − tarifa − envio | R$ 19,10 |

## Decisões

| Decisão | Escolha | Motivo |
|---|---|---|
| Marketplaces | ML agora; camada normalizada preparada para Shopee | Cobre a maioria dos pedidos sem duplicar trabalho depois |
| Momento da busca | No sincronismo (cron), não sob demanda | ~15 pedidos/dia × 2 chamadas = ~30/dia, contra as ~5.760/dia que o cron de status já faz. Custo irrelevante e o modal fica instantâneo |
| Congelamento | Para de re-consultar quando `ml_shipment_status = 'delivered'` | Nesse ponto tarifa e frete estão liquidados. O custo do cron não cresce com o histórico |
| Histórico | Backfill único via rota admin | Pedidos já entregues nunca entrariam na rotação; sem isso não dá para fechar o mês corrente |

O congelamento é necessário porque os valores **não nascem prontos**: a tarifa de
venda existe desde a criação do pedido, mas o custo de envio só fica definitivo
quando o shipment é criado e despachado. Uma busca única na ingestão gravaria
frete zerado — o mesmo defeito que o Bling tem hoje.

## Arquitetura

```
Bling (ingestão) → pedido no banco
                        ↓
        cronRepasseMl (a cada min, 4 por execução)
                        ↓
   edge function ml-order-billing → API ML → repasse.ts (normaliza)
                        ↓
               colunas repasse_* em pedidos
                        ↓
              RepasseDialog (leitura pura)
```

O modal nunca fala com o ML: abre instantâneo e funciona com o ML fora do ar.

### a) Edge function `supabase/functions/ml-order-billing`

Mesmo molde de `ml-shipment-status` — existe porque o Cloudflare Workers não
alcança `api.mercadolibre.com` diretamente (erro 1016/530).

Entrada: `{ ml_order_id, access_token }`. Faz `GET /orders/{id}` e, com o
`shipping.id` de lá, `GET /shipments/{id}/costs`. Reaproveita o fallback
`/packs/{id}` que já existe naquela função para pedidos de carrinho: em um pack,
soma o `sale_fee` de todos os pedidos e conta o frete uma única vez.

Saída: `{ ok: true, ... }` ou `{ ok: false, error }` — mesmo contrato das outras.

### b) `src/lib/repasse.ts` (módulo puro, sem I/O)

Segue o padrão de `atendidos-ml.ts` e `reconciliar-atendidos.ts`: lógica pura,
testável sem rede.

```ts
export type RepasseMarketplace = {
  marketplace: "mercado_livre" | "shopee";
  valor_bruto: number;
  tarifa_venda: number;
  tarifa_percentual: number | null;
  custo_envio: number;
  valor_liquido: number;
  final: boolean;
};
```

Contém `normalizarRepasseMl(payload)` e a seleção de candidatos do cron. É o
ponto de extensão da fase 2: a Shopee vira `normalizarRepasseShopee(escrow_detail)`
devolvendo o mesmo tipo, sem tocar em cron nem UI.

Regras de cálculo:

- `valor_liquido = valor_bruto − tarifa_venda − custo_envio`, calculado por nós,
  nunca copiado de um campo do ML.
- `tarifa_percentual = tarifa_venda ÷ valor_bruto × 100`, arredondado a 2 casas;
  `null` quando `valor_bruto` é zero.
- Valores monetários arredondados a 2 casas na normalização.

### c) Migration

Colunas novas em `public.pedidos` — separadas, não JSONB, porque o objetivo
declarado inclui somar isso depois:

| Coluna | Tipo |
|---|---|
| `repasse_tarifa_venda` | `NUMERIC(12,2)` |
| `repasse_tarifa_percentual` | `NUMERIC(5,2)` |
| `repasse_custo_envio` | `NUMERIC(12,2)` |
| `repasse_valor_liquido` | `NUMERIC(12,2)` |
| `repasse_checked_at` | `TIMESTAMPTZ` |
| `repasse_final` | `BOOLEAN NOT NULL DEFAULT false` |
| `repasse_error` | `TEXT` |

Índice parcial para a rotação do cron, sobre pedidos ainda não congelados.

### d) Cron `cronRepasseMl`

Registrado no `scheduled` de `src/server.ts` ao lado de `cronSyncPoll`,
`cronReconciliar` e `cronNfEmissao`.

Rotação idêntica a `atualizarSituacoesExistentes`: orçamento próprio
`MAX_CANDIDATOS_REPASSE = 4` por execução (não compartilhado com os demais),
priorizando `repasse_checked_at IS NULL` e depois os mais antigos.

Candidato é o pedido que: tem `numero_loja`, pertence à loja ML (constante
`ML_BLING_LOJA_ID` de `nf-emissao.policy.ts`), não está cancelado
(`situacao_valor <> 12`) e tem `repasse_final = false`.

`repasse_checked_at` sempre avança, tenha mudado algo ou não — mesma razão
documentada em `atualizarSituacoesExistentes`: senão um pedido problemático
monopoliza os slots. `repasse_final` vira `true` quando `ml_shipment_status`
é `delivered`.

### e) UI

`src/routes/_app/pedidos.tsx`: o número do pedido vira botão. O componente novo
`src/components/RepasseDialog.tsx` usa o `<Dialog>` do shadcn (já instalado) e lê
apenas as colunas `repasse_*`. Isso exige acrescentar essas colunas ao `select`
de `listarPedidos` e ao tipo `PedidoRow` — o modal não faz consulta própria.

Layout espelhando o painel do ML: valor da venda → tarifa de venda total (com o
percentual ao lado) → custo do envio → líquido em destaque. Rodapé discreto com
"atualizado em ..." e, enquanto `repasse_final` for falso, aviso de que os valores
ainda podem mudar.

Estados de exceção:

- pedido não-ML → "indisponível para este marketplace"
- `repasse_checked_at` nulo → "aguardando sincronização"
- `repasse_error` preenchido → mensagem do erro

### f) Backfill

Rota `src/routes/api/admin/backfill-repasse.ts`, no mesmo padrão de
`importar-pedido.ts` e `reconciliar.ts`. Varre pedidos ML sem `repasse_checked_at`,
em lotes, e preenche. ~466 chamadas para os 233 pedidos atuais. Idempotente:
rodar de novo não reprocessa o que já tem dado.

## Erros

Falha na API do ML grava `repasse_error` e **não derruba o cron** — mesmo contrato
`{ ok: false, error }` que `checarStatusEnvioML` já usa. Sem conexão ML retorna
`ml_no_connection` e o pedido continua candidato para a próxima execução.

## Testes

Padrão de `test/atendidos-ml.test.mjs` (Node test runner, `.mjs`, sem rede),
cobrindo `repasse.ts`:

- normalização de um pedido simples, reconciliando com os números do painel
  (31,20 / 5,15 / 6,95 / 19,10)
- pedido de carrinho (pack): tarifas somadas, frete contado uma vez
- `tarifa_percentual` nulo quando o bruto é zero
- arredondamento a 2 casas
- seleção de candidatos: respeita o orçamento, prioriza nunca verificados,
  exclui cancelados, não-ML e congelados

## Fora de escopo

- Shopee e demais marketplaces (fase 2, via `normalizarRepasseShopee`)
- Coluna de líquido na listagem — o pedido foi por modal
- Relatório agregado de "quanto sobrou no mês"; o schema fica preparado, mas a
  tela não faz parte desta entrega
- Estornos e devoluções após a entrega, consequência direta do congelamento

## Critérios de aceite

1. Clicar no número de um pedido ML abre o modal exibindo valor da venda, tarifa
   de venda total, percentual da tarifa, custo do envio e líquido.
2. Os valores reconciliam com o painel do Mercado Livre para o pedido do print.
3. O modal abre sem chamada de rede ao ML.
4. Pedido não-ML e pedido sem dado exibem seus estados próprios, sem erro.
5. Pedido novo tem o repasse preenchido pelo cron sem intervenção manual.
6. Após o backfill, os 233 pedidos existentes exibem repasse.
7. Falha na API do ML não interrompe os demais crons.
