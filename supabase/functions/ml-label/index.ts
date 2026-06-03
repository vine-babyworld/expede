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

  const ML_HOSTS = ["api.mercadolibre.com", "api.mercadolivre.com"];
  const shipmentPath = `/shipments/${encodeURIComponent(input.shipment_id)}/label?response_type=zpl`;

  const fetchInit: RequestInit = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.access_token}`,
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "EXPEDE/1.0 (expede.lovable.app)",
    },
  };

  let mlRes: Response | null = null;
  let lastErr: unknown = null;
  for (const host of ML_HOSTS) {
    const url = `https://${host}${shipmentPath}`;
    try {
      console.log("[ml-label] tentando host:", url);
      mlRes = await fetchWithRetry(url, fetchInit);
      console.log("[ml-label] sucesso conectando em:", host);
      break;
    } catch (err) {
      lastErr = err;
      console.error("[ml-label] host falhou:", host, "erro:", err);
    }
  }

  if (!mlRes) {
    console.error("[ml-label] todos os hosts falharam. Último erro:", lastErr);
    return new Response(
      JSON.stringify({
        ok: false,
        status: 0,
        body: `fetch_failed (todos hosts): ${String(lastErr instanceof Error ? lastErr.message : lastErr)}`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

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
    JSON.stringify({ ok: mlRes.ok, status: mlRes.status, body: rawBody }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
