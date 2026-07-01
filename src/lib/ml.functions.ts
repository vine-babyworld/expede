import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ML_CLIENT_ID = process.env.ML_CLIENT_ID!;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET!;
const ML_REDIRECT_URI = "https://expede.lovable.app/api/ml/callback";
const ML_AUTH_URL = "https://auth.mercadolivre.com.br/authorization";

// ── Auth URL ─────────────────────────────────────────────────────────────────

export function getMLAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ML_CLIENT_ID,
    redirect_uri: ML_REDIRECT_URI,
  });
  return `${ML_AUTH_URL}?${params.toString()}`;
}

// ── Edge function proxy helper ───────────────────────────────────────────────

type ProxyResponse = { ok: boolean; status: number; body: string };

async function invokeMLProxy(fn: string, payload: Record<string, unknown>): Promise<ProxyResponse> {
  const { data, error } = await supabaseAdmin.functions.invoke<ProxyResponse>(fn, {
    body: payload,
  });
  if (error) {
    throw new Error(`edge_invoke_failed:${fn}:${error.message}`);
  }
  if (!data) {
    throw new Error(`edge_empty_response:${fn}`);
  }
  return data;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeMLCode(code: string): Promise<void> {
  const proxy = await invokeMLProxy("ml-token-exchange", {
    grant_type: "authorization_code",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    code,
    redirect_uri: ML_REDIRECT_URI,
  });

  let json: any = {};
  try { json = JSON.parse(proxy.body); } catch { /* not json */ }

  if (!proxy.ok) {
    console.error("[ml] exchange falhou status:", proxy.status, "body:", proxy.body.slice(0, 400));
    throw new Error(json?.message ?? `ML token exchange HTTP ${proxy.status}: ${proxy.body.slice(0, 200)}`);
  }

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 21600) * 1000).toISOString();

  const { error } = await supabaseAdmin.from("ml_connections").upsert(
    {
      ml_user_id: json.user_id,
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "ml_user_id" },
  );

  if (error) throw new Error("Falha ao salvar conexão ML: " + error.message);
  console.log("[ml] conexão salva para user_id:", json.user_id);
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshMLToken(conn: {
  id: string;
  ml_user_id: number;
  refresh_token: string;
}): Promise<string> {
  const proxy = await invokeMLProxy("ml-token-exchange", {
    grant_type: "refresh_token",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: conn.refresh_token,
  });

  let json: any = {};
  try { json = JSON.parse(proxy.body); } catch { /* not json */ }

  if (!proxy.ok) {
    console.error("[ml] refresh falhou status:", proxy.status, "body:", proxy.body.slice(0, 400));
    throw new Error(json?.message ?? `ML refresh HTTP ${proxy.status}: ${proxy.body.slice(0, 200)}`);
  }

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 21600) * 1000).toISOString();

  await supabaseAdmin
    .from("ml_connections")
    .update({
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? conn.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conn.id);

  return json.access_token as string;
}

// ── Get valid token ───────────────────────────────────────────────────────────

export async function getMLAccessToken(): Promise<string> {
  const { data: conn, error } = await supabaseAdmin
    .from("ml_connections")
    .select("id, ml_user_id, access_token, refresh_token, expires_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !conn) throw new Error("Nenhuma conexão ML ativa");

  const exp = new Date(conn.expires_at).getTime();
  if (exp <= Date.now() + 60_000) {
    return refreshMLToken(conn as any);
  }
  return conn.access_token;
}

// ── Busca etiqueta ────────────────────────────────────────────────────────────

export type MLEtiquetaResult =
  | { ok: true; conteudo: string }
  | { ok: false; error: string };

export async function buscarEtiquetaML(mlOrderId: string): Promise<MLEtiquetaResult> {
  let token: string;
  try {
    token = await getMLAccessToken();
  } catch {
    return { ok: false, error: "ml_no_connection" };
  }

  let proxy: ProxyResponse;
  try {
    proxy = await invokeMLProxy("ml-label", { ml_order_id: mlOrderId, access_token: token });
  } catch (e) {
    console.warn("[ml] invoke ml-label falhou:", e);
    return { ok: false, error: "ml_proxy_error" };
  }

  if (!proxy.ok) {
    // Tenta extrair mensagem de erro estruturada da edge function
    let errMsg = `ml_api_error:${proxy.status}`;
    try {
      const parsed = JSON.parse(proxy.body);
      if (parsed?.message) errMsg = parsed.message;
      else if (parsed?.error) errMsg = parsed.error;
    } catch { /* body não é JSON */ }
    console.warn("[ml] label falhou:", proxy.status, proxy.body.slice(0, 200));
    return { ok: false, error: errMsg };
  }

  const text = proxy.body;
  if (!text || (!text.includes("^XA") && !text.startsWith("CT~~"))) {
    console.warn("[ml] label não é ZPL:", text.slice(0, 120));
    return { ok: false, error: "ml_not_zpl" };
  }

  return { ok: true, conteudo: text };
}

// ── Checagem de status de envio (cron leve) ───────────────────────────────────

// Statuses que indicam que o ML já despachou/entregou o pedido.
// Mapeados a partir de pedidos reais (incluindo pedido #8248).
const ML_DESPACHADO_STATUSES = new Set(["shipped", "delivered"]);

export type MLShipmentCheckResult =
  | { ok: true; status: string; substatus: string | null; despachado: boolean }
  | { ok: false; error: string };

export async function checarStatusEnvioML(mlOrderId: string): Promise<MLShipmentCheckResult> {
  let token: string;
  try {
    token = await getMLAccessToken();
  } catch {
    return { ok: false, error: "ml_no_connection" };
  }

  let data: any;
  try {
    const { data: proxyData, error } = await supabaseAdmin.functions.invoke<any>(
      "ml-shipment-status",
      { body: { ml_order_id: mlOrderId, access_token: token } },
    );
    if (error) return { ok: false, error: `edge_invoke:${error.message}` };
    data = proxyData;
  } catch (e) {
    return { ok: false, error: `edge_invoke_exception:${String(e)}` };
  }

  if (!data?.ok) {
    return { ok: false, error: data?.error ?? "unknown_error" };
  }

  const status: string = data.status ?? "";
  const substatus: string | null = data.substatus ?? null;
  const despachado = ML_DESPACHADO_STATUSES.has(status);

  return { ok: true, status, substatus, despachado };
}

// ── Server functions (UI) ─────────────────────────────────────────────────────

export type MLConnectionStatus =
  | { connected: true; ml_user_id: number; expires_at: string }
  | { connected: false };

export const getMLConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<MLConnectionStatus> => {
    const { data } = await supabaseAdmin
      .from("ml_connections")
      .select("ml_user_id, expires_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return { connected: false };
    return { connected: true, ml_user_id: data.ml_user_id, expires_at: data.expires_at };
  });

export const disconnectML = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ ok: boolean }> => {
    const { error } = await supabaseAdmin.from("ml_connections").delete().gte("created_at", "2000-01-01");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
