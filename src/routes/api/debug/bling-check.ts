import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/debug/bling-check")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const { data, error } = await supabaseAdmin
          .from("bling_connections")
          .select("id, status");

        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        return Response.json({
          count: data.length,
          rows: data.map((r) => ({ id: r.id, status: r.status })),
          supabase_url: process.env.SUPABASE_URL?.slice(0, 30),
        });
      },
    },
  },
});
