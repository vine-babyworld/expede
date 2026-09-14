import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { codigosCadastrados, normalizarGtin, temEanCadastrado, type ItemBipagem } from "@/lib/bipagem";

export type ResultadoBipagemRegistro =
  | "sucesso"
  | "erro_ean_invalido"
  | "ean_nao_cadastrado"
  | "liberado_sem_ean"
  | "sem_codigo"
  | "produto_errado"
  | "sem_estoque";

export type BipagemInput = {
  pedidoItemId: string;
  pedidoId: string;
  codigoBipado: string;
  resultado: ResultadoBipagemRegistro;
  usuario: string | null;
};

export type BipagemResult =
  | { ok: true; pedidoConcluido: boolean }
  | { ok: false; error: string };

// Resultados que fazem a quantidade_bipada avançar (e portanto podem concluir o pedido
// e disparar a impressão). Todo o resto é só registro de auditoria.
const RESULTADOS_QUE_CONTAM = new Set(["sucesso", "liberado_sem_ean"]);

export const registrarBipagem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: BipagemInput) => d)
  .handler(async ({ data, context }): Promise<BipagemResult> => {
    const { userId } = context;

    // Carrega o item ANTES de gravar: o servidor reconfere o código por conta própria em
    // vez de aceitar o `resultado` que o cliente mandou. Sem isso, qualquer chamada direta
    // à server function (ou um bug na tela) conclui o pedido e imprime a etiqueta sem
    // nenhuma conferência de EAN.
    const { data: item, error: fetchErr } = await supabaseAdmin
      .from("pedido_itens")
      .select("id, sku, ean, descricao, quantidade, quantidade_bipada, produto:produtos(gtin)")
      .eq("id", data.pedidoItemId)
      .single();

    if (fetchErr || !item) {
      console.error("[bipagem] fetch pedido_item falhou:", fetchErr?.message);
      return { ok: false, error: "item_not_found" };
    }

    const itemBipagem: ItemBipagem = {
      id: String((item as any).id),
      sku: (item as any).sku ?? null,
      ean: (item as any).ean ?? null,
      produto_gtin: (item as any).produto?.gtin ?? null,
      descricao: (item as any).descricao ?? "",
      quantidade: Number((item as any).quantidade ?? 1),
      quantidade_bipada: Number((item as any).quantidade_bipada ?? 0),
    };

    // ─── Revalidação no servidor ──────────────────────────────────────────────
    let resultado = data.resultado;

    if (resultado === "sucesso") {
      const alvo = normalizarGtin(data.codigoBipado);
      const confere =
        alvo != null && codigosCadastrados(itemBipagem).some((c) => normalizarGtin(c) === alvo);

      if (!temEanCadastrado(itemBipagem)) {
        // Cliente afirmou sucesso num item que não tem EAN cadastrado — é exatamente o
        // bug corrigido em 09/2026. Rebaixa para registro de erro e recusa.
        resultado = "ean_nao_cadastrado";
      } else if (!confere) {
        resultado = "erro_ean_invalido";
      }
    } else if (resultado === "liberado_sem_ean" && temEanCadastrado(itemBipagem)) {
      // Liberação só existe para item SEM EAN. Item com EAN tem que ser bipado de verdade.
      resultado = "erro_ean_invalido";
    }

    const recusado = resultado !== data.resultado;

    const { error: bipErr } = await supabaseAdmin.from("bipagens").insert({
      pedido_item_id: data.pedidoItemId,
      codigo_bipado: data.codigoBipado,
      resultado,
      usuario: data.usuario,
      user_id: userId,
    });

    if (bipErr) {
      console.error("[bipagem] insert bipagens falhou:", bipErr.message);
      return { ok: false, error: bipErr.message };
    }

    if (recusado) {
      console.warn(
        `[bipagem] cliente enviou "${data.resultado}" mas o servidor apurou "${resultado}" ` +
          `(item ${data.pedidoItemId}, código "${data.codigoBipado}")`,
      );
      return { ok: false, error: resultado };
    }

    if (!RESULTADOS_QUE_CONTAM.has(resultado)) {
      return { ok: true, pedidoConcluido: false };
    }

    const atual = itemBipagem.quantidade_bipada;
    const esperada = itemBipagem.quantidade;

    // Trava contra over-scan: item já completo não incrementa de novo (bipagem duplicada/scanner
    // double-fire não pode empurrar quantidade_bipada além do pedido — isso "conclui" o pedido
    // silenciosamente sem printed_at, fazendo-o sumir do Checkout sem nunca ter sido impresso)
    const nova = atual >= esperada ? atual : atual + 1;
    if (nova !== atual) {
      await supabaseAdmin
        .from("pedido_itens")
        .update({ quantidade_bipada: nova } as any)
        .eq("id", data.pedidoItemId);
    }

    // Re-query para verificar se todos os itens foram concluídos
    const { data: allItems } = await supabaseAdmin
      .from("pedido_itens")
      .select("quantidade, quantidade_bipada")
      .eq("pedido_id", data.pedidoId);

    const pedidoConcluido = (allItems ?? []).every(
      (i: any) => Number(i.quantidade_bipada) >= Number(i.quantidade),
    );

    return { ok: true, pedidoConcluido };
  });
