import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapProduct } from "@/lib/produtos.functions";

export const Route = createFileRoute("/api/admin/importar-produtos-lote")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }

        const { blingConnectionId, produtos } = body ?? {};
        if (!blingConnectionId || !Array.isArray(produtos)) {
          return Response.json(
            { ok: false, error: "blingConnectionId e produtos[] obrigatorios" },
            { status: 400 },
          );
        }

        const totalRecebidos: number = produtos.length;
        let totalUpserted = 0;
        let totalErros = 0;
        const erros: any[] = [];

        // Insert run log at start
        const { data: run } = await supabaseAdmin
          .from("produtos_sync_runs")
          .insert({ bling_connection_id: blingConnectionId, origem: "pc-local" })
          .select("id")
          .single();
        const runId: string | null = run?.id ?? null;

        // Map Bling raw objects to produto rows
        const rows: any[] = [];
        for (const p of produtos) {
          try {
            rows.push(mapProduct(p, blingConnectionId));
          } catch (e: any) {
            totalErros += 1;
            erros.push({ bling_product_id: p?.id, mensagem: String(e?.message ?? e) });
          }
        }

        // Single batch upsert — never deletes
        if (rows.length > 0) {
          const { error: upErr } = await supabaseAdmin
            .from("produtos")
            .upsert(rows as any, { onConflict: "bling_connection_id,bling_product_id" });
          if (upErr) {
            totalErros += rows.length;
            erros.push({ mensagem: "upsert em lote falhou: " + upErr.message });
          } else {
            totalUpserted = rows.length;
          }
        }

        // Update run log at end
        if (runId) {
          await supabaseAdmin
            .from("produtos_sync_runs")
            .update({
              finalizado_em: new Date().toISOString(),
              total_recebidos: totalRecebidos,
              total_upserted: totalUpserted,
              total_erros: totalErros,
              detalhes: erros.length > 0 ? erros : null,
            })
            .eq("id", runId);
        }

        console.log(
          `[importar-produtos-lote] recebidos=${totalRecebidos} upserted=${totalUpserted} erros=${totalErros}`,
        );

        return Response.json({ ok: true, total_recebidos: totalRecebidos, total_upserted: totalUpserted, total_erros: totalErros });
      },
    },
  },
});
