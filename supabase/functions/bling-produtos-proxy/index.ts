// Proxies Bling /Api/v3/produtos requests via Supabase Edge Function.
// Cloudflare Workers are blocked by Bling's CDN (HTTP 403 "Just a moment...").
// Runs on Supabase (Deno Deploy), outside Cloudflare's IP pool.

// Headers de diagnóstico repassados ao cliente: permitem distinguir um 403 do WAF
// (bloqueio de IP de datacenter, corpo HTML/vazio, server=cloudflare, cf-mitigated)
// de um 403 legítimo da API do Bling (corpo JSON).
const DIAG_HEADERS = ["server", "cf-ray", "cf-mitigated", "content-type"];

function collectDiagHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DIAG_HEADERS) {
    const value = res.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const { url, access_token } = await req.json();

    if (
      typeof url !== "string" ||
      typeof access_token !== "string" ||
      !url.startsWith("https://api.bling.com.br/")
    ) {
      return new Response(
        JSON.stringify({ ok: false, status: 400, body: "invalid_request" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/json",
        // O Cloudflare do Bling desafia requisições de datacenter que chegam sem
        // User-Agent reconhecível (o Deno manda o dele, "Deno/x.y.z"). Identificar a
        // aplicação de verdade é o que separa um cliente legítimo de um scraper aos
        // olhos do WAF — não é disfarce de navegador, é o cabeçalho que faltava.
        "User-Agent": "EXPEDE/1.0 (+https://babyworld.expede.workers.dev; integracao Bling)",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
    });
    const body = await res.text();

    return new Response(
      JSON.stringify({
        ok: res.ok,
        status: res.status,
        body,
        headers: collectDiagHeaders(res),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, status: 0, body: String(err) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
});
