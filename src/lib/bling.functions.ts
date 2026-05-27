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

async function encryptToken(plain: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  const ct = new Uint8Array(ctBuf);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return "\\x" + bytesToHex(out);
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
  // Copia para ArrayBuffer próprio para satisfazer BufferSource estrito.
  const iv = b.slice(0, 12);
  const ct = b.slice(12);
  const pt = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function basicAuthHeader(): string {
  const id = process.env.BLING_CLIENT_ID!;
  const secret = process.env.BLING_CLIENT_SECRET!;
  return "Basic " + btoa(`${id}:${secret}`);
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
    const state = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(24)));

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
    refreshPlain = await decryptToken(conn.refresh_token as unknown as string);
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
    access_token: await encryptToken(tokenJson.access_token),
    refresh_token: await encryptToken(tokenJson.refresh_token ?? refreshPlain),

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
    access_token: await encryptToken(tj.access_token),
    refresh_token: await encryptToken(tj.refresh_token),

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

// =====================================================
// Helpers expostos para o módulo de produtos / callback
// =====================================================

/**
 * Retorna access token plaintext da conexão. Se já expirou (ou expira em < 60s),
 * tenta refresh antes. Lança em caso de falha definitiva.
 */
export async function getDecryptedAccessToken(connectionId: string): Promise<string> {
  const { data: conn, error } = await supabaseAdmin
    .from("bling_connections")
    .select("id, access_token, access_expires_at, status")
    .eq("id", connectionId)
    .maybeSingle();
  if (error || !conn) throw new Error("Conexão Bling não encontrada");

  const exp = conn.access_expires_at ? new Date(conn.access_expires_at).getTime() : 0;
  if (exp <= Date.now() + 60_000 || conn.status !== "connected") {
    const r = await refreshConnectionById(connectionId);
    if (!r.ok) throw new Error("Falha ao renovar token Bling: " + r.error);
    const { data: refreshed } = await supabaseAdmin
      .from("bling_connections")
      .select("access_token")
      .eq("id", connectionId)
      .maybeSingle();
    if (!refreshed?.access_token) throw new Error("Token indisponível após refresh");
    return decryptToken(refreshed.access_token as unknown as string);
  }
  return decryptToken(conn.access_token as unknown as string);
}

export type UpdateNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: "no_name" | "missing_scope" | "endpoint_not_found" | "auth_failed" | "unknown"; message: string };

/**
 * Best-effort: descobre o nome real da empresa Bling. Nunca lança.
 * Sempre retorna um discriminated union.
 */
export async function updateBlingAccountNameInternal(
  connectionId: string,
): Promise<UpdateNameResult> {
  const extractName = (json: any): string | null => {
    const d = json?.data ?? json;
    const e = Array.isArray(d) ? d[0] : d;
    const n =
      e?.nomeFantasia?.toString?.().trim() ||
      e?.nome?.toString?.().trim() ||
      e?.razaoSocial?.toString?.().trim() ||
      e?.fantasia?.toString?.().trim() ||
      e?.empresa?.nome?.toString?.().trim() ||
      null;
    const id = e?.id?.toString?.() ?? e?.numeroDocumento ?? null;
    return n ? n : null;
    void id;
  };

  try {
    let token: string;
    try {
      token = await getDecryptedAccessToken(connectionId);
    } catch (e: any) {
      return { ok: false, reason: "auth_failed", message: "Falha ao obter token Bling: " + (e?.message ?? "desconhecido") };
    }

    const endpoints = [
      "https://www.bling.com.br/Api/v3/empresas/me",
      "https://www.bling.com.br/Api/v3/empresas",
    ];
    let lastStatus: number | null = null;

    for (const url of endpoints) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      } catch (e: any) {
        console.warn("[updateBlingAccountName] network err", url, e?.message);
        continue;
      }
      lastStatus = res.status;

      if (res.ok) {
        const json: any = await res.json().catch(() => ({}));
        const name = extractName(json);
        if (!name) {
          console.warn("[updateBlingAccountName] resposta sem nome:", JSON.stringify(json).slice(0, 500));
          return { ok: false, reason: "no_name", message: "Bling retornou dados da empresa mas sem nome em campo reconhecido." };
        }
        const d = json?.data ?? json;
        const e = Array.isArray(d) ? d[0] : d;
        const blingId = e?.id?.toString?.() ?? e?.numeroDocumento ?? null;
        const update: any = { bling_account_name: name };
        if (blingId) update.bling_account_id = blingId;
        const { error } = await supabaseAdmin.from("bling_connections").update(update).eq("id", connectionId);
        if (error) return { ok: false, reason: "unknown", message: "Falha ao salvar nome: " + error.message };
        return { ok: true, name };
      }

      if (res.status === 403) {
        return {
          ok: false,
          reason: "missing_scope",
          message: 'Escopo "Visualizar dados básicos da empresa" não está marcado no app Bling. Marque o escopo no painel do Bling e refaça a autorização.',
        };
      }
      if (res.status === 401) {
        // tenta refresh + retry uma vez
        const r = await refreshConnectionById(connectionId);
        if (!r.ok) return { ok: false, reason: "auth_failed", message: "Token expirado e refresh falhou. Reconecte o Bling." };
        try { token = await getDecryptedAccessToken(connectionId); } catch { continue; }
        const res2 = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        lastStatus = res2.status;
        if (res2.ok) {
          const json: any = await res2.json().catch(() => ({}));
          const name = extractName(json);
          if (!name) return { ok: false, reason: "no_name", message: "Bling retornou dados sem nome reconhecido." };
          const d = json?.data ?? json;
          const e = Array.isArray(d) ? d[0] : d;
          const blingId = e?.id?.toString?.() ?? e?.numeroDocumento ?? null;
          const update: any = { bling_account_name: name };
          if (blingId) update.bling_account_id = blingId;
          await supabaseAdmin.from("bling_connections").update(update).eq("id", connectionId);
          return { ok: true, name };
        }
        if (res2.status === 401) return { ok: false, reason: "auth_failed", message: "Falha de autenticação após refresh. Reconecte o Bling." };
      }
    }

    return {
      ok: false,
      reason: "endpoint_not_found",
      message: `Não foi possível obter dados da empresa no Bling (último status: ${lastStatus ?? "n/a"}).`,
    };
  } catch (e: any) {
    console.error("[updateBlingAccountName] erro inesperado:", e);
    return { ok: false, reason: "unknown", message: "Erro inesperado: " + (e?.message ?? "desconhecido") };
  }
}

/** Server fn pública para o botão "Atualizar nome". Nunca lança para casos esperados. */
export const updateBlingAccountName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId: string }) => d)
  .handler(async ({ data, context }): Promise<UpdateNameResult> => {
    const { userId } = context;
    const { data: conn } = await supabaseAdmin
      .from("bling_connections")
      .select("user_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (!conn) return { ok: false, reason: "unknown", message: "Conexão não encontrada" };
    if (conn.user_id !== userId) return { ok: false, reason: "unknown", message: "Sem permissão" };
    return updateBlingAccountNameInternal(data.connectionId);
  });

// =====================================================
// DIAGNÓSTICO (temporário) — descobrir endpoint correto
// =====================================================

type EndpointTestResult = {
  url: string;
  status: number;
  contentType: string;
  bodyPreview: string;
  durationMs: number;
  isJson: boolean;
  parsedKeys: string[] | null;
  networkError?: string;
};

export type DiagnoseResult =
  | {
      ok: true;
      connection_id: string;
      scopes_in_token: string | null;
      results: EndpointTestResult[];
    }
  | { ok: false; error: string };

function extractTokenScopes(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payloadRaw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadRaw + "===".slice((payloadRaw.length + 3) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const payload = JSON.parse(decoded);
    if (typeof payload.scope === "string") {
      return payload.scope;
    }
    if (Array.isArray(payload.scopes)) {
      return payload.scopes.join(" ");
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

async function testEndpoint(url: string, token: string): Promise<EndpointTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    const contentType = res.headers.get("content-type") ?? "";
    const bodyText = await res.text();
    const bodyPreview = bodyText.length > 2000 ? bodyText.slice(0, 2000) + "…[truncado]" : bodyText;
    const durationMs = Date.now() - start;
    let isJson = false;
    let parsedKeys: string[] | null = null;
    try {
      const parsed = JSON.parse(bodyText);
      isJson = true;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedKeys = Object.keys(parsed);
      } else if (Array.isArray(parsed)) {
        parsedKeys = ["<array>"];
      }
    } catch {
      isJson = false;
    }
    return { url, status: res.status, contentType, bodyPreview, durationMs, isJson, parsedKeys };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      url,
      status: 0,
      contentType: "",
      bodyPreview: "",
      durationMs: Date.now() - start,
      isJson: false,
      parsedKeys: null,
      networkError: msg,
    };
  }
}

export const diagnoseBlingEmpresaEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId: string }) => d)
  .handler(async ({ data, context }): Promise<DiagnoseResult> => {
    try {
      const { userId } = context;
      const { data: conn } = await supabaseAdmin
        .from("bling_connections")
        .select("user_id")
        .eq("id", data.connectionId)
        .maybeSingle();
      if (!conn) return { ok: false, error: "Conexão não encontrada" };
      if (conn.user_id !== userId) return { ok: false, error: "Sem permissão" };

      let token: string;
      try {
        token = await getDecryptedAccessToken(data.connectionId);
      } catch (e: any) {
        return { ok: false, error: "Falha ao obter token: " + (e?.message ?? "?") };
      }

      const scopes = extractTokenScopes(token);

      const urls = [
        "https://api.bling.com.br/Api/v3/empresas/me",
        "https://api.bling.com.br/Api/v3/empresas",
        "https://api.bling.com.br/Api/v3/empresa",
        "https://api.bling.com.br/Api/v3/empresa/me",
        "https://api.bling.com.br/Api/v3/usuarios/me",
        "https://api.bling.com.br/Api/v3/me",
        "https://api.bling.com.br/Api/v3/account",
        "https://api.bling.com.br/Api/v3/contas/me",
      ];

      const results: EndpointTestResult[] = [];
      for (const url of urls) {
        const r = await testEndpoint(url, token);
        results.push(r);
      }

      return { ok: true, connection_id: data.connectionId, scopes_in_token: scopes, results };
    } catch (e: any) {
      return { ok: false, error: "Erro inesperado: " + (e?.message ?? "?") };
    }
  });


/** Helper: dado um state recém-usado, encontra a conexão recém-criada para o user. */
export async function findLatestConnectionByState(state: string): Promise<string | null> {
  const { data: st } = await supabaseAdmin
    .from("oauth_states")
    .select("user_id")
    .eq("state", state)
    .maybeSingle();
  if (!st?.user_id) return null;
  const { data: c } = await supabaseAdmin
    .from("bling_connections")
    .select("id")
    .eq("user_id", st.user_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return c?.id ?? null;
}

