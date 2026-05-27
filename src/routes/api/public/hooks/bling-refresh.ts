import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { refreshConnectionById } from "@/lib/bling.functions";

// Cron-hook público. O agendador (pg_cron) envia
// `apikey: ${SUPABASE_PUBLISHABLE_KEY}` (anon key) como confirmação simples
// de que a chamada vem do projeto.
export const Route = createFileRoute("/api/public/hooks/bling-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || key !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Conexões 'connected' cujo access_token expira em até 1 hora.
        const cutoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const { data: rows, error } = await supabaseAdmin
          .from("bling_connections")
          .select("id")
          .eq("status", "connected")
          .lt("access_expires_at", cutoff);
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: Array<{ id: string; ok: boolean; error?: string }> = [];
        for (const row of rows ?? []) {
          const r = await refreshConnectionById(row.id);
          results.push(r.ok ? { id: row.id, ok: true } : { id: row.id, ok: false, error: r.error });
        }
        return Response.json({ ok: true, processed: results.length, results });
      },
    },
  },
});
