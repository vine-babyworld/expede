import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ReconciliarReport } from "@/lib/pedidos.functions";

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
    const { gte: hojeBR, lt: amanhaBR } = brTodayRange();

    const [{ data: todosAbertos }, { data: expedidosHojeRows }] = await Promise.all([
      supabaseAdmin
        .from("pedidos")
        .select("id, pedido_itens(quantidade, quantidade_bipada)")
        .neq("situacao_id", 12),
      supabaseAdmin
        .from("pedidos")
        .select("id, total")
        .gte("printed_at", hojeBR)
        .lt("printed_at", amanhaBR)
        .neq("situacao_id", 12),
    ]);

    // Pendentes: TODOS os pedidos em aberto com algum item não bipado, sem filtro de data
    const pendentes = (todosAbertos ?? []).filter((p: any) =>
      (p.pedido_itens as any[]).some((it: any) => (it.quantidade_bipada ?? 0) < it.quantidade)
    ).length;

    const expedidos = expedidosHojeRows ?? [];
    const expedidosHoje = expedidos.length;
    const totalValor = expedidos.reduce((s: number, p: any) => s + (p.total ?? 0), 0);

    return { pendentes, expedidosHoje, totalValor, totalHoje: expedidosHoje };
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
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) throw new Error("ADMIN_KEY não configurado");

    const res = await fetch(
      "https://expede.lovable.app/api/admin/reconciliar",
      {
        method: "POST",
        headers: { "X-Admin-Key": adminKey },
      }
    );
    const json = await res.json() as { ok: boolean; error?: string; resultado?: ReconciliarReport };
    if (!json.ok) throw new Error(json.error ?? "Erro ao reconciliar");
    return { ok: true as const, resultado: json.resultado as ReconciliarReport };
  });
