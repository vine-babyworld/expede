import { createServerFn } from "@tanstack/react-start";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BLING_ETIQUETAS_URL = "https://api.bling.com.br/Api/v3/logisticas/etiquetas";

export type EtiquetaResult =
  | { ok: true; tipo: "zpl" | "pdf_url" | "desconhecido"; conteudo: string }
  | { ok: false; error: string };

export const buscarEtiquetaBling = createServerFn({ method: "POST" })
  .inputValidator((d: { pedidoId: number }) => d)
  .handler(async ({ data }): Promise<EtiquetaResult> => {
    // Fallback: retorna ZPL salvo no banco sem chamar o Bling
    const { data: pedido } = await supabaseAdmin
      .from("pedidos")
      .select("id, etiqueta_zpl")
      .eq("bling_pedido_id", data.pedidoId)
      .maybeSingle();

    if (pedido?.etiqueta_zpl) {
      return { ok: true, tipo: "zpl", conteudo: pedido.etiqueta_zpl };
    }

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
    params.append("idVendas[]", String(data.pedidoId));
    const url = `${BLING_ETIQUETAS_URL}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[etiqueta] GET falhou: ${res.status}`, txt);
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
      if (pedido?.id) {
        await supabaseAdmin
          .from("pedidos")
          .update({ etiqueta_zpl: raw } as any)
          .eq("id", pedido.id);
      }
      return { ok: true, tipo: "zpl", conteudo: raw };
    }

    if (raw.startsWith("http")) {
      const r = await fetch(raw);
      const text = await r.text();
      if (text.startsWith("^XA") || text.includes("^XA")) {
        if (pedido?.id) {
          await supabaseAdmin
            .from("pedidos")
            .update({ etiqueta_zpl: text } as any)
            .eq("id", pedido.id);
        }
        return { ok: true, tipo: "zpl", conteudo: text };
      }
      return { ok: true, tipo: "pdf_url", conteudo: raw };
    }

    return { ok: true, tipo: "desconhecido", conteudo: raw };
  });
