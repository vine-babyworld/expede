// Proxy para buscar o repasse financeiro de um pedido no ML.
// Cloudflare Workers não alcança api.mercadolibre.com diretamente (erro 1016/530).
// Molde idêntico a ml-shipment-status.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface BillingInput {
  ml_order_id: string;
  access_token: string;
}

interface ItemBilling {
  unit_price: number;
  quantity: number;
  sale_fee: number;
}

export interface BillingPayload {
  ok: boolean;
  order_items?: ItemBilling[];
  custo_envio?: number;
  shipment_status?: string | null;
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

function extrairItens(order: any): ItemBilling[] {
  return (order?.order_items ?? []).map((i: any) => ({
    unit_price: Number(i?.unit_price ?? 0),
    quantity: Number(i?.quantity ?? 0),
    sale_fee: Number(i?.sale_fee ?? 0),
  }));
}

// Custo que o VENDEDOR paga pelo envio: senders[0].cost de /shipments/{id}/costs.
// Não confundir com receiver.cost, que é o que o comprador pagou.
async function buscarCustoEnvio(
  shipmentId: number | null,
  token: string,
): Promise<{ custo: number; status: string | null }> {
  if (!shipmentId) return { custo: 0, status: null };

  const rShip = await fetch(`${ML_HOST}/shipments/${shipmentId}`, {
    headers: baseHeaders(token),
  });
  const status = rShip.ok ? ((await rShip.json())?.status ?? null) : null;

  const rCost = await fetch(`${ML_HOST}/shipments/${shipmentId}/costs`, {
    headers: baseHeaders(token),
  });

  if (!rCost.ok) {
    console.log(`[ml-order-billing] costs shipment=${shipmentId} -> ${rCost.status}`);
    return { custo: 0, status };
  }

  const costs: any = await rCost.json();
  const custo = Number(costs?.senders?.[0]?.cost ?? 0);
  return { custo, status };
}

async function resolveBilling(mlOrderId: string, token: string): Promise<BillingPayload> {
  const r1 = await fetch(`${ML_HOST}/orders/${mlOrderId}`, { headers: baseHeaders(token) });

  if (r1.ok) {
    const order: any = await r1.json();
    const { custo, status } = await buscarCustoEnvio(order?.shipping?.id ?? null, token);
    console.log(
      `[ml-order-billing] order=${mlOrderId} itens=${order?.order_items?.length ?? 0} frete=${custo} status=${status}`,
    );
    return {
      ok: true,
      order_items: extrairItens(order),
      custo_envio: custo,
      shipment_status: status,
    };
  }

  if (r1.status !== 404) {
    return { ok: false, error: `orders_error:${r1.status}` };
  }

  // Carrinho/pack: soma os itens de todos os pedidos, mas o frete é UM só —
  // por isso ele é buscado fora do laço, pelo shipping do pack.
  console.log(`[ml-order-billing] /orders/${mlOrderId} -> 404, tentando /packs`);
  const rPack = await fetch(`${ML_HOST}/packs/${mlOrderId}`, { headers: baseHeaders(token) });

  if (!rPack.ok) {
    return { ok: false, error: `pack_not_found:${rPack.status}` };
  }

  const pack: any = await rPack.json();
  const orders: any[] = pack?.orders ?? [];
  if (orders.length === 0) {
    return { ok: false, error: "pack_sem_orders" };
  }

  const itens: ItemBilling[] = [];
  let shipmentId: number | null = pack?.shipment?.id ?? null;

  for (const ref of orders) {
    const rOrder = await fetch(`${ML_HOST}/orders/${ref.id}`, { headers: baseHeaders(token) });
    if (!rOrder.ok) {
      return { ok: false, error: `pack_order_error:${ref.id}:${rOrder.status}` };
    }
    const order: any = await rOrder.json();
    itens.push(...extrairItens(order));
    if (!shipmentId) shipmentId = order?.shipping?.id ?? null;
  }

  const { custo, status } = await buscarCustoEnvio(shipmentId, token);
  console.log(
    `[ml-order-billing] pack=${mlOrderId} orders=${orders.length} itens=${itens.length} frete=${custo}`,
  );

  return { ok: true, order_items: itens, custo_envio: custo, shipment_status: status };
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

  let input: BillingInput;
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
    const result = await resolveBilling(input.ml_order_id, input.access_token);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[ml-order-billing] erro:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
