import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { renderDanfePdf, uint8ToBase64, type DanfeItem } from "@/lib/danfe-render";

export type DanfeResult = { ok: true; pdf: string } | { ok: false; error: string };

export const gerarDanfeCustom = createServerFn({ method: "POST" })
  .inputValidator((d: { pedidoId: string }) => d)
  .handler(async ({ data }): Promise<DanfeResult> => {
    const { data: pedido, error: pedErr } = await supabaseAdmin
      .from("pedidos")
      .select(
        "id, numero, numero_loja, data_pedido, bling_nota_fiscal_id, bling_nota_fiscal_numero, raw_json, pedido_itens(id, sku, descricao, quantidade)",
      )
      .eq("id", data.pedidoId)
      .single();

    if (pedErr || !pedido) return { ok: false, error: "pedido_not_found" };

    const raw: any = pedido.raw_json ?? {};

    // ── Busca NF na API Bling ──────────────────────────────────────────────
    let chaveAcesso = "";
    let nfNumero: string = (pedido as any).bling_nota_fiscal_numero ?? "";

    if ((pedido as any).bling_nota_fiscal_id) {
      try {
        const { data: conn } = await supabaseAdmin
          .from("bling_connections")
          .select("id")
          .eq("status", "connected")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (conn) {
          const token = await getDecryptedAccessToken(conn.id);
          const nfRes = await fetch(
            `https://api.bling.com.br/Api/v3/nfe`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
          );
          if (nfRes.ok) {
            const nfJson: any = await nfRes.json().catch(() => null);
            const nf = nfJson?.data?.find(
              (n: any) => n.id === (pedido as any).bling_nota_fiscal_id,
            );
            chaveAcesso = nf?.chaveAcesso ?? "";
            nfNumero = String(nf?.numero ?? nfNumero);
            console.log("[danfe] NF Bling ok — chave:", !!chaveAcesso, "numero:", nfNumero);
          } else {
            console.warn("[danfe] NF Bling erro HTTP:", nfRes.status);
          }
        }
      } catch (err) {
        console.warn("[danfe] erro ao buscar NF Bling:", err);
      }
    }

    // ── Dados do destinatário ─────────────────────────────────────────────
    const contato: any = raw?.contato ?? {};
    const nomeCliente = contato?.nome ?? "—";
    const docCliente = contato?.numeroDocumento ?? "—";
    const ufCliente = raw?.transporte?.etiqueta?.uf ?? contato?.endereco?.uf ?? "—";
    const numeroLoja: string = (pedido as any).numero_loja ?? "";
    const itens: DanfeItem[] = ((pedido as any).pedido_itens ?? []).map((item: any) => ({
      sku: item.sku ?? null,
      descricao: item.descricao ?? "",
      quantidade: Number(item.quantidade ?? 1),
    }));

    const pdfBytes = await renderDanfePdf({
      nfNumero,
      dataPedido: (pedido as any).data_pedido ?? null,
      chaveAcesso,
      nomeCliente,
      docCliente,
      ufCliente,
      numeroLoja,
      itens,
    });

    return { ok: true, pdf: uint8ToBase64(pdfBytes) };
  });
