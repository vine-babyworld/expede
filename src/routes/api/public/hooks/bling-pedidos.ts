import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING_PEDIDOS_URL = "https://www.bling.com.br/Api/v3/pedidos/vendas";
const DEPOSITO_ALVO = "Geral";

export const Route = createFileRoute("/api/public/hooks/bling-pedidos")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        const blingPedidoId: unknown = (body as any)?.data?.id;
        if (!blingPedidoId) {
          return Response.json({ ok: false, error: "missing_id" }, { status: 400 });
        }

        // Log completo do payload — útil nos primeiros testes em produção
        console.log("[bling-pedidos] payload recebido:", JSON.stringify(body));

        try {
          // Estratégia: Babyworld tem 1 conexão Bling ativa.
          // TODO: quando houver multi-conexão real, investigar se o Bling envia
          // identificador da empresa no header ou body e mapear connection por esse campo.
          const { data: conn, error: connErr } = await supabaseAdmin
            .from("bling_connections")
            .select("id")
            .eq("status", "connected")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

          if (connErr || !conn) {
            console.error("[bling-pedidos] nenhuma conexão ativa:", connErr?.message);
            // Retorna 200 — o Bling não vai retentar; logamos pra debugging
            return Response.json({ ok: false, error: "no_active_connection" });
          }

          const token = await getDecryptedAccessToken(conn.id);
          const res = await fetch(`${BLING_PEDIDOS_URL}/${blingPedidoId}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            console.error(
              `[bling-pedidos] GET pedido ${blingPedidoId} falhou: ${res.status}`,
              errText,
            );
            // Retorna 200 intencionalmente enquanto debugamos para não forçar reentreda.
            // TODO: retornar 500 em produção estável para permitir reentrega do Bling.
            return Response.json({ ok: false, error: "bling_api_error", http_status: res.status });
          }

          const json: any = await res.json();
          const d = json?.data;
          if (!d) {
            console.error("[bling-pedidos] resposta sem campo data:", JSON.stringify(json));
            return Response.json({ ok: false, error: "empty_response" });
          }

          // Filtro 1: só pedidos com nota fiscal emitida
          if (!d.notaFiscal?.id) {
            console.log(`[bling-pedidos] pedido ${blingPedidoId} sem NF — ignorado`);
            return Response.json({ skipped: "no_invoice" });
          }

          // Filtro 2: todos os itens devem ser do depósito "Geral"
          const itens: any[] = d.itens ?? [];
          const itemForaDoDeposito = itens.find(
            (it: any) => it.deposito?.descricao !== DEPOSITO_ALVO,
          );
          if (itemForaDoDeposito) {
            console.log(
              `[bling-pedidos] pedido ${blingPedidoId} tem item no depósito` +
              ` "${itemForaDoDeposito.deposito?.descricao}" — ignorado`,
            );
            return Response.json({ skipped: "wrong_warehouse" });
          }

          const pedidoPayload = {
            bling_connection_id:      conn.id,
            bling_pedido_id:          d.id,
            numero:                   String(d.numero ?? d.id),
            numero_loja:              d.numeroLoja ?? null,
            situacao_id:              d.situacao?.id ?? null,
            situacao_valor:           d.situacao?.valor ?? null,
            data_pedido:              d.data ? new Date(d.data).toISOString() : null,
            total:                    d.total ?? null,
            // contato na Bling API v3 = cliente no nosso domínio (ver comentário na migration)
            cliente:                  d.contato ?? null,
            bling_nota_fiscal_id:     d.notaFiscal.id,
            bling_nota_fiscal_numero: d.notaFiscal.numero ?? null,
            raw_json:                 d,
          };

          const { data: upserted, error: upsertErr } = await supabaseAdmin
            .from("pedidos")
            .upsert(pedidoPayload, {
              onConflict: "bling_connection_id,bling_pedido_id",
              ignoreDuplicates: false,
            })
            .select("id")
            .single();

          if (upsertErr || !upserted) {
            console.error("[bling-pedidos] upsert falhou:", upsertErr?.message);
            return Response.json({ ok: false, error: "upsert_error" });
          }

          const pedidoDbId: string = upserted.id;

          // Itens: replace-all — delete existentes e reinsere os atuais
          await supabaseAdmin.from("pedido_itens").delete().eq("pedido_id", pedidoDbId);

          const itensPrepared = await Promise.all(
            itens.map(async (it: any) => {
              let produtoId: string | null = null;

              const gtin = it.gtin ?? null;
              const sku  = it.codigo ?? null;

              // Tentativa de match: EAN (gtin) primeiro, SKU depois
              if (gtin) {
                const { data: p } = await supabaseAdmin
                  .from("produtos")
                  .select("id")
                  .eq("gtin", gtin)
                  .eq("bling_connection_id", conn.id)
                  .maybeSingle();
                produtoId = p?.id ?? null;
              }

              if (!produtoId && sku) {
                const { data: p } = await supabaseAdmin
                  .from("produtos")
                  .select("id")
                  .eq("sku", sku)
                  .eq("bling_connection_id", conn.id)
                  .maybeSingle();
                produtoId = p?.id ?? null;
              }

              return {
                pedido_id:          pedidoDbId,
                produto_id:         produtoId,
                bling_item_id:      it.id ?? null,
                sku,
                ean:                gtin,
                descricao:          it.descricao ?? "",
                quantidade:         it.quantidade ?? 1,
                valor_unitario:     it.valor ?? null,
                deposito_id:        it.deposito?.id ?? null,
                deposito_descricao: it.deposito?.descricao ?? null,
              };
            }),
          );

          if (itensPrepared.length > 0) {
            const { error: itemsErr } = await supabaseAdmin
              .from("pedido_itens")
              .insert(itensPrepared);
            if (itemsErr) {
              console.error("[bling-pedidos] insert itens falhou:", itemsErr.message);
            }
          }

          console.log(
            `[bling-pedidos] OK pedido=${blingPedidoId} db_id=${pedidoDbId} itens=${itensPrepared.length}`,
          );
          return Response.json({ ok: true, pedido_id: pedidoDbId, items_count: itensPrepared.length });

        } catch (err) {
          console.error("[bling-pedidos] erro inesperado:", err);
          // Retorna 200 intencionalmente enquanto debugamos.
          // TODO: retornar 500 em produção estável.
          return Response.json({ ok: false, error: "internal_error" });
        }
      },
    },
  },
});
