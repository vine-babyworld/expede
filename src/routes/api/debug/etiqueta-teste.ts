import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BASE = "https://api.bling.com.br/Api/v3/logisticas/etiquetas";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBlingPost(token: string, bodyPayload: unknown) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(bodyPayload),
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

        const { data: pedidos, error: pedidosErr } = await supabaseAdmin
          .from("pedidos")
          .select("numero, bling_pedido_id")
          .not("bling_pedido_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(3);

        if (pedidosErr || !pedidos?.length) {
          return Response.json(
            { ok: false, error: "no_pedidos", detail: pedidosErr?.message },
            { status: 500 },
          );
        }

        const results: Record<string, unknown> = {};
        for (const pedido of pedidos) {
          const res = await fetchBlingPost(token, { idVendas: [pedido.bling_pedido_id] });
          results[`pedido_${pedido.numero}`] = {
            numero: pedido.numero,
            bling_pedido_id: pedido.bling_pedido_id,
            ...res,
          };
          await delay(400);
        }

        return Response.json(results);
      },
    },
  },
});
