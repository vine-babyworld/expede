import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function utcTodayRange(): { gte: string; lt: string } {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    gte: today.toISOString(),
    lt: new Date(today.getTime() + 86_400_000).toISOString(),
  };
}

export const getDashboardExpedicao = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { gte, lt } = utcTodayRange();

    const { data } = await supabaseAdmin
      .from("pedidos")
      .select("id, total, pedido_itens(quantidade, quantidade_bipada)")
      .gte("data_pedido", gte)
      .lt("data_pedido", lt)
      .neq("situacao_id", 12);

    const pedidos = data ?? [];

    const pendentes = pedidos.filter((p: any) =>
      (p.pedido_itens as any[]).some((it: any) => (it.quantidade_bipada ?? 0) < it.quantidade)
    ).length;

    const expedidos = pedidos.filter((p: any) => {
      const itens = p.pedido_itens as any[];
      return itens.length > 0 && itens.every((it: any) => (it.quantidade_bipada ?? 0) >= it.quantidade);
    }).length;

    const totalValor = pedidos.reduce((s: number, p: any) => s + (p.total ?? 0), 0);

    return { pendentes, expedidos, totalValor, totalHoje: pedidos.length };
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
