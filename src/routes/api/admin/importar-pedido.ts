import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";

export const Route = createFileRoute("/api/admin/importar-pedido")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }

        const { numeroLoja, blingPedidoId } = body ?? {};
        if (!numeroLoja && !blingPedidoId) {
          return Response.json({ ok: false, error: "numeroLoja ou blingPedidoId obrigatorio" }, { status: 400 });
        }

        const { data: conn } = await supabaseAdmin
          .from("bling_connections")
          .select("id")
          .eq("status", "connected")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!conn) return Response.json({ ok: false, error: "sem conexao Bling ativa" }, { status: 500 });

        let token: string;
        try {
          token = await getDecryptedAccessToken(conn.id);
        } catch (e) {
          return Response.json({ ok: false, error: "erro ao obter token Bling" }, { status: 500 });
        }

        const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

        // Se veio numeroLoja, busca o pedido Bling pelo numeroLoja
        let resolvedBlingId: number | null = blingPedidoId ?? null;

        if (!resolvedBlingId && numeroLoja) {
          const res = await fetch(
            `${BLING_PEDIDOS_URL}?numeroLoja=${encodeURIComponent(numeroLoja)}&limite=5&pagina=1`,
            { headers }
          );
          if (!res.ok) {
            return Response.json({ ok: false, error: `bling_api_error:${res.status}` }, { status: 500 });
          }
          const json: any = await res.json().catch(() => null);
          const lista = json?.data ?? [];
          if (lista.length === 0) {
            return Response.json({ ok: false, error: `pedido com numeroLoja=${numeroLoja} nao encontrado no Bling` }, { status: 404 });
          }
          resolvedBlingId = lista[0].id;
        }

        if (!resolvedBlingId) {
          return Response.json({ ok: false, error: "nao foi possivel resolver o blingPedidoId" }, { status: 400 });
        }

        // Busca detalhes completos do pedido
        const resDetalhe = await fetch(`${BLING_PEDIDOS_URL}/${resolvedBlingId}`, { headers });
        if (!resDetalhe.ok) {
          return Response.json({ ok: false, error: `bling_api_error:${resDetalhe.status}` }, { status: 500 });
        }
        const jsonDetalhe: any = await resDetalhe.json().catch(() => null);
        const d = jsonDetalhe?.data;
        if (!d) return Response.json({ ok: false, error: "resposta vazia da API Bling" }, { status: 500 });

        // Upsert forçado — ignora situação e NF, importa o pedido como está
        const pedidoPayload = {
          bling_connection_id:      conn.id,
          bling_pedido_id:          d.id,
          numero:                   String(d.numero ?? d.id),
          numero_loja:              d.numeroLoja ?? null,
          situacao_id:              d.situacao?.id ?? null,
          situacao_valor:           d.situacao?.valor ?? null,
          data_pedido:              d.data ? new Date(d.data).toISOString() : null,
          total:                    d.total ?? null,
          cliente:                  d.contato ?? null,
          bling_nota_fiscal_id:     d.notaFiscal?.id ?? null,
          bling_nota_fiscal_numero: d.notaFiscal?.numero ?? null,
          raw_json:                 d,
        };

        const { data: upserted, error: upsertErr } = await supabaseAdmin
          .from("pedidos")
          .upsert(pedidoPayload, { onConflict: "bling_connection_id,bling_pedido_id", ignoreDuplicates: false })
          .select("id")
          .single();

        if (upsertErr || !upserted) {
          return Response.json({ ok: false, error: "upsert_error: " + upsertErr?.message }, { status: 500 });
        }

        // Upsert dos itens
        const itens: any[] = d.itens ?? [];
        if (itens.length > 0) {
          await supabaseAdmin.from("pedido_itens").delete().eq("pedido_id", upserted.id);
          const itensPrepared = itens.map((it: any) => ({
            pedido_id:          upserted.id,
            produto_id:         null,
            bling_item_id:      it.id ?? null,
            sku:                it.codigo ?? null,
            ean:                it.gtin ?? null,
            descricao:          it.descricao ?? "",
            quantidade:         it.quantidade ?? 1,
            valor_unitario:     it.valor ?? null,
            deposito_id:        it.deposito?.id ?? null,
            deposito_descricao: it.deposito?.descricao ?? null,
          }));
          await supabaseAdmin.from("pedido_itens").insert(itensPrepared);
        }

        return Response.json({
          ok: true,
          blingPedidoId: resolvedBlingId,
          numero: pedidoPayload.numero,
          numeroLoja: pedidoPayload.numero_loja,
          situacao_id: pedidoPayload.situacao_id,
          notaFiscalId: pedidoPayload.bling_nota_fiscal_id,
          detalhe: "importado com sucesso",
        });
      },
    },
  },
});
