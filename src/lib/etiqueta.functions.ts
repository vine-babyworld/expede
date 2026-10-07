import { createServerFn } from "@tanstack/react-start";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { buscarEtiquetaML } from "@/lib/ml.functions";
import { buscarEtiquetaShopee } from "@/lib/shopee";
import { buscarEtiquetaMagalu } from "@/lib/magalu-etiqueta";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BLING_ETIQUETAS_URL = "https://api.bling.com.br/Api/v3/logisticas/etiquetas";

export type EtiquetaTipo = "zpl" | "pdf_url" | "pdf_base64" | "desconhecido";

export type EtiquetaResult =
  | {
      ok: true;
      tipo: EtiquetaTipo;
      conteudo: string;
      /**
       * Só faz sentido com `tipo: "pdf_base64"`. Ausente = comportamento antigo
       * (a impressão recorta a etiqueta de dentro da página A4, layout Shopee).
       * `false` = imprimir a página como veio — o PDF do Magalu é A4 com 3
       * etiquetas e o recorte da Shopee o destruiria.
       */
      recortarA4?: boolean;
    }
  | { ok: false; error: string };

type BuscadorEtiqueta = {
  buscar: (numeroLoja: string) => Promise<{ ok: true; conteudo: string } | { ok: false; error: string }>;
  tipo: EtiquetaTipo;
};

// Despacho explícito por marketplace. Antes o ML era o `else` de todos os
// canais: qualquer marketplace sem tratamento próprio ia bater na API do
// Mercado Livre com um id de pedido que não é dele. Agora um canal conhecido
// sem buscador (`null`) falha com erro claro.
//
// `null` na coluna continua caindo no ML de propósito — são os pedidos legados,
// gravados antes da coluna `marketplace` existir.
const FALLBACK_POR_MARKETPLACE: Record<string, BuscadorEtiqueta | null> = {
  mercadolivre: { buscar: buscarEtiquetaML, tipo: "zpl" },
  mercadolivreflex: { buscar: buscarEtiquetaML, tipo: "zpl" },
  shopee: { buscar: buscarEtiquetaShopee, tipo: "pdf_base64" },
  // Magalu Entregas: a premissa antiga ("o Bling resolve a etiqueta depois da
  // NF-e") foi REFUTADA pelo pedido 9634 — o Bling não entrega etiqueta de
  // marketplace. O Magalu não passa por esta tabela: tem ramo próprio no
  // handler, que vai direto à API do Magalu sem chamar o Bling
  // (`buscarEtiquetaMagalu`). O `null` fica para que o canal continue
  // "conhecido" caso alguém chegue aqui por outro caminho.
  magalu: null,
};

async function salvarEtiqueta(pedidoId: string, conteudo: string, tipo: EtiquetaTipo) {
  const { error } = await supabaseAdmin
    .from("pedidos")
    .update({ etiqueta_zpl: conteudo, etiqueta_tipo: tipo } as any)
    .eq("id", pedidoId);
  // No Magalu, cache perdido = a reimpressão volta à API e pode gerar etiqueta nova.
  if (error) console.error("[etiqueta] falha ao gravar cache da etiqueta:", pedidoId, error.message);
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

    const marketplace: string | null = (pedido as any)?.marketplace ?? null;

    if (pedido?.etiqueta_zpl) {
      const tipoCache = ((pedido as any).etiqueta_tipo as EtiquetaTipo) ?? "zpl";
      // PDF do Magalu (A4 com 3 etiquetas) não pode passar pelo recorte da Shopee.
      if (marketplace === "magalu" && (tipoCache === "pdf_base64" || tipoCache === "pdf_url")) {
        return { ok: true, tipo: tipoCache, conteudo: pedido.etiqueta_zpl, recortarA4: false };
      }
      return { ok: true, tipo: tipoCache, conteudo: pedido.etiqueta_zpl };
    }

    // numero_loja = id do pedido no marketplace (ML order ID, Shopee order_sn,
    // código do pedido no Magalu)
    const numeroLoja: string | null = (pedido as any)?.numero_loja ?? null;

    // Magalu: direto na API do Magalu, SEM passar pelo Bling (o Bling não é
    // fonte de etiqueta de marketplace). Toda etiqueta obtida vai para o cache,
    // seja ZPL ou PDF: cada chamada a `shipping-labels` pode gerar etiqueta
    // nova, então reimpressão tem de sair do banco.
    if (marketplace === "magalu") {
      if (!numeroLoja) return { ok: false, error: "magalu_sem_numero_loja" };
      let r: Awaited<ReturnType<typeof buscarEtiquetaMagalu>>;
      try {
        r = await buscarEtiquetaMagalu(numeroLoja);
      } catch (err) {
        console.error("[etiqueta] magalu exception:", numeroLoja, err);
        return { ok: false, error: "magalu_exception: " + (err instanceof Error ? err.message : String(err)) };
      }
      if (!r.ok) {
        console.warn("[etiqueta] magalu falhou:", numeroLoja, r.error);
        return r;
      }
      // Falha ao gravar o cache não pode jogar fora uma etiqueta já gerada.
      if (pedido?.id) {
        try {
          await salvarEtiqueta(pedido.id, r.conteudo, r.tipo);
        } catch (err) {
          console.error("[etiqueta] magalu: etiqueta obtida mas cache falhou:", numeroLoja, err);
        }
      }
      return r;
    }

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
    if (!numeroLoja) return blingResult;

    // Pedido legado sem marketplace definido segue no ML.
    const canal = marketplace ?? "mercadolivre";

    if (!(canal in FALLBACK_POR_MARKETPLACE)) {
      console.warn(`[etiqueta] marketplace desconhecido: ${canal} — sem fallback`);
      return blingResult;
    }

    const fallback = FALLBACK_POR_MARKETPLACE[canal];
    if (!fallback) {
      console.warn(`[etiqueta] ${canal} não tem busca própria de etiqueta — depende do Bling`);
      return { ok: false, error: `sem_fallback:${canal}` };
    }

    try {
      const result = await fallback.buscar(numeroLoja);
      if (result.ok) {
        if (pedido?.id) await salvarEtiqueta(pedido.id, result.conteudo, fallback.tipo);
        return { ok: true, tipo: fallback.tipo, conteudo: result.conteudo };
      }
      console.warn(`[etiqueta] ${canal} também falhou:`, result.error);
      return { ok: false, error: result.error };
    } catch (err) {
      console.warn(`[etiqueta] ${canal} exception:`, err);
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
