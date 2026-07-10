import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type BipagemInput = {
  pedidoItemId: string;
  pedidoId: string;
  codigoBipado: string;
  resultado: "sucesso" | "erro_ean_invalido" | "sem_codigo" | "produto_errado" | "sem_estoque";
  usuario: string | null;
};

export type BipagemResult =
  | { ok: true; pedidoConcluido: boolean }
  | { ok: false; error: string };

export const registrarBipagem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: BipagemInput) => d)
  .handler(async ({ data, context }): Promise<BipagemResult> => {
    const { userId } = context;

    const { error: bipErr } = await supabaseAdmin.from("bipagens").insert({
      pedido_item_id: data.pedidoItemId,
      codigo_bipado: data.codigoBipado,
      resultado: data.resultado,
      usuario: data.usuario,
      user_id: userId,
    });

    if (bipErr) {
      console.error("[bipagem] insert bipagens falhou:", bipErr.message);
      return { ok: false, error: bipErr.message };
    }

    if (data.resultado !== "sucesso") {
      return { ok: true, pedidoConcluido: false };
    }

    // Increment quantidade_bipada atomicamente via read-update (sistema single-operador)
    const { data: item, error: fetchErr } = await supabaseAdmin
      .from("pedido_itens")
      .select("quantidade, quantidade_bipada")
      .eq("id", data.pedidoItemId)
      .single();

    if (fetchErr || !item) {
      console.error("[bipagem] fetch pedido_item falhou:", fetchErr?.message);
      return { ok: false, error: "item_not_found" };
    }

    const atual = Number((item as any).quantidade_bipada ?? 0);
    const esperada = Number((item as any).quantidade ?? 1);

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
