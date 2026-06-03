import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ML_CLIENT_ID = process.env.ML_CLIENT_ID!;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET!;
const ML_REDIRECT_URI = "https://expede.lovable.app/api/ml/callback";
const ML_AUTH_URL = "https://auth.mercadolivre.com.br/authorization";
const ML_TOKEN_URL = "https://api.mercadolivre.com/oauth/token";
const ML_API = "https://api.mercadolivre.com";

// ── Auth URL ─────────────────────────────────────────────────────────────────

export function getMLAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ML_CLIENT_ID,
    redirect_uri: ML_REDIRECT_URI,
  });
  return `${ML_AUTH_URL}?${params.toString()}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeMLCode(code: string): Promise<void> {
  const res = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI,
    }).toString(),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.message ?? `ML token exchange HTTP ${res.status}`);
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
  const res = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }).toString(),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.message ?? `ML refresh HTTP ${res.status}`);
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

export async function buscarEtiquetaML(shipmentId: string): Promise<MLEtiquetaResult> {
  let token: string;
  try {
    token = await getMLAccessToken();
  } catch {
    return { ok: false, error: "ml_no_connection" };
  }

  const res = await fetch(
    `${ML_API}/shipments/${shipmentId}/label?response_type=zpl`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json,text/plain,*/*" } },
  );

  if (!res.ok) {
    console.warn("[ml] GET label falhou:", res.status);
    return { ok: false, error: `ml_api_error:${res.status}` };
  }

  const text = await res.text();
  if (!text || (!text.includes("^XA") && !text.startsWith("CT~~"))) {
    console.warn("[ml] label não é ZPL:", text.slice(0, 120));
    return { ok: false, error: "ml_not_zpl" };
  }

  return { ok: true, conteudo: text };
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
    const { error } = await supabaseAdmin.from("ml_connections").delete().neq("id", "");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
