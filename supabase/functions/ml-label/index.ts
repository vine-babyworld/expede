// Proxies ML label requests via Supabase Edge Function.
// Cloudflare Workers cannot reach api.mercadolibre.com directly (error 1016/530).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface LabelInput {
  ml_order_id: string;
  access_token: string;
}

const ML_HOST = "https://api.mercadolibre.com";
const RETRY_DELAYS_MS = [500, 1000, 2000];

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      console.warn(`[ml-label] fetch attempt ${i + 1} failed:`, err);
      if (i < RETRY_DELAYS_MS.length - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
      }
    }
  }
  throw lastErr;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "EXPEDE/1.0 (expede.lovable.app)",
    "x-format-new": "true",
  };
}

function jsonResult(payload: { ok: boolean; status: number; body: string }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveShipment(
  mlOrderId: string,
  token: string,
): Promise<{ shipment: any; source: string } | null> {
  // Tentativa 1: pedido simples
  const r1 = await fetch(`${ML_HOST}/orders/${mlOrderId}/shipments`, {
    headers: baseHeaders(token),
  });
  if (r1.ok) {
    return { shipment: await r1.json(), source: "order" };
  }

  console.log(`[ml-label] /orders/${mlOrderId}/shipments → ${r1.status}, tentando /packs`);

  if (r1.status !== 404) return null; // erro inesperado

  // Tentativa 2: carrinho/pack
  const rPack = await fetch(`${ML_HOST}/packs/${mlOrderId}`, {
    headers: baseHeaders(token),
  });
  if (!rPack.ok) {
    console.log(`[ml-label] /packs/${mlOrderId} → ${rPack.status}`);
    return null;
  }

  const pack: any = await rPack.json();
  const orderId = pack?.orders?.[0]?.id;
  if (!orderId) {
    console.log("[ml-label] pack sem orders[0].id:", JSON.stringify(pack).slice(0, 200));
    return null;
  }

  const r2 = await fetch(`${ML_HOST}/orders/${orderId}/shipments`, {
    headers: baseHeaders(token),
  });
  if (!r2.ok) {
    console.log(`[ml-label] /orders/${orderId}/shipments (via pack) → ${r2.status}`);
    return null;
  }

  return { shipment: await r2.json(), source: `pack→order:${orderId}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let input: LabelInput;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!input.ml_order_id || !input.access_token) {
    return new Response(JSON.stringify({ error: "missing_fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Resolve shipment ──────────────────────────────────────────────────────
  let resolved: { shipment: any; source: string } | null;
  try {
    resolved = await resolveShipment(input.ml_order_id, input.access_token);
  } catch (err) {
    console.error("[ml-label] erro ao resolver shipment:", err);
    return jsonResult({
      ok: false, status: 0,
      body: JSON.stringify({ error: "shipment_resolve_error", message: String(err) }),
    });
  }

  if (!resolved?.shipment?.id) {
    return jsonResult({
      ok: false, status: 404,
      body: JSON.stringify({ error: "shipment_not_found", message: "Shipment não encontrado para este pedido ML" }),
    });
  }

  const { id: shipmentId, status, substatus, logistic_type } = resolved.shipment;
  console.log(
    `[ml-label] ml_order_id=${input.ml_order_id} source=${resolved.source}`,
    `shipment_id=${shipmentId} status=${status} substatus=${substatus} logistic_type=${logistic_type}`,
  );

  // ── Validações de status ──────────────────────────────────────────────────
  if (logistic_type === "fulfillment") {
    return jsonResult({
      ok: false, status: 200,
      body: JSON.stringify({ error: "ml_fulfillment", message: "Pedido Full: etiqueta gerida pelo ML" }),
    });
  }

  if (status !== "ready_to_ship") {
    const detalhe = substatus ? ` (${substatus})` : "";
    return jsonResult({
      ok: false, status: 200,
      body: JSON.stringify({
        error: "ml_not_ready",
        message: `Etiqueta indisponível: shipment em ${status}${detalhe}`,
      }),
    });
  }

  // ── Busca ZPL ─────────────────────────────────────────────────────────────
  const labelUrl = `${ML_HOST}/shipment_labels?shipment_ids=${shipmentId}&response_type=zpl2`;
  let mlRes: Response;
  try {
    mlRes = await fetchWithRetry(labelUrl, {
      method: "GET",
      headers: {
        ...baseHeaders(input.access_token),
        Accept: "application/json,text/plain,*/*",
      },
    });
  } catch (err) {
    console.error("[ml-label] fetch label falhou:", err);
    return jsonResult({
      ok: false, status: 0,
      body: JSON.stringify({ error: "label_fetch_error", message: String(err) }),
    });
  }

  const rawBody = await mlRes.text();
  console.log(
    `[ml-label] label shipment_id=${shipmentId} status=${mlRes.status}`,
    `content-type=${mlRes.headers.get("content-type")}`,
    `body(200)=${rawBody.slice(0, 200)}`,
  );

  return jsonResult({ ok: mlRes.ok, status: mlRes.status, body: rawBody });
});
