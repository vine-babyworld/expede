import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BASE = "https://api.bling.com.br/Api/v3/logisticas/etiquetas";

async function fetchBling(url: string, token: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

export const Route = createFileRoute("/api/debug/etiqueta-teste")({
  server: {
    handlers: {
      GET: async () => {
        const { data: conn, error: connErr } = await supabaseAdmin
          .from("bling_connections")
          .select("id")
          .eq("status", "connected")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (connErr || !conn) {
          return Response.json(
            { ok: false, error: "no_active_connection", detail: connErr?.message },
            { status: 500 },
          );
        }

        let token: string;
        try {
          token = await getDecryptedAccessToken(conn.id);
        } catch (err) {
          return Response.json(
            { ok: false, error: "token_error", detail: String(err) },
            { status: 500 },
          );
        }

        const url1 = `${BASE}?idVendas[]=25965853179`;
        const url2 = `${BASE}?idVendas%5B%5D=25965853179`;
        const url3 = `${BASE}?idVendas=25965853179`;

        const [r1, r2, r3] = await Promise.all([
          fetchBling(url1, token),
          fetchBling(url2, token),
          fetchBling(url3, token),
        ]);

        return Response.json({
          url1: { url: url1, ...r1 },
          url2: { url: url2, ...r2 },
          url3: { url: url3, ...r3 },
        });
      },
    },
  },
});
