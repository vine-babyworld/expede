import { createServerFn } from "@tanstack/react-start";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { buscarEtiquetaML } from "@/lib/ml.functions";
import { buscarEtiquetaShopee } from "@/lib/shopee";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BLING_ETIQUETAS_URL = "https://api.bling.com.br/Api/v3/logisticas/etiquetas";

export type EtiquetaTipo = "zpl" | "pdf_url" | "pdf_base64" | "desconhecido";

export type EtiquetaResult =
  | { ok: true; tipo: EtiquetaTipo; conteudo: string }
  | { ok: false; error: string };

async function salvarEtiqueta(pedidoId: string, conteudo: string, tipo: EtiquetaTipo) {
  await supabaseAdmin
    .from("pedidos")
    .update({ etiqueta_zpl: conteudo, etiqueta_tipo: tipo } as any)
    .eq("id", pedidoId);
}

export const buscarEtiquetaBling = createServerFn({ method: "POST" })
  .inputValidator((d: { pedidoId: number }) => d)
  .handler(async ({ data }): Promise<EtiquetaResult> => {
    // 1. Cache: retorna etiqueta salva no banco sem chamar APIs externas
    const { data: pedido } = await supabaseAdmin
      .from("pedidos")
      .select("id, etiqueta_zpl, etiqueta_tipo, numero_loja, marketplace")
      .eq("bling_pedido_id", data.pedidoId)
      .maybeSingle();

    if (pedido?.etiqueta_zpl) {
      const tipoCache = ((pedido as any).etiqueta_tipo as EtiquetaTipo) ?? "zpl";
      return { ok: true, tipo: tipoCache, conteudo: pedido.etiqueta_zpl };
    }

    // numero_loja = id do pedido no marketplace (ML order ID ou Shopee order_sn)
    const numeroLoja: string | null = (pedido as any)?.numero_loja ?? null;
    const marketplace: string | null = (pedido as any)?.marketplace ?? null;

    // 2. Tenta API do Bling
    const blingResult = await tentarBling(data.pedidoId, pedido?.id ?? null);

    if (blingResult.ok) {
      if (pedido?.id && blingResult.tipo === "zpl") {
        await salvarEtiqueta(pedido.id, blingResult.conteudo, "zpl");
      }
      return blingResult;
    }

    console.warn("[etiqueta] Bling falhou:", blingResult.error, "— tentando marketplace:", marketplace, numeroLoja);

    // 3. Fallback por marketplace
    if (marketplace === "shopee" && numeroLoja) {
      try {
        const shopeeResult = await buscarEtiquetaShopee(numeroLoja);
        if (shopeeResult.ok) {
          if (pedido?.id) await salvarEtiqueta(pedido.id, shopeeResult.conteudo, "pdf_base64");
          return { ok: true, tipo: "pdf_base64", conteudo: shopeeResult.conteudo };
        }
        console.warn("[etiqueta] Shopee também falhou:", shopeeResult.error);
        return { ok: false, error: shopeeResult.error };
      } catch (err) {
        console.warn("[etiqueta] Shopee exception:", err);
      }
      return blingResult;
    }

    // Fallback ML (default — inclui pedidos legados sem marketplace definido)
    if (numeroLoja) {
      try {
        const mlResult = await buscarEtiquetaML(numeroLoja);
        if (mlResult.ok) {
          if (pedido?.id) await salvarEtiqueta(pedido.id, mlResult.conteudo, "zpl");
          return { ok: true, tipo: "zpl", conteudo: mlResult.conteudo };
        }
        console.warn("[etiqueta] ML também falhou:", mlResult.error);
        return { ok: false, error: mlResult.error };
      } catch (err) {
        console.warn("[etiqueta] ML exception:", err);
      }
    }

    return blingResult; // retorna o erro original do Bling
  });

async function tentarBling(
  pedidoId: number,
  dbId: string | null,
): Promise<EtiquetaResult> {
  const { data: conn, error: connErr } = await supabaseAdmin
    .from("bling_connections")
    .select("id")
    .eq("status", "connected")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (connErr || !conn) return { ok: false, error: "no_active_connection" };

  let token: string;
  try {
    token = await getDecryptedAccessToken(conn.id);
  } catch (err) {
    return { ok: false, error: "token_error: " + String(err) };
  }

  const params = new URLSearchParams();
  params.append("idVendas[]", String(pedidoId));
  const url = `${BLING_ETIQUETAS_URL}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[etiqueta] GET Bling falhou: ${res.status}`, txt);
    return { ok: false, error: `bling_api_error:${res.status}` };
  }

  const json: any = await res.json().catch(() => null);
  console.log("[etiqueta] resposta Bling:", JSON.stringify(json));

  const etiqueta = json?.data?.[0];
  if (!etiqueta) return { ok: false, error: "no_etiqueta_data" };

  const raw: string =
    etiqueta.etiqueta ?? etiqueta.zpl ?? etiqueta.conteudo ?? etiqueta.url ?? "";

  if (!raw) return { ok: false, error: "empty_etiqueta_content" };

  if (raw.startsWith("^XA") || raw.startsWith("CT~~") || raw.includes("^XA")) {
    return { ok: true, tipo: "zpl", conteudo: raw };
  }

  if (raw.startsWith("http")) {
    const r = await fetch(raw);
    const text = await r.text();
    if (text.startsWith("^XA") || text.includes("^XA")) {
      return { ok: true, tipo: "zpl", conteudo: text };
    }
    return { ok: true, tipo: "pdf_url", conteudo: raw };
  }

  return { ok: true, tipo: "desconhecido", conteudo: raw };
}
