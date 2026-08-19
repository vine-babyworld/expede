import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SHOPEE_GATEWAY_URL = "https://shopee-egress.bwbaby.com.br";

/**
 * Chamadas server-to-server pra Shopee em produção passam pelo gateway de IP
 * fixo, autenticado com o Service Token do Cloudflare Access. A URL de
 * autorização continua direta porque é aberta pelo navegador do usuário.
 */
async function shopeeFetch(shopeeUrl: string, init?: RequestInit): Promise<Response> {
  if (isShopeeSandbox()) {
    return fetch(shopeeUrl, init);
  }

  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("[SHOPEE] CF_ACCESS_CLIENT_ID/SECRET não configurados — obrigatório em produção");
  }

  const url = new URL(shopeeUrl);
  const gatewayUrl = `${SHOPEE_GATEWAY_URL}${url.pathname}${url.search}`;
  const headers = new Headers(init?.headers);
  headers.set("CF-Access-Client-Id", clientId);
  headers.set("CF-Access-Client-Secret", clientSecret);

  return fetch(gatewayUrl, { ...init, headers });
}

const SHOPEE_BASE_SANDBOX = "https://partner.test-stable.shopeemobile.com";
const SHOPEE_BASE_PROD = "https://partner.shopeemobile.com";
const SHOPEE_AUTH_PARTNER_PATH = "/api/v2/shop/auth_partner";
const SHOPEE_TOKEN_GET_PATH = "/api/v2/auth/token/get";
// "/api/v2/auth/refresh_access_token" (usado antes aqui) não existe na API da
// Shopee — devolve 404 "error_not_found" sempre. O endpoint real de refresh é
// este mesmo, com `refresh_token` no lugar de `code` no corpo da requisição.
const SHOPEE_REFRESH_TOKEN_PATH = "/api/v2/auth/access_token/get";
const SHOPEE_REDIRECT_URI = "https://babyworld.expede.workers.dev/api/shopee/callback";

// Endpoints "públicos" da Shopee — assinados sem access_token/shop_id
// (token/get e access_token/get usam o mesmo formato de assinatura).
const SHOPEE_PUBLIC_PATHS = new Set([
  SHOPEE_TOKEN_GET_PATH,
  SHOPEE_REFRESH_TOKEN_PATH,
  SHOPEE_AUTH_PARTNER_PATH,
]);

export type ShopeeConnectionRow = {
  id: string;
  shop_id: number;
  shop_name: string | null;
  partner_id: number;
  access_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  is_sandbox: boolean | null;
};

function isShopeeSandbox(): boolean {
  return process.env.SHOPEE_SANDBOX !== "false";
}

async function sha256FingerprintHex(value: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function getShopeePartnerCreds(): { partnerId: string; partnerKey: string } {
  const sandbox = isShopeeSandbox();
  const rawPartnerId = sandbox ? process.env.SHOPEE_TEST_PARTNER_ID : process.env.SHOPEE_PARTNER_ID;
  const rawPartnerKey = sandbox ? process.env.SHOPEE_TEST_PARTNER_KEY : process.env.SHOPEE_PARTNER_KEY;

  if (!rawPartnerId || !rawPartnerKey) {
    throw new Error("[SHOPEE] partner_id/partner_key não configurados no ambiente");
  }

  const partnerId = rawPartnerId.trim();
  const partnerKey = rawPartnerKey.trim();

  if (!/^\d+$/.test(partnerId)) {
    throw new Error("[SHOPEE] partner_id inválido — precisa ser numérico (sem espaços/caracteres extras)");
  }
  if (rawPartnerKey !== partnerKey) {
    throw new Error(
      "[SHOPEE] partner_key contém espaço ou quebra de linha nas bordas — provável erro de cópia do secret",
    );
  }
  if (partnerKey.length === 0) {
    throw new Error("[SHOPEE] partner_key vazia");
  }

  // Diagnóstico opcional e controlado: nunca ativo por padrão, nunca registra o
  // valor da chave — só comprimento e uma fingerprint SHA-256 abreviada, pra
  // comparar contra o console da Shopee sem expor o segredo. Desligar depois
  // de usar (não deixar SHOPEE_DEBUG_KEY_FINGERPRINT=true em produção).
  if (process.env.SHOPEE_DEBUG_KEY_FINGERPRINT === "true") {
    void sha256FingerprintHex(partnerKey).then((fp) => {
      console.log(
        `[SHOPEE][diag] partner_key length=${partnerKey.length} sha256_prefix=${fp.slice(0, 12)} sandbox=${sandbox}`,
      );
    });
  }

  return { partnerId, partnerKey };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function hmacSha256Hex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export async function generateShopeeSignature(
  path: string,
  timestamp: number,
  accessToken: string | null,
  shopId: string | number | null,
): Promise<string> {
  const { partnerId, partnerKey } = getShopeePartnerCreds();

  const baseString = SHOPEE_PUBLIC_PATHS.has(path)
    ? `${partnerId}${path}${timestamp}`
    : `${partnerId}${path}${timestamp}${accessToken ?? ""}${shopId ?? ""}`;

  return hmacSha256Hex(baseString, partnerKey);
}

export async function buildShopeeUrl(
  path: string,
  params: Record<string, string | number>,
  accessToken: string | null,
  shopId: string | number | null,
): Promise<string> {
  const { partnerId } = getShopeePartnerCreds();
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await generateShopeeSignature(path, timestamp, accessToken, shopId);
  const baseUrl = isShopeeSandbox() ? SHOPEE_BASE_SANDBOX : SHOPEE_BASE_PROD;

  const search = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
  });
  if (accessToken) search.set("access_token", accessToken);
  if (shopId !== null && shopId !== undefined) search.set("shop_id", String(shopId));
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }

  return `${baseUrl}${path}?${search.toString()}`;
}

export async function refreshShopeeTokenIfNeeded(shopId: string | number): Promise<string> {
  const { data: conn, error } = await supabaseAdmin
    .from("shopee_connections")
    .select("*")
    .eq("shop_id", Number(shopId))
    .maybeSingle();

  if (error) {
    console.error("[SHOPEE] erro ao buscar shopee_connections:", error.message);
  }
  if (!conn) {
    throw new Error("Shopee não conectada");
  }

  const row = conn as ShopeeConnectionRow;
  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  const needsRefresh = expiresAt - Date.now() < 10 * 60 * 1000;

  if (!needsRefresh) {
    return row.access_token as string;
  }

  const { partnerId } = getShopeePartnerCreds();
  const path = SHOPEE_REFRESH_TOKEN_PATH;

  try {
    // shopId vai só no corpo, não na URL: como token/get, este é um endpoint
    // "público" (sem contexto de loja pra Shopee) — colocar shop_id na
    // querystring quebra a validação de sign (error_sign), mesmo com sign
    // calculado certo pela fórmula pública (partnerId+path+timestamp).
    const url = await buildShopeeUrl(path, {}, null, null);
    const res = await shopeeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: row.refresh_token,
        shop_id: Number(shopId),
        partner_id: Number(partnerId),
      }),
    });

    const json: any = await res.json().catch(() => null);

    if (!res.ok || !json || json.error) {
      console.error("[SHOPEE] refresh_access_token falhou:", res.status, JSON.stringify(json));
      throw new Error(`shopee_refresh_failed: ${json?.error ?? res.status}`);
    }

    const accessTokenExpiresAt = new Date(Date.now() + (json.expire_in ?? 0) * 1000).toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from("shopee_connections")
      .update({
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? row.refresh_token,
        access_token_expires_at: accessTokenExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("shop_id", Number(shopId));

    if (updateErr) {
      console.error("[SHOPEE] falha ao salvar token renovado:", updateErr.message);
    }

    return json.access_token as string;
  } catch (err) {
    console.error("[SHOPEE] erro ao renovar access_token:", err);
    throw err;
  }
}

// ── Auth URL ─────────────────────────────────────────────────────────────────

export async function getShopeeAuthUrl(): Promise<string> {
  const { partnerId } = getShopeePartnerCreds();
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await generateShopeeSignature(SHOPEE_AUTH_PARTNER_PATH, timestamp, null, null);
  const baseUrl = isShopeeSandbox() ? SHOPEE_BASE_SANDBOX : SHOPEE_BASE_PROD;

  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
    redirect: SHOPEE_REDIRECT_URI,
  });

  return `${baseUrl}${SHOPEE_AUTH_PARTNER_PATH}?${params.toString()}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeShopeeCode(code: string, shopId: string): Promise<void> {
  const { partnerId } = getShopeePartnerCreds();
  const url = await buildShopeeUrl(SHOPEE_TOKEN_GET_PATH, {}, null, null);

  const res = await shopeeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      shop_id: Number(shopId),
      partner_id: Number(partnerId),
    }),
  });

  const json: any = await res.json().catch(() => null);

  if (!res.ok || !json || json.error) {
    console.error("[SHOPEE] token/get falhou:", res.status, JSON.stringify(json));
    throw new Error(json?.message ?? `Shopee token exchange HTTP ${res.status}`);
  }

  const accessTokenExpiresAt = new Date(Date.now() + (json.expire_in ?? 0) * 1000).toISOString();
  const refreshTokenExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  const { error } = await supabaseAdmin.from("shopee_connections").upsert(
    {
      shop_id: Number(shopId),
      partner_id: Number(partnerId),
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      access_token_expires_at: accessTokenExpiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
      is_sandbox: isShopeeSandbox(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id" },
  );

  if (error) throw new Error("Falha ao salvar conexão Shopee: " + error.message);
  console.log("[shopee] conexão salva para shop_id:", shopId);
}

// ── Busca etiqueta ────────────────────────────────────────────────────────────

export type ShopeeEtiquetaResult =
  | { ok: true; conteudo: string }
  | { ok: false; error: string };

// Checa se a Shopee já tem um documento de envio pronto pra este pedido —
// a Shopee gera o AWB automaticamente assim que o canal (ex: Shopee Xpress
// dropoff) atribui o ponto de coleta, ANTES de qualquer logistics_status de
// "pronto". Confirmado ao vivo: get_shipping_document_result + download
// funcionam pra pedidos ainda em LOGISTICS_REQUEST_CREATED, mesmo quando
// create_shipping_document falha com tracking_number_invalid pro mesmo
// pedido — chamar create_shipping_document de novo num documento que já
// existe é o erro, não falta de prontidão logística. Erro #28 (parte 3).
async function getShopeeDocumentStatus(
  orderSn: string,
  accessToken: string,
  shopId: string | number,
): Promise<"READY" | "FAILED" | null> {
  const url = await buildShopeeUrl(
    "/api/v2/logistics/get_shipping_document_result",
    {},
    accessToken,
    shopId,
  );
  const res = await shopeeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: [{ order_sn: orderSn }] }),
  });
  const json: any = await res.json().catch(() => null);
  return json?.response?.result_list?.[0]?.status ?? null;
}

async function pollShopeeShippingDocumentReady(
  orderSn: string,
  accessToken: string,
  shopId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = await getShopeeDocumentStatus(orderSn, accessToken, shopId);
    if (status === "READY") return true;
    if (status === "FAILED") return false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function downloadShopeeDocument(
  orderSn: string,
  accessToken: string,
  shopId: string | number,
): Promise<ShopeeEtiquetaResult> {
  const downloadUrl = await buildShopeeUrl(
    "/api/v2/logistics/download_shipping_document",
    {},
    accessToken,
    shopId,
  );
  const downloadRes = await shopeeFetch(downloadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_list: [{ order_sn: orderSn, shipping_document_type: "THERMAL_AIR_WAYBILL" }],
    }),
  });

  if (!downloadRes.ok || (downloadRes.headers.get("content-type") ?? "").includes("application/json")) {
    const errJson: any = await downloadRes.json().catch(() => null);
    console.error("[shopee] download_shipping_document falhou:", downloadRes.status, JSON.stringify(errJson));
    return { ok: false, error: errJson?.error ?? "shopee_download_document_failed" };
  }

  const buffer = await downloadRes.arrayBuffer();
  if (buffer.byteLength === 0) {
    return { ok: false, error: "shopee_empty_document" };
  }

  return { ok: true, conteudo: bytesToBase64(new Uint8Array(buffer)) };
}

export async function buscarEtiquetaShopee(orderSn: string): Promise<ShopeeEtiquetaResult> {
  const { data: conn, error } = await supabaseAdmin
    .from("shopee_connections")
    .select("shop_id")
    .eq("is_sandbox", isShopeeSandbox())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.error("[SHOPEE] erro ao buscar conexão ativa:", error.message);
  if (!conn) return { ok: false, error: "shopee_no_connection" };

  const shopId = conn.shop_id;

  let accessToken: string;
  try {
    accessToken = await refreshShopeeTokenIfNeeded(shopId);
  } catch (err) {
    // Antes retornava sempre "shopee_no_connection" (enganoso: mesmo com
    // conexão presente, um erro real de refresh — ex: path errado, refresh
    // token inválido — ficava indistinguível de "não conectado"). Erro #28.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `shopee_token_refresh_failed: ${detail}` };
  }

  try {
    // 1. A Shopee costuma já ter o documento pronto (gerado automaticamente
    // assim que o canal — ex: Shopee Xpress dropoff — atribui o ponto de
    // coleta), independente do pedido ainda estar "em processamento". Baixar
    // direto cobre tanto reimpressão (documento já gerado antes, por nós ou
    // pela própria Shopee) quanto o caso feliz comum.
    const existingStatus = await getShopeeDocumentStatus(orderSn, accessToken, shopId);
    if (existingStatus === "READY") {
      return await downloadShopeeDocument(orderSn, accessToken, shopId);
    }

    // 2. Documento ainda não existe (ou falhou antes) — tenta criar um novo.
    // Chamar create_shipping_document quando o documento JÁ existe é o que
    // gera "tracking_number_invalid" — por isso a checagem acima vem antes,
    // não depois. Erro #28 (parte 3).
    const createUrl = await buildShopeeUrl(
      "/api/v2/logistics/create_shipping_document",
      {},
      accessToken,
      shopId,
    );
    const createRes = await shopeeFetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_list: [{ order_sn: orderSn, shipping_document_type: "THERMAL_AIR_WAYBILL" }],
      }),
    });
    const createJson: any = await createRes.json().catch(() => null);

    if (!createRes.ok || !createJson || createJson.error) {
      console.error("[shopee] create_shipping_document falhou:", createRes.status, JSON.stringify(createJson));
      // Em erro de lote (ex: "common.batch_api_all_failed"), a Shopee devolve o
      // motivo real por pedido em response.result_list — sem isso, o erro
      // top-level sozinho é genérico demais pra diagnosticar (ou pro operador
      // entender) o que de fato aconteceu com ESTE pedido.
      const itemFail = createJson?.response?.result_list?.[0];
      const detail = itemFail?.fail_message ?? itemFail?.fail_error ?? createJson?.message ?? null;
      const errorCode = itemFail?.fail_error ?? createJson?.error ?? "shopee_create_document_failed";
      return { ok: false, error: detail ? `${errorCode}: ${detail}` : errorCode };
    }

    const ready = await pollShopeeShippingDocumentReady(orderSn, accessToken, shopId);
    if (!ready) {
      return { ok: false, error: "shopee_document_not_ready" };
    }

    return await downloadShopeeDocument(orderSn, accessToken, shopId);
  } catch (err) {
    console.error("[shopee] buscarEtiquetaShopee erro:", err);
    return { ok: false, error: "shopee_label_error" };
  }
}

// ── Server functions (UI) ─────────────────────────────────────────────────────

export type ShopeeConnectionStatus =
  | { connected: true; shop_id: number; expires_at: string }
  | { connected: false };

export const getShopeeConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ShopeeConnectionStatus> => {
    const { data } = await supabaseAdmin
      .from("shopee_connections")
      .select("shop_id, access_token_expires_at")
      .eq("is_sandbox", isShopeeSandbox())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return { connected: false };
    return { connected: true, shop_id: data.shop_id, expires_at: data.access_token_expires_at as string };
  });

export const disconnectShopee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ ok: boolean }> => {
    const { error } = await supabaseAdmin.from("shopee_connections").delete().gte("created_at", "2000-01-01");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
