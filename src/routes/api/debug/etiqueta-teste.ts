import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING_ETIQUETAS_URL =
  "https://api.bling.com.br/Api/v3/logisticas/etiquetas";

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

        const params = new URLSearchParams();
        params.append("idVendas[]", "25965853179");
        const url = `${BLING_ETIQUETAS_URL}?${params.toString()}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });

        const statusHttp = res.status;
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });

        let body: unknown;
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }

        return Response.json({ statusHttp, headers, body });
      },
    },
  },
});
