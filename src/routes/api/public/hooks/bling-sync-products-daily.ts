import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function runDaily(request: Request) {
  const { data: conns, error } = await supabaseAdmin
    .from("bling_connections")
    .select("id")
    .eq("status", "connected");
  if (error) throw new Error(error.message);

  const expected = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const created: string[] = [];
  const reused: string[] = [];
  for (const c of conns ?? []) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("sync_jobs")
      .select("id")
      .eq("bling_connection_id", c.id)
      .eq("tipo", "produtos")
      .in("status", ["pendente", "rodando", "pausado"])
      .limit(1)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) {
      reused.push(existing.id);
      continue;
    }

    const { data: job, error: insertError } = await supabaseAdmin
      .from("sync_jobs")
      .insert({ bling_connection_id: c.id, tipo: "produtos", status: "pendente" })
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    if (job) {
      created.push(job.id);
      const url = new URL(request.url);
      fetch(`${url.origin}/api/public/hooks/bling-sync-products-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: expected },
        body: JSON.stringify({ job_id: job.id }),
      }).catch(() => { /* ignore */ });
    }
  }
  return Response.json({ ok: true, created, reused });
}

/**
 * Cron diário (04:00) — cria sync_jobs de produtos para cada conexão Bling ativa.
 */
export const Route = createFileRoute("/api/public/hooks/bling-sync-products-daily")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || key !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        return runDaily(request);
      },
      GET: async ({ request }) => {
        const key = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || key !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        return runDaily(request);
      },
    },
  },
});
