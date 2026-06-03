// Proxies token requests to Mercado Livre.
// Workaround for Cloudflare Worker -> api.mercadolivre.com error 1016/530.
// This function runs on Supabase (Deno Deploy), outside Cloudflare's network.

const ML_TOKEN_URL = "https://api.mercadolivre.com/oauth/token";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface TokenInput {
  grant_type: "authorization_code" | "refresh_token";
  client_id: string;
  client_secret: string;
  code?: string;
  refresh_token?: string;
  redirect_uri?: string;
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

  let input: TokenInput;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!input.grant_type || !input.client_id || !input.client_secret) {
    return new Response(JSON.stringify({ error: "missing_fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const params = new URLSearchParams({
    grant_type: input.grant_type,
    client_id: input.client_id,
    client_secret: input.client_secret,
  });
  if (input.code) params.set("code", input.code);
  if (input.refresh_token) params.set("refresh_token", input.refresh_token);
  if (input.redirect_uri) params.set("redirect_uri", input.redirect_uri);

  const mlRes = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "EXPEDE/1.0 (expede.lovable.app)",
    },
    body: params.toString(),
  });

  const rawBody = await mlRes.text();
  console.log(
    "[ml-token-exchange] ML status:",
    mlRes.status,
    "content-type:",
    mlRes.headers.get("content-type"),
    "body (first 400):",
    rawBody.slice(0, 400),
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
