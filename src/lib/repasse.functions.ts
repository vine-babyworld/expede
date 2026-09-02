import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMLAccessToken } from "@/lib/ml.functions";
import { normalizarRepasseMl, montarCandidatosRepasse } from "@/lib/repasse";

export const MAX_CANDIDATOS_REPASSE = 4;

export type CandidatoRepasse = {
  id: string;
  bling_pedido_id: number;
  numero_loja: string | null;
};

type BillingResponse = {
  ok: boolean;
  order_items?: Array<{ unit_price: number; quantity: number; sale_fee: number }>;
  custo_envio?: number;
  shipment_status?: string | null;
  error?: string;
};

// Busca o repasse na edge function. Mesmo contrato { ok: false, error } que
// checarStatusEnvioML usa: falha aqui nunca lança pra cima.
async function buscarRepasseML(mlOrderId: string): Promise<BillingResponse> {
  let token: string;
  try {
    token = await getMLAccessToken();
  } catch {
    return { ok: false, error: "ml_no_connection" };
  }

  try {
    const { data, error } = await supabaseAdmin.functions.invoke<BillingResponse>(
      "ml-order-billing",
      { body: { ml_order_id: mlOrderId, access_token: token } },
    );
    if (error) return { ok: false, error: `edge_invoke:${error.message}` };
    if (!data) return { ok: false, error: "edge_empty_response" };
    return data;
  } catch (e) {
    return { ok: false, error: `edge_invoke_exception:${String(e)}` };
  }
}

export type ResultadoAtualizacao =
  | { ok: true; liquido: number; final: boolean }
  | { ok: false; error: string };

// Busca, normaliza e grava o repasse de um pedido. repasse_checked_at sempre
// avança, tenha dado certo ou não — senão um pedido problemático monopoliza os
// slots da rotação pra sempre (mesma razão documentada em
// atualizarSituacoesExistentes).
export async function atualizarRepassePedido(
  pedido: CandidatoRepasse,
): Promise<ResultadoAtualizacao> {
  const agora = new Date().toISOString();

  if (!pedido.numero_loja) {
    await supabaseAdmin
      .from("pedidos")
      .update({ repasse_checked_at: agora, repasse_error: "sem_numero_loja" } as any)
      .eq("id", pedido.id);
    return { ok: false, error: "sem_numero_loja" };
  }

  const resp = await buscarRepasseML(pedido.numero_loja);

  if (!resp.ok) {
    await supabaseAdmin
      .from("pedidos")
      .update({ repasse_checked_at: agora, repasse_error: resp.error ?? "erro_desconhecido" } as any)
      .eq("id", pedido.id);
    return { ok: false, error: resp.error ?? "erro_desconhecido" };
  }

  const repasse = normalizarRepasseMl({
    order_items: resp.order_items ?? [],
    custo_envio: resp.custo_envio ?? 0,
    shipment_status: resp.shipment_status ?? null,
  });

  await supabaseAdmin
    .from("pedidos")
    .update({
      repasse_valor_bruto: repasse.valor_bruto,
      repasse_tarifa_venda: repasse.tarifa_venda,
      repasse_tarifa_percentual: repasse.tarifa_percentual,
      repasse_custo_envio: repasse.custo_envio,
      repasse_valor_liquido: repasse.valor_liquido,
      repasse_final: repasse.final,
      repasse_checked_at: agora,
      repasse_error: null,
    } as any)
    .eq("id", pedido.id);

  return { ok: true, liquido: repasse.valor_liquido, final: repasse.final };
}

// Rotação em dois buckets, igual a cronMLStatus: "nunca verificados" têm
// prioridade (mais antigos primeiro); "retry" só ocupa os slots que sobrarem,
// ordenado por quem está há mais tempo sem checagem.
export async function selecionarCandidatosRepasse(
  orcamento: number = MAX_CANDIDATOS_REPASSE,
): Promise<CandidatoRepasse[]> {
  const baseQuery = () =>
    supabaseAdmin
      .from("pedidos")
      .select("id, bling_pedido_id, numero_loja")
      .eq("marketplace", "mercadolivre")
      .eq("repasse_final", false)
      .neq("situacao_id", 12)
      .not("numero_loja", "is", null);

  const { data: nuncaVerificados, error: erro1 } = (await baseQuery()
    .is("repasse_checked_at", null)
    .order("data_pedido", { ascending: false, nullsFirst: false })
    .limit(orcamento)) as any;

  if (erro1) {
    console.error("[repasse] select nunca-verificados falhou:", erro1.message);
    return [];
  }

  const slotsRestantes = orcamento - (nuncaVerificados?.length ?? 0);
  let retry: CandidatoRepasse[] = [];

  if (slotsRestantes > 0) {
    const { data: retryData, error: erro2 } = (await baseQuery()
      .not("repasse_checked_at", "is", null)
      .order("repasse_checked_at", { ascending: true })
      .limit(slotsRestantes)) as any;

    if (erro2) {
      console.error("[repasse] select retry falhou:", erro2.message);
    } else {
      retry = retryData ?? [];
    }
  }

  return montarCandidatosRepasse(nuncaVerificados ?? [], retry, orcamento);
}

export type ResultadoBackfill = {
  processados: number;
  ok: number;
  erros: Array<{ bling_pedido_id: number; error: string }>;
  restantes: number;
};

// Backfill único do histórico. Idempotente: só pega pedidos com
// repasse_checked_at nulo, então rodar de novo não reprocessa o que já tem dado.
// Chamada em lotes pra caber no limite de subrequests do Worker.
export async function backfillRepasseMl(limite: number = 40): Promise<ResultadoBackfill> {
  const { data, error } = (await supabaseAdmin
    .from("pedidos")
    .select("id, bling_pedido_id, numero_loja")
    .eq("marketplace", "mercadolivre")
    .is("repasse_checked_at", null)
    .neq("situacao_id", 12)
    .not("numero_loja", "is", null)
    .order("data_pedido", { ascending: false, nullsFirst: false })
    .limit(limite)) as any;

  if (error) throw new Error(`select backfill falhou: ${error.message}`);

  const pedidos: CandidatoRepasse[] = data ?? [];
  const erros: Array<{ bling_pedido_id: number; error: string }> = [];
  let ok = 0;

  for (const pedido of pedidos) {
    const res = await atualizarRepassePedido(pedido);
    if (res.ok) ok += 1;
    else erros.push({ bling_pedido_id: pedido.bling_pedido_id, error: res.error });
  }

  const { count } = (await supabaseAdmin
    .from("pedidos")
    .select("id", { count: "exact", head: true })
    .eq("marketplace", "mercadolivre")
    .is("repasse_checked_at", null)
    .neq("situacao_id", 12)
    .not("numero_loja", "is", null)) as any;

  console.log(`[backfill-repasse] ${ok}/${pedidos.length} ok, ${count ?? 0} restantes`);

  return { processados: pedidos.length, ok, erros, restantes: count ?? 0 };
}
