import type { SupabaseClient } from "@supabase/supabase-js";

const SHOPEE_BASE_SANDBOX = "https://partner.test-stable.shopeemobile.com";
const SHOPEE_BASE_PROD = "https://partner.shopeemobile.com";

// Endpoints "públicos" da Shopee — assinados sem access_token/shop_id
// (token/get e refresh_access_token usam o mesmo formato de assinatura).
const SHOPEE_PUBLIC_PATHS = new Set([
  "/api/v2/auth/token/get",
  "/api/v2/auth/access_token/get",
  "/api/v2/auth/refresh_access_token",
  "/api/v2/shop/auth_partner",
]);

export type ShopeeEnv = {
  SHOPEE_SANDBOX?: string;
  SHOPEE_TEST_PARTNER_ID?: string;
  SHOPEE_TEST_PARTNER_KEY?: string;
  SHOPEE_TEST_SHOP_ID?: string;
  SHOPEE_PARTNER_ID?: string;
  SHOPEE_PARTNER_KEY?: string;
  [key: string]: string | undefined;
};

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

function isShopeeSandbox(env: ShopeeEnv): boolean {
  return env.SHOPEE_SANDBOX !== "false";
}

function getShopeePartnerCreds(env: ShopeeEnv): { partnerId: string; partnerKey: string } {
  const partnerId = isShopeeSandbox(env) ? env.SHOPEE_TEST_PARTNER_ID : env.SHOPEE_PARTNER_ID;
  const partnerKey = isShopeeSandbox(env) ? env.SHOPEE_TEST_PARTNER_KEY : env.SHOPEE_PARTNER_KEY;

  if (!partnerId || !partnerKey) {
    throw new Error("[SHOPEE] partner_id/partner_key não configurados no ambiente");
  }

  return { partnerId, partnerKey };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  env: ShopeeEnv,
): Promise<string> {
  const { partnerId, partnerKey } = getShopeePartnerCreds(env);

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
  env: ShopeeEnv,
): Promise<string> {
  const { partnerId } = getShopeePartnerCreds(env);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await generateShopeeSignature(path, timestamp, accessToken, shopId, env);
  const baseUrl = isShopeeSandbox(env) ? SHOPEE_BASE_SANDBOX : SHOPEE_BASE_PROD;

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

export async function refreshShopeeTokenIfNeeded(
  supabase: SupabaseClient<any>,
  shopId: string | number,
  env: ShopeeEnv,
): Promise<string> {
  const { data: conn, error } = await supabase
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

  const { partnerId } = getShopeePartnerCreds(env);
  const path = "/api/v2/auth/refresh_access_token";

  try {
    const url = await buildShopeeUrl(path, {}, null, shopId, env);
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

    const { error: updateErr } = await supabase
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

export async function getShopeeOrders(
  supabase: SupabaseClient<any>,
  env: ShopeeEnv,
): Promise<string[]> {
  try {
    const shopId = env.SHOPEE_TEST_SHOP_ID;
    if (!shopId) throw new Error("SHOPEE_TEST_SHOP_ID não configurado");

    const accessToken = await refreshShopeeTokenIfNeeded(supabase, shopId, env);

    const now = Math.floor(Date.now() / 1000);
    const url = await buildShopeeUrl(
      "/api/v2/order/get_order_list",
      {
        time_range_field: "update_time",
        time_from: now - 7 * 24 * 3600,
        time_to: now,
        order_status: "READY_TO_SHIP",
        page_size: 50,
      },
      accessToken,
      shopId,
      env,
    );

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const json: any = await res.json().catch(() => null);

    if (!res.ok || !json || json.error) {
      console.error("[SHOPEE] get_order_list falhou:", res.status, JSON.stringify(json));
      return [];
    }

    const list: any[] = json.response?.order_list ?? [];
    return list.map((o) => o.order_sn).filter(Boolean);
  } catch (err) {
    console.error("[SHOPEE] getShopeeOrders erro:", err);
    return [];
  }
}

export async function getShopeeOrderDetail(
  supabase: SupabaseClient<any>,
  orderSn: string,
  env: ShopeeEnv,
): Promise<any> {
  try {
    const shopId = env.SHOPEE_TEST_SHOP_ID;
    if (!shopId) throw new Error("SHOPEE_TEST_SHOP_ID não configurado");

    const accessToken = await refreshShopeeTokenIfNeeded(supabase, shopId, env);

    const url = await buildShopeeUrl(
      "/api/v2/order/get_order_detail",
      {
        order_sn_list: orderSn,
        response_optional_fields: "item_list,recipient_address,buyer_username",
      },
      accessToken,
      shopId,
      env,
    );

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const json: any = await res.json().catch(() => null);

    if (!res.ok || !json || json.error) {
      console.error("[SHOPEE] get_order_detail falhou:", res.status, JSON.stringify(json));
      return null;
    }

    return json.response?.order_list?.[0] ?? null;
  } catch (err) {
    console.error("[SHOPEE] getShopeeOrderDetail erro:", err);
    return null;
  }
}
