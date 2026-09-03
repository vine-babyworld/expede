# Repasse do marketplace — fase 2 (Shopee) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o modal de repasse funcionar para os 42 pedidos Shopee, exibindo a quebra de tarifas e o líquido oficial (`escrow_amount`) da Escrow API, sem alterar o comportamento do modal do Mercado Livre.

**Architecture:** A camada normalizada da fase 1 (`src/lib/repasse.ts`) ganha `normalizarRepasseShopee`, devolvendo o mesmo `RepasseMarketplace` — agora com quebra de linhas rotuladas e líquido informado pelo marketplace. A busca vai direto do Worker pelo gateway de IP fixo que já existe (`shopee-egress.bwbaby.com.br`), **sem edge function**. Um `cronRepasseShopee` irmão do `cronRepasseMl` preenche as colunas `repasse_*`, e o `RepasseDialog` continua leitura pura.

**Tech Stack:** TypeScript 5.8, TanStack Start, Supabase (Postgres), Cloudflare Workers, Node test runner (`.mjs`, sem rede), Shopee Open API v2 (`payment/get_escrow_detail` + `order/get_order_detail`).

**Spec:** `docs/superpowers/specs/2026-09-03-repasse-shopee-fase-2-design.md`

**Worktree:** `.claude/worktrees/repasse-shopee-fase-2`, branch `feat/repasse-shopee-fase-2`. Todo trabalho acontece aqui. **Nunca deployar desta worktree** — ela não tem `.env` e o bundle sairia sem as `VITE_SUPABASE_*` (Lição #26).

**Baseline medido antes de começar (03/09/2026):**
- `node --test test/*.test.mjs` → 16/16 passando
- `npx tsc --noEmit` → **exatamente 1 erro**: `src/lib/shopee.ts(458,79)`. Qualquer erro além desse é regressão.
- `npm run lint` **não** é critério (51.550 problemas pré-existentes de CRLF). Avaliar por arquivo.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/repasse.ts` | Lógica pura de normalização, sem I/O. Ganha o tipo estendido e `normalizarRepasseShopee` | Modificar |
| `src/lib/shopee.ts` | Rede autenticada com a Shopee. Ganha `buscarRepasseShopee` | Modificar |
| `src/lib/repasse.functions.ts` | Camada de I/O: despacho por marketplace, seleção de candidatos, gravação, backfill | Modificar |
| `src/server.ts` | `cronRepasseShopee` | Modificar |
| `plugins/cloudflare-scheduled.ts` | Registro do cron novo | Modificar |
| `src/routes/api/admin/backfill-repasse.ts` | Backfill parametrizado por marketplace | Modificar |
| `src/lib/pedidos.functions.ts` | `PedidoRow` + `select` de `listarPedidos` | Modificar |
| `src/integrations/supabase/types.ts` | Row/Insert/Update das colunas novas | Modificar |
| `src/components/RepasseDialog.tsx` | Quebra de linhas, rótulos por marketplace, aviso de divergência | Modificar |
| `supabase/migrations/20260903120000_repasse-shopee.sql` | Colunas novas + índice | Criar |
| `test/repasse.test.mjs` | Testes da normalização | Modificar |

`shopeeFetch` permanece **privado** em `src/lib/shopee.ts`. Não exportar — abriria o caminho de rede autenticado para o resto do código.

---

### Task 1: Estender `RepasseMarketplace` sem quebrar o Mercado Livre

**Files:**
- Modify: `src/lib/repasse.ts`
- Test: `test/repasse.test.mjs`

- [ ] **Step 1: Escrever o teste de não-regressão do ML (falha)**

Acrescentar ao final de `test/repasse.test.mjs`:

```js
test("normalizarRepasseMl devolve uma linha unica e sem liquido informado", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 31.2, quantity: 1, sale_fee: 5.15 }],
    custo_envio: 6.95,
    shipment_status: "shipped",
  });

  assert.deepEqual(r.linhas, [{ chave: "sale_fee", rotulo: "Tarifa de venda", valor: 5.15 }]);
  assert.equal(r.liquido_informado, null);
  assert.equal(r.envio_coberto_pelo_marketplace, false);
  assert.equal(r.divergencia, null);
  assert.equal(r.valor_liquido, 19.1);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --test test/*.test.mjs`
Expected: FAIL — `r.linhas` é `undefined`. Os outros 16 continuam passando.

> ⚠️ `node --test test/` (com o diretório) **falha no Windows** — o Node interpreta o diretório como módulo. Sempre usar o glob `test/*.test.mjs`.

- [ ] **Step 3: Estender o tipo e o normalizador do ML**

Em `src/lib/repasse.ts`, substituir o bloco do tipo `RepasseMarketplace` por:

```ts
// Uma linha da quebra de tarifas. `chave` é o campo de origem na API do
// marketplace — mantida para rastreabilidade quando um valor for contestado.
export type LinhaRepasse = {
  chave: string;
  rotulo: string;
  valor: number;
};

// Formato normalizado de repasse do marketplace. Único tipo que a UI e o banco
// conhecem. O ML devolve uma linha só; a Shopee devolve até seis.
export type RepasseMarketplace = {
  marketplace: "mercado_livre" | "shopee";
  valor_bruto: number;
  tarifa_venda: number;
  tarifa_percentual: number | null;
  custo_envio: number;
  valor_liquido: number;
  final: boolean;
  linhas: LinhaRepasse[];
  // Líquido informado pelo próprio marketplace. A Shopee fornece (escrow_amount);
  // o ML não tem equivalente, então é null e o líquido é o que nós calculamos.
  liquido_informado: number | null;
  envio_coberto_pelo_marketplace: boolean;
  // (bruto − tarifa − envio) − liquido_informado. Auto-conferência: diferente de
  // zero significa que existe uma linha de taxa que não estamos somando.
  divergencia: number | null;
};
```

E, dentro de `normalizarRepasseMl`, substituir o `return` por:

```ts
  return {
    marketplace: "mercado_livre",
    valor_bruto,
    tarifa_venda,
    tarifa_percentual,
    custo_envio,
    valor_liquido,
    final: payload.shipment_status === "delivered",
    linhas: [{ chave: "sale_fee", rotulo: "Tarifa de venda", valor: tarifa_venda }],
    liquido_informado: null,
    envio_coberto_pelo_marketplace: false,
    divergencia: null,
  };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --test test/*.test.mjs`
Expected: PASS — 17/17.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repasse.ts test/repasse.test.mjs
git commit -m "feat(repasse): estende RepasseMarketplace com quebra de linhas e liquido informado"
```

---

### Task 2: `normalizarRepasseShopee`

**Files:**
- Modify: `src/lib/repasse.ts`
- Test: `test/repasse.test.mjs`

Os três primeiros testes usam **números reais medidos em 03/09/2026** contra a Escrow API de produção. Não alterar os valores: eles são a evidência.

- [ ] **Step 1: Escrever os testes (falham)**

Acrescentar ao final de `test/repasse.test.mjs`, e ajustar o import do topo para:

```js
import { normalizarRepasseMl, normalizarRepasseShopee, montarCandidatosRepasse } from "../src/lib/repasse.ts";
```

```js
// Pedido 9080 / 260831SN9WNUGC — caso comum: frete coberto, sem comissao AMS.
test("normalizarRepasseShopee reconcilia o pedido 9080", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 393,
      commission_fee: 46.92,
      service_fee: 33.82,
      ads_escrow_top_up_fee_or_technical_support_fee: 7.82,
      voucher_from_seller: 1.97,
      shipping_seller_protection_fee_amount: 0.49,
      actual_shipping_fee: 112.59,
      buyer_paid_shipping_fee: 72.59,
      shopee_shipping_rebate: 40,
      escrow_amount: 301.98,
      escrow_amount_after_adjustment: 301.98,
      total_adjustment_amount: 0,
    },
    order_status: "SHIPPED",
  });

  assert.equal(r.marketplace, "shopee");
  assert.equal(r.valor_bruto, 393);
  assert.equal(r.tarifa_venda, 91.02);
  assert.equal(r.tarifa_percentual, 23.16);
  assert.equal(r.custo_envio, 0);
  assert.equal(r.valor_liquido, 301.98);
  assert.equal(r.liquido_informado, 301.98);
  assert.equal(r.divergencia, 0);
  assert.equal(r.envio_coberto_pelo_marketplace, true);
  assert.equal(r.final, false);
  assert.equal(r.linhas.length, 5);
});

// Pedido 8912 / 260818MK0GET5H — um dos 5 (de 42) com order_ams_commission_fee.
// Foi este campo que produziu divergencia na primeira medicao; sem ele a conta
// erra por R$ 10,08.
test("normalizarRepasseShopee soma order_ams_commission_fee (pedido 8912)", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 214,
      commission_fee: 25.44,
      service_fee: 31.65,
      ads_escrow_top_up_fee_or_technical_support_fee: 4.24,
      order_ams_commission_fee: 10.08,
      voucher_from_seller: 1.97,
      shipping_seller_protection_fee_amount: 0.49,
      actual_shipping_fee: 33.59,
      shopee_shipping_rebate: 33.59,
      escrow_amount: 140.13,
      total_adjustment_amount: 0,
    },
    order_status: "COMPLETED",
  });

  assert.equal(r.tarifa_venda, 73.87);
  assert.equal(r.valor_liquido, 140.13);
  assert.equal(r.divergencia, 0);
  assert.equal(r.final, true);
  assert.equal(r.linhas.length, 6);
  assert.deepEqual(
    r.linhas.find((l) => l.chave === "order_ams_commission_fee"),
    { chave: "order_ams_commission_fee", rotulo: "Comissão de anúncios (AMS)", valor: 10.08 },
  );
});

// Pedido 9077 / 260831SEM7SFGG — um dos 2 (de 42) com frete real pro vendedor.
test("normalizarRepasseShopee cobra o frete quando o rebate nao cobre (pedido 9077)", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 316.72,
      commission_fee: 37.77,
      service_fee: 32.3,
      ads_escrow_top_up_fee_or_technical_support_fee: 6.3,
      voucher_from_seller: 1.97,
      shipping_seller_protection_fee_amount: 0.49,
      actual_shipping_fee: 43.31,
      shopee_shipping_rebate: 37.23,
      escrow_amount: 231.81,
      total_adjustment_amount: 0,
    },
    order_status: "TO_CONFIRM_RECEIVE",
  });

  assert.equal(r.tarifa_venda, 78.83);
  assert.equal(r.custo_envio, 6.08);
  assert.equal(r.valor_liquido, 231.81);
  assert.equal(r.divergencia, 0);
  assert.equal(r.envio_coberto_pelo_marketplace, false);
  assert.equal(r.final, false);
});

test("normalizarRepasseShopee omite linhas de valor zero", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 100,
      commission_fee: 10,
      service_fee: 0,
      voucher_from_seller: 0,
      escrow_amount: 90,
    },
    order_status: "SHIPPED",
  });

  assert.deepEqual(r.linhas, [{ chave: "commission_fee", rotulo: "Comissão", valor: 10 }]);
});

test("normalizarRepasseShopee acusa divergencia quando falta uma taxa na soma", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 100,
      commission_fee: 10,
      escrow_amount: 85,
    },
    order_status: "COMPLETED",
  });

  assert.equal(r.valor_liquido, 85);
  assert.equal(r.divergencia, 5);
});

test("normalizarRepasseShopee usa o valor ajustado quando houve ajuste", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 100,
      commission_fee: 10,
      escrow_amount: 90,
      escrow_amount_after_adjustment: 80,
      total_adjustment_amount: -10,
    },
    order_status: "COMPLETED",
  });

  assert.equal(r.liquido_informado, 80);
  assert.equal(r.valor_liquido, 80);
});

test("normalizarRepasseShopee devolve percentual nulo quando o bruto e zero", () => {
  const r = normalizarRepasseShopee({ order_income: {}, order_status: null });

  assert.equal(r.valor_bruto, 0);
  assert.equal(r.tarifa_percentual, null);
  assert.equal(r.linhas.length, 0);
  assert.equal(r.final, false);
});
```

- [ ] **Step 2: Rodar e confirmar que falham**

Run: `node --test test/*.test.mjs`
Expected: FAIL — `normalizarRepasseShopee is not a function`.

- [ ] **Step 3: Implementar**

Acrescentar em `src/lib/repasse.ts`, depois de `normalizarRepasseMl`:

```ts
// Recorte de `order_income` da Escrow API. Só os campos que entram na conta —
// a resposta real tem ~100 campos, a maioria irrelevante ou zerada no Brasil.
export type OrderIncomeShopee = {
  order_selling_price?: number;
  commission_fee?: number;
  service_fee?: number;
  ads_escrow_top_up_fee_or_technical_support_fee?: number;
  order_ams_commission_fee?: number;
  voucher_from_seller?: number;
  shipping_seller_protection_fee_amount?: number;
  actual_shipping_fee?: number;
  buyer_paid_shipping_fee?: number;
  shopee_shipping_rebate?: number;
  escrow_amount?: number;
  escrow_amount_after_adjustment?: number;
  total_adjustment_amount?: number;
};

export type PayloadRepasseShopee = {
  order_income: OrderIncomeShopee;
  order_status: string | null;
};

// Linhas que a Shopee debita do vendedor, na ordem em que o modal exibe.
// `voucher_from_seller` é desconto dado pelo vendedor, não tarifa da Shopee —
// mas reduz o repasse, então entra. NÃO usar net_commission_fee/net_service_fee:
// eles vêm preenchidos e parecem certos, mas o que a Shopee debita é o bruto
// (o rebate que gera o "net" já está em voucher_from_shopee, bancado por ela).
// Medido em 42/42 pedidos: com os brutos a conta fecha, com os "net" não.
const LINHAS_SHOPEE: Array<{ chave: keyof OrderIncomeShopee; rotulo: string }> = [
  { chave: "commission_fee", rotulo: "Comissão" },
  { chave: "service_fee", rotulo: "Taxa de serviço" },
  { chave: "ads_escrow_top_up_fee_or_technical_support_fee", rotulo: "Taxa de suporte técnico" },
  { chave: "order_ams_commission_fee", rotulo: "Comissão de anúncios (AMS)" },
  { chave: "voucher_from_seller", rotulo: "Cupom do vendedor" },
  { chave: "shipping_seller_protection_fee_amount", rotulo: "Proteção de envio" },
];

// Diferente do ML, aqui o líquido não é calculado por nós: a Shopee informa o
// escrow_amount, que é o que ela de fato deposita. Nós calculamos em paralelo
// só para conferir (campo `divergencia`).
export function normalizarRepasseShopee(payload: PayloadRepasseShopee): RepasseMarketplace {
  const oi = payload.order_income ?? {};
  const num = (v: number | undefined): number => arredondar(v ?? 0);

  const linhas: LinhaRepasse[] = LINHAS_SHOPEE.map(({ chave, rotulo }) => ({
    chave: chave as string,
    rotulo,
    valor: num(oi[chave]),
  })).filter((l) => l.valor !== 0);

  const valor_bruto = num(oi.order_selling_price);
  const tarifa_venda = arredondar(linhas.reduce((acc, l) => acc + l.valor, 0));

  // O rebate da Shopee cobre o frete em 40 dos 42 pedidos medidos: sob o
  // Programa de Frete Grátis o vendedor não paga frete, paga comissão maior.
  const rebate = num(oi.shopee_shipping_rebate);
  const custo_envio = arredondar(
    num(oi.actual_shipping_fee) - num(oi.buyer_paid_shipping_fee) - rebate,
  );

  const houveAjuste = num(oi.total_adjustment_amount) !== 0;
  const liquido_informado = houveAjuste
    ? num(oi.escrow_amount_after_adjustment)
    : num(oi.escrow_amount);

  const calculado = arredondar(valor_bruto - tarifa_venda - custo_envio);

  return {
    marketplace: "shopee",
    valor_bruto,
    tarifa_venda,
    tarifa_percentual:
      valor_bruto === 0 ? null : arredondar((tarifa_venda / valor_bruto) * 100),
    custo_envio,
    valor_liquido: liquido_informado,
    // Na Shopee entregue ≠ liquidado: só em COMPLETED o escrow foi liberado e
    // os valores param de mudar.
    final: payload.order_status === "COMPLETED",
    linhas,
    liquido_informado,
    envio_coberto_pelo_marketplace: custo_envio === 0 && rebate > 0,
    divergencia: arredondar(calculado - liquido_informado),
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passam**

Run: `node --test test/*.test.mjs`
Expected: PASS — 24/24.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repasse.ts test/repasse.test.mjs
git commit -m "feat(repasse): normalizarRepasseShopee a partir do escrow_detail"
```

---

### Task 3: Migration das colunas novas

**Files:**
- Create: `supabase/migrations/20260903120000_repasse-shopee.sql`

- [ ] **Step 1: Criar a migration**

```sql
-- Fase 2 do repasse: Shopee. A quebra de tarifas vai em JSONB porque ninguém
-- soma linha de quebra entre pedidos; os agregados continuam em colunas
-- próprias (é neles que um relatório mensal vai somar).
-- `order_ams_commission_fee` só aparece em 5 de 42 pedidos: colunas fixas por
-- tipo de taxa fariam cada taxa nova da Shopee virar migration.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS repasse_linhas            JSONB,
  ADD COLUMN IF NOT EXISTS repasse_liquido_informado NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_divergencia       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS shopee_order_status       TEXT;

COMMENT ON COLUMN public.pedidos.repasse_liquido_informado IS
  'Líquido informado pelo marketplace (escrow_amount na Shopee). NULL no ML, que não tem equivalente.';
COMMENT ON COLUMN public.pedidos.repasse_divergencia IS
  '(bruto − tarifa − envio) − liquido_informado. Diferente de zero indica linha de taxa não somada.';
COMMENT ON COLUMN public.pedidos.shopee_order_status IS
  'order_status da Shopee. COMPLETED é o ponto de congelamento do repasse (escrow liberado).';

-- Índice da rotação do cron da Shopee, espelhando idx_pedidos_repasse_pendente
-- da fase 1 mas escopado ao marketplace, para os dois crons não competirem
-- pelo mesmo plano de consulta.
CREATE INDEX IF NOT EXISTS idx_pedidos_repasse_shopee_pendente
  ON public.pedidos (repasse_checked_at NULLS FIRST)
  WHERE repasse_final = false AND marketplace = 'shopee';
```

- [ ] **Step 2: Commit (sem aplicar ainda)**

```bash
git add supabase/migrations/20260903120000_repasse-shopee.sql
git commit -m "feat(repasse): migration das colunas de quebra e status Shopee"
```

> ⚠️ **Não aplicar nesta task.** A aplicação em produção acontece na Task 10, com autorização explícita do Vinicius, e **só via MCP `apply_migration`** escopado a esta migration. **Nunca** `supabase db push` nem `migration up` neste projeto: o histórico do CLI está dessincronizado (~8 migrations locais não registradas e ~8 remotas sem arquivo), e a fila tentaria reaplicar migrations antigas às cegas. Ver `CURRENT-STATE.md`, "Bloqueios atuais".

---

### Task 4: `buscarRepasseShopee` em `shopee.ts`

**Files:**
- Modify: `src/lib/shopee.ts` (acrescentar ao final, antes dos `createServerFn` do bloco de conexão)

Não há teste automatizado aqui: é I/O de rede autenticado, no mesmo padrão de `buscarEtiquetaShopee`, que também não tem. A verificação é a Task 10, contra a API real.

- [ ] **Step 1: Acrescentar o import no topo do arquivo**

Em `src/lib/shopee.ts`, junto dos três imports existentes (linhas 1-3):

```ts
import type { OrderIncomeShopee } from "@/lib/repasse";
```

- [ ] **Step 2: Implementar**

Acrescentar em `src/lib/shopee.ts`, logo depois de `buscarEtiquetaShopee`:

```ts
// ── Repasse (Escrow API) ─────────────────────────────────────────────────────

export type ShopeeRepasseResult =
  | { ok: true; order_income: OrderIncomeShopee; order_status: string | null }
  | { ok: false; error: string };

// Vai direto do Worker pelo gateway de IP fixo — NÃO existe edge function aqui.
// A restrição que motivou a edge function do ML (Worker não alcança
// api.mercadolibre.com, erro 1016/530) não se aplica à Shopee: o ingress do
// cloudflared libera `^/api/v2/.*` e o nginx faz `location /api/v2/`, então
// payment/ e order/ passam pelo mesmo caminho que logistics/ já usa.
export async function buscarRepasseShopee(orderSn: string): Promise<ShopeeRepasseResult> {
  const { data: conn, error } = await supabaseAdmin
    .from("shopee_connections")
    .select("shop_id")
    .eq("is_sandbox", isShopeeSandbox())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.error("[shopee] erro ao buscar conexão ativa:", error.message);
  if (!conn) return { ok: false, error: "shopee_no_connection" };

  const shopId = (conn as { shop_id: number }).shop_id;

  let accessToken: string;
  try {
    accessToken = await refreshShopeeTokenIfNeeded(shopId);
  } catch (err) {
    return { ok: false, error: `shopee_token: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const escrowUrl = await buildShopeeUrl(
      "/api/v2/payment/get_escrow_detail",
      { order_sn: orderSn },
      accessToken,
      shopId,
    );
    const escrowRes = await shopeeFetch(escrowUrl, { method: "GET" });
    const escrowJson: any = await escrowRes.json().catch(() => null);

    if (!escrowRes.ok || escrowJson?.error || !escrowJson?.response?.order_income) {
      return { ok: false, error: `shopee_escrow: ${escrowJson?.error ?? escrowRes.status}` };
    }

    // Segunda chamada só pelo order_status: é ele que define o congelamento
    // (COMPLETED = escrow liberado). A Escrow API não devolve o status.
    const orderUrl = await buildShopeeUrl(
      "/api/v2/order/get_order_detail",
      { order_sn_list: orderSn, response_optional_fields: "order_status" },
      accessToken,
      shopId,
    );
    const orderRes = await shopeeFetch(orderUrl, { method: "GET" });
    const orderJson: any = await orderRes.json().catch(() => null);
    const orderStatus: string | null = orderJson?.response?.order_list?.[0]?.order_status ?? null;

    return {
      ok: true,
      order_income: escrowJson.response.order_income as OrderIncomeShopee,
      order_status: orderStatus,
    };
  } catch (err) {
    return { ok: false, error: `shopee_escrow_exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 3: Verificar que compila sem erro novo**

Run: `npx tsc --noEmit`
Expected: exatamente 1 erro — `src/lib/shopee.ts(458,79)`, o pré-existente. Qualquer outro é regressão desta task.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shopee.ts
git commit -m "feat(shopee): buscarRepasseShopee via escrow detail + order status"
```

---

### Task 5: Despacho por marketplace em `repasse.functions.ts`

**Files:**
- Modify: `src/lib/repasse.functions.ts`

- [ ] **Step 1: Ajustar imports e o tipo do candidato**

Substituir o bloco de imports e `CandidatoRepasse` no topo de `src/lib/repasse.functions.ts` por:

```ts
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMLAccessToken } from "@/lib/ml.functions";
import { buscarRepasseShopee } from "@/lib/shopee";
import {
  normalizarRepasseMl,
  normalizarRepasseShopee,
  montarCandidatosRepasse,
  type RepasseMarketplace,
} from "@/lib/repasse";

export const MAX_CANDIDATOS_REPASSE = 4;

export type MarketplaceRepasse = "mercadolivre" | "shopee";

export type CandidatoRepasse = {
  id: string;
  bling_pedido_id: number;
  numero_loja: string | null;
  marketplace: string | null;
};
```

- [ ] **Step 2: Substituir `atualizarRepassePedido` pelo despacho**

Substituir a função `atualizarRepassePedido` inteira por:

```ts
type RepasseBuscado =
  | { ok: true; repasse: RepasseMarketplace; shopee_order_status: string | null }
  | { ok: false; error: string };

async function buscarRepasse(
  marketplace: string | null,
  numeroLoja: string,
): Promise<RepasseBuscado> {
  if (marketplace === "shopee") {
    const resp = await buscarRepasseShopee(numeroLoja);
    if (!resp.ok) return { ok: false, error: resp.error };
    return {
      ok: true,
      repasse: normalizarRepasseShopee({
        order_income: resp.order_income,
        order_status: resp.order_status,
      }),
      shopee_order_status: resp.order_status,
    };
  }

  const resp = await buscarRepasseML(numeroLoja);
  if (!resp.ok) return { ok: false, error: resp.error ?? "erro_desconhecido" };
  return {
    ok: true,
    repasse: normalizarRepasseMl({
      order_items: resp.order_items ?? [],
      custo_envio: resp.custo_envio ?? 0,
      shipment_status: resp.shipment_status ?? null,
    }),
    shopee_order_status: null,
  };
}

// Busca, normaliza e grava o repasse de um pedido. repasse_checked_at sempre
// avança, tenha dado certo ou não — senão um pedido problemático monopoliza os
// slots da rotação pra sempre (mesma razão documentada em
// atualizarSituacoesExistentes). Único caminho de escrita: cron e backfill
// passam os dois por aqui, de propósito, pra não divergirem.
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

  const resp = await buscarRepasse(pedido.marketplace, pedido.numero_loja);

  if (!resp.ok) {
    await supabaseAdmin
      .from("pedidos")
      .update({ repasse_checked_at: agora, repasse_error: resp.error } as any)
      .eq("id", pedido.id);
    return { ok: false, error: resp.error };
  }

  const repasse = resp.repasse;

  await supabaseAdmin
    .from("pedidos")
    .update({
      repasse_valor_bruto: repasse.valor_bruto,
      repasse_tarifa_venda: repasse.tarifa_venda,
      repasse_tarifa_percentual: repasse.tarifa_percentual,
      repasse_custo_envio: repasse.custo_envio,
      repasse_valor_liquido: repasse.valor_liquido,
      repasse_linhas: repasse.linhas,
      repasse_liquido_informado: repasse.liquido_informado,
      repasse_divergencia: repasse.divergencia,
      repasse_final: repasse.final,
      repasse_checked_at: agora,
      repasse_error: null,
      ...(pedido.marketplace === "shopee"
        ? { shopee_order_status: resp.shopee_order_status }
        : {}),
    } as any)
    .eq("id", pedido.id);

  return { ok: true, liquido: repasse.valor_liquido, final: repasse.final };
}
```

- [ ] **Step 3: Parametrizar a seleção de candidatos por marketplace**

Substituir `selecionarCandidatosRepasse` por:

```ts
// Rotação em dois buckets, igual a cronMLStatus: "nunca verificados" têm
// prioridade (mais recentes primeiro); "retry" só ocupa os slots que sobrarem,
// ordenado por quem está há mais tempo sem checagem.
export async function selecionarCandidatosRepasse(
  marketplace: MarketplaceRepasse = "mercadolivre",
  orcamento: number = MAX_CANDIDATOS_REPASSE,
): Promise<CandidatoRepasse[]> {
  const baseQuery = () =>
    supabaseAdmin
      .from("pedidos")
      .select("id, bling_pedido_id, numero_loja, marketplace")
      .eq("marketplace", marketplace)
      .eq("repasse_final", false)
      .neq("situacao_id", 12)
      .not("numero_loja", "is", null);

  const { data: nuncaVerificados, error: erro1 } = (await baseQuery()
    .is("repasse_checked_at", null)
    .order("data_pedido", { ascending: false, nullsFirst: false })
    .limit(orcamento)) as any;

  if (erro1) {
    console.error(`[repasse:${marketplace}] select nunca-verificados falhou:`, erro1.message);
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
      console.error(`[repasse:${marketplace}] select retry falhou:`, erro2.message);
    } else {
      retry = retryData ?? [];
    }
  }

  return montarCandidatosRepasse(nuncaVerificados ?? [], retry, orcamento);
}
```

- [ ] **Step 4: Parametrizar o backfill**

Substituir `backfillRepasseMl` por:

```ts
// Backfill do histórico. Idempotente: só pega pedidos com repasse_checked_at
// nulo, então rodar de novo não reprocessa o que já tem dado. Chamada em lotes
// pra caber no limite de subrequests do Worker.
export async function backfillRepasse(
  marketplace: MarketplaceRepasse = "mercadolivre",
  limite: number = 40,
): Promise<ResultadoBackfill> {
  const { data, error } = (await supabaseAdmin
    .from("pedidos")
    .select("id, bling_pedido_id, numero_loja, marketplace")
    .eq("marketplace", marketplace)
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
    .eq("marketplace", marketplace)
    .is("repasse_checked_at", null)
    .neq("situacao_id", 12)
    .not("numero_loja", "is", null)) as any;

  console.log(`[backfill-repasse:${marketplace}] ${ok}/${pedidos.length} ok, ${count ?? 0} restantes`);

  return { processados: pedidos.length, ok, erros, restantes: count ?? 0 };
}
```

O nome antigo `backfillRepasseMl` some. Ele só era usado em
`src/routes/api/admin/backfill-repasse.ts` (confirmado por `grep`), e essa
chamada é atualizada na Task 7 — nenhum outro arquivo referencia.

- [ ] **Step 5: Verificar compilação**

Run: `npx tsc --noEmit`
Expected: exatamente 1 erro — `src/lib/shopee.ts(458,79)`. Nenhum erro em `repasse.functions.ts`.

Run: `node --test test/*.test.mjs`
Expected: PASS — 24/24 (este arquivo não é coberto por teste, mas os de `repasse.ts` não podem quebrar).

- [ ] **Step 6: Commit**

```bash
git add src/lib/repasse.functions.ts
git commit -m "feat(repasse): despacho por marketplace e selecao/backfill parametrizados"
```

---

### Task 6: `cronRepasseShopee`

**Files:**
- Modify: `src/server.ts`
- Modify: `plugins/cloudflare-scheduled.ts`

- [ ] **Step 1: Ajustar a chamada existente do ML**

Em `src/server.ts`, dentro de `cronRepasseMl`, trocar:

```ts
    const candidatos = await selecionarCandidatosRepasse();
```

por:

```ts
    const candidatos = await selecionarCandidatosRepasse("mercadolivre");
```

- [ ] **Step 2: Acrescentar o estado do cron novo**

Em `src/server.ts`, logo depois da linha `const REPASSE_INTERVAL_MS = 5 * 60 * 1000;`, acrescentar:

```ts
let lastRepasseShopeeAt = 0;
```

- [ ] **Step 3: Implementar `cronRepasseShopee`**

Acrescentar em `src/server.ts`, imediatamente depois de `cronRepasseMl`:

```ts
// Irmão de cronRepasseMl com gate e orçamento próprios: uma indisponibilidade
// da Shopee não pode consumir os slots do ML, nem o contrário.
export async function cronRepasseShopee() {
  const now = Date.now();

  try {
    if (now - lastRepasseShopeeAt < REPASSE_INTERVAL_MS) return;

    const db = supabaseAdmin as any;
    const { data: state } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "repasse_shopee")
      .maybeSingle();

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    if (now - lastRun < REPASSE_INTERVAL_MS) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert(
        { job_name: "repasse_shopee", last_run_at: new Date(now).toISOString() },
        { onConflict: "job_name" },
      );

    if (upsertError) {
      console.error("[cron-repasse-shopee] upsert cron_state falhou", { message: upsertError.message });
      return;
    }

    lastRepasseShopeeAt = now;

    const candidatos = await selecionarCandidatosRepasse("shopee");
    console.log(`[cron-repasse-shopee] ${candidatos.length} candidato(s)`);

    for (const pedido of candidatos) {
      const res = await atualizarRepassePedido(pedido);
      if (res.ok) {
        console.log(
          `[cron-repasse-shopee] pedido ${pedido.bling_pedido_id} liquido=${res.liquido} final=${res.final}`,
        );
      } else {
        console.warn(`[cron-repasse-shopee] pedido ${pedido.bling_pedido_id} erro: ${res.error}`);
      }
    }
  } catch (e) {
    console.error("[cron-repasse-shopee] erro:", e);
  }
}
```

- [ ] **Step 4: Registrar no plugin**

Em `plugins/cloudflare-scheduled.ts`, trocar a linha de import por:

```ts
import { cronReconciliar, cronSyncPoll, cronMLStatus, cronNfStatus, cronNfEmissao, cronRepasseMl, cronRepasseShopee } from "../src/server";
```

E acrescentar a entrada ao final do array `tarefas`:

```ts
      ["cron-repasse-shopee", cronRepasseShopee],
```

Atualizar o comentário acima do array: trocar "Os seis crons" por "Os sete crons".

> O `scheduled` exportado em `src/server.ts` é **código morto** sob o preset Nitro cloudflare-module — registrar lá não faz o cron rodar.

- [ ] **Step 5: Verificar compilação**

Run: `npx tsc --noEmit`
Expected: exatamente 1 erro — `src/lib/shopee.ts(458,79)`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts plugins/cloudflare-scheduled.ts
git commit -m "feat(repasse): cronRepasseShopee com gate e orcamento proprios"
```

---

### Task 7: Backfill parametrizado por marketplace

**Files:**
- Modify: `src/routes/api/admin/backfill-repasse.ts`

- [ ] **Step 1: Implementar**

Substituir o corpo do handler `POST` (do `const url = new URL(...)` até o fim do `try/catch`) por:

```ts
        const url = new URL(request.url);
        const limiteParam = Number(url.searchParams.get("limite") ?? "40");
        const limite =
          Number.isFinite(limiteParam) && limiteParam > 0 ? Math.min(limiteParam, 100) : 40;

        const marketplaceParam = url.searchParams.get("marketplace") ?? "mercadolivre";
        if (marketplaceParam !== "mercadolivre" && marketplaceParam !== "shopee") {
          return Response.json(
            { ok: false, error: "marketplace deve ser mercadolivre ou shopee" },
            { status: 400 },
          );
        }

        try {
          const resultado = await backfillRepasse(marketplaceParam, limite);
          return Response.json({ ok: true, marketplace: marketplaceParam, resultado });
        } catch (err) {
          console.error("[backfill-repasse] erro:", err);
          return Response.json(
            { ok: false, error: String(err instanceof Error ? err.message : err) },
            { status: 500 },
          );
        }
```

E trocar o import do topo:

```ts
import { backfillRepasse } from "@/lib/repasse.functions";
```

O default continua `mercadolivre`, então qualquer chamada existente sem o parâmetro se comporta exatamente como antes.

- [ ] **Step 2: Verificar compilação**

Run: `npx tsc --noEmit`
Expected: exatamente 1 erro — `src/lib/shopee.ts(458,79)`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/admin/backfill-repasse.ts
git commit -m "feat(repasse): backfill aceita ?marketplace=shopee"
```

---

### Task 8: Expor as colunas novas para a UI

**Files:**
- Modify: `src/integrations/supabase/types.ts`
- Modify: `src/lib/pedidos.functions.ts`

`types.ts` está desatualizado por débito técnico conhecido, e as colunas da fase 1 foram acrescentadas à mão. Sem isso, o tipo da query inteira colapsa em `SelectQueryError`.

- [ ] **Step 1: Acrescentar as colunas em `types.ts`**

Em `src/integrations/supabase/types.ts`, na tabela `pedidos`, acrescentar em **Row** (junto das demais `repasse_*`, por volta da linha 334):

```ts
          repasse_linhas: Json | null
          repasse_liquido_informado: number | null
          repasse_divergencia: number | null
          shopee_order_status: string | null
```

Em **Insert** e em **Update**, acrescentar as mesmas quatro, com `?`:

```ts
          repasse_linhas?: Json | null
          repasse_liquido_informado?: number | null
          repasse_divergencia?: number | null
          shopee_order_status?: string | null
```

- [ ] **Step 2: Acrescentar ao `PedidoRow`**

Em `src/lib/pedidos.functions.ts`, no tipo `PedidoRow`, depois de `repasse_error: string | null;`:

```ts
  repasse_linhas: Array<{ chave: string; rotulo: string; valor: number }> | null;
  repasse_liquido_informado: number | null;
  repasse_divergencia: number | null;
  shopee_order_status: string | null;
```

- [ ] **Step 3: Acrescentar ao `select` de `listarPedidos`**

Na string de `select` (linha ~91), trocar o trecho final `repasse_error, pedido_itens(count)` por:

```
repasse_error, repasse_linhas, repasse_liquido_informado, repasse_divergencia, shopee_order_status, pedido_itens(count)
```

- [ ] **Step 4: Verificar compilação**

Run: `npx tsc --noEmit`
Expected: exatamente 1 erro — `src/lib/shopee.ts(458,79)`. **Se aparecer `SelectQueryError` em `pedidos.functions.ts`, o Step 1 ficou incompleto** — conferir que as quatro colunas entraram nas três seções (Row, Insert, Update).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/supabase/types.ts src/lib/pedidos.functions.ts
git commit -m "feat(repasse): expoe colunas de quebra e status Shopee no PedidoRow"
```

---

### Task 9: `RepasseDialog` com a quebra

**Files:**
- Modify: `src/components/RepasseDialog.tsx`

- [ ] **Step 1: Substituir `corpo()` e acrescentar o componente de linha secundária**

Em `src/components/RepasseDialog.tsx`, acrescentar depois da função `Linha`:

```tsx
// Linha da quebra de tarifas: indentada e menor, subordinada ao agregado.
function LinhaQuebra({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between py-1 pl-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular-nums text-xs text-muted-foreground">{valor}</span>
    </div>
  );
}
```

Substituir a função `corpo()` inteira por:

```tsx
  function corpo() {
    if (!pedido) return null;

    const isShopee = pedido.marketplace === "shopee";
    const nomeMarketplace = isShopee ? "Shopee" : "Mercado Livre";

    if (pedido.marketplace !== "mercadolivre" && !isShopee) {
      return (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Repasse indisponível para este marketplace.
        </p>
      );
    }

    if (pedido.repasse_checked_at === null) {
      return (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Aguardando sincronização com o {nomeMarketplace}.
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

    // "Tarifa de venda" no ML; na Shopee o agregado inclui o cupom do vendedor,
    // que é desconto dado por nós e não tarifa dela — chamar tudo de tarifa
    // seria impreciso.
    const rotuloTarifa = isShopee
      ? `Tarifas e descontos${percentual}`
      : `Tarifa de venda total${percentual}`;

    const linhas = pedido.repasse_linhas ?? [];
    const envioCoberto = isShopee && pedido.repasse_custo_envio === 0;
    const divergencia = pedido.repasse_divergencia ?? 0;

    return (
      <div className="space-y-1">
        <Linha label="Valor da venda" valor={formatBRL(pedido.repasse_valor_bruto)} />
        <Linha label={rotuloTarifa} valor={`- ${formatBRL(pedido.repasse_tarifa_venda)}`} negativo />
        {linhas.length > 1 &&
          linhas.map((l) => (
            <LinhaQuebra key={l.chave} label={l.rotulo} valor={`- ${formatBRL(l.valor)}`} />
          ))}
        <Linha
          label={envioCoberto ? "Custo do envio (coberto pela Shopee)" : "Custo do envio"}
          valor={envioCoberto ? formatBRL(0) : `- ${formatBRL(pedido.repasse_custo_envio)}`}
          negativo={!envioCoberto}
        />
        <div className="flex items-baseline justify-between pt-3 mt-2 border-t-2">
          <span className="font-medium">Total</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatBRL(pedido.repasse_valor_liquido)}
          </span>
        </div>

        {divergencia !== 0 && (
          <p className="text-xs text-amber-600 pt-3">
            Conferência: nossa soma difere em {formatBRL(Math.abs(divergencia))} do valor informado
            pela {nomeMarketplace}.
          </p>
        )}
        {!pedido.repasse_final && (
          <p className="text-xs text-muted-foreground pt-3">
            {isShopee
              ? "A Shopee ainda não liberou o pagamento — estes valores podem mudar."
              : "O envio ainda não foi entregue — estes valores podem mudar."}
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-1">
          Atualizado em {formatDateTime(pedido.repasse_checked_at)}
        </p>
      </div>
    );
  }
```

O modal do ML fica inalterado: `linhas.length === 1` não renderiza quebra, `isShopee` é falso, `divergencia` é 0, e os rótulos e o rodapé são os mesmos de hoje.

- [ ] **Step 2: Verificar compilação**

Run: `npx tsc --noEmit`
Expected: exatamente 1 erro — `src/lib/shopee.ts(458,79)`.

- [ ] **Step 3: Commit**

```bash
git add src/components/RepasseDialog.tsx
git commit -m "feat(repasse): modal exibe quebra de tarifas e frete coberto da Shopee"
```

---

### Task 10: Verificação contra a realidade

Nada aqui é automatizável: é a etapa que a fase 1 usou para descobrir que o modal exibia o campo errado. **Cada passo que toca produção precisa de autorização explícita do Vinicius.**

- [ ] **Step 1: Suíte completa e tipo**

```bash
node --test test/*.test.mjs
npx tsc --noEmit
```

Expected: 24/24 passando; exatamente 1 erro de `tsc`, em `src/lib/shopee.ts(458,79)`.

- [ ] **Step 2: Revisar o diff contra o plano**

```bash
git diff main...feat/repasse-shopee-fase-2 --stat
```

Confirmar que só os 11 arquivos da seção "File Structure" aparecem.

- [ ] **Step 3: Aplicar a migration em produção — PEDIR AUTORIZAÇÃO**

Somente via MCP `apply_migration`, escopado a `20260903120000_repasse-shopee.sql`. **Nunca** `supabase db push` / `migration up`.

Conferir depois:

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='pedidos'
  and column_name in ('repasse_linhas','repasse_liquido_informado','repasse_divergencia','shopee_order_status');
```

Expected: 4 linhas.

- [ ] **Step 4: Deploy — PEDIR AUTORIZAÇÃO, e só do checkout principal**

```bash
npm run build
npx wrangler deploy --config .output/server/wrangler.json
```

⚠️ **Rodar em `C:\Users\Vinicius\EXPEDE`, nunca nesta worktree** — ela não tem `.env` e o bundle sairia sem `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` (Lição #26). Antes de deployar, confirmar que a URL do Supabase aparece em `.output/public/assets/*.js`.

- [ ] **Step 5: Backfill dos 42**

```bash
curl -X POST -H "X-Admin-Key: <ADMIN_KEY>" \
  "https://babyworld.expede.workers.dev/api/admin/backfill-repasse?marketplace=shopee&limite=50"
```

Expected: `ok: true`, `resultado.ok = 42`, `resultado.restantes = 0`, `erros: []`.

- [ ] **Step 6: Conferir os números no banco**

```sql
select count(*) as total,
       count(*) filter (where repasse_divergencia = 0) as sem_divergencia,
       count(*) filter (where repasse_error is not null) as com_erro,
       count(*) filter (where repasse_final) as congelados,
       count(*) filter (where repasse_custo_envio = 0) as frete_zero
from pedidos where marketplace = 'shopee';
```

Expected, com base na medição de 03/09/2026: `total=42`, `sem_divergencia=42`, `com_erro=0`, `congelados=19`, `frete_zero=40`.

**`sem_divergencia` menor que 42 significa que existe uma linha de taxa que não estamos somando** — investigar antes de considerar entregue, exatamente como `order_ams_commission_fee` apareceu na investigação.

- [ ] **Step 7: Conferir a tela**

Abrir `/pedidos` em produção e clicar no número de um pedido Shopee. Se o modal não abrir, **antes de suspeitar de bug**: `Ctrl+Shift+R`. O chunk da tela é carregado sob demanda e o manifesto em cache pede a versão anterior — foi exatamente isso que custou tempo na fase 1 (ver `05 - Erros e Soluções.md`).

Conferir: um pedido Shopee com frete coberto (ex: 9080) mostra "coberto pela Shopee"; um com frete real (9077) mostra R$ 6,08; um pedido ML permanece idêntico ao de hoje.

- [ ] **Step 8: Verificar as larguras de mobile**

A quebra acrescenta altura ao modal. Verificar em **320, 344 e 390px** — 344px é a largura real do aparelho do Vinicius (Galaxy Z Fold 6 fechado), não 390.

- [ ] **Step 9: Confirmar que o cron roda sozinho**

```bash
npx wrangler tail --format pretty
```

Expected: `[cron-repasse-shopee] N candidato(s)` a cada ~5 min, e nenhuma interferência em `[cron-repasse]` (ML).

- [ ] **Step 10: Atualizar a documentação**

Conforme `DOCUMENTATION-RULES.md`:
- `AGENT-CONTEXT/SESSION-HANDOFF.md` (obrigatório)
- `AGENT-CONTEXT/CURRENT-STATE.md` — Shopee sai de "fase 2 pendente"
- `01 - Decisões de Arquitetura.md` — o líquido vir do marketplace em vez de calculado, e o congelamento em `COMPLETED`
- `AGENT-CONTEXT/KNOWN-ISSUES.md` — devoluções (`TO_RETURN`) não tratadas
- `03 - Fases e Roadmap.md` — fase 2 concluída

---

## Notas de execução

- **Ordem das tasks importa.** 1→2 são a base pura; 3 é independente; 4→7 dependem de 1-2; 8→9 dependem de 3.
- **Não deployar da worktree.** Regra do repositório, e a Lição #26 já foi paga uma vez.
- **`npm run lint` não é critério.** 51.550 problemas pré-existentes de CRLF. Avaliar por arquivo, olhando só erros `@typescript-eslint` reais.
- **Baseline do `tsc` é 1 erro, não zero.** `src/lib/shopee.ts(458,79)`.
