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

async function fetchBlingGet(token: string, queryString: string) {
  const res = await fetch(`${BASE}${queryString}`, {
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

        const r1 = await fetchBlingPost(token, { idVendas: [25965853179] });
        await delay(500);

        const r2 = await fetchBlingPost(token, { idVendas: [16085416930] });
        await delay(500);

        const r3 = await fetchBlingGet(token, "?idVendas[]=25965853179");

        return Response.json({
          r1: { desc: "POST idVenda (numero venda)", payload: { idVendas: [25965853179] }, ...r1 },
          r2: { desc: "POST idVolume (numero volume)", payload: { idVendas: [16085416930] }, ...r2 },
          r3: { desc: "GET idVendas[]=25965853179", ...r3 },
        });
      },
    },
  },
});
