// Proxies shipment label requests to Mercado Livre.
// Workaround for Cloudflare Worker -> api.mercadolivre.com error 1016/530.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface LabelInput {
  shipment_id: string;
  access_token: string;
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

  if (!input.shipment_id || !input.access_token) {
    return new Response(JSON.stringify({ error: "missing_fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = `https://api.mercadolivre.com/shipments/${encodeURIComponent(
    input.shipment_id,
  )}/label?response_type=zpl`;

  const mlRes = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.access_token}`,
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "EXPEDE/1.0 (expede.lovable.app)",
    },
  });

  const rawBody = await mlRes.text();
  console.log(
    "[ml-label] shipment:",
    input.shipment_id,
    "status:",
    mlRes.status,
    "content-type:",
    mlRes.headers.get("content-type"),
    "body (first 200):",
    rawBody.slice(0, 200),
  );

  return new Response(
    JSON.stringify({
      ok: mlRes.ok,
      status: mlRes.status,
      body: rawBody,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
