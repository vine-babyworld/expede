import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING = "https://api.bling.com.br/Api/v3";

async function blingGet(url: string, token: string) {
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

        const [r1, r2, r3, r4] = await Promise.all([
          blingGet(`${BLING}/notasfiscais/25977264250`, token),
          blingGet(`${BLING}/notasfiscais?idVendas[]=25976902452`, token),
          blingGet(`${BLING}/pedidos/vendas/25976902452`, token),
          blingGet(`${BLING}/nfe`, token),
        ]);

        return Response.json({
          r1: { desc: "GET /notasfiscais/25977264250 (id direto da NF)", ...r1 },
          r2: { desc: "GET /notasfiscais?idVendas[]=25976902452 (NF pelo id da venda)", ...r2 },
          r3: { desc: "GET /pedidos/vendas/25976902452 (pedido completo — ver raw NF)", ...r3 },
          r4: { desc: "GET /nfe (lista NFs — ver formato)", ...r4 },
        });
      },
    },
  },
});
