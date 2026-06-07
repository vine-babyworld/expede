import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

export const getDashboardExpedicao = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { gte, lt } = brTodayRange();

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
