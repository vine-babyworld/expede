import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BLING_AUTH_URL = "https://www.bling.com.br/Api/v3/oauth/authorize";
const BLING_TOKEN_URL = "https://www.bling.com.br/Api/v3/oauth/token";

// ---- Crypto via Web Crypto API (Cloudflare Workers + browser, sem node:*) ----
// Formato bytea: [12-byte IV][ciphertext + 16-byte authTag concatenado pelo WebCrypto]
async function getCryptoKey(): Promise<CryptoKey> {
  const raw = process.env.BLING_ENCRYPTION_KEY;
  if (!raw) throw new Error("BLING_ENCRYPTION_KEY não configurado");
  const enc = new TextEncoder();
  const hash = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(raw));
  return globalThis.crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function encryptToken(plain: string): Promise<Uint8Array> {
  const key = await getCryptoKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

async function decryptToken(buf: Uint8Array | string): Promise<string> {
  const key = await getCryptoKey();
  let b: Uint8Array;
  if (typeof buf === "string") {
    const hex = buf.startsWith("\\x") ? buf.slice(2) : buf;
    b = hexToBytes(hex);
  } else {
    b = buf;
  }
  const iv = b.subarray(0, 12);
  const ct = b.subarray(12);
  const pt = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// Bytea para Postgres via supabase-js: enviar como string hex "\x...."
function bytesToBytea(b: Uint8Array): string {
  return "\\x" + bytesToHex(b);
}

function b64encode(s: string): string {
  // btoa funciona em Workers e browser
  return btoa(s);
}

function basicAuthHeader(): string {
  const id = process.env.BLING_CLIENT_ID!;
  const secret = process.env.BLING_CLIENT_SECRET!;
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function fetchAccountInfo(accessToken: string): Promise<{ id?: string; name?: string }> {
  try {
    const res = await fetch("https://www.bling.com.br/Api/v3/empresas/me", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const json: any = await res.json();
    const data = json?.data ?? json;
    return {
      id: data?.id?.toString?.() ?? data?.numeroDocumento ?? undefined,
      name: data?.nome ?? data?.razaoSocial ?? data?.fantasia ?? undefined,
    };
  } catch {
    return {};
  }
}

/** Inicia o fluxo OAuth: gera state, salva e retorna a URL de autorização. */
export const blingOAuthStart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const state = randomBytes(24).toString("hex");

    const { error } = await supabaseAdmin
      .from("oauth_states")
      .insert({ state, user_id: userId });
    if (error) throw new Error("Falha ao gerar state: " + error.message);

    try { await supabaseAdmin.rpc("cleanup_oauth_states"); } catch { /* ignore */ }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: process.env.BLING_CLIENT_ID!,
      state,
    });
    return { url: `${BLING_AUTH_URL}?${params.toString()}` };
  });

/** Lista (status, sem tokens) — usada pela tela de configurações. */
export const getBlingConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const { data, error } = await supabaseAdmin
      .from("bling_connections_status")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

/** Renova um token específico (com checagem de dono). */
export const blingRefreshToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { data: conn } = await supabaseAdmin
      .from("bling_connections")
      .select("user_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (!conn) throw new Error("Conexão não encontrada");
    if (conn.user_id !== userId) throw new Error("Sem permissão");
    const r = await refreshConnectionById(data.connectionId);
    if (!r.ok) throw new Error(r.error);
    return { ok: true };
  });

/** Helper interno: renova um token por id (sem checagem de auth). */
export async function refreshConnectionById(
  connectionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: conn, error: errConn } = await supabaseAdmin
    .from("bling_connections")
    .select("id, refresh_token")
    .eq("id", connectionId)
    .maybeSingle();
  if (errConn || !conn) return { ok: false, error: "Conexão não encontrada" };

  let refreshPlain: string;
  try {
    refreshPlain = decryptToken(conn.refresh_token as unknown as string);
  } catch {
    return { ok: false, error: "Falha ao decriptar refresh_token" };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshPlain,
  });
  const res = await fetch(BLING_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const tokenJson: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = tokenJson?.error_description ?? tokenJson?.error ?? `HTTP ${res.status}`;
    await supabaseAdmin
      .from("bling_connections")
      .update({ status: "expired", last_error: String(msg) } as any)
      .eq("id", conn.id);
    return { ok: false, error: String(msg) };
  }

  const now = Date.now();
  const accessExp = new Date(now + (tokenJson.expires_in ?? 21600) * 1000);
  const refreshExp = new Date(now + (tokenJson.refresh_expires_in ?? 30 * 24 * 3600) * 1000);

  const updatePayload: any = {
    access_token: encryptToken(tokenJson.access_token),
    refresh_token: encryptToken(tokenJson.refresh_token ?? refreshPlain),
    access_expires_at: accessExp.toISOString(),
    refresh_expires_at: refreshExp.toISOString(),
    scope: tokenJson.scope ?? null,
    status: "connected",
    last_refresh_at: new Date().toISOString(),
    last_error: null,
  };
  const { error: updErr } = await supabaseAdmin
    .from("bling_connections")
    .update(updatePayload)
    .eq("id", conn.id);
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true };
}

/** Desconecta (apaga conexão). */
export const blingDisconnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { error } = await supabaseAdmin
      .from("bling_connections")
      .delete()
      .eq("id", data.connectionId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Internal helper exposto p/ a rota de callback. */
export async function exchangeCodeAndStore(params: {
  code: string;
  state: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: st, error: stErr } = await supabaseAdmin
    .from("oauth_states")
    .select("state, user_id, used, created_at")
    .eq("state", params.state)
    .maybeSingle();
  if (stErr || !st) return { ok: false, error: "state inválido" };
  if (st.used) return { ok: false, error: "state já utilizado" };
  const ageMs = Date.now() - new Date(st.created_at).getTime();
  if (ageMs > 10 * 60 * 1000) return { ok: false, error: "state expirado" };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
  });
  const res = await fetch(BLING_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const tj: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = tj?.error_description ?? tj?.error ?? `HTTP ${res.status}`;
    return { ok: false, error: String(msg) };
  }

  await supabaseAdmin.from("oauth_states").update({ used: true }).eq("state", params.state);

  const account = await fetchAccountInfo(tj.access_token);

  const now = Date.now();
  const accessExp = new Date(now + (tj.expires_in ?? 21600) * 1000);
  const refreshExp = new Date(now + (tj.refresh_expires_in ?? 30 * 24 * 3600) * 1000);

  const insertPayload: any = {
    user_id: st.user_id,
    bling_account_id: account.id ?? null,
    bling_account_name: account.name ?? "Conta Bling",
    access_token: encryptToken(tj.access_token),
    refresh_token: encryptToken(tj.refresh_token),
    access_expires_at: accessExp.toISOString(),
    refresh_expires_at: refreshExp.toISOString(),
    scope: tj.scope ?? null,
    status: "connected",
    last_refresh_at: new Date().toISOString(),
  };
  const { error: insErr } = await supabaseAdmin.from("bling_connections").insert(insertPayload);
  if (insErr) return { ok: false, error: insErr.message };
  return { ok: true };
}
