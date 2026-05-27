import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runSyncJob } from "@/lib/produtos.functions";

/**
 * Endpoint interno para continuar (ou disparar) um sync job.
 * Protegido com apikey = SUPABASE_PUBLISHABLE_KEY.
 *
 * Usos:
 * - Fire-and-forget chamado pelo syncProductsStart
 * - Cron poll: sem body, processa jobs em 'pausado'/'pendente' com proxima_execucao_em <= now
 */
export const Route = createFileRoute("/api/public/hooks/bling-sync-products-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || key !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: any = {};
        try { body = await request.json(); } catch { /* ignore */ }

        const jobIds: string[] = [];
        if (body?.jobId) {
          jobIds.push(String(body.jobId));
        } else {
          // pega jobs pendentes/pausados que estão na hora de rodar
          const nowIso = new Date().toISOString();
          const { data } = await supabaseAdmin
            .from("sync_jobs")
            .select("id, proxima_execucao_em, status")
            .in("status", ["pendente", "pausado"])
            .limit(10);
          for (const r of data ?? []) {
            if (!r.proxima_execucao_em || r.proxima_execucao_em <= nowIso) {
              jobIds.push(r.id);
            }
          }
        }

        const results: any[] = [];
        for (const id of jobIds) {
          try {
            const r = await runSyncJob(id);
            results.push({ id, ...r });
            // se não terminou, dispara continuação no próximo invoke (cron poll faz isso)
            if (!r.done && body?.jobId) {
              // self-trigger
              const url = new URL(request.url);
              fetch(`${url.origin}/api/public/hooks/bling-sync-products-run`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: expected },
                body: JSON.stringify({ jobId: id }),
              }).catch(() => { /* ignore */ });
            }
          } catch (e: any) {
            results.push({ id, error: String(e?.message ?? e) });
          }
        }
        return Response.json({ ok: true, results });
      },
    },
  },
});
