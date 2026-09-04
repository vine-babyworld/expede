import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { resolverProdutoDoItem } from "@/lib/pedidos.functions";
import { encontrarPedidoPorNumeroLoja } from "@/lib/reconciliar-atendidos";
import { marketplacePelaLojaBling } from "@/lib/nf-emissao.policy";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
// O Bling ignora ?numeroLoja=, então a busca é uma varredura conferida no cliente.
// 5 páginas de 100 cobrem ~5 semanas de pedidos, o suficiente para recuperação manual.
const BUSCA_NUMERO_LOJA_PAGINAS = 5;
const BUSCA_NUMERO_LOJA_LIMITE = 100;

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
          // Varredura paginada: o Bling aceita ?numeroLoja= mas não filtra por ele
          // (verificado em 04/09/2026), então cada página precisa ser conferida aqui.
          // Confiar em lista[0], como era feito antes, importava o pedido mais
          // recente da conta no lugar do pedido solicitado.
          const alvo = String(numeroLoja);
          for (let pagina = 1; pagina <= BUSCA_NUMERO_LOJA_PAGINAS && !resolvedBlingId; pagina++) {
            const res = await fetch(
              `${BLING_PEDIDOS_URL}?numeroLoja=${encodeURIComponent(alvo)}` +
              `&limite=${BUSCA_NUMERO_LOJA_LIMITE}&pagina=${pagina}`,
              { headers }
            );
            if (!res.ok) {
              return Response.json({ ok: false, error: `bling_api_error:${res.status}` }, { status: 500 });
            }
            const json: any = await res.json().catch(() => null);
            const lista: any[] = json?.data ?? [];
            const encontrado = encontrarPedidoPorNumeroLoja(lista, alvo);
            if (encontrado) resolvedBlingId = encontrado.id;
            if (lista.length < BUSCA_NUMERO_LOJA_LIMITE) break; // última página
            await new Promise((r) => setTimeout(r, 350)); // rate limit Bling: 3 req/s
          }

          if (!resolvedBlingId) {
            return Response.json(
              {
                ok: false,
                error: `pedido com numeroLoja=${alvo} nao encontrado nas ultimas ` +
                  `${BUSCA_NUMERO_LOJA_PAGINAS * BUSCA_NUMERO_LOJA_LIMITE} vendas do Bling` +
                  ` — informe blingPedidoId se o pedido for mais antigo`,
              },
              { status: 404 },
            );
          }
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

        // Upsert forçado — ignora situação e NF, importa o pedido como está.
        // O marketplace vem da loja Bling: sem isso a coluna cai no default
        // 'mercadolivre' e um pedido Shopee importado por aqui fica classificado errado.
        const marketplaceDetectado = marketplacePelaLojaBling(d);
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
          ...(marketplaceDetectado ? { marketplace: marketplaceDetectado } : {}),
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
          const itensPrepared = await Promise.all(itens.map(async (it: any) => {
            const { produtoId, ean } = await resolverProdutoDoItem(it, conn.id);
            return {
              pedido_id:          upserted.id,
              produto_id:         produtoId,
              bling_item_id:      it.id ?? null,
              sku:                it.codigo ?? null,
              ean,
              descricao:          it.descricao ?? "",
              quantidade:         it.quantidade ?? 1,
              valor_unitario:     it.valor ?? null,
              deposito_id:        it.deposito?.id ?? null,
              deposito_descricao: it.deposito?.descricao ?? null,
            };
          }));
          await supabaseAdmin.from("pedido_itens").insert(itensPrepared);
        }

        return Response.json({
          ok: true,
          blingPedidoId: resolvedBlingId,
          numero: pedidoPayload.numero,
          numeroLoja: pedidoPayload.numero_loja,
          situacao_id: pedidoPayload.situacao_id,
          marketplace: marketplaceDetectado,
          notaFiscalId: pedidoPayload.bling_nota_fiscal_id,
          detalhe: "importado com sucesso",
        });
      },
    },
  },
});
