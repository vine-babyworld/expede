import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SHOPEE_BASE_SANDBOX = "https://partner.test-stable.shopeemobile.com";
const SHOPEE_BASE_PROD = "https://partner.shopeemobile.com";
const SHOPEE_AUTH_PARTNER_PATH = "/api/v2/shop/auth_partner";
const SHOPEE_TOKEN_GET_PATH = "/api/v2/auth/token/get";
const SHOPEE_REDIRECT_URI = "https://expede.lovable.app/api/shopee/callback";

// Endpoints "públicos" da Shopee — assinados sem access_token/shop_id
// (token/get e refresh_access_token usam o mesmo formato de assinatura).
const SHOPEE_PUBLIC_PATHS = new Set([
  SHOPEE_TOKEN_GET_PATH,
  "/api/v2/auth/access_token/get",
  "/api/v2/auth/refresh_access_token",
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

function getShopeePartnerCreds(): { partnerId: string; partnerKey: string } {
  const sandbox = isShopeeSandbox();
  const partnerId = sandbox ? process.env.SHOPEE_TEST_PARTNER_ID : process.env.SHOPEE_PARTNER_ID;
  const partnerKey = sandbox ? process.env.SHOPEE_TEST_PARTNER_KEY : process.env.SHOPEE_PARTNER_KEY;

  if (!partnerId || !partnerKey) {
    throw new Error("[SHOPEE] partner_id/partner_key não configurados no ambiente");
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
  const path = "/api/v2/auth/refresh_access_token";

  try {
    const url = await buildShopeeUrl(path, {}, null, shopId);
    const res = await fetch(url, {
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

  const res = await fetch(url, {
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

async function pollShopeeShippingDocumentReady(
  orderSn: string,
  accessToken: string,
  shopId: string,
): Promise<boolean> {
  const path = "/api/v2/logistics/get_shipping_document_result";

  for (let attempt = 0; attempt < 3; attempt++) {
    const url = await buildShopeeUrl(path, {}, accessToken, shopId);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_list: [{ order_sn: orderSn }] }),
    });
    const json: any = await res.json().catch(() => null);
    const status = json?.response?.result_list?.[0]?.status;

    if (status === "READY") return true;
    if (status === "FAILED") return false;

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return false;
}

export async function buscarEtiquetaShopee(orderSn: string): Promise<ShopeeEtiquetaResult> {
  const shopId = process.env.SHOPEE_TEST_SHOP_ID;
  if (!shopId) return { ok: false, error: "shopee_shop_id_not_configured" };

  let accessToken: string;
  try {
    accessToken = await refreshShopeeTokenIfNeeded(shopId);
  } catch {
    return { ok: false, error: "shopee_no_connection" };
  }

  try {
    const createUrl = await buildShopeeUrl(
      "/api/v2/logistics/create_shipping_document",
      {},
      accessToken,
      shopId,
    );
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_list: [{ order_sn: orderSn, shipping_document_type: "THERMAL_AIR_WAYBILL" }],
      }),
    });
    const createJson: any = await createRes.json().catch(() => null);

    if (!createRes.ok || !createJson || createJson.error) {
      console.error("[shopee] create_shipping_document falhou:", createRes.status, JSON.stringify(createJson));
      return { ok: false, error: createJson?.error ?? "shopee_create_document_failed" };
    }

    const ready = await pollShopeeShippingDocumentReady(orderSn, accessToken, shopId);
    if (!ready) {
      return { ok: false, error: "shopee_document_not_ready" };
    }

    const downloadUrl = await buildShopeeUrl(
      "/api/v2/logistics/download_shipping_document",
      {},
      accessToken,
      shopId,
    );
    const downloadRes = await fetch(downloadUrl, {
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
