import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

async function blingGet(url: string, token: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers, body };
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

        const VOLUME_ID = "16086896637";

        const [r1, r2] = await Promise.all([
          blingGet(`https://www.bling.com.br/Api/v3/logisticasinternal/etiquetas/objetos?ids[]=${VOLUME_ID}`, token),
          blingGet(`https://api.bling.com.br/Api/v3/logisticasinternal/etiquetas/objetos?ids[]=${VOLUME_ID}`, token),
        ]);

        return Response.json({
          r1: { desc: "GET www.bling.com.br /logisticasinternal/etiquetas/objetos", volumeId: VOLUME_ID, ...r1 },
          r2: { desc: "GET api.bling.com.br /logisticasinternal/etiquetas/objetos", volumeId: VOLUME_ID, ...r2 },
        });
      },
    },
  },
});
