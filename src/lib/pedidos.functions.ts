import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
const BLING_LISTA_URL = "https://api.bling.com.br/Api/v3/pedidosvendas";
const DEPOSITO_ALVO = "Geral";

export type PedidoRow = {
  id: string;
  bling_pedido_id: number;
  numero: string;
  numero_loja: string | null;
  situacao_id: number | null;
  situacao_valor: number | null;
  data_pedido: string | null;
  total: number | null;
  cliente: Record<string, any> | null;
  bling_nota_fiscal_id: number | null;
  bling_nota_fiscal_numero: string | null;
  etiqueta_zpl: string | null;
  created_at: string;
  updated_at: string;
  items_count: number;
};

export type ListarPedidosInput = {
  search?: string;
  hidecanceled?: boolean;
  page?: number;
};

export type ListarPedidosResult = {
  rows: PedidoRow[];
  total: number;
  page: number;
  pageSize: number;
};

const PAGE_SIZE = 50;

export const listarPedidos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: ListarPedidosInput) => d)
  .handler(async ({ data }): Promise<ListarPedidosResult> => {
    const { search = "", hidecanceled = true, page = 1 } = data;
    const offset = (page - 1) * PAGE_SIZE;

    let query = supabaseAdmin
      .from("pedidos")
      .select(
        "id, bling_pedido_id, numero, numero_loja, situacao_id, situacao_valor, data_pedido, total, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, etiqueta_zpl, created_at, updated_at, pedido_itens(count)",
        { count: "exact" },
      );

    if (search.trim()) {
      query = query.ilike("numero", `%${search.trim()}%`);
    }

    if (hidecanceled) {
      query = query.neq("situacao_valor", 12);
    }

    query = query
      .order("data_pedido", { ascending: false, nullsFirst: false })
      .range(offset, offset + PAGE_SIZE - 1);

    const { data: rows, error, count } = await query;
    if (error) throw new Error(error.message);

    return {
      rows: (rows ?? []).map((r: any) => ({
        ...r,
        items_count: r.pedido_itens?.[0]?.count ?? 0,
        pedido_itens: undefined,
      })),
      total: count ?? 0,
      page,
      pageSize: PAGE_SIZE,
    };
  });

// Shared helper — mesma lógica do webhook bling-pedidos.ts
async function processarPedidoBling(
  blingPedidoId: number | string,
  connId: string,
  token: string,
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const res = await fetch(`${BLING_PEDIDOS_URL}/${blingPedidoId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[processarPedido] GET ${blingPedidoId} falhou: ${res.status}`, txt);
    return { ok: false, error: `bling_api_error:${res.status}` };
  }

  const json: any = await res.json();
  const d = json?.data;
  if (!d) return { ok: false, error: "empty_response" };

  if (!d.notaFiscal?.id) return { ok: true, skipped: "no_invoice" };

  const itens: any[] = d.itens ?? [];
  const itemForaDoDeposito = itens.find(
    (it: any) => it.deposito?.descricao !== undefined && it.deposito?.descricao !== DEPOSITO_ALVO,
  );
  if (itemForaDoDeposito) return { ok: true, skipped: "wrong_warehouse" };

  const pedidoPayload = {
    bling_connection_id:      connId,
    bling_pedido_id:          d.id,
    numero:                   String(d.numero ?? d.id),
    numero_loja:              d.numeroLoja ?? null,
    situacao_id:              d.situacao?.id ?? null,
    situacao_valor:           d.situacao?.valor ?? null,
    data_pedido:              d.data ? new Date(d.data).toISOString() : null,
    total:                    d.total ?? null,
    cliente:                  d.contato ?? null,
    bling_nota_fiscal_id:     d.notaFiscal.id,
    bling_nota_fiscal_numero: d.notaFiscal.numero ?? null,
    raw_json:                 d,
  };

  const { data: upserted, error: upsertErr } = await supabaseAdmin
    .from("pedidos")
    .upsert(pedidoPayload, { onConflict: "bling_connection_id,bling_pedido_id", ignoreDuplicates: false })
    .select("id")
    .single();

  if (upsertErr || !upserted) {
    console.error("[processarPedido] upsert falhou:", upsertErr?.message);
    return { ok: false, error: "upsert_error: " + upsertErr?.message };
  }

  const pedidoDbId: string = upserted.id;
  await supabaseAdmin.from("pedido_itens").delete().eq("pedido_id", pedidoDbId);

  const itensPrepared = await Promise.all(
    itens.map(async (it: any) => {
      let produtoId: string | null = null;
      const gtin = it.gtin ?? null;
      const sku  = it.codigo ?? null;

      if (gtin) {
        const { data: p } = await supabaseAdmin
          .from("produtos").select("id")
          .eq("gtin", gtin).eq("bling_connection_id", connId).maybeSingle();
        produtoId = p?.id ?? null;
      }
      if (!produtoId && sku) {
        const { data: p } = await supabaseAdmin
          .from("produtos").select("id")
          .eq("sku", sku).eq("bling_connection_id", connId).maybeSingle();
        produtoId = p?.id ?? null;
      }

      return {
        pedido_id:          pedidoDbId,
        produto_id:         produtoId,
        bling_item_id:      it.id ?? null,
        sku,
        ean:                gtin,
        descricao:          it.descricao ?? "",
        quantidade:         it.quantidade ?? 1,
        valor_unitario:     it.valor ?? null,
        deposito_id:        it.deposito?.id ?? null,
        deposito_descricao: it.deposito?.descricao ?? null,
      };
    }),
  );

  if (itensPrepared.length > 0) {
    const { error: itemsErr } = await supabaseAdmin.from("pedido_itens").insert(itensPrepared);
    if (itemsErr) console.error("[processarPedido] insert itens falhou:", itemsErr.message);
  }

  console.log(`[processarPedido] OK pedido=${blingPedidoId} db_id=${pedidoDbId} itens=${itensPrepared.length}`);
  return { ok: true };
}

export async function reconciliarPedidos(): Promise<void> {
  const { data: conn } = await supabaseAdmin
    .from("bling_connections")
    .select("id")
    .eq("status", "connected")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!conn) { console.log("[reconciliar] nenhuma conexão ativa"); return; }

  let token: string;
  try {
    token = await getDecryptedAccessToken(conn.id);
  } catch (e) {
    console.error("[reconciliar] erro ao obter token:", e);
    return;
  }

  const res = await fetch(`${BLING_LISTA_URL}?situacao=9&limite=50`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    console.error("[reconciliar] GET lista falhou:", res.status, await res.text().catch(() => ""));
    return;
  }

  const json: any = await res.json().catch(() => null);
  const pedidos: any[] = json?.data ?? [];

  if (pedidos.length === 0) { console.log("[reconciliar] lista vazia"); return; }

  const blingIds = pedidos.map((p: any) => p.id);
  const { data: existentes } = await supabaseAdmin
    .from("pedidos")
    .select("bling_pedido_id")
    .in("bling_pedido_id", blingIds);

  const existentesSet = new Set((existentes ?? []).map((e: any) => e.bling_pedido_id));
  const novos = pedidos.filter((p: any) => !existentesSet.has(p.id));

  if (novos.length === 0) { console.log("[reconciliar] nenhum pedido novo"); return; }

  console.log(`[reconciliar] ${novos.length} pedido(s) novo(s) a processar`);

  for (const p of novos) {
    const result = await processarPedidoBling(p.id, conn.id, token);
    console.log(`[reconciliar] pedido ${p.id}:`, JSON.stringify(result));
  }
}
