import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isPedidoFlex, reconciliarPedidos } from "@/lib/pedidos.functions";

function brTodayRange(): { gte: string; lt: string } {
  const now = new Date();
  // Brasília = UTC-3: subtrai 3h para obter o "agora" no horário local
  const brNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const y = brNow.getUTCFullYear();
  const m = brNow.getUTCMonth();
  const d = brNow.getUTCDate();
  // Meia-noite de hoje em Brasília = 03:00 UTC
  const start = new Date(Date.UTC(y, m, d,     3, 0, 0));
  // Meia-noite de amanhã em Brasília = 03:00 UTC do dia +1
  const end   = new Date(Date.UTC(y, m, d + 1, 3, 0, 0));
  return { gte: start.toISOString(), lt: end.toISOString() };
}

// Pedidos que compõem o card "A expedir": ainda não impressos, não cancelados,
// com algum item ainda não bipado, com NF do Bling emitida (exceto Flex) e
// ainda não despachados/entregues no ML — mesmo critério da tela de Expedição
// (ExpedicaoPage.tsx, useMemo `pendentes`), pra o contador do Dashboard bater
// com o que realmente aparece no Checkout por Produto.
const PEDIDOS_A_EXPEDIR_SELECT =
  "id, numero, numero_loja, situacao_id, marketplace, raw_json, cliente, data_pedido, total, bling_nota_fiscal_id, ml_shipment_status, pedido_itens(quantidade, quantidade_bipada)";

export type PedidoAExpedir = {
  id: string;
  numero: string;
  numero_loja: string | null;
  situacao_id: number | null;
  marketplace: string | null;
  raw_json: any;
  cliente: Record<string, any> | null;
  data_pedido: string | null;
  total: number | null;
  bling_nota_fiscal_id: number | null;
  ml_shipment_status: string | null;
};

async function fetchPedidosAExpedir(): Promise<PedidoAExpedir[]> {
  const { data } = await supabaseAdmin
    .from("pedidos")
    .select(PEDIDOS_A_EXPEDIR_SELECT)
    .is("printed_at", null)
    .neq("situacao_id", 12)
    .eq("arquivado", false)
    .or("ml_shipment_status.is.null,ml_shipment_status.not.in.(shipped,delivered)")
    .order("data_pedido", { ascending: false, nullsFirst: false });

  return (data ?? [])
    .filter((p: any) => (p.pedido_itens as any[]).some((it: any) => (it.quantidade_bipada ?? 0) < it.quantidade))
    .filter((p: any) => p.bling_nota_fiscal_id || isPedidoFlex(p))
    .map(({ pedido_itens, ...p }: any) => p as PedidoAExpedir);
}

export const getPedidosAExpedir = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const rows = await fetchPedidosAExpedir();
    return { rows, total: rows.length };
  });

export const getDashboardExpedicao = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { gte: hojeBR, lt: amanhaBR } = brTodayRange();

    const [aExpedir, { data: expedidosHojeRows }] = await Promise.all([
      fetchPedidosAExpedir(),
      supabaseAdmin
        .from("pedidos")
        .select("id, total")
        .gte("printed_at", hojeBR)
        .lt("printed_at", amanhaBR)
        .neq("situacao_id", 12),
    ]);

    const pendentes = aExpedir.length;

    const expedidos = expedidosHojeRows ?? [];
    const expedidosHoje = expedidos.length;
    const totalValor = expedidos.reduce((s: number, p: any) => s + (p.total ?? 0), 0);

    const { count: divergentes } = await supabaseAdmin
      .from("pedidos")
      .select("id", { count: "exact", head: true })
      .eq("bling_divergente", true)
      .is("printed_at", null)
      .eq("arquivado", false) as any;

    return { pendentes, expedidosHoje, totalValor, totalHoje: expedidosHoje, divergentes: divergentes ?? 0 };
  });

// Pedidos que aparecem no card "Expedidos hoje": já impressos, com printed_at
// dentro do dia atual em horário de Brasília, excluindo cancelados.
const PEDIDOS_EXPEDIDOS_HOJE_SELECT =
  "id, numero, numero_loja, marketplace, cliente, total, printed_at";

export type PedidoExpedidoHoje = {
  id: string;
  numero_loja: string | null;
  marketplace: string | null;
  cliente_nome: string;
  valor_total: number | null;
  printed_at: string | null;
};

async function fetchPedidosExpedidosHoje(): Promise<PedidoExpedidoHoje[]> {
  const { gte: hojeBR, lt: amanhaBR } = brTodayRange();

  const { data } = await supabaseAdmin
    .from("pedidos")
    .select(PEDIDOS_EXPEDIDOS_HOJE_SELECT)
    .gte("printed_at", hojeBR)
    .lt("printed_at", amanhaBR)
    .neq("situacao_id", 12)
    .order("printed_at", { ascending: false });

  return (data ?? []).map((p: any) => ({
    id: p.id,
    numero_loja: p.numero_loja ?? p.numero,
    marketplace: p.marketplace,
    cliente_nome: p.cliente?.nome ?? p.cliente?.razaoSocial ?? "—",
    valor_total: p.total,
    printed_at: p.printed_at,
  }));
}

export const getExpedidosHoje = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const rows = await fetchPedidosExpedidosHoje();
    return { rows, total: rows.length };
  });

export const getDashboardVendas = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const { data } = await supabaseAdmin
      .from("pedidos")
      .select("data_pedido, total")
      .gte("data_pedido", since)
      .neq("situacao_id", 12)
      .order("data_pedido");

    const byDay = new Map<string, { pedidos: number; valor: number }>();
    for (const p of data ?? []) {
      const dia = (p.data_pedido as string | null)?.substring(0, 10);
      if (!dia) continue;
      const e = byDay.get(dia) ?? { pedidos: 0, valor: 0 };
      byDay.set(dia, { pedidos: e.pedidos + 1, valor: e.valor + ((p.total as number | null) ?? 0) });
    }

    return Array.from(byDay.entries()).map(([dia, v]) => ({
      dia,
      pedidos: v.pedidos,
      valor: Math.round(v.valor * 100) / 100,
    }));
  });

export const getFunilExpedicao = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    // Janela: últimos 30 dias por data_pedido, excluindo cancelados
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const { data } = await supabaseAdmin
      .from("pedidos")
      .select("id, situacao_id, printed_at, pedido_itens(quantidade, quantidade_bipada)")
      .gte("data_pedido", since)
      .neq("situacao_id", 12);

    const rows = data ?? [];
    const importado = rows.length;

    let bipado = 0;
    let impresso = 0;
    let faturado = 0;

    for (const p of rows as any[]) {
      const itens = (p.pedido_itens as any[]) ?? [];
      const totalBipado = itens.length > 0 && itens.every((it) => (it.quantidade_bipada ?? 0) >= it.quantidade);
      if (totalBipado) bipado++;
      if (p.printed_at) impresso++;
      if (p.situacao_id === 9) faturado++;
    }

    return { importado, bipado, impresso, faturado };
  });

export const triggerReconciliar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const resultado = await reconciliarPedidos();
    return { ok: true as const, resultado };
  });

// ─── Histórico ─────────────────────────────────────────────────────────────────

const HISTORICO_SELECT =
  "id, numero, numero_loja, marketplace, cliente, total, printed_at, situacao_id, bling_pedido_id, bling_nota_fiscal_id, raw_json, pedido_itens(id, sku, ean, descricao, quantidade, quantidade_bipada, produto:produtos(imagem_url, gtin))";

export const HISTORICO_LIMIT = 50;

export type HistoricoRow = {
  id: string;
  numero: string;
  numero_loja: string | null;
  marketplace: string | null;
  cliente_nome: string;
  valor_total: number | null;
  printed_at: string;
  situacao_id: number | null;
  bling_pedido_id: number | null;
  bling_nota_fiscal_id: number | null;
  raw_json: any;
  itens: Array<{
    id: string;
    sku: string | null;
    ean: string | null;
    descricao: string;
    quantidade: number;
    quantidade_bipada: number;
    produto_gtin: string | null;
    produto: { imagem_url: string | null; gtin: string | null } | null;
  }>;
};

export const getHistorico = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { page?: number; busca?: string }) => d)
  .handler(async ({ data }) => {
    const page = Math.max(1, data.page ?? 1);
    const busca = data.busca?.trim() ?? "";
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

    let query = supabaseAdmin
      .from("pedidos")
      .select(HISTORICO_SELECT, { count: "exact" })
      .not("printed_at", "is", null)
      .gte("printed_at", since)
      .neq("situacao_id", 12)
      .order("printed_at", { ascending: false })
      .range((page - 1) * HISTORICO_LIMIT, page * HISTORICO_LIMIT - 1);

    if (busca) {
      query = query.or(
        `numero.ilike.%${busca}%,numero_loja.ilike.%${busca}%,cliente->>nome.ilike.%${busca}%,cliente->>razaoSocial.ilike.%${busca}%`,
      );
    }

    const { data: rows, count } = await query;

    return {
      rows: (rows ?? []).map((p: any): HistoricoRow => ({
        id: p.id,
        numero: p.numero,
        numero_loja: p.numero_loja ?? null,
        marketplace: p.marketplace ?? null,
        cliente_nome: p.cliente?.nome ?? p.cliente?.razaoSocial ?? "—",
        valor_total: p.total ?? null,
        printed_at: p.printed_at,
        situacao_id: p.situacao_id ?? null,
        bling_pedido_id: p.bling_pedido_id ?? null,
        bling_nota_fiscal_id: p.bling_nota_fiscal_id ?? null,
        raw_json: p.raw_json ?? null,
        itens: (p.pedido_itens ?? []).map((i: any) => ({
          id: i.id,
          sku: i.sku ?? null,
          ean: i.ean ?? null,
          descricao: i.descricao ?? "",
          quantidade: Number(i.quantidade ?? 1),
          quantidade_bipada: Number(i.quantidade_bipada ?? 0),
          produto_gtin: i.produto?.gtin ?? null,
          produto: i.produto ?? null,
        })),
      })),
      total: count ?? 0,
      page,
    };
  });
