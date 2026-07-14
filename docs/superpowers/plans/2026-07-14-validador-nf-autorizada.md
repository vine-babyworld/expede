# Validador de NF Autorizada no Bipar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. **Não rodar `npx wrangler deploy` nem aplicar a migration em produção
> sem confirmação explícita do Vinicius** — regra permanente do projeto (ver
> `CLAUDE.md`, "Deploy é sempre manual").

**Goal:** Bloquear a bipagem (e qualquer impressão automática) de pedidos
não-Flex cuja NF exista no Bling mas não esteja autorizada, mostrando um popup
bloqueante e mantendo o pedido visível na fila até a NF ser corrigida.

**Architecture:** ver
`docs/superpowers/specs/2026-07-14-validador-nf-autorizada-design.md`. Resumo:
novo cron `cronNfStatus` (mesmo padrão do `cronMLStatus` já existente) mantém
`pedidos.nf_situacao` atualizado; `ExpedicaoPage.tsx` e `historico.tsx` usam um
helper compartilhado `nfNaoAutorizada()` pra decidir bloquear.

**Tech Stack:** TanStack Start (server functions), TanStack Query, React,
shadcn/ui `AlertDialog`, Supabase Admin client, Cloudflare Workers cron
(`cloudflare:scheduled` hook via Nitro plugin).

Não há test suite no projeto — verificação é via `npm run build` (TypeScript),
`npm run lint`, e teste manual no dev server / `wrangler tail` em produção
(mesmo padrão já usado em todo o histórico do projeto).

---

## File Map

| Arquivo | Operação | Responsabilidade |
|---|---|---|
| `supabase/migrations/20260714100000_nf-situacao.sql` | Create | Colunas `nf_situacao`, `nf_situacao_motivo`, `nf_situacao_checked_at` |
| `src/lib/pedidos.functions.ts` | Modify (append) | `fetchNfSituacaoBling`, `NF_SITUACOES_AUTORIZADAS`, `nfSituacaoLabel`, `nfNaoAutorizada` |
| `src/server.ts` | Modify (append) | `cronNfStatus` |
| `plugins/cloudflare-scheduled.ts` | Modify | Registra `cronNfStatus` |
| `src/features/expedicao/ExpedicaoPage.tsx` | Modify | Gate no bipar, `NfNaoAutorizadaDialog`, badge, defesa no print |
| `src/lib/dashboard.functions.ts` | Modify | `nf_situacao`/`nf_situacao_motivo` em `HISTORICO_SELECT`/`HistoricoRow` |
| `src/routes/_app/historico.tsx` | Modify | Mesmo gate no reimprimir |

---

## Task 1: Migration — colunas de situação da NF

**Files:**
- Create: `supabase/migrations/20260714100000_nf-situacao.sql`

- [ ] **Step 1: Criar o arquivo de migration**

  ```sql
  -- Rastreamento da situação da NF no Bling (situação != "id existe" — Bling
  -- cria o registro da NF mesmo quando ela nunca chega a ser autorizada pela
  -- SEFAZ, ex: NCM faltante nos itens). Sem isso o EXPEDE não distinguia "NF
  -- criada mas com erro" de "NF autorizada" — pedidos nessa situação eram
  -- bipáveis e podiam ser marcados como impressos com DANFE inválida.
  --
  -- Códigos de situação (Bling API v3, GET /nfe/{id}):
  -- 1 Pendente | 2 Cancelada | 3 Aguardando recibo | 4 Rejeitada | 5 Autorizada
  -- 6 Emitida DANFE | 7 Registrada | 8 Aguardando protocolo | 9 Denegada
  -- 10 Consulta situação | 11 Bloqueada
  -- Autorizada para efeito de bipagem = 5 ou 6.

  ALTER TABLE public.pedidos
    ADD COLUMN IF NOT EXISTS nf_situacao SMALLINT,
    ADD COLUMN IF NOT EXISTS nf_situacao_motivo TEXT,
    ADD COLUMN IF NOT EXISTS nf_situacao_checked_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_pedidos_nf_situacao_checked_at
    ON public.pedidos (nf_situacao_checked_at ASC NULLS FIRST)
    WHERE printed_at IS NULL AND bling_nota_fiscal_id IS NOT NULL;
  ```

- [ ] **Step 2: Aplicar a migration**

  Perguntar ao Vinicius se aplica agora via MCP do Supabase (`apply_migration`)
  ou se prefere `supabase db push` local — **não aplicar sem confirmação**,
  mesma regra de qualquer mudança de schema neste projeto.

- [ ] **Step 3: Verificar**

  ```sql
  select column_name, data_type from information_schema.columns
  where table_name = 'pedidos' and column_name like 'nf_situacao%';
  ```

  Esperado: 3 linhas (`nf_situacao` smallint, `nf_situacao_motivo` text,
  `nf_situacao_checked_at` timestamptz).

---

## Task 2: `fetchNfSituacaoBling` + helpers compartilhados em `pedidos.functions.ts`

**Files:**
- Modify: `src/lib/pedidos.functions.ts`

- [ ] **Step 1: Localizar o ponto de inserção**

  `fetchNfNumeroBling` está na linha ~757. A nova função entra logo depois
  dela (antes de `buscarNumeroNF`, linha 771).

- [ ] **Step 2: Adicionar `fetchNfSituacaoBling`**

  ```ts
  /**
   * Consulta a situação real da NF no Bling (autorizada, rejeitada, pendente, etc)
   * — não confundir com "bling_nota_fiscal_id preenchido", que só indica que o
   * Bling criou o registro da NF, não que ela foi autorizada pela SEFAZ.
   * Extração do motivo é best-effort: a API v3 não documenta publicamente um
   * campo de erro/motivo no GET /nfe/{id}, então tentamos os nomes mais
   * plováveis e caímos pra `null` se nenhum vier preenchido — a UI sempre tem
   * o fallback do rótulo da situação (ver nfSituacaoLabel).
   */
  async function fetchNfSituacaoBling(
    nfId: number,
    token: string,
  ): Promise<{ situacao: number | null; motivo: string | null }> {
    try {
      const res = await fetch(`${BLING_NFE_URL}/${nfId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) return { situacao: null, motivo: null };
      const json: any = await res.json().catch(() => null);
      const d = json?.data ?? null;
      if (!d) return { situacao: null, motivo: null };

      console.log("[nf-situacao] resposta bruta Bling", JSON.stringify(d).slice(0, 1000));

      const situacao = d.situacao != null ? Number(d.situacao) : null;
      const motivo: string | null =
        d.motivo ?? d.mensagem ?? d.erro ?? d.observacoes ?? d.xJust ?? null;
      return { situacao, motivo: motivo ? String(motivo) : null };
    } catch (e) {
      console.error("[nf-situacao] erro ao consultar Bling:", e);
      return { situacao: null, motivo: null };
    }
  }

  /** Situações do Bling que significam NF de fato autorizada/emitida. */
  export const NF_SITUACOES_AUTORIZADAS = new Set<number>([5, 6]);

  const NF_SITUACAO_LABELS: Record<number, string> = {
    1: "Pendente",
    2: "Cancelada",
    3: "Aguardando recibo",
    4: "Rejeitada",
    5: "Autorizada",
    6: "Emitida DANFE",
    7: "Registrada",
    8: "Aguardando protocolo",
    9: "Denegada",
    10: "Consulta situação",
    11: "Bloqueada",
  };

  export function nfSituacaoLabel(codigo: number | null): string {
    if (codigo == null) return "não verificada";
    return NF_SITUACAO_LABELS[codigo] ?? `código ${codigo}`;
  }

  /**
   * true somente quando: a NF existe (bling_nota_fiscal_id preenchido), o cron
   * já verificou a situação real (nf_situacao != null) e essa situação NÃO está
   * no conjunto autorizado. Pedido ainda não verificado (nf_situacao null) não
   * bloqueia — mesma janela de defasagem aceita no design (poucos minutos até
   * o cronNfStatus alcançar o pedido).
   */
  export function nfNaoAutorizada(p: {
    bling_nota_fiscal_id: number | null;
    nf_situacao: number | null;
  }): boolean {
    if (!p.bling_nota_fiscal_id) return false;
    if (p.nf_situacao == null) return false;
    return !NF_SITUACOES_AUTORIZADAS.has(p.nf_situacao);
  }
  ```

  Exportar também `fetchNfSituacaoBling` (remover o `async function` privado e
  usar `export async function fetchNfSituacaoBling(...)`) — o `cronNfStatus`
  em `server.ts` precisa importá-la.

- [ ] **Step 3: Verificar build**

  ```bash
  npm run build
  ```

  Esperado: zero erros novos (os erros de TS pré-existentes de tipos Supabase
  desatualizados continuam os mesmos, ver `CLAUDE.md`).

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/pedidos.functions.ts
  git commit -m "feat(nf): adiciona fetchNfSituacaoBling e helpers de situação de NF"
  ```

---

## Task 3: `cronNfStatus` em `server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Atualizar o import de `pedidos.functions`**

  Linha 6 hoje:
  ```ts
  import { reconciliarPedidos } from "./lib/pedidos.functions";
  ```
  Substituir por:
  ```ts
  import { reconciliarPedidos, fetchNfSituacaoBling, NF_SITUACOES_AUTORIZADAS } from "./lib/pedidos.functions";
  import { getDecryptedAccessToken } from "./lib/bling.functions";
  ```

- [ ] **Step 2: Adicionar constantes de gate, logo após `MAX_CANDIDATOS_ML_STATUS` (linha 78)**

  ```ts
  let lastNfStatusAt = 0;
  const NF_STATUS_INTERVAL_MS = 2 * 60 * 1000; // 2 min — mais curto que o ML (bloqueia bipagem)
  const MAX_CANDIDATOS_NF_STATUS = 4;
  ```

- [ ] **Step 3: Adicionar `cronNfStatus`, logo após o fechamento de `cronMLStatus` (linha 222, antes de `export async function cronReconciliar()`)**

  ```ts
  export async function cronNfStatus() {
    const now = Date.now();
    console.log("[cron-nf-status] iniciando verificação de gate", { now: new Date(now).toISOString() });

    try {
      const diffMemMs = now - lastNfStatusAt;
      if (diffMemMs < NF_STATUS_INTERVAL_MS) {
        console.log("[cron-nf-status] bloqueado pelo gate em memória", { diffMemMs });
        return;
      }

      const db = supabaseAdmin as any;
      const { data: state } = await db
        .from("cron_state")
        .select("last_run_at")
        .eq("job_name", "nf_status")
        .maybeSingle();

      const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
      const diffMs = now - lastRun;
      if (diffMs < NF_STATUS_INTERVAL_MS) return;

      const { error: upsertError } = await db
        .from("cron_state")
        .upsert({ job_name: "nf_status", last_run_at: new Date(now).toISOString() }, { onConflict: "job_name" });
      if (upsertError) {
        console.error("[cron-nf-status] upsert cron_state falhou", { message: upsertError.message });
        return;
      }

      lastNfStatusAt = now;

      const { data: conn } = await supabaseAdmin
        .from("bling_connections")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!conn) {
        console.log("[cron-nf-status] nenhuma conexão Bling cadastrada");
        return;
      }

      let token: string;
      try {
        token = await getDecryptedAccessToken(conn.id);
      } catch (e) {
        console.error("[cron-nf-status] erro ao obter token:", e);
        return;
      }

      const situacoesAutorizadas = Array.from(NF_SITUACOES_AUTORIZADAS);

      const baseQuery = () =>
        supabaseAdmin
          .from("pedidos")
          .select("id, bling_nota_fiscal_id, nf_situacao, nf_situacao_checked_at")
          .is("printed_at", null)
          .not("bling_nota_fiscal_id", "is", null)
          .neq("situacao_id", 12)
          .eq("arquivado", false)
          .not("nf_situacao", "in", `(${situacoesAutorizadas.join(",")})`);

      const { data: nuncaVerificados, error: selectError1 } = await baseQuery()
        .is("nf_situacao", null)
        .order("data_pedido", { ascending: true })
        .limit(MAX_CANDIDATOS_NF_STATUS) as any;

      if (selectError1) {
        console.error("[cron-nf-status] select nunca-verificados falhou:", selectError1.message);
        return;
      }

      const slotsRestantes = MAX_CANDIDATOS_NF_STATUS - (nuncaVerificados?.length ?? 0);
      let retry: any[] = [];

      if (slotsRestantes > 0) {
        const { data: retryData, error: selectError2 } = await baseQuery()
          .not("nf_situacao", "is", null)
          .order("nf_situacao_checked_at", { ascending: true, nullsFirst: true })
          .limit(slotsRestantes) as any;

        if (selectError2) {
          console.error("[cron-nf-status] select retry falhou:", selectError2.message);
        } else {
          retry = retryData ?? [];
        }
      }

      const candidatos = [...(nuncaVerificados ?? []), ...retry];
      console.log(
        `[cron-nf-status] ${candidatos.length} candidato(s) encontrado(s)`,
        `(${nuncaVerificados?.length ?? 0} nunca verificado(s), ${retry.length} retry)`,
      );

      for (const pedido of candidatos) {
        if (!pedido.bling_nota_fiscal_id) continue;

        const { situacao, motivo } = await fetchNfSituacaoBling(pedido.bling_nota_fiscal_id, token);

        console.log(
          `[cron-nf-status] pedido ${pedido.id} nf=${pedido.bling_nota_fiscal_id} situacao=${situacao} motivo=${motivo ?? "null"}`,
        );

        if (situacao == null) continue; // não sobrescreve com null — mantém o que já sabia (ou continua null)

        await supabaseAdmin
          .from("pedidos")
          .update({
            nf_situacao: situacao,
            nf_situacao_motivo: motivo,
            nf_situacao_checked_at: new Date(now).toISOString(),
          } as any)
          .eq("id", pedido.id);
      }

      console.log("[cron-nf-status] ciclo concluído");
    } catch (e) {
      console.error("[cron-nf-status] exceção não tratada", {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  }
  ```

  > **Nota sobre o filtro `.not("nf_situacao", "in", ...)`:** exclui da fila
  > pedidos já confirmados autorizados (5 ou 6) — situação da NF não regride
  > sozinha na prática (uma vez autorizada, fica autorizada; cancelamento
  > passa por `situacao_id=12` do pedido, já filtrado à parte). Isso evita
  > rechecar pra sempre pedidos que já estão OK, ao contrário do
  > `cron-ml-status` (que precisa rechecar até virar `delivered`).

- [ ] **Step 4: Verificar build**

  ```bash
  npm run build
  ```

---

## Task 4: Registrar `cronNfStatus` no hook do Cloudflare

**Files:**
- Modify: `plugins/cloudflare-scheduled.ts`

- [ ] **Step 1: Atualizar import e registro**

  Arquivo completo hoje:
  ```ts
  import { definePlugin } from "nitro";
  import { cronReconciliar, cronSyncPoll, cronMLStatus } from "../src/server";

  export default definePlugin((nitroApp) => {
    nitroApp.hooks.hook("cloudflare:scheduled", async ({ context }: any) => {
      context.waitUntil(
        cronSyncPoll().catch((e: unknown) => console.error("[cron-sync] poll erro:", e)),
      );
      context.waitUntil(
        cronReconciliar().catch((e: unknown) => console.error("[cron-reconciliar] erro:", e)),
      );
      context.waitUntil(
        cronMLStatus().catch((e: unknown) => console.error("[cron-ml-status] erro:", e)),
      );
    });
  });
  ```

  Substituir por:
  ```ts
  import { definePlugin } from "nitro";
  import { cronReconciliar, cronSyncPoll, cronMLStatus, cronNfStatus } from "../src/server";

  // O preset Nitro cloudflare-module não usa o `scheduled` exportado em src/server.ts —
  // Cron Triggers do Cloudflare chegam aqui via hook "cloudflare:scheduled".
  // https://nitro.build/deploy/providers/cloudflare#runtime-hooks
  export default definePlugin((nitroApp) => {
    nitroApp.hooks.hook("cloudflare:scheduled", async ({ context }: any) => {
      context.waitUntil(
        cronSyncPoll().catch((e: unknown) => console.error("[cron-sync] poll erro:", e)),
      );
      context.waitUntil(
        cronReconciliar().catch((e: unknown) => console.error("[cron-reconciliar] erro:", e)),
      );
      context.waitUntil(
        cronMLStatus().catch((e: unknown) => console.error("[cron-ml-status] erro:", e)),
      );
      context.waitUntil(
        cronNfStatus().catch((e: unknown) => console.error("[cron-nf-status] erro:", e)),
      );
    });
  });
  ```

- [ ] **Step 2: Verificar build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/server.ts plugins/cloudflare-scheduled.ts
  git commit -m "feat(nf): adiciona cron cronNfStatus para verificar situação da NF no Bling"
  ```

---

## Task 5: Gate + dialog + badge em `ExpedicaoPage.tsx`

**Files:**
- Modify: `src/features/expedicao/ExpedicaoPage.tsx`

- [ ] **Step 1: Atualizar imports**

  Linha 20-25 (import de `Dialog`), adicionar `AlertDialog`:
  ```ts
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "@/components/ui/dialog";
  import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
  } from "@/components/ui/alert-dialog";
  ```

  Linha 30, adicionar os novos helpers ao import existente:
  ```ts
  import { isPedidoFlex, marcarPedidoImpresso, nfNaoAutorizada, nfSituacaoLabel } from "@/lib/pedidos.functions";
  ```

- [ ] **Step 2: Adicionar campos ao tipo `PedidoExpedicao` (linha 49-65)**

  ```ts
  type PedidoExpedicao = {
    id: string;
    bling_pedido_id: number;
    numero: string;
    numero_loja: string | null;
    marketplace: string | null;
    data_pedido: string | null;
    cliente: { nome?: string; razaoSocial?: string } | null;
    bling_nota_fiscal_id: number | null;
    bling_nota_fiscal_numero: string | null;
    nf_situacao: number | null;
    nf_situacao_motivo: string | null;
    situacao_valor: number | null;
    raw_json: any;
    itens: ItemExpedicao[];
    printed_at: string | null;
    bling_divergente: boolean;
    ml_shipment_status: string | null;
  };
  ```

- [ ] **Step 3: Atualizar `fetchPedidos` (linha 127-167)**

  Select (linha 131), adicionar `nf_situacao, nf_situacao_motivo`:
  ```ts
  .select(
    "id, bling_pedido_id, numero, numero_loja, data_pedido, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, nf_situacao, nf_situacao_motivo, situacao_id, situacao_valor, marketplace, raw_json, printed_at, bling_divergente, ml_shipment_status, pedido_itens(id, sku, ean, descricao, quantidade, quantidade_bipada, produto:produtos(imagem_url, gtin))",
  )
  ```

  Map (dentro do `.map((p) => ({ ... }))`, logo após `bling_nota_fiscal_numero`):
  ```ts
  bling_nota_fiscal_numero: p.bling_nota_fiscal_numero ?? null,
  nf_situacao: p.nf_situacao ?? null,
  nf_situacao_motivo: p.nf_situacao_motivo ?? null,
  ```

- [ ] **Step 4: Adicionar estado `pedidoNfBloqueada` (perto da linha 210-211)**

  ```ts
  const [pedidoAtivo, setPedidoAtivo] = useState<PedidoExpedicao | null>(null);
  const [pedidoNfBloqueada, setPedidoNfBloqueada] = useState<PedidoExpedicao | null>(null);
  const [showPrinterConfig, setShowPrinterConfig] = useState(false);
  ```

- [ ] **Step 5: Atualizar `handleBiparPedido` (linha 262-273)**

  ```ts
  const handleBiparPedido = useCallback(
    (pedido: PedidoExpedicao) => {
      const semNf = !pedido.bling_nota_fiscal_id;
      if (!isPedidoFlex(pedido) && semNf) {
        toast.info("Este pedido ainda não tem NF emitida no Bling — aguarde o próximo sync");
        return;
      }
      if (!isPedidoFlex(pedido) && nfNaoAutorizada(pedido)) {
        setPedidoNfBloqueada(pedido);
        return;
      }
      const fresh = pedidos.find((p) => p.id === pedido.id) ?? pedido;
      setPedidoAtivo(fresh);
    },
    [pedidos],
  );
  ```

- [ ] **Step 6: Defesa em profundidade em `handleImpressaoAutomatica` (logo após o bloco `semNf` existente, linha 288-291)**

  Código atual:
  ```ts
  if (!isFlex && semNf) {
    toast.warning("Pedido aguardando NF no Bling — impressão bloqueada até a NF ser emitida");
    return;
  }
  ```

  Adicionar logo depois:
  ```ts
  if (!isFlex && nfNaoAutorizada(pedido)) {
    toast.warning(
      `NF não autorizada (${nfSituacaoLabel(pedido.nf_situacao)}) — corrija no Bling antes de imprimir`,
      { id: "print" },
    );
    return;
  }
  ```

- [ ] **Step 7: Renderizar o novo dialog (junto ao `<BipagemModal>`, linha 507-519)**

  ```tsx
  {/* Modal de bipagem */}
  <BipagemModal
    pedido={pedidoAtivo}
    onClose={() => setPedidoAtivo(null)}
    onConcluido={(pedido) => {
      queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] });
      setPedidoAtivo(null);
      handleImpressaoAutomatica(pedido);
    }}
    onRegistered={() =>
      queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] })
    }
  />

  {/* Aviso de NF não autorizada */}
  <NfNaoAutorizadaDialog pedido={pedidoNfBloqueada} onClose={() => setPedidoNfBloqueada(null)} />
  ```

- [ ] **Step 8: Adicionar componente `NfNaoAutorizadaDialog` (após `detectarMarketplace`, antes de `PedidoCard`, ~linha 542)**

  ```tsx
  function NfNaoAutorizadaDialog({
    pedido,
    onClose,
  }: {
    pedido: PedidoExpedicao | null;
    onClose: () => void;
  }) {
    return (
      <AlertDialog open={!!pedido} onOpenChange={(open) => { if (!open) onClose(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>NF não autorizada</AlertDialogTitle>
            <AlertDialogDescription>
              {pedido && (
                <>
                  O pedido <strong>{pedido.numero_loja || pedido.numero}</strong>
                  {pedido.bling_nota_fiscal_numero ? ` (NF ${pedido.bling_nota_fiscal_numero})` : ""} não
                  possui NF autorizada no Bling — situação atual:{" "}
                  <strong>{nfSituacaoLabel(pedido.nf_situacao)}</strong>.
                  {pedido.nf_situacao_motivo ? ` Motivo: ${pedido.nf_situacao_motivo}.` : ""} Corrija a nota
                  fiscal no Bling antes de bipar este pedido.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={onClose}>Entendi</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  ```

- [ ] **Step 9: Badge no `PedidoCard` (linha 603-612, junto aos badges `semNf`)**

  Código atual:
  ```tsx
  {semNf && (
    <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border bg-orange-100 text-orange-700 border-orange-300">
      ⚠ Sem NF
    </span>
  )}
  {!isFlex && semNf && (
    <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded border bg-gray-100 text-gray-500 border-gray-300">
      Aguardando NF do Bling
    </span>
  )}
  ```

  Adicionar logo depois:
  ```tsx
  {!isFlex && nfNaoAutorizada(pedido) && (
    <span
      className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border bg-red-100 text-red-700 border-red-300"
      title={pedido.nf_situacao_motivo ?? undefined}
    >
      ⚠ NF não autorizada ({nfSituacaoLabel(pedido.nf_situacao)})
    </span>
  )}
  ```

- [ ] **Step 10: Verificar build**

  ```bash
  npm run build
  ```

- [ ] **Step 11: Teste manual (dev server)**

  ```bash
  npm run dev
  ```

  1. Pedido normal (NF autorizada ou `nf_situacao` ainda `null`): clicar BIPAR
     abre o modal normalmente — sem regressão.
  2. Simular um pedido com `nf_situacao` fora de `{5,6}` (via update manual no
     Supabase de um pedido de teste) e `bling_nota_fiscal_id` preenchido:
     clicar BIPAR deve abrir o `NfNaoAutorizadaDialog`, modal de bipagem NÃO
     abre, pedido continua na lista depois de fechar o aviso.
  3. Mesmo pedido de teste, mas marcado como Flex (`marketplace =
     "mercadolivreflex"` ou `raw_json.transporte.volumes[0].servico` contendo
     "flex"): BIPAR deve abrir o modal normalmente, sem bloqueio.
  4. Badge "⚠ NF não autorizada (...)" visível no card do pedido de teste
     (não-Flex).

- [ ] **Step 12: Commit**

  ```bash
  git add src/features/expedicao/ExpedicaoPage.tsx
  git commit -m "feat(nf): bloqueia bipagem de pedidos com NF não autorizada no Bling"
  ```

---

## Task 6: Mesmo gate em `historico.tsx` (reimprimir)

**Files:**
- Modify: `src/lib/dashboard.functions.ts`
- Modify: `src/routes/_app/historico.tsx`

- [ ] **Step 1: Adicionar campos ao `HISTORICO_SELECT` e `HistoricoRow` (`dashboard.functions.ts`, linha 204-231)**

  ```ts
  const HISTORICO_SELECT =
    "id, numero, numero_loja, marketplace, cliente, total, printed_at, situacao_id, bling_pedido_id, bling_nota_fiscal_id, nf_situacao, nf_situacao_motivo, raw_json, pedido_itens(id, sku, ean, descricao, quantidade, quantidade_bipada, produto:produtos(imagem_url, gtin))";
  ```

  No tipo `HistoricoRow`, adicionar logo após `bling_nota_fiscal_id`:
  ```ts
  bling_nota_fiscal_id: number | null;
  nf_situacao: number | null;
  nf_situacao_motivo: string | null;
  ```

  No `.map((p: any): HistoricoRow => ({ ... }))` (linha ~259), adicionar logo
  após `bling_nota_fiscal_id`:
  ```ts
  bling_nota_fiscal_id: p.bling_nota_fiscal_id ?? null,
  nf_situacao: p.nf_situacao ?? null,
  nf_situacao_motivo: p.nf_situacao_motivo ?? null,
  ```

- [ ] **Step 2: Atualizar `handleReimprimir` em `historico.tsx` (linha 77-92)**

  Adicionar import (linha 17):
  ```ts
  import { getHistorico, HISTORICO_LIMIT, type HistoricoRow } from "@/lib/dashboard.functions";
  import { nfNaoAutorizada, nfSituacaoLabel } from "@/lib/pedidos.functions";
  ```

  Código atual:
  ```ts
  const isFlex = !!(pedido.raw_json as any)
    ?.transporte?.volumes?.[0]?.servico?.toLowerCase().includes("flex");
  const semNf = !pedido.bling_nota_fiscal_id;

  if (!isFlex && semNf) {
    toast.warning("Pedido sem NF — impressão de DANFE indisponível");
    return;
  }
  ```

  Substituir por:
  ```ts
  const isFlex = !!(pedido.raw_json as any)
    ?.transporte?.volumes?.[0]?.servico?.toLowerCase().includes("flex");
  const semNf = !pedido.bling_nota_fiscal_id;

  if (!isFlex && semNf) {
    toast.warning("Pedido sem NF — impressão de DANFE indisponível");
    return;
  }
  if (!isFlex && nfNaoAutorizada(pedido)) {
    toast.warning(`NF não autorizada (${nfSituacaoLabel(pedido.nf_situacao)}) — corrija no Bling antes de reimprimir`);
    return;
  }
  ```

- [ ] **Step 3: Verificar build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/dashboard.functions.ts src/routes/_app/historico.tsx
  git commit -m "feat(nf): aplica o mesmo bloqueio de NF não autorizada ao reimprimir do Histórico"
  ```

---

## Task 7: Validação em produção com o pedido real (#8467)

- [ ] **Step 1: Confirmar (via SQL direto, `execute_sql`/`query_database` MCP) que `bling_nota_fiscal_id` do pedido `2000014001394589` está de fato preenchido hoje**

  ```sql
  select id, numero, numero_loja, bling_nota_fiscal_id, bling_nota_fiscal_numero,
         nf_situacao, nf_situacao_motivo, printed_at
  from pedidos where numero_loja = '2000014001394589';
  ```

- [ ] **Step 2: Depois do deploy (só com confirmação explícita do Vinicius — `npm run build` → `npx wrangler deploy`), acompanhar `wrangler tail` até o `cron-nf-status` processar esse pedido**

  Procurar no log: `[nf-situacao] resposta bruta Bling ...` — **essa linha
  confirma empiricamente se a API do Bling expõe algum campo de motivo/erro
  utilizável** (decisão de design 2). Se não expuser nada reconhecível, o
  fallback de rótulo genérico já cobre o caso — nenhuma mudança de código
  necessária, só ajustar a expectativa documentada no design.

- [ ] **Step 3: Rodar a query do Step 1 de novo — esperado: `nf_situacao` preenchido com um código fora de `{5,6}` (provavelmente `1`, Pendente, já que o erro de NCM impede o envio à SEFAZ antes de qualquer rejeição formal)**

- [ ] **Step 4: Confirmar visualmente em produção**: abrir o Checkout por
  Produto, localizar o pedido #8467, confirmar badge "⚠ NF não autorizada" e
  que o clique em BIPAR abre o popup em vez do modal de bipagem.

- [ ] **Step 5: Atualizar a documentação do vault** (mesmo padrão de sempre):
  `CLAUDE.md` ("Atualizado em" + regra crítica nova), `00 - Memória de
  Projeto.md` (nova entrada cronológica), `03 - Fases e Roadmap.md` se fizer
  sentido registrar como item concluído.

---

## Checklist de aceite final

- [ ] Migration aplicada, 3 colunas novas confirmadas via SQL
- [ ] `cronNfStatus` rodando em produção (log `[cron-nf-status] ciclo
  concluído` aparecendo em `wrangler tail`)
- [ ] Pedido não-Flex com NF não autorizada: BIPAR abre popup, modal de
  bipagem não abre, pedido continua na lista
- [ ] Pedido Flex nas mesmas condições: sem bloqueio, comportamento igual ao
  de antes
- [ ] Pedido com `nf_situacao` ainda `null`: sem bloqueio (regressão zero no
  fluxo atual)
- [ ] Badge "⚠ NF não autorizada (...)" visível no card
- [ ] `handleImpressaoAutomatica` e reimprimir do Histórico também recusam
  completar com NF não autorizada
- [ ] Pedido #8467 validado ponta a ponta em produção
- [ ] `npm run build` e `npm run lint` passam limpos
- [ ] Vault atualizado (CLAUDE.md, Memória de Projeto, Roadmap)
