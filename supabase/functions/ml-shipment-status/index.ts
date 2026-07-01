// Proxy leve para checar status de envio no ML sem baixar etiqueta.
// Cloudflare Workers não alcança api.mercadolibre.com diretamente (erro 1016/530).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface StatusInput {
  ml_order_id: string;
  access_token: string;
}

export interface ShipmentStatusPayload {
  ok: boolean;
  shipment_id?: number;
  status?: string;
  substatus?: string;
  logistic_type?: string;
  error?: string;
}

const ML_HOST = "https://api.mercadolibre.com";

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "EXPEDE/1.0 (expede.lovable.app)",
  };
}

async function resolveShipmentStatus(
  mlOrderId: string,
  token: string,
): Promise<ShipmentStatusPayload> {
  // Tentativa 1: pedido simples
  const r1 = await fetch(`${ML_HOST}/orders/${mlOrderId}/shipments`, {
    headers: baseHeaders(token),
  });

  if (r1.ok) {
    const s = await r1.json();
    console.log(`[ml-shipment-status] order=${mlOrderId} status=${s.status} substatus=${s.substatus} logistic_type=${s.logistic_type}`);
    return {
      ok: true,
      shipment_id: s.id,
      status: s.status,
      substatus: s.substatus ?? undefined,
      logistic_type: s.logistic_type,
    };
  }

  console.log(`[ml-shipment-status] /orders/${mlOrderId}/shipments → ${r1.status}, tentando /packs`);

  if (r1.status !== 404) {
    return { ok: false, error: `orders_shipments_error:${r1.status}` };
  }

  // Tentativa 2: carrinho/pack
  const rPack = await fetch(`${ML_HOST}/packs/${mlOrderId}`, {
    headers: baseHeaders(token),
  });

  if (!rPack.ok) {
    return { ok: false, error: `pack_not_found:${rPack.status}` };
  }

  const pack: any = await rPack.json();
  const orderId = pack?.orders?.[0]?.id;
  if (!orderId) {
    return { ok: false, error: "pack_sem_orders" };
  }

  const r2 = await fetch(`${ML_HOST}/orders/${orderId}/shipments`, {
    headers: baseHeaders(token),
  });

  if (!r2.ok) {
    return { ok: false, error: `pack_shipments_error:${r2.status}` };
  }

  const s = await r2.json();
  console.log(`[ml-shipment-status] order=${mlOrderId} via pack→${orderId} status=${s.status} substatus=${s.substatus}`);
  return {
    ok: true,
    shipment_id: s.id,
    status: s.status,
    substatus: s.substatus ?? undefined,
    logistic_type: s.logistic_type,
  };
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

  let input: StatusInput;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!input.ml_order_id || !input.access_token) {
    return new Response(JSON.stringify({ ok: false, error: "missing_fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const result = await resolveShipmentStatus(input.ml_order_id, input.access_token);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[ml-shipment-status] erro:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
