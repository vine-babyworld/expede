import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

export const Route = createFileRoute("/api/debug/bling-token")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const { data: conn } = await supabaseAdmin
          .from("bling_connections")
          .select("id, access_expires_at")
          .eq("status", "connected")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (!conn) {
          return Response.json({ ok: false, error: "nenhuma conexão Bling ativa" }, { status: 404 });
        }

        try {
          const access_token = await getDecryptedAccessToken(conn.id);
          return Response.json({
            access_token,
            expira_em: conn.access_expires_at ?? null,
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: String(err instanceof Error ? err.message : err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
