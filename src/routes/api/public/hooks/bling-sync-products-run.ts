import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runSyncJob } from "@/lib/produtos.functions";

const ACTIVE_STATUSES = ["pendente", "rodando", "pausado"];

async function markJobAsError(jobId: string, message: string) {
  const { data: job } = await supabaseAdmin
    .from("sync_jobs")
    .select("erros")
    .eq("id", jobId)
    .maybeSingle();

  const erros = Array.isArray(job?.erros) ? job.erros : [];
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status: "erro",
      finalizado_em: new Date().toISOString(),
      erros: [...erros, { mensagem: message }].slice(-50),
    })
    .eq("id", jobId);
}

async function handleRun(jobId: string) {
  const { data: job, error } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, status")
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!job) return Response.json({ ok: false, error: "Job não encontrado" }, { status: 404 });
  if (!ACTIVE_STATUSES.includes(job.status)) {
    return Response.json({ ok: false, error: `Job em status ${job.status}` }, { status: 409 });
  }

  try {
    const result = await runSyncJob(jobId);
    return Response.json({ ok: true, status: result.status, done: result.done });
  } catch (e: any) {
    const message = String(e?.message ?? e ?? "erro desconhecido");
    await markJobAsError(jobId, message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

async function getRunnableJobIds() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, proxima_execucao_em, status")
    .in("status", ["pendente", "pausado", "rodando"])
    .limit(10);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((r) => !r.proxima_execucao_em || r.proxima_execucao_em <= nowIso)
    .map((r) => r.id);
}

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

        const explicitJobId = body?.job_id ?? body?.jobId;
        if (explicitJobId) return handleRun(String(explicitJobId));

        const results: any[] = [];
        const jobIds = await getRunnableJobIds();
        for (const id of jobIds) {
          try {
            const r = await runSyncJob(id);
            results.push({ id, ...r });
          } catch (e: any) {
            const message = String(e?.message ?? e ?? "erro desconhecido");
            await markJobAsError(id, message);
            results.push({ id, ok: false, error: message });
          }
        }
        return Response.json({ ok: true, results });
      },
      GET: async ({ request }) => {
        const key = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || key !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const url = new URL(request.url);
        const jobId = url.searchParams.get("job_id") ?? url.searchParams.get("jobId");
        if (!jobId) return Response.json({ ok: false, error: "job_id obrigatório" }, { status: 400 });
        return handleRun(jobId);
      },
    },
  },
});
