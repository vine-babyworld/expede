import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type PedidoRow = {
  id: string;
  bling_pedido_id: number;
  numero: string;
  numero_loja: string | null;
  situacao_id: number | null;
  situacao_valor: number | null;
  data_pedido: string | null;
  total: number | null;
  cliente: Record<string, unknown> | null;
  bling_nota_fiscal_id: number | null;
  bling_nota_fiscal_numero: string | null;
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
        "id, bling_pedido_id, numero, numero_loja, situacao_id, situacao_valor, data_pedido, total, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, created_at, updated_at, pedido_itens(count)",
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
