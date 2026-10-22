// Parte com banco da explosão de kits formato "E" (lógica pura em kit-estrutura.ts).
// Usada pelos três caminhos que gravam pedido_itens: processarPedidoBling (reconciliador),
// webhook bling-pedidos e /api/admin/importar-pedido.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  blingProductIdsDosItens,
  componentesDaEstrutura,
  componentesFaltando,
  explodirItensPorEstrutura,
  type ProdutoCadastro,
  type ResultadoExplosao,
} from "@/lib/kit-estrutura";

// Uma consulta para os itens + uma por nível de kit dentro de kit.
const RODADAS_CADASTRO = 4;

async function carregarCadastroKits(
  itens: any[],
  connId: string,
): Promise<Map<number, ProdutoCadastro>> {
  const cadastro = new Map<number, ProdutoCadastro>();
  let ids = blingProductIdsDosItens(itens);

  for (let rodada = 0; rodada < RODADAS_CADASTRO && ids.length > 0; rodada++) {
    const { data, error } = await supabaseAdmin
      .from("produtos")
      .select("id, bling_product_id, sku, gtin, nome, raw_data")
      .eq("bling_connection_id", connId)
      .in("bling_product_id", ids);
    if (error) {
      console.error("[kit-estrutura] leitura do cadastro falhou:", error.message);
      break;
    }
    for (const r of (data ?? []) as any[]) {
      cadastro.set(Number(r.bling_product_id), {
        id: String(r.id),
        bling_product_id: Number(r.bling_product_id),
        sku: r.sku ?? null,
        gtin: r.gtin ?? null,
        nome: r.nome ?? null,
        raw_data: r.raw_data ?? null,
      });
    }
    // Componente que não existe no cadastro não volta na consulta; tirar os já pedidos
    // evita repetir a mesma busca vazia nas rodadas seguintes.
    const jaBuscados = new Set(ids);
    ids = componentesFaltando(cadastro).filter((id) => !jaBuscados.has(id));
  }
  return cadastro;
}

export type PlanoItensPedido = ResultadoExplosao & {
  /** SKUs de linhas antigas do kit inteiro, nunca bipadas, que os componentes substituem. */
  linhasDeKitSubstituidas: string[];
};

/**
 * Decide como os itens do Bling viram pedido_itens, explodindo kits formato E.
 *
 * Kits ficam inteiros (comportamento antigo) quando:
 *  - o pedido já foi impresso — acrescentar componentes não bipados a um pedido que já saiu
 *    o faria parecer incompleto;
 *  - a linha do kit inteiro já tem bipagem — não se descarta conferência já feita.
 */
export async function planejarItensPedido(
  pedidoDbId: string,
  itens: any[],
  connId: string,
): Promise<PlanoItensPedido> {
  const cadastro = await carregarCadastroKits(itens, connId);

  const skusDeKit = new Set<string>();
  for (const it of itens ?? []) {
    const produto = cadastro.get(Number(it?.produto?.id));
    if (produto && componentesDaEstrutura(produto.raw_data) && it?.codigo) skusDeKit.add(String(it.codigo));
  }
  if (skusDeKit.size === 0) {
    return { ...explodirItensPorEstrutura(itens, cadastro), linhasDeKitSubstituidas: [] };
  }

  const [{ data: pedido }, { data: existentes }] = await Promise.all([
    supabaseAdmin.from("pedidos").select("printed_at").eq("id", pedidoDbId).maybeSingle(),
    supabaseAdmin
      .from("pedido_itens")
      .select("sku, quantidade_bipada")
      .eq("pedido_id", pedidoDbId)
      .in("sku", [...skusDeKit]),
  ]);

  const manterComoItem = new Set<string>();
  if ((pedido as any)?.printed_at) {
    skusDeKit.forEach((s) => manterComoItem.add(s));
  } else {
    for (const r of (existentes ?? []) as any[]) {
      if (Number(r.quantidade_bipada ?? 0) > 0) manterComoItem.add(String(r.sku));
    }
  }

  const resultado = explodirItensPorEstrutura(itens, cadastro, { manterComoItem });
  const explodidos = new Set(resultado.kitsExplodidos);
  const linhasDeKitSubstituidas = ((existentes ?? []) as any[])
    .map((r) => String(r.sku))
    .filter((sku) => explodidos.has(sku));

  if (resultado.kitsExplodidos.length > 0) {
    console.log(`[kit-estrutura] pedido ${pedidoDbId}: kits explodidos [${resultado.kitsExplodidos.join(", ")}]`);
  }
  if (resultado.kitsSemComponente.length > 0) {
    console.warn(
      `[kit-estrutura] pedido ${pedidoDbId}: kit sem componente no cadastro, ficou inteiro` +
        ` [${resultado.kitsSemComponente.join(", ")}] — sincronizar o produto componente`,
    );
  }

  return { ...resultado, linhasDeKitSubstituidas };
}

/**
 * Remove as linhas do kit inteiro que os componentes substituíram. Chamar DEPOIS de gravar os
 * componentes. O filtro quantidade_bipada = 0 protege contra um bipe que chegue entre o
 * planejamento e esta remoção.
 */
export async function removerLinhasDeKitSubstituidas(pedidoDbId: string, skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  const { error } = await supabaseAdmin
    .from("pedido_itens")
    .delete()
    .eq("pedido_id", pedidoDbId)
    .in("sku", skus)
    .eq("quantidade_bipada", 0);
  if (error) console.error("[kit-estrutura] remoção das linhas de kit falhou:", error.message);
}
