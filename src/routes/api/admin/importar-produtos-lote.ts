import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapProduct } from "@/lib/produtos.functions";

export const Route = createFileRoute("/api/admin/importar-produtos-lote")({
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

        const { blingConnectionId, produtos } = body ?? {};
        if (!blingConnectionId || !Array.isArray(produtos)) {
          return Response.json(
            { ok: false, error: "blingConnectionId e produtos[] obrigatorios" },
            { status: 400 },
          );
        }

        const totalRecebidos: number = produtos.length;
        let totalUpserted = 0;
        let totalErros = 0;
        let totalComDetalhe = 0;
        const erros: any[] = [];

        // Insert run log at start.
        // Falha aqui NÃO derruba o import (o upsert de produtos é o que importa),
        // mas precisa ficar visível nos logs do Worker — antes o erro era engolido
        // e o import rodava "com sucesso" sem deixar nenhum registro de run.
        const { data: run, error: runInsertErr } = await supabaseAdmin
          .from("produtos_sync_runs")
          .insert({ bling_connection_id: blingConnectionId, origem: "pc-local" })
          .select("id")
          .single();
        if (runInsertErr) {
          console.error(
            "[importar-produtos-lote] falha ao inserir run em produtos_sync_runs:",
            runInsertErr.message,
          );
        }
        const runId: string | null = run?.id ?? null;
        let runLogged = Boolean(runId);

        // Map Bling raw objects to produto rows.
        //
        // Cada item pode vir em dois formatos:
        //   { detalhe: boolean, produto: {...} }  → envelope do sync-produtos-local
        //   {...}                                 → objeto Bling cru (formato antigo)
        //
        // `detalhe: true` só é aceito quando o item é ENVELOPADO, porque só nesse caso o
        // script afirma que o objeto é a resposta de GET /produtos/:id. O objeto cru é
        // sempre tratado como listagem: passar { detail: true } num objeto de listagem faria
        // `classifyProduct` não achar `variacoes`/`produtoPai` e regravar todo produto-pai
        // como tipo="simples", bipavel=true.
        const rowsDetalhe: any[] = [];
        const rowsListagem: any[] = [];
        for (const item of produtos) {
          const envelopado =
            item && typeof item === "object" && !Array.isArray(item) &&
            typeof item.produto === "object" && item.produto !== null;
          const p = envelopado ? item.produto : item;
          const comDetalhe = envelopado && item.detalhe === true;
          try {
            if (comDetalhe) {
              rowsDetalhe.push(mapProduct(p, blingConnectionId, { detail: true }));
              totalComDetalhe += 1;
            } else {
              rowsListagem.push(mapProduct(p, blingConnectionId));
            }
          } catch (e: any) {
            totalErros += 1;
            erros.push({ bling_product_id: p?.id, mensagem: String(e?.message ?? e) });
          }
        }

        // Upserts SEPARADOS por conjunto de colunas — nunca deleta.
        //
        // As linhas de detalhe têm colunas que as de listagem não têm (gtin, tipo, bipavel,
        // pesos, dimensões...). No insert em lote do PostgREST as colunas saem do payload e
        // toda chave ausente numa das linhas vira NULL: um único lote misto gravaria
        // gtin=NULL, tipo=NULL e bipavel=NULL em cima de todo produto cujo detalhe falhou.
        // É a mesma perda de 09/2026, só que por outro caminho. Dois upserts homogêneos
        // eliminam a possibilidade.
        for (const [rotulo, rows] of [["detalhe", rowsDetalhe], ["listagem", rowsListagem]] as const) {
          if (rows.length === 0) continue;
          const { error: upErr } = await supabaseAdmin
            .from("produtos")
            .upsert(rows as any, { onConflict: "bling_connection_id,bling_product_id" });
          if (upErr) {
            totalErros += rows.length;
            erros.push({ mensagem: `upsert em lote (${rotulo}) falhou: ` + upErr.message });
          } else {
            totalUpserted += rows.length;
          }
        }

        // Update run log at end
        if (runId) {
          const { error: runUpdateErr } = await supabaseAdmin
            .from("produtos_sync_runs")
            .update({
              finalizado_em: new Date().toISOString(),
              total_recebidos: totalRecebidos,
              total_upserted: totalUpserted,
              total_erros: totalErros,
              // total_com_detalhe NÃO entra aqui: a tabela produtos_sync_runs não tem essa
              // coluna (ver 20260618100000_produtos-sync-runs.sql) e o update inteiro
              // falharia, zerando o log da run. Ele vai só na resposta e no console.
              detalhes: erros.length > 0 ? erros : null,
            })
            .eq("id", runId);
          if (runUpdateErr) {
            runLogged = false;
            console.error(
              "[importar-produtos-lote] falha ao atualizar run em produtos_sync_runs:",
              runUpdateErr.message,
            );
          }
        }

        console.log(
          `[importar-produtos-lote] recebidos=${totalRecebidos} upserted=${totalUpserted} com_detalhe=${totalComDetalhe} erros=${totalErros} run_logged=${runLogged}`,
        );

        return Response.json({
          ok: true,
          total_recebidos: totalRecebidos,
          total_upserted: totalUpserted,
          total_erros: totalErros,
          total_com_detalhe: totalComDetalhe,
          run_logged: runLogged,
        });
      },
    },
  },
});
