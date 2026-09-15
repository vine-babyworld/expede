/**
 * Magalu — cliente HTTP e OAuth2 (o lado de I/O; a lógica pura está em
 * `magalu.ts`).
 *
 * Três diferenças em relação aos outros canais, todas medidas, não supostas:
 *
 * 1. **Sem proxy.** O Worker alcança `api.magalu.com` direto (401 em 177 ms,
 *    medido em 15/09/2026 por `/api/debug/magalu-ping`). O ML precisa de Edge
 *    Function e a Shopee de gateway de IP fixo; o Magalu não precisa de nada.
 * 2. **Sem HMAC.** OAuth2 Authorization Code puro — nada de assinar request
 *    como a Shopee.
 * 3. **Token cifrado em repouso** (AES-256-GCM, `token-crypto.ts`), ao
 *    contrário de `ml_connections`/`shopee_connections`, que guardam texto puro.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import {
  MAGALU_API_BASE,
  MAGALU_REDIRECT_URI,
  MAGALU_SCOPES,
  MAGALU_TOKEN_URL,
  montarUrlConsentimento,
  precisaRenovar,
} from "@/lib/magalu";

function clientId(): string {
  const v = process.env.MAGALU_CLIENT_ID;
  if (!v) throw new Error("MAGALU_CLIENT_ID não configurado no Worker");
  return v;
}

function clientSecret(): string {
  const v = process.env.MAGALU_CLIENT_SECRET;
  if (!v) throw new Error("MAGALU_CLIENT_SECRET não configurado no Worker");
  return v;
}

// ── URL de consentimento ─────────────────────────────────────────────────────

export function getMagaluAuthUrl(state: string): string {
  return montarUrlConsentimento({
    clientId: clientId(),
    redirectUri: MAGALU_REDIRECT_URI,
    state,
    scopes: MAGALU_SCOPES,
  });
}

// ── Troca/renovação de token ─────────────────────────────────────────────────

export type RespostaToken = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [k: string]: unknown;
};

/** Metadados não-secretos da resposta de token — o que dá para gravar e logar. */
function metaSemSegredo(json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === "access_token" || k === "refresh_token" || k === "id_token") continue;
    out[k] = v;
  }
  return out;
}

/**
 * A doc descreve uma assimetria real: troca de code em `application/json`,
 * refresh em `application/x-www-form-urlencoded`. Como isso nunca foi testado
 * de verdade — e como um GET nesse endpoint devolveu 404 em 15/09 — a função
 * tenta o content-type documentado e, se levar 404/405/415, repete com o outro
 * e **reporta qual funcionou**. É diagnóstico de uma incógnita aberta, não
 * gambiarra permanente: quando o dado aparecer, um dos dois caminhos sai.
 */
async function postToken(
  corpo: Record<string, string>,
  preferido: "json" | "form",
): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; texto: string; formato: "json" | "form" }> {
  const ordem: Array<"json" | "form"> = preferido === "json" ? ["json", "form"] : ["form", "json"];
  let ultima: { ok: boolean; status: number; json: Record<string, unknown>; texto: string; formato: "json" | "form" } | null = null;

  for (const formato of ordem) {
    const res = await fetch(MAGALU_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": formato === "json" ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: formato === "json" ? JSON.stringify(corpo) : new URLSearchParams(corpo).toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const texto = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(texto) as Record<string, unknown>;
    } catch {
      /* resposta não-JSON: fica no `texto` */
    }

    ultima = { ok: res.ok, status: res.status, json, texto, formato };
    if (res.ok) return ultima;
    // 404/405/415 = o endpoint não aceitou este formato; qualquer outro erro é
    // recusa de verdade (credencial, code expirado) e repetir só queima o code.
    if (res.status !== 404 && res.status !== 405 && res.status !== 415) return ultima;
  }

  return ultima!;
}

async function gravarConexao(json: RespostaToken, formato: "json" | "form"): Promise<void> {
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 7200;
  const agora = new Date();

  if (!json.access_token) throw new Error("magalu: resposta de token sem access_token");
  if (!json.refresh_token) throw new Error("magalu: resposta de token sem refresh_token");

  // Uma conexão só (um seller). Apaga antes de inserir para nunca ficar com
  // duas linhas e um `order by created_at desc` escolhendo em silêncio.
  await supabaseAdmin.from("magalu_connections" as any).delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const { error } = await supabaseAdmin.from("magalu_connections" as any).insert({
    access_token: await encryptToken(json.access_token),
    refresh_token: await encryptToken(json.refresh_token),
    access_expires_at: new Date(agora.getTime() + ttl * 1000).toISOString(),
    access_ttl_seconds: ttl,
    scope: typeof json.scope === "string" ? json.scope : null,
    status: "connected",
    last_refresh_at: agora.toISOString(),
    token_endpoint_format: formato,
    token_meta: metaSemSegredo(json as Record<string, unknown>),
  } as any);

  if (error) throw new Error("Falha ao salvar conexão Magalu: " + error.message);
  console.log("[magalu] conexão salva — ttl", ttl, "s, escopos:", json.scope ?? "(não informados)");
}

export async function exchangeMagaluCode(code: string): Promise<void> {
  const r = await postToken(
    {
      grant_type: "authorization_code",
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: MAGALU_REDIRECT_URI,
      code,
    },
    "json",
  );

  if (!r.ok) {
    console.error("[magalu] troca de code falhou:", r.status, r.texto.slice(0, 400));
    throw new Error(`Magalu token exchange HTTP ${r.status}: ${r.texto.slice(0, 200)}`);
  }
  await gravarConexao(r.json as RespostaToken, r.formato);
}

type ConexaoMagalu = {
  id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  access_ttl_seconds: number | null;
};

async function lerConexao(): Promise<ConexaoMagalu> {
  const { data, error } = await supabaseAdmin
    .from("magalu_connections" as any)
    .select("id, access_token, refresh_token, access_expires_at, access_ttl_seconds")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("Falha ao ler conexão Magalu: " + error.message);
  if (!data) throw new Error("Nenhuma conexão Magalu ativa — autorize em /api/magalu/auth");
  return data as unknown as ConexaoMagalu;
}

export async function refreshMagaluToken(conn: ConexaoMagalu): Promise<string> {
  const refreshPlain = await decryptToken(conn.refresh_token);

  const r = await postToken(
    {
      grant_type: "refresh_token",
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshPlain,
    },
    "form",
  );

  if (!r.ok) {
    const msg = `HTTP ${r.status}: ${r.texto.slice(0, 200)}`;
    console.error("[magalu] refresh falhou:", msg);
    // 429 e 5xx não são recusa de autorização — é a Lição #41 com o Bling.
    // Marcar `expired` aqui faria o painel pedir reautorização de uma conexão
    // íntegra.
    const transitorio = r.status === 429 || r.status >= 500;
    await supabaseAdmin
      .from("magalu_connections" as any)
      .update((transitorio ? { last_error: msg } : { status: "expired", last_error: msg }) as any)
      .eq("id", conn.id);
    throw new Error("Magalu refresh " + msg);
  }

  const json = r.json as RespostaToken;
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 7200;

  await supabaseAdmin
    .from("magalu_connections" as any)
    .update({
      access_token: await encryptToken(json.access_token),
      // Refresh token rotativo: se vier um novo, é ele que vale daqui em diante.
      refresh_token: json.refresh_token ? await encryptToken(json.refresh_token) : conn.refresh_token,
      access_expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      access_ttl_seconds: ttl,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      status: "connected",
      last_error: null,
      last_refresh_at: new Date().toISOString(),
    } as any)
    .eq("id", conn.id);

  return json.access_token;
}

export async function getMagaluAccessToken(): Promise<string> {
  const conn = await lerConexao();

  const renovar = precisaRenovar({
    agoraMs: Date.now(),
    expiraEmMs: new Date(conn.access_expires_at).getTime(),
    ttlSegundos: conn.access_ttl_seconds,
  });

  if (renovar) return refreshMagaluToken(conn);
  return decryptToken(conn.access_token);
}

// ── Chamadas à API ───────────────────────────────────────────────────────────

export type RespostaMagalu = {
  ok: boolean;
  status: number;
  ms: number;
  json: unknown;
  texto: string;
  request_id: string | null;
};

/**
 * Chamada crua à API do seller. Devolve corpo interpretado **e** cru: numa rota
 * de descoberta, o que a API mandou importa tanto quanto se deu certo.
 */
export async function chamarMagalu(
  caminho: string,
  opts: { token: string; method?: string; body?: unknown } = { token: "" },
): Promise<RespostaMagalu> {
  const inicio = Date.now();
  const url = caminho.startsWith("http") ? caminho : `${MAGALU_API_BASE}${caminho}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(20_000),
  });

  const texto = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* não-JSON */
  }

  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - inicio,
    json,
    texto,
    request_id: res.headers.get("x-request-id"),
  };
}
