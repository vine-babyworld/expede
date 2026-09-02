# Repasse do Marketplace no Modal de Pedidos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicar no número de um pedido do Mercado Livre na tela de pedidos abre um modal com tarifa de venda, percentual da tarifa, custo do envio e valor líquido.

**Architecture:** Um cron busca o repasse na API do ML (via edge function, porque o Cloudflare Workers não alcança `api.mercadolibre.com`), normaliza num módulo puro e grava em colunas `repasse_*` na tabela `pedidos`. O modal só lê do banco — nunca chama o ML. Pedidos param de ser re-consultados quando o envio vira `delivered`.

**Tech Stack:** TanStack Start + React, Supabase (Postgres + Edge Functions Deno), Cloudflare Workers, shadcn/ui, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-02-repasse-marketplace-modal-design.md`

---

## Contexto que o implementador precisa saber

O projeto tem duas fontes de dado de pedido. O **Bling** é a fonte primária (ingestão,
situação, NF) — mas seu campo `taxas` chega **zerado em 100% dos pedidos**, por isso
este trabalho existe. O **Mercado Livre** é consultado só para o que o Bling não tem.

Chamadas ao ML **nunca** saem direto do Worker: o Cloudflare não alcança
`api.mercadolibre.com` (erro 1016/530). Todas passam por uma Supabase Edge Function
que age como proxy. Veja `supabase/functions/ml-shipment-status/index.ts` — a função
nova é o mesmo molde.

Os crons **não** são registrados pelo `scheduled` exportado em `src/server.ts` (esse
bloco é código morto, e há um comentário dizendo isso). O registro real está em
`plugins/cloudflare-scheduled.ts`, que serializa cinco tarefas. O cron trigger dispara
a cada minuto, mas cada cron se auto-limita com um gate de intervalo gravado na tabela
`cron_state`.

A tabela `pedidos` já tem uma coluna `marketplace` com valores `'mercadolivre'` e
`'shopee'` — use ela para filtrar, não `raw_json`.

Estado atual do banco: 191 pedidos `mercadolivre`, 42 `shopee`, todos com `numero_loja`.

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/repasse.ts` (criar) | Lógica pura: normalização e cálculo. Sem I/O. Ponto de extensão da fase 2 (Shopee) |
| `test/repasse.test.mjs` (criar) | Testes do módulo puro |
| `supabase/migrations/20260902120000_repasse-marketplace.sql` (criar) | Colunas `repasse_*` e índice da rotação |
| `supabase/functions/ml-order-billing/index.ts` (criar) | Proxy Deno: `/orders` + `/shipments/{id}/costs` |
| `src/lib/repasse.functions.ts` (criar) | I/O: cliente da edge function, atualização de um pedido, seleção de candidatos, backfill |
| `src/server.ts` (modificar) | `cronRepasseMl()` |
| `plugins/cloudflare-scheduled.ts` (modificar) | Registrar o cron novo |
| `src/lib/pedidos.functions.ts` (modificar) | `PedidoRow` + `select` de `listarPedidos` |
| `src/components/RepasseDialog.tsx` (criar) | Modal, leitura pura |
| `src/routes/_app/pedidos.tsx` (modificar) | Número do pedido vira botão |
| `src/routes/api/admin/backfill-repasse.ts` (criar) | Rota do backfill único |

Ordem: o módulo puro primeiro (nada depende dele), depois o schema, depois o caminho
de dados, e a UI por último — assim cada tarefa é verificável sozinha.

---

### Task 1: Módulo puro de normalização

**Files:**
- Create: `src/lib/repasse.ts`
- Test: `test/repasse.test.mjs`

- [ ] **Step 1: Escreva o teste que falha**

Crie `test/repasse.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

import { normalizarRepasseMl, montarCandidatosRepasse } from "../src/lib/repasse.ts";

test("normalizarRepasseMl reconcilia com o painel do ML", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 31.2, quantity: 1, sale_fee: 5.15 }],
    custo_envio: 6.95,
    shipment_status: "shipped",
  });

  assert.equal(r.marketplace, "mercado_livre");
  assert.equal(r.valor_bruto, 31.2);
  assert.equal(r.tarifa_venda, 5.15);
  assert.equal(r.custo_envio, 6.95);
  assert.equal(r.valor_liquido, 19.1);
  assert.equal(r.tarifa_percentual, 16.51);
  assert.equal(r.final, false);
});

test("normalizarRepasseMl soma itens do pack e conta o frete uma vez", () => {
  const r = normalizarRepasseMl({
    order_items: [
      { unit_price: 50, quantity: 1, sale_fee: 8 },
      { unit_price: 25, quantity: 2, sale_fee: 4 },
    ],
    custo_envio: 6.95,
    shipment_status: "delivered",
  });

  assert.equal(r.valor_bruto, 100);
  assert.equal(r.tarifa_venda, 16);
  assert.equal(r.custo_envio, 6.95);
  assert.equal(r.valor_liquido, 77.05);
  assert.equal(r.final, true);
});

test("normalizarRepasseMl devolve percentual nulo quando o bruto e zero", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 0, quantity: 1, sale_fee: 0 }],
    custo_envio: 0,
    shipment_status: null,
  });

  assert.equal(r.tarifa_percentual, null);
  assert.equal(r.valor_liquido, 0);
});

test("normalizarRepasseMl arredonda a 2 casas", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 10.005, quantity: 3, sale_fee: 1.666 }],
    custo_envio: 0.014,
    shipment_status: null,
  });

  assert.equal(r.valor_bruto, 30.02);
  assert.equal(r.tarifa_venda, 5);
  assert.equal(r.custo_envio, 0.01);
  assert.equal(r.valor_liquido, 25.01);
});

test("normalizarRepasseMl trata lista de itens vazia sem quebrar", () => {
  const r = normalizarRepasseMl({ order_items: [], custo_envio: 0, shipment_status: null });

  assert.equal(r.valor_bruto, 0);
  assert.equal(r.tarifa_venda, 0);
  assert.equal(r.tarifa_percentual, null);
  assert.equal(r.valor_liquido, 0);
});

test("montarCandidatosRepasse prioriza nunca verificados e respeita o orcamento", () => {
  const nunca = [{ id: "a" }, { id: "b" }];
  const retry = [{ id: "c" }, { id: "d" }, { id: "e" }];

  assert.deepEqual(montarCandidatosRepasse(nunca, retry, 4), [
    { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" },
  ]);
  assert.deepEqual(montarCandidatosRepasse(nunca, retry, 1), [{ id: "a" }]);
  assert.deepEqual(montarCandidatosRepasse([], retry, 2), [{ id: "c" }, { id: "d" }]);
  assert.deepEqual(montarCandidatosRepasse([], [], 4), []);
});
```

- [ ] **Step 2: Rode o teste e confirme que falha**

```bash
node --test test/repasse.test.mjs
```

Esperado: FAIL — `Cannot find module '../src/lib/repasse.ts'`.

- [ ] **Step 3: Escreva a implementação mínima**

Crie `src/lib/repasse.ts`:

```typescript
// Formato normalizado de repasse do marketplace. Único tipo que a UI e o banco
// conhecem — a fase 2 (Shopee) adiciona um normalizarRepasseShopee que devolve
// este mesmo tipo, sem tocar em cron nem UI.
export type RepasseMarketplace = {
  marketplace: "mercado_livre" | "shopee";
  valor_bruto: number;
  tarifa_venda: number;
  tarifa_percentual: number | null;
  custo_envio: number;
  valor_liquido: number;
  final: boolean;
};

export type ItemRepasseMl = {
  unit_price: number;
  quantity: number;
  sale_fee: number;
};

export type PayloadRepasseMl = {
  order_items: ItemRepasseMl[];
  custo_envio: number;
  shipment_status: string | null;
};

function arredondar(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

// O líquido é sempre calculado por nós (bruto − tarifa − envio), nunca copiado
// de um campo do ML: é o número que o usuário confere contra o painel.
export function normalizarRepasseMl(payload: PayloadRepasseMl): RepasseMarketplace {
  const itens = payload.order_items ?? [];

  const valor_bruto = arredondar(
    itens.reduce((acc, i) => acc + i.unit_price * i.quantity, 0),
  );
  const tarifa_venda = arredondar(
    itens.reduce((acc, i) => acc + i.sale_fee * i.quantity, 0),
  );
  const custo_envio = arredondar(payload.custo_envio ?? 0);
  const valor_liquido = arredondar(valor_bruto - tarifa_venda - custo_envio);

  // Percentual efetivo (calculado), não a alíquota nominal da categoria: pode
  // divergir da segunda casa do que o painel do ML exibe.
  const tarifa_percentual =
    valor_bruto === 0 ? null : arredondar((tarifa_venda / valor_bruto) * 100);

  return {
    marketplace: "mercado_livre",
    valor_bruto,
    tarifa_venda,
    tarifa_percentual,
    custo_envio,
    valor_liquido,
    final: payload.shipment_status === "delivered",
  };
}

// Concatena os dois buckets da rotação do cron respeitando o orçamento. Os
// "nunca verificados" vêm primeiro; o retry só ocupa o que sobrar.
export function montarCandidatosRepasse<T>(
  nuncaVerificados: T[],
  retry: T[],
  orcamento: number,
): T[] {
  return [...nuncaVerificados, ...retry].slice(0, orcamento);
}
```

- [ ] **Step 4: Rode o teste e confirme que passa**

```bash
node --test test/repasse.test.mjs
```

Esperado: PASS — 6 testes, 0 falhas.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repasse.ts test/repasse.test.mjs
git commit -m "feat(repasse): modulo puro de normalizacao do repasse ML"
```

---

### Task 2: Migration das colunas de repasse

**Files:**
- Create: `supabase/migrations/20260902120000_repasse-marketplace.sql`

- [ ] **Step 1: Escreva a migration**

Crie `supabase/migrations/20260902120000_repasse-marketplace.sql`:

```sql
-- Repasse do marketplace: valores que o Bling não fornece (campo `taxas` chega
-- zerado em 100% dos pedidos) e que vêm da API do Mercado Livre.
-- Colunas separadas em vez de JSONB porque o objetivo declarado inclui somar
-- esses valores por período depois.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS repasse_valor_bruto       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_tarifa_venda      NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_tarifa_percentual NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS repasse_custo_envio       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_valor_liquido     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_checked_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repasse_final             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS repasse_error             TEXT;

-- Índice da rotação do cron: só pedidos ainda não congelados entram na fila, e
-- a ordenação é por quem está há mais tempo sem checagem (nulos primeiro).
CREATE INDEX IF NOT EXISTS idx_pedidos_repasse_pendente
  ON public.pedidos (repasse_checked_at NULLS FIRST)
  WHERE repasse_final = false;
```

- [ ] **Step 2: Aplique a migration**

Aplique via MCP do Supabase (`apply_migration`, projeto `faukznejkvdzmgualsnj`, nome
`repasse-marketplace`) ou `supabase db push`, conforme o fluxo em uso.

- [ ] **Step 3: Verifique que as colunas existem**

Rode no banco:

```sql
select column_name, data_type
from information_schema.columns
where table_name = 'pedidos' and column_name like 'repasse%'
order by column_name;
```

Esperado: 8 linhas — `repasse_checked_at`, `repasse_custo_envio`, `repasse_error`,
`repasse_final`, `repasse_tarifa_percentual`, `repasse_tarifa_venda`,
`repasse_valor_bruto`, `repasse_valor_liquido`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260902120000_repasse-marketplace.sql
git commit -m "feat(repasse): colunas repasse_* em pedidos"
```

---

### Task 3: Edge function `ml-order-billing`

**Files:**
- Create: `supabase/functions/ml-order-billing/index.ts`

Esta função é o único ponto que fala com a API do ML. Ela devolve dados **crus e
agregados** (itens + custo de envio); o cálculo fica no módulo puro da Task 1.

- [ ] **Step 1: Escreva a edge function**

Crie `supabase/functions/ml-order-billing/index.ts`:

```typescript
// Proxy para buscar o repasse financeiro de um pedido no ML.
// Cloudflare Workers não alcança api.mercadolibre.com diretamente (erro 1016/530).
// Molde idêntico a ml-shipment-status.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface BillingInput {
  ml_order_id: string;
  access_token: string;
}

interface ItemBilling {
  unit_price: number;
  quantity: number;
  sale_fee: number;
}

export interface BillingPayload {
  ok: boolean;
  order_items?: ItemBilling[];
  custo_envio?: number;
  shipment_status?: string | null;
  error?: string;
}

const ML_HOST = "https://api.mercadolibre.com";

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "EXPEDE/1.0 (expede.lovable.app)",
  };
}

function extrairItens(order: any): ItemBilling[] {
  return (order?.order_items ?? []).map((i: any) => ({
    unit_price: Number(i?.unit_price ?? 0),
    quantity: Number(i?.quantity ?? 0),
    sale_fee: Number(i?.sale_fee ?? 0),
  }));
}

// Custo que o VENDEDOR paga pelo envio: senders[0].cost de /shipments/{id}/costs.
// Não confundir com receiver.cost, que é o que o comprador pagou.
async function buscarCustoEnvio(
  shipmentId: number | null,
  token: string,
): Promise<{ custo: number; status: string | null }> {
  if (!shipmentId) return { custo: 0, status: null };

  const rShip = await fetch(`${ML_HOST}/shipments/${shipmentId}`, {
    headers: baseHeaders(token),
  });
  const status = rShip.ok ? ((await rShip.json())?.status ?? null) : null;

  const rCost = await fetch(`${ML_HOST}/shipments/${shipmentId}/costs`, {
    headers: baseHeaders(token),
  });

  if (!rCost.ok) {
    console.log(`[ml-order-billing] costs shipment=${shipmentId} -> ${rCost.status}`);
    return { custo: 0, status };
  }

  const costs: any = await rCost.json();
  const custo = Number(costs?.senders?.[0]?.cost ?? 0);
  return { custo, status };
}

async function resolveBilling(mlOrderId: string, token: string): Promise<BillingPayload> {
  const r1 = await fetch(`${ML_HOST}/orders/${mlOrderId}`, { headers: baseHeaders(token) });

  if (r1.ok) {
    const order: any = await r1.json();
    const { custo, status } = await buscarCustoEnvio(order?.shipping?.id ?? null, token);
    console.log(
      `[ml-order-billing] order=${mlOrderId} itens=${order?.order_items?.length ?? 0} frete=${custo} status=${status}`,
    );
    return {
      ok: true,
      order_items: extrairItens(order),
      custo_envio: custo,
      shipment_status: status,
    };
  }

  if (r1.status !== 404) {
    return { ok: false, error: `orders_error:${r1.status}` };
  }

  // Carrinho/pack: soma os itens de todos os pedidos, mas o frete é UM só —
  // por isso ele é buscado fora do laço, pelo shipping do pack.
  console.log(`[ml-order-billing] /orders/${mlOrderId} -> 404, tentando /packs`);
  const rPack = await fetch(`${ML_HOST}/packs/${mlOrderId}`, { headers: baseHeaders(token) });

  if (!rPack.ok) {
    return { ok: false, error: `pack_not_found:${rPack.status}` };
  }

  const pack: any = await rPack.json();
  const orders: any[] = pack?.orders ?? [];
  if (orders.length === 0) {
    return { ok: false, error: "pack_sem_orders" };
  }

  const itens: ItemBilling[] = [];
  let shipmentId: number | null = pack?.shipment?.id ?? null;

  for (const ref of orders) {
    const rOrder = await fetch(`${ML_HOST}/orders/${ref.id}`, { headers: baseHeaders(token) });
    if (!rOrder.ok) {
      return { ok: false, error: `pack_order_error:${ref.id}:${rOrder.status}` };
    }
    const order: any = await rOrder.json();
    itens.push(...extrairItens(order));
    if (!shipmentId) shipmentId = order?.shipping?.id ?? null;
  }

  const { custo, status } = await buscarCustoEnvio(shipmentId, token);
  console.log(
    `[ml-order-billing] pack=${mlOrderId} orders=${orders.length} itens=${itens.length} frete=${custo}`,
  );

  return { ok: true, order_items: itens, custo_envio: custo, shipment_status: status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let input: BillingInput;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!input.ml_order_id || !input.access_token) {
    return new Response(JSON.stringify({ ok: false, error: "missing_fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const result = await resolveBilling(input.ml_order_id, input.access_token);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[ml-order-billing] erro:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

- [ ] **Step 2: Faça o deploy da função**

Use o MCP do Supabase (`deploy_edge_function`, projeto `faukznejkvdzmgualsnj`,
nome `ml-order-billing`) ou `supabase functions deploy ml-order-billing`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ml-order-billing/index.ts
git commit -m "feat(repasse): edge function ml-order-billing"
```

---

### Task 4: Camada de I/O do repasse

**Files:**
- Create: `src/lib/repasse.functions.ts`

Uma única função (`atualizarRepassePedido`) é usada pelo cron **e** pelo backfill —
os dois caminhos não podem divergir.

- [ ] **Step 1: Escreva o módulo**

Crie `src/lib/repasse.functions.ts`:

```typescript
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMLAccessToken } from "@/lib/ml.functions";
import { normalizarRepasseMl, montarCandidatosRepasse } from "@/lib/repasse";

export const MAX_CANDIDATOS_REPASSE = 4;

export type CandidatoRepasse = {
  id: string;
  bling_pedido_id: number;
  numero_loja: string | null;
};

type BillingResponse = {
  ok: boolean;
  order_items?: Array<{ unit_price: number; quantity: number; sale_fee: number }>;
  custo_envio?: number;
  shipment_status?: string | null;
  error?: string;
};

// Busca o repasse na edge function. Mesmo contrato { ok: false, error } que
// checarStatusEnvioML usa: falha aqui nunca lança pra cima.
async function buscarRepasseML(mlOrderId: string): Promise<BillingResponse> {
  let token: string;
  try {
    token = await getMLAccessToken();
  } catch {
    return { ok: false, error: "ml_no_connection" };
  }

  try {
    const { data, error } = await supabaseAdmin.functions.invoke<BillingResponse>(
      "ml-order-billing",
      { body: { ml_order_id: mlOrderId, access_token: token } },
    );
    if (error) return { ok: false, error: `edge_invoke:${error.message}` };
    if (!data) return { ok: false, error: "edge_empty_response" };
    return data;
  } catch (e) {
    return { ok: false, error: `edge_invoke_exception:${String(e)}` };
  }
}

export type ResultadoAtualizacao =
  | { ok: true; liquido: number; final: boolean }
  | { ok: false; error: string };

// Busca, normaliza e grava o repasse de um pedido. repasse_checked_at sempre
// avança, tenha dado certo ou não — senão um pedido problemático monopoliza os
// slots da rotação pra sempre (mesma razão documentada em
// atualizarSituacoesExistentes).
export async function atualizarRepassePedido(
  pedido: CandidatoRepasse,
): Promise<ResultadoAtualizacao> {
  const agora = new Date().toISOString();

  if (!pedido.numero_loja) {
    await supabaseAdmin
      .from("pedidos")
      .update({ repasse_checked_at: agora, repasse_error: "sem_numero_loja" } as any)
      .eq("id", pedido.id);
    return { ok: false, error: "sem_numero_loja" };
  }

  const resp = await buscarRepasseML(pedido.numero_loja);

  if (!resp.ok) {
    await supabaseAdmin
      .from("pedidos")
      .update({ repasse_checked_at: agora, repasse_error: resp.error ?? "erro_desconhecido" } as any)
      .eq("id", pedido.id);
    return { ok: false, error: resp.error ?? "erro_desconhecido" };
  }

  const repasse = normalizarRepasseMl({
    order_items: resp.order_items ?? [],
    custo_envio: resp.custo_envio ?? 0,
    shipment_status: resp.shipment_status ?? null,
  });

  await supabaseAdmin
    .from("pedidos")
    .update({
      repasse_valor_bruto: repasse.valor_bruto,
      repasse_tarifa_venda: repasse.tarifa_venda,
      repasse_tarifa_percentual: repasse.tarifa_percentual,
      repasse_custo_envio: repasse.custo_envio,
      repasse_valor_liquido: repasse.valor_liquido,
      repasse_final: repasse.final,
      repasse_checked_at: agora,
      repasse_error: null,
    } as any)
    .eq("id", pedido.id);

  return { ok: true, liquido: repasse.valor_liquido, final: repasse.final };
}

// Rotação em dois buckets, igual a cronMLStatus: "nunca verificados" têm
// prioridade (mais antigos primeiro); "retry" só ocupa os slots que sobrarem,
// ordenado por quem está há mais tempo sem checagem.
export async function selecionarCandidatosRepasse(
  orcamento: number = MAX_CANDIDATOS_REPASSE,
): Promise<CandidatoRepasse[]> {
  const baseQuery = () =>
    supabaseAdmin
      .from("pedidos")
      .select("id, bling_pedido_id, numero_loja")
      .eq("marketplace", "mercadolivre")
      .eq("repasse_final", false)
      .neq("situacao_id", 12)
      .not("numero_loja", "is", null);

  const { data: nuncaVerificados, error: erro1 } = (await baseQuery()
    .is("repasse_checked_at", null)
    .order("data_pedido", { ascending: false, nullsFirst: false })
    .limit(orcamento)) as any;

  if (erro1) {
    console.error("[repasse] select nunca-verificados falhou:", erro1.message);
    return [];
  }

  const slotsRestantes = orcamento - (nuncaVerificados?.length ?? 0);
  let retry: CandidatoRepasse[] = [];

  if (slotsRestantes > 0) {
    const { data: retryData, error: erro2 } = (await baseQuery()
      .not("repasse_checked_at", "is", null)
      .order("repasse_checked_at", { ascending: true })
      .limit(slotsRestantes)) as any;

    if (erro2) {
      console.error("[repasse] select retry falhou:", erro2.message);
    } else {
      retry = retryData ?? [];
    }
  }

  return montarCandidatosRepasse(nuncaVerificados ?? [], retry, orcamento);
}

export type ResultadoBackfill = {
  processados: number;
  ok: number;
  erros: Array<{ bling_pedido_id: number; error: string }>;
  restantes: number;
};

// Backfill único do histórico. Idempotente: só pega pedidos com
// repasse_checked_at nulo, então rodar de novo não reprocessa o que já tem dado.
// Chamada em lotes pra caber no limite de subrequests do Worker.
export async function backfillRepasseMl(limite: number = 40): Promise<ResultadoBackfill> {
  const { data, error } = (await supabaseAdmin
    .from("pedidos")
    .select("id, bling_pedido_id, numero_loja")
    .eq("marketplace", "mercadolivre")
    .is("repasse_checked_at", null)
    .neq("situacao_id", 12)
    .not("numero_loja", "is", null)
    .order("data_pedido", { ascending: false, nullsFirst: false })
    .limit(limite)) as any;

  if (error) throw new Error(`select backfill falhou: ${error.message}`);

  const pedidos: CandidatoRepasse[] = data ?? [];
  const erros: Array<{ bling_pedido_id: number; error: string }> = [];
  let ok = 0;

  for (const pedido of pedidos) {
    const res = await atualizarRepassePedido(pedido);
    if (res.ok) ok += 1;
    else erros.push({ bling_pedido_id: pedido.bling_pedido_id, error: res.error });
  }

  const { count } = (await supabaseAdmin
    .from("pedidos")
    .select("id", { count: "exact", head: true })
    .eq("marketplace", "mercadolivre")
    .is("repasse_checked_at", null)
    .neq("situacao_id", 12)
    .not("numero_loja", "is", null)) as any;

  console.log(`[backfill-repasse] ${ok}/${pedidos.length} ok, ${count ?? 0} restantes`);

  return { processados: pedidos.length, ok, erros, restantes: count ?? 0 };
}
```

- [ ] **Step 2: Confirme que compila**

```bash
npx tsc --noEmit -p tsconfig.json
```

Esperado: sem erros apontando para `src/lib/repasse.functions.ts`. (Erros
pré-existentes em outros arquivos, se houver, não são desta tarefa.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/repasse.functions.ts
git commit -m "feat(repasse): camada de I/O compartilhada por cron e backfill"
```

---

### Task 5: Cron `cronRepasseMl`

**Files:**
- Modify: `src/server.ts`
- Modify: `plugins/cloudflare-scheduled.ts`

- [ ] **Step 1: Adicione o cron em `src/server.ts`**

Junto das outras constantes de gate no topo do arquivo (perto de
`ML_STATUS_INTERVAL_MS`, linha ~79), acrescente:

```typescript
let lastRepasseAt = 0;
const REPASSE_INTERVAL_MS = 5 * 60 * 1000; // 5 min — mesmo ritmo do cron de status ML
```

Adicione o import junto dos demais imports de `@/lib`:

```typescript
import {
  atualizarRepassePedido,
  selecionarCandidatosRepasse,
} from "@/lib/repasse.functions";
```

E adicione a função, ao lado de `cronMLStatus`:

```typescript
// Busca o repasse financeiro (tarifa de venda, custo de envio) na API do ML.
// O Bling não fornece esses valores — seu campo `taxas` chega zerado.
// Gate de 5 min + orçamento de 4 pedidos por execução: com ~15 pedidos/dia isso
// é folgado, e pedidos entregues saem da rotação (repasse_final), então o custo
// não cresce com o histórico.
export async function cronRepasseMl() {
  const now = Date.now();

  try {
    if (now - lastRepasseAt < REPASSE_INTERVAL_MS) return;

    const db = supabaseAdmin as any;
    const { data: state } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "repasse_ml")
      .maybeSingle();

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    if (now - lastRun < REPASSE_INTERVAL_MS) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert(
        { job_name: "repasse_ml", last_run_at: new Date(now).toISOString() },
        { onConflict: "job_name" },
      );

    if (upsertError) {
      console.error("[cron-repasse] upsert cron_state falhou", { message: upsertError.message });
      return;
    }

    lastRepasseAt = now;

    const candidatos = await selecionarCandidatosRepasse();
    console.log(`[cron-repasse] ${candidatos.length} candidato(s)`);

    for (const pedido of candidatos) {
      const res = await atualizarRepassePedido(pedido);
      if (res.ok) {
        console.log(
          `[cron-repasse] pedido ${pedido.bling_pedido_id} liquido=${res.liquido} final=${res.final}`,
        );
      } else {
        console.warn(`[cron-repasse] pedido ${pedido.bling_pedido_id} erro: ${res.error}`);
      }
    }

    console.log("[cron-repasse] ciclo concluído");
  } catch (e) {
    console.error("[cron-repasse] exceção não tratada", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
```

- [ ] **Step 2: Registre o cron em `plugins/cloudflare-scheduled.ts`**

Este é o registro **real** — o `scheduled` exportado em `src/server.ts` é código morto.

Altere o import:

```typescript
import { cronReconciliar, cronSyncPoll, cronMLStatus, cronNfStatus, cronNfEmissao, cronRepasseMl } from "../src/server";
```

E acrescente a entrada ao final da lista `tarefas` (por último: é o menos crítico,
e as tarefas rodam serializadas):

```typescript
      ["cron-repasse", cronRepasseMl],
```

- [ ] **Step 3: Confirme que compila**

```bash
npx tsc --noEmit -p tsconfig.json
```

Esperado: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts plugins/cloudflare-scheduled.ts
git commit -m "feat(repasse): cron que busca o repasse ML com rotacao"
```

---

### Task 6: Expor as colunas na listagem

**Files:**
- Modify: `src/lib/pedidos.functions.ts:35-53` (tipo `PedidoRow`), `src/lib/pedidos.functions.ts:78` (o `select`)

O modal não faz consulta própria: ele lê o que `listarPedidos` já trouxe.

- [ ] **Step 1: Acrescente os campos ao tipo `PedidoRow`**

Em `src/lib/pedidos.functions.ts`, dentro de `export type PedidoRow`, depois de
`bling_divergente: boolean;`, adicione:

```typescript
  marketplace: string | null;
  repasse_valor_bruto: number | null;
  repasse_tarifa_venda: number | null;
  repasse_tarifa_percentual: number | null;
  repasse_custo_envio: number | null;
  repasse_valor_liquido: number | null;
  repasse_checked_at: string | null;
  repasse_final: boolean;
  repasse_error: string | null;
```

- [ ] **Step 2: Acrescente as colunas ao `select` de `listarPedidos`**

Na string do `.select(...)`, acrescente antes de `pedido_itens(count)`:

```
marketplace, repasse_valor_bruto, repasse_tarifa_venda, repasse_tarifa_percentual, repasse_custo_envio, repasse_valor_liquido, repasse_checked_at, repasse_final, repasse_error, 
```

- [ ] **Step 3: Confirme que compila**

```bash
npx tsc --noEmit -p tsconfig.json
```

Esperado: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/lib/pedidos.functions.ts
git commit -m "feat(repasse): expoe colunas de repasse na listagem de pedidos"
```

---

### Task 7: Modal `RepasseDialog`

**Files:**
- Create: `src/components/RepasseDialog.tsx`
- Modify: `src/routes/_app/pedidos.tsx`

- [ ] **Step 1: Crie o componente**

Crie `src/components/RepasseDialog.tsx`:

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PedidoRow } from "@/lib/pedidos.functions";

function formatBRL(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  // Brasília = UTC-3: subtrai 3h manualmente para compatibilidade com CF Workers
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hour}:${min}`;
}

function Linha({ label, valor, negativo }: { label: string; valor: string; negativo?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`tabular-nums text-sm ${negativo ? "text-red-600" : ""}`}>{valor}</span>
    </div>
  );
}

export function RepasseDialog({
  pedido,
  onClose,
}: {
  pedido: PedidoRow | null;
  onClose: () => void;
}) {
  const aberto = pedido !== null;

  function corpo() {
    if (!pedido) return null;

    if (pedido.marketplace !== "mercadolivre") {
      return (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Repasse indisponível para este marketplace.
        </p>
      );
    }

    if (pedido.repasse_checked_at === null) {
      return (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Aguardando sincronização com o Mercado Livre.
        </p>
      );
    }

    if (pedido.repasse_error) {
      return (
        <div className="py-6 text-center space-y-1">
          <p className="text-sm text-red-600">Não foi possível buscar o repasse.</p>
          <p className="text-xs text-muted-foreground font-mono">{pedido.repasse_error}</p>
        </div>
      );
    }

    const percentual =
      pedido.repasse_tarifa_percentual === null
        ? ""
        : ` (${pedido.repasse_tarifa_percentual.toString().replace(".", ",")}%)`;

    return (
      <div className="space-y-1">
        <Linha label="Valor da venda" valor={formatBRL(pedido.repasse_valor_bruto)} />
        <Linha
          label={`Tarifa de venda total${percentual}`}
          valor={`- ${formatBRL(pedido.repasse_tarifa_venda)}`}
          negativo
        />
        <Linha
          label="Custo do envio"
          valor={`- ${formatBRL(pedido.repasse_custo_envio)}`}
          negativo
        />
        <div className="flex items-baseline justify-between pt-3 mt-2 border-t-2">
          <span className="font-medium">Total</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatBRL(pedido.repasse_valor_liquido)}
          </span>
        </div>

        {!pedido.repasse_final && (
          <p className="text-xs text-muted-foreground pt-3">
            O envio ainda não foi entregue — estes valores podem mudar.
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-1">
          Atualizado em {formatDateTime(pedido.repasse_checked_at)}
        </p>
      </div>
    );
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repasse do marketplace</DialogTitle>
          <DialogDescription>
            Pedido {pedido?.numero}
            {pedido?.numero_loja && pedido.numero_loja !== pedido.numero
              ? ` · ${pedido.numero_loja}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {corpo()}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Ligue o modal na tela de pedidos**

Em `src/routes/_app/pedidos.tsx`, adicione o import junto dos outros de
`@/components`:

```tsx
import { RepasseDialog } from "@/components/RepasseDialog";
```

Dentro de `function PedidosPage()`, junto dos outros `useState`, adicione:

```tsx
  const [repassePedido, setRepassePedido] = useState<PedidoRow | null>(null);
```

Isso exige o tipo; acrescente `type PedidoRow` ao import existente de
`@/lib/pedidos.functions`:

```tsx
import { listarPedidos, buscarNumeroNF, type PedidoRow } from "@/lib/pedidos.functions";
```

Substitua o conteúdo da primeira `<td>` da linha (o bloco que hoje renderiza
`{row.numero}` seguido do badge de `numero_loja`) por:

```tsx
                    <td className="px-4 py-3 font-mono">
                      <button
                        type="button"
                        onClick={() => setRepassePedido(row)}
                        className="hover:underline underline-offset-2 text-left"
                        title="Ver repasse do marketplace"
                      >
                        {row.numero}
                      </button>
                      {row.numero_loja && row.numero_loja !== row.numero && (
                        <span className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {row.numero_loja}
                        </span>
                      )}
                    </td>
```

E, logo antes de `<PrinterConfig ... />` no final do componente, adicione:

```tsx
      <RepasseDialog pedido={repassePedido} onClose={() => setRepassePedido(null)} />
```

- [ ] **Step 3: Verifique no navegador**

```bash
npm run dev
```

Abra a tela de pedidos, clique no número de um pedido. Como o backfill ainda não
rodou, o esperado é o estado **"Aguardando sincronização com o Mercado Livre"**
para pedidos ML e **"Repasse indisponível para este marketplace"** para os Shopee.

- [ ] **Step 4: Commit**

```bash
git add src/components/RepasseDialog.tsx src/routes/_app/pedidos.tsx
git commit -m "feat(repasse): modal de repasse ao clicar no numero do pedido"
```

---

### Task 8: Rota admin de backfill

**Files:**
- Create: `src/routes/api/admin/backfill-repasse.ts`

- [ ] **Step 1: Crie a rota**

Molde idêntico a `src/routes/api/admin/reconciliar.ts`. Crie
`src/routes/api/admin/backfill-repasse.ts`:

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { backfillRepasseMl } from "@/lib/repasse.functions";

export const Route = createFileRoute("/api/admin/backfill-repasse")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const limiteParam = Number(url.searchParams.get("limite") ?? "40");
        const limite = Number.isFinite(limiteParam) && limiteParam > 0
          ? Math.min(limiteParam, 100)
          : 40;

        try {
          const resultado = await backfillRepasseMl(limite);
          return Response.json({ ok: true, resultado });
        } catch (err) {
          console.error("[backfill-repasse] erro:", err);
          return Response.json(
            { ok: false, error: String(err instanceof Error ? err.message : err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
```

- [ ] **Step 2: Confirme que compila e que a rota foi gerada**

```bash
npx tsc --noEmit -p tsconfig.json
```

Esperado: sem erros novos. (A rota entra em `src/routeTree.gen.ts` no próximo
`npm run dev` ou `npm run build` — não edite esse arquivo à mão.)

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/admin/backfill-repasse.ts src/routeTree.gen.ts
git commit -m "feat(repasse): rota admin de backfill do historico"
```

---

### Task 9: Verificação end-to-end

**Files:** nenhum — é verificação contra o sistema real.

- [ ] **Step 1: Rode a suíte de testes e o lint**

```bash
node --test test/ && npm run lint
```

Esperado: todos os testes passam; lint sem erros novos.

- [ ] **Step 2: Faça o deploy**

Deploy pelo fluxo normal do projeto (o `main.yml` do GitHub Actions). Confirme que
a edge function `ml-order-billing` também está publicada (Task 3, Step 2).

- [ ] **Step 3: Rode o backfill em lotes**

Com `ADMIN_KEY` do ambiente:

```bash
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" "https://babyworld.expede.workers.dev/api/admin/backfill-repasse?limite=40"
```

Esperado: `{"ok":true,"resultado":{"processados":40,"ok":40,"erros":[],"restantes":151}}`.
Repita até `restantes` chegar a 0 — são 191 pedidos ML, cerca de 5 chamadas.

- [ ] **Step 4: Confira os números contra o painel do ML**

```sql
select numero, numero_loja, total, repasse_valor_bruto,
       repasse_tarifa_venda, repasse_tarifa_percentual,
       repasse_custo_envio, repasse_valor_liquido, repasse_final
from pedidos
where marketplace = 'mercadolivre' and repasse_checked_at is not null
order by data_pedido desc limit 5;
```

Abra um desses pedidos no painel do Mercado Livre e confira os quatro valores.
Devem bater. Verifique também que
`repasse_valor_bruto = repasse_tarifa_venda + repasse_custo_envio + repasse_valor_liquido`.

Se `repasse_valor_bruto` divergir de `total`, é esperado e não é bug: `total` vem do
Bling (pode incluir desconto ou frete cobrado do comprador) e o bruto vem dos itens do
ML. O modal exibe o bruto do ML justamente para a conta fechar na tela.

- [ ] **Step 5: Verifique os filtros de candidato do cron**

Estes filtros vivem na query do Supabase (não no módulo puro), então são
verificados aqui:

```sql
select
  count(*) filter (where marketplace = 'shopee' and repasse_checked_at is not null) as shopee_indevido,
  count(*) filter (where situacao_id = 12 and repasse_checked_at is not null) as cancelado_indevido,
  count(*) filter (where repasse_final and ml_shipment_status <> 'delivered') as congelado_indevido
from pedidos;
```

Esperado: `0, 0, 0`.

- [ ] **Step 6: Verifique o modal no ar**

Abra a tela de pedidos em produção e clique no número de um pedido ML: os cinco
valores aparecem. Clique num pedido Shopee: aparece "Repasse indisponível para
este marketplace". Confirme na aba Network que **nenhuma** requisição sai para o
ML ao abrir o modal.

- [ ] **Step 7: Verifique o cron nos logs**

Nos logs do Worker, procure `[cron-repasse]`. Esperado: uma execução a cada ~5 min,
com `0 candidato(s)` depois que o backfill zerou a fila e os pedidos novos forem
processados. Confirme que nenhum outro cron passou a falhar.

- [ ] **Step 8: Atualize a documentação da sessão**

Conforme `CLAUDE.md`, atualize `AGENT-CONTEXT/SESSION-HANDOFF.md` no Obsidian
(e `CURRENT-STATE.md` se couber) com a entrega do repasse e a fase 2 pendente
(Shopee via `normalizarRepasseShopee`).

- [ ] **Step 9: Commit final**

```bash
git add -A
git commit -m "chore(repasse): verificacao end-to-end concluida"
```

---

## Notas de decisão registradas

- **O modal exibe `repasse_valor_bruto` (soma dos itens do ML), não `total` (Bling).**
  Os dois podem divergir; usar o bruto do ML é o que garante que
  bruto − tarifa − envio = líquido feche na tela.
- **Percentual é efetivo, não nominal.** Calculamos `tarifa ÷ bruto`, então pode
  divergir na segunda casa do que o painel mostra (16,51% vs "16,5%"). É o número
  correto para o pedido específico.
- **Frete do pack conta uma vez.** Garantido pelo formato de saída da edge function
  (um único `custo_envio`), não por lógica de deduplicação no cliente.
- **`repasse_checked_at` avança mesmo em erro.** Sem isso, um pedido problemático
  monopoliza os slots da rotação pra sempre — lição já documentada no projeto.
- **Estornos e devoluções pós-entrega não são capturados.** Consequência aceita do
  congelamento em `delivered`.
