// Proxies Bling /Api/v3/produtos requests via Supabase Edge Function.
// Cloudflare Workers are blocked by Bling's CDN (HTTP 403 "Just a moment...").
// Runs on Supabase (Deno Deploy), outside Cloudflare's IP pool.

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
      },
    });
    const body = await res.text();

    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status, body }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, status: 0, body: String(err) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
});
