import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { lerFlagConfig, NF_CONFIG_FLEX } from "@/lib/nf-config.server";
import {
  classificarEmissaoNf,
  isPedidoFlex,
  ML_BLING_LOJA_ID as ML_LOJA_ID,
  SHOPEE_BLING_LOJA_ID as SHOPEE_LOJA_ID,
  type MarketplacePedido,
} from "@/lib/nf-emissao.policy";
import { validarCandidatoAtendidoMl } from "@/lib/atendidos-ml";
import {
  agregarCandidatosReconciliacao,
  construirUrlsConsultasMl,
  janelaCivilBrt,
  planejarInspecoesReconciliacao,
  registrarErroConsulta,
  type CandidatoReconciliacao,
} from "@/lib/reconciliar-atendidos";

export { isPedidoFlex } from "@/lib/nf-emissao.policy";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
const DEPOSITO_ALVO = "Geral";
const MAX_CANDIDATOS_POR_EXECUCAO = 4;
const MAX_CANDIDATOS_SITUACAO = 4; // orçamento próprio de atualizarSituacoesExistentes (não compartilha com MAX_CANDIDATOS_POR_EXECUCAO)
const BLING_PRODUTOS_URL = "https://api.bling.com.br/Api/v3/produtos";
const BLING_NFE_URL = "https://api.bling.com.br/Api/v3/nfe";

export type PedidoRow = {
  id: string;
  bling_pedido_id: number;
  numero: string;
  numero_loja: string | null;
  situacao_id: number | null;
  situacao_valor: number | null;
  data_pedido: string | null;
  total: number | null;
  cliente: Record<string, any> | null;
  bling_nota_fiscal_id: number | null;
  bling_nota_fiscal_numero: string | null;
  nf_emissao_modo: string | null;
  nf_emissao_status: string | null;
  nf_emissao_error: string | null;
  etiqueta_zpl: string | null;
  created_at: string;
  updated_at: string;
  items_count: number;
  ml_shipment_status: string | null;
  ml_shipment_substatus: string | null;
  bling_divergente: boolean;
};

export type ListarPedidosInput = {
  search?: string;
  hidecanceled?: boolean;
  page?: number;
};

export type ListarPedidosResult = {
  rows: PedidoRow[];
  total: number;
  page: number;
  pageSize: number;
};

const PAGE_SIZE = 50;

export const listarPedidos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: ListarPedidosInput) => d)
  .handler(async ({ data }): Promise<ListarPedidosResult> => {
    const { search = "", hidecanceled = true, page = 1 } = data;
    const offset = (page - 1) * PAGE_SIZE;

    let query = supabaseAdmin
      .from("pedidos")
      .select(
        "id, bling_pedido_id, numero, numero_loja, situacao_id, situacao_valor, data_pedido, total, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, nf_emissao_modo, nf_emissao_status, nf_emissao_error, etiqueta_zpl, created_at, updated_at, ml_shipment_status, ml_shipment_substatus, bling_divergente, pedido_itens(count)",
        { count: "exact" },
      );

    if (search.trim()) {
      const term = search.trim();
      query = query.or(`numero.ilike.%${term}%,numero_loja.ilike.%${term}%`);
    }

    if (hidecanceled) {
      query = query.neq("situacao_valor", 12);
    }

    query = query
      .order("data_pedido", { ascending: false, nullsFirst: false })
      .range(offset, offset + PAGE_SIZE - 1);

    const { data: rows, error, count } = await query;
    if (error) throw new Error(error.message);

    return {
      rows: (rows ?? []).map((r: any) => ({
        ...r,
        items_count: r.pedido_itens?.[0]?.count ?? 0,
        pedido_itens: undefined,
      })),
      total: count ?? 0,
      page,
      pageSize: PAGE_SIZE,
    };
  });

// ---- Kit explosion helpers ----

export function parseComponentesKit(codigo: string): string[] {
  if (!codigo.includes("/")) return [codigo];
  return codigo
    .split("/")
    .map((part) => part.replace(/^c[oó]d:\s*/i, "").trim())
    .filter(Boolean);
}

export async function buscarProdutoPorSku(
  sku: string,
  blingConnectionId: string,
): Promise<{ id: string; gtin: string | null; nome: string } | null> {
  const { data } = await supabaseAdmin
    .from("produtos")
    .select("id, gtin, nome")
    .eq("sku", sku)
    .eq("bling_connection_id", blingConnectionId)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// Resolve produto_id + ean de um item de pedido Bling: tenta GTIN primeiro, cai para SKU,
// e usa o gtin do produto cadastrado como fallback quando o item não traz gtin.
// Mesma lógica usada por processarPedidoBling (reconciler) — ponto único de matching.
export async function resolverProdutoDoItem(
  it: { codigo?: string | null; gtin?: string | null },
  blingConnectionId: string,
): Promise<{ produtoId: string | null; ean: string | null }> {
  const gtin = it.gtin ?? null;
  const sku = it.codigo ?? null;

  if (gtin) {
    const { data } = await supabaseAdmin
      .from("produtos")
      .select("id, gtin")
      .eq("gtin", gtin)
      .eq("bling_connection_id", blingConnectionId)
      .limit(1)
      .maybeSingle();
    if (data) return { produtoId: data.id, ean: gtin };
  }

  if (sku) {
    const produto = await buscarProdutoPorSku(sku, blingConnectionId);
    if (produto) return { produtoId: produto.id, ean: gtin ?? produto.gtin ?? null };
  }

  return { produtoId: null, ean: gtin };
}

async function buscarEanPorSku(
  sku: string,
  blingConnectionId: string,
  blingToken: string,
): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("produtos")
      .select("gtin")
      .eq("sku", sku)
      .eq("bling_connection_id", blingConnectionId)
      .not("gtin", "is", null)
      .limit(1)
      .maybeSingle();
    if (data?.gtin) return data.gtin as string;

    const res = await fetch(
      `${BLING_PRODUTOS_URL}?codigo=${encodeURIComponent(sku)}&limite=1`,
      { headers: { Authorization: `Bearer ${blingToken}`, Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    return (json?.data?.[0]?.gtin as string) ?? null;
  } catch (err) {
    console.error(`[buscarEanPorSku] sku=${sku}:`, err);
    return null;
  }
}

// ---- / Kit explosion helpers ----

export async function sincronizarPoliticaInicialEmissaoNf(
  pedidoDbId: string,
  detalhe: any,
  marketplace: MarketplacePedido,
): Promise<void> {
  const db = supabaseAdmin as any;
  const emitirFlex = await lerFlagConfig(NF_CONFIG_FLEX);
  const classificacao = classificarEmissaoNf(detalhe, marketplace, { emitirFlex });

  if (classificacao === "out_of_scope") return;

  if (classificacao === "existing") {
    // Se o Bling criou a nota antes do controlador assumir, ela não pertence à
    // fila do EXPEDE. Evita reenviar uma NF que a automação antiga já tratou.
    await db
      .from("pedidos")
      .update({
        nf_emissao_modo: "automatic",
        nf_emissao_status: "sent",
        nf_emissao_locked_at: null,
        nf_emissao_error: null,
      })
      .eq("id", pedidoDbId)
      // Linha recem-ingerida tem modo NULL: o .eq("automatic") anterior nao casava
      // nada e o pedido ficava invisivel pro controlador e pro relatorio diario.
      // O OR mantem a intencao original de nunca sobrescrever um Flex ("manual").
      .or("nf_emissao_modo.is.null,nf_emissao_modo.eq.automatic");
    return;
  }

  if (classificacao === "manual") {
    await db
      .from("pedidos")
      .update({
        nf_emissao_modo: "manual",
        nf_emissao_status: "manual",
        nf_emissao_locked_at: null,
        nf_emissao_error: null,
      })
      .eq("id", pedidoDbId);
    return;
  }

  if (classificacao === "automatic") {
    await db
      .from("pedidos")
      .update({
        nf_emissao_modo: "automatic",
        nf_emissao_status: "pending",
        nf_emissao_error: null,
      })
      .eq("id", pedidoDbId)
      .is("nf_emissao_modo", null);

    // Um payload inicial incompleto pode ter sido bloqueado sem serviço. Assim
    // que o detalhe ficar completo, promove apenas esse bloqueio conhecido.
    await db
      .from("pedidos")
      .update({ nf_emissao_status: "pending", nf_emissao_error: null })
      .eq("id", pedidoDbId)
      .eq("nf_emissao_modo", "automatic")
      .eq("nf_emissao_status", "blocked")
      .eq("nf_emissao_error", "UNKNOWN_LOGISTICS_SERVICE");
    return;
  }

  const error = classificacao === "cancelled"
    ? "ORDER_CANCELLED"
    : "UNKNOWN_LOGISTICS_SERVICE";

  await db
    .from("pedidos")
    .update({
      nf_emissao_modo: "automatic",
      nf_emissao_status: "blocked",
      nf_emissao_error: error,
      nf_emissao_locked_at: null,
    })
    .eq("id", pedidoDbId)
    .is("nf_emissao_modo", null);
}

// Shared helper — mesma lógica do webhook bling-pedidos.ts
async function processarPedidoBling(
  blingPedidoId: number | string,
  connId: string,
  token: string,
  opts: {
    permitirSemNf?: boolean;
    marketplace?: "mercadolivre" | "shopee";
    atendidoMl?: { lojaId: string; dataInicio: string; dataFim: string };
  } = {},
): Promise<{
  ok: boolean;
  skipped?: string;
  error?: string;
  detalhe: string;
  numeroLoja?: string | null;
  numero?: string;
  temNf?: boolean;
}> {
  const res = await fetch(`${BLING_PEDIDOS_URL}/${blingPedidoId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[processarPedido] GET ${blingPedidoId} falhou: ${res.status}`, txt);
    return { ok: false, error: `bling_api_error:${res.status}`, detalhe: `erro HTTP ${res.status} ao buscar pedido` };
  }

  const json: any = await res.json();
  const d = json?.data;
  if (!d) return { ok: false, error: "empty_response", detalhe: "resposta vazia da API Bling" };

  if (opts.atendidoMl) {
    const validacao = validarCandidatoAtendidoMl(
      d,
      opts.atendidoMl.lojaId,
      opts.atendidoMl.dataInicio,
      opts.atendidoMl.dataFim,
    );
    if (!validacao.valido) {
      return {
        ok: true,
        skipped: "invalid_atendido_ml",
        detalhe: `candidato Atendido ML inválido — ${validacao.motivo}`,
      };
    }
  }

  if (!d.notaFiscal?.id) {
    if (!opts.permitirSemNf) return { ok: true, skipped: "no_invoice", detalhe: "sem nota fiscal" };
    const servico: string = d.transporte?.volumes?.[0]?.servico ?? "";
    console.log(`[processarPedido] sem NF: pedido ${blingPedidoId} servico="${servico || "—"}"`);
  }

  const itens: any[] = d.itens ?? [];
  const itemForaDoDeposito = itens.find(
    (it: any) => it.deposito?.descricao !== undefined && it.deposito?.descricao !== DEPOSITO_ALVO,
  );
  if (itemForaDoDeposito) return { ok: true, skipped: "wrong_warehouse", detalhe: "depósito incorreto" };

  let nfNumero: string | null = d.notaFiscal?.numero ?? null;
  if (d.notaFiscal?.id && !nfNumero) {
    nfNumero = await fetchNfNumeroBling(d.notaFiscal.id, token);
  }

  const pedidoPayload = {
    bling_connection_id:      connId,
    bling_pedido_id:          d.id,
    numero:                   String(d.numero ?? d.id),
    numero_loja:              d.numeroLoja ?? null,
    situacao_id:              d.situacao?.id ?? null,
    situacao_valor:           d.situacao?.valor ?? null,
    data_pedido:              d.data ? new Date(d.data).toISOString() : null,
    total:                    d.total ?? null,
    cliente:                  d.contato ?? null,
    bling_nota_fiscal_id:     (d.notaFiscal?.id && d.notaFiscal.id !== 0) ? d.notaFiscal.id : null,
    bling_nota_fiscal_numero: nfNumero,
    marketplace:              opts.marketplace ?? "mercadolivre",
    raw_json:                 d,
  };

  const { data: upserted, error: upsertErr } = await supabaseAdmin
    .from("pedidos")
    .upsert(pedidoPayload, { onConflict: "bling_connection_id,bling_pedido_id", ignoreDuplicates: false })
    .select("id")
    .single();

  if (upsertErr || !upserted) {
    console.error("[processarPedido] upsert falhou:", upsertErr?.message);
    return { ok: false, error: "upsert_error: " + upsertErr?.message, detalhe: "falha ao salvar pedido no banco" };
  }

  const pedidoDbId: string = upserted.id;

  await sincronizarPoliticaInicialEmissaoNf(
    pedidoDbId,
    d,
    opts.marketplace ?? "mercadolivre",
  );

  // Identifica SKUs de componentes de kits neste pedido — usado só para pular
  // relookup de produto/EAN de componentes já conhecidos (evita subrequests repetidos
  // a cada reconciliação). Preservação de quantidade_bipada agora é responsabilidade
  // do upsert por (pedido_id, sku) abaixo, não mais de um delete seletivo.
  const componentSkusFromKits = new Set<string>();
  for (const it of itens) {
    const componentes = parseComponentesKit(it.codigo ?? "");
    if (componentes.length >= 2) componentes.forEach((s) => componentSkusFromKits.add(s));
  }

  let jaExplodidosSkus = new Set<string>();
  if (componentSkusFromKits.size > 0) {
    const { data: existentes } = await supabaseAdmin
      .from("pedido_itens")
      .select("sku")
      .eq("pedido_id", pedidoDbId)
      .in("sku", [...componentSkusFromKits]);
    jaExplodidosSkus = new Set((existentes ?? []).map((r: any) => r.sku as string).filter(Boolean));
  }

  if (itens.length === 0) {
    console.log(`[processarPedido] pedido ${blingPedidoId} chegou com itens vazios — pedido_itens preservado sem alteração`);
  }

  // Monta rows de itens — kits são explodidos em componentes individuais
  const itensPrepared: any[] = [];

  // Pré-carrega produto_id para itens simples em duas queries em lote (evita N subrequests por item)
  const itensSimples = itens.filter((it: any) => parseComponentesKit(it.codigo ?? "").length < 2);
  const todosGtins = itensSimples.map((it: any) => it.gtin).filter(Boolean) as string[];
  const todosSkus  = itensSimples.map((it: any) => it.codigo).filter(Boolean) as string[];

  const { data: produtosPorGtinRows } = todosGtins.length > 0
    ? await supabaseAdmin.from("produtos").select("id, gtin")
        .in("gtin", todosGtins).eq("bling_connection_id", connId)
    : { data: [] as { id: string; gtin: string }[] };

  const { data: produtosPorSkuRows } = todosSkus.length > 0
    ? await supabaseAdmin.from("produtos").select("id, sku, gtin")
        .in("sku", todosSkus).eq("bling_connection_id", connId)
    : { data: [] as { id: string; sku: string; gtin: string | null }[] };

  const gtinMap = new Map<string, { id: string; gtin: string | null }>(
    (produtosPorGtinRows ?? []).map((r: any) => [r.gtin as string, { id: r.id as string, gtin: (r.gtin ?? null) as string | null }]),
  );
  const skuMap = new Map<string, { id: string; gtin: string | null }>(
    (produtosPorSkuRows ?? []).map((r: any) => [r.sku as string, { id: r.id as string, gtin: (r.gtin ?? null) as string | null }]),
  );

  for (const it of itens) {
    const sku = it.codigo ?? null;
    const componentes = parseComponentesKit(sku ?? "");

    if (componentes.length < 2) {
      // Item simples — lookup no Map pré-carregado, sem subrequests por item
      const gtin = it.gtin ?? null;
      const lookupResult =
        (gtin ? gtinMap.get(gtin) : undefined) ??
        (sku  ? skuMap.get(sku)   : undefined) ??
        null;
      const produtoId = lookupResult?.id ?? null;
      // usa gtin do item; se vazio, copia do produto encontrado no cadastro
      const eanFinal = gtin ?? lookupResult?.gtin ?? null;

      itensPrepared.push({
        pedido_id:          pedidoDbId,
        produto_id:         produtoId,
        bling_item_id:      it.id ?? null,
        sku,
        ean:                eanFinal,
        descricao:          it.descricao ?? "",
        quantidade:         it.quantidade ?? 1,
        valor_unitario:     it.valor ?? null,
        deposito_id:        it.deposito?.id ?? null,
        deposito_descricao: it.deposito?.descricao ?? null,
      });
    } else {
      // Kit — explode em componentes individuais
      for (const skuComponente of componentes) {
        if (jaExplodidosSkus.has(skuComponente)) continue; // já no DB, preserva bipagem

        const produto = await buscarProdutoPorSku(skuComponente, connId);
        let ean = produto?.gtin ?? null;
        if (!ean) ean = await buscarEanPorSku(skuComponente, connId, token);

        itensPrepared.push({
          pedido_id:          pedidoDbId,
          produto_id:         produto?.id ?? null,
          bling_item_id:      it.id ?? null,
          sku:                skuComponente,
          ean,
          descricao:          produto?.nome ?? `${it.descricao ?? ""} (componente ${skuComponente})`,
          quantidade:         it.quantidade ?? 1,
          quantidade_bipada:  0,
          valor_unitario:     null,
          deposito_id:        it.deposito?.id ?? null,
          deposito_descricao: it.deposito?.descricao ?? null,
        });
      }
      console.log(`[processarPedido] kit explodido: sku="${sku}" → [${componentes.join(", ")}]`);
    }
  }

  if (itensPrepared.length > 0) {
    // Upsert por (pedido_id, sku) — nunca deleta antes de gravar. Evita a race condition
    // de reconciliação concorrente (webhook + reconciliarPedidos) apagando um item que a
    // outra chamada acabou de inserir; ON CONFLICT não toca quantidade_bipada (só presente
    // no payload de itens novos), preservando progresso de bipagem automaticamente.
    const { error: itemsErr } = await supabaseAdmin
      .from("pedido_itens")
      .upsert(itensPrepared, { onConflict: "pedido_id,sku" });
    if (itemsErr) console.error("[processarPedido] upsert itens falhou:", itemsErr.message);
  }

  console.log(
    `[processarPedido] OK pedido=${blingPedidoId} db_id=${pedidoDbId}` +
    ` inseridos=${itensPrepared.length} preservados=${jaExplodidosSkus.size}`,
  );
  const nfDetalhe = pedidoPayload.bling_nota_fiscal_numero
    ? `NF ${pedidoPayload.bling_nota_fiscal_numero}`
    : "FLEX sem NF";
  return {
    ok: true,
    detalhe: nfDetalhe,
    numeroLoja: pedidoPayload.numero_loja,
    numero: pedidoPayload.numero,
    temNf: !!pedidoPayload.bling_nota_fiscal_id,
  };
}

export type ReconciliarQueryReport = {
  encontrados: number;
  importados: number;
  pulados: number;
  erros: string[];
};

export type AtualizarSituacoesReport = {
  verificados: number;
  atualizados: number;
  erros: string[];
};

export type ItensAusentesReport = {
  verificados: number;
  recuperados: number;
  erros: string[];
};


export type PedidoImportadoNovo = {
  numeroLoja: string | null;
  numero: string;
  temNf: boolean;
};

export type ReconciliarReport = {
  query1: ReconciliarQueryReport;
  query2: ReconciliarQueryReport;
  query3: ReconciliarQueryReport;
  query4: ReconciliarQueryReport;
  query5: ReconciliarQueryReport;
  situacoes: AtualizarSituacoesReport;
  itensAusentes: ItensAusentesReport;
  detalhes: string[];

  // Total de candidatos distintos vistos nesta rodada (deduplicado entre Q1-Q5) —
  // diferente da soma de query1.encontrados + query2.encontrados, que conta sobreposições.
  totalCandidatos: number;
  // Pedidos efetivamente inseridos nesta execução (exclui os pulados por já existir).
  importadosNovos: PedidoImportadoNovo[];
};

function novoQueryReport(): ReconciliarQueryReport {
  return { encontrados: 0, importados: 0, pulados: 0, erros: [] };
}

function novaSituacoesReport(): AtualizarSituacoesReport {
  return { verificados: 0, atualizados: 0, erros: [] };
}

function novaItensAusentesReport(): ItensAusentesReport {
  return { verificados: 0, recuperados: 0, erros: [] };
}

export async function reconciliarPedidos(): Promise<ReconciliarReport> {
  const report: ReconciliarReport = {
    query1: novoQueryReport(),
    query2: novoQueryReport(),
    query3: novoQueryReport(),
    query4: novoQueryReport(),
    query5: novoQueryReport(),
    situacoes: novaSituacoesReport(),
    itensAusentes: novaItensAusentesReport(),
    detalhes: [],

    totalCandidatos: 0,
    importadosNovos: [],
  };

  // Prefere uma conexão com status="connected" (mais antiga entre as conectadas).
  // Com múltiplas contas Bling cadastradas (uma por usuário), a mais antiga por
  // created_at nem sempre é a que está saudável — ex: 2026-08-21, a conexão mais
  // antiga ficou "expired" (invalid_grant, token não renovável) enquanto uma
  // conexão mais nova estava "connected" e funcionando; escolher sempre a mais
  // antiga travava toda a sincronização.
  // Se NENHUMA estiver "connected" (ex: única conexão existente, temporariamente
  // expirada), cai no fallback abaixo sem filtrar por status — getDecryptedAccessToken
  // decide sozinho se precisa renovar, e toda execução (a cada 1 min) tenta de novo,
  // autocurando o problema assim que o Bling voltar a responder.
  let conn: { id: string } | null = null;
  {
    const { data } = await supabaseAdmin
      .from("bling_connections")
      .select("id")
      .eq("status", "connected")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    conn = data;
  }
  let errConn: { message: string } | undefined;
  if (!conn) {
    const { data, error } = await supabaseAdmin
      .from("bling_connections")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    conn = data;
    errConn = error ?? undefined;
  }

  console.log("[reconciliar] conn result:", JSON.stringify({ conn, error: errConn?.message }));

  if (!conn) {
    console.log("[reconciliar] nenhuma conexão cadastrada");
    report.detalhes.push("nenhuma conexão Bling cadastrada");
    return report;
  }

  let token: string;
  try {
    token = await getDecryptedAccessToken(conn.id);
  } catch (e) {
    console.error("[reconciliar] erro ao obter token:", e);
    report.detalhes.push(`erro ao obter token Bling: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  // Janela de 10 dias. A API Bling retorna os mais recentes primeiro, mas o
  // processamento abaixo reordena por data mais antiga — com MAX_CANDIDATOS_POR_EXECUCAO
  // limitando quantos rodam por execução, isso garante que a fila sempre avance
  // (pedidos antigos pendentes não ficam perpetuamente atrás de chegadas novas).
  const { inicio: dataInicio, fim: dataFim } = janelaCivilBrt(new Date(), 10);
  // Shopee usa janela menor (7 dias) para nunca reimportar pedidos antigos que já foram
  // processados fora do EXPEDE e chegaram duplicados via sync sem filtro de data.
  const dataInicioShopee = new Date(Date.now() - 7 * 86_400_000).toISOString().substring(0, 10);

  // Query 1: faturados (idSituacao=9) — últimos 10 dias, loja ML
  // Query 2: loja ML (idLoja=203482894) — últimos 10 dias, inclui pedidos sem NF
  // Query 4: atendidos ML (idSituacao=15 + idLoja=203482894) — últimos 10 dias,
  // validada de novo no detalhe porque a API pode ignorar filtros de lista.
  // Query 5: faturados (idSituacao=9) — últimos 7 dias, loja Shopee (sempre exige NF, sem variante "sem NF")
  const urlQ5 = `${BLING_PEDIDOS_URL}?idSituacao=9&idLoja=${SHOPEE_LOJA_ID}&limite=50&pagina=1&dataInicio=${dataInicioShopee}`;
  const urlsMl = construirUrlsConsultasMl(BLING_PEDIDOS_URL, String(ML_LOJA_ID), dataInicio, dataFim);
  console.log(`[reconciliar] Q5 url=${urlQ5}`);

  const [resFaturados, resLoja, resAtendidosML, resFaturadosShopee] = await Promise.allSettled([
    fetch(urlsMl.q1, { headers }),
    fetch(urlsMl.q2, { headers }),
    fetch(urlsMl.q4, { headers }),
    fetch(urlQ5, { headers }),
  ]);
  const resAtendidos: PromiseSettledResult<Response> = { status: "rejected", reason: "desativado" } as PromiseSettledResult<Response>;

  // Agrega candidatos das cinco listas; loja ML (Q2) sempre promove para permitirSemNf=true
  const candidatosBrutos: CandidatoReconciliacao[] = [];

  if (resFaturados.status === "fulfilled" && resFaturados.value.ok) {
    const json: any = await resFaturados.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query1.encontrados = lista.length;
    for (const p of lista) {
      candidatosBrutos.push({ id: p.id, permitirSemNf: false, origem: "q1", dataPedido: p.data ?? null });
    }
  } else {
    const motivo = resFaturados.status === "rejected" ? resFaturados.reason : (resFaturados.value as any)?.status;
    console.error("[reconciliar] GET faturados falhou:", motivo);
    report.detalhes.push(`Q1 erro ao buscar lista: ${String(motivo)}`);
  }

  if (resAtendidos.status === "fulfilled" && resAtendidos.value.ok) {
    const json: any = await resAtendidos.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query3.encontrados = lista.length;
    for (const p of lista) {
      candidatosBrutos.push({ id: p.id, permitirSemNf: false, origem: "q3", dataPedido: p.data ?? null });
    }
  } else {
    const motivo = resAtendidos.status === "rejected" ? resAtendidos.reason : (resAtendidos.value as any)?.status;
    console.error("[reconciliar] GET atendidos falhou:", motivo);
    report.detalhes.push(`Q3 erro ao buscar lista: ${String(motivo)}`);
  }

  if (resAtendidosML.status === "fulfilled" && resAtendidosML.value.ok) {
    const json: any = await resAtendidosML.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query4.encontrados = lista.length;
    for (const p of lista) {
      candidatosBrutos.push({ id: p.id, permitirSemNf: true, origem: "q4", dataPedido: p.data ?? null });
    }
  } else {
    const motivo = resAtendidosML.status === "rejected" ? resAtendidosML.reason : (resAtendidosML.value as any)?.status;
    console.error("[reconciliar] GET atendidos ML falhou:", motivo);
    registrarErroConsulta(report.query4, report.detalhes, "Q4", motivo);
  }

  if (resLoja.status === "fulfilled" && resLoja.value.ok) {
    const json: any = await resLoja.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query2.encontrados = lista.length;
    for (const p of lista) {
      candidatosBrutos.push({ id: p.id, permitirSemNf: true, origem: "q2", dataPedido: p.data ?? null });
    }
  } else {
    const motivo = resLoja.status === "rejected" ? resLoja.reason : (resLoja.value as any)?.status;
    console.error("[reconciliar] GET loja ML falhou:", motivo);
    report.detalhes.push(`Q2 erro ao buscar lista: ${String(motivo)}`);
  }

  if (resFaturadosShopee.status === "fulfilled" && resFaturadosShopee.value.ok) {
    const json: any = await resFaturadosShopee.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query5.encontrados = lista.length;
    console.log(`[reconciliar] Q5 retornou ${lista.length} item(ns)`);
    let q5Pulados = 0;
    for (const p of lista) {
      // Filtro defensivo: mesmo que o Bling ignore dataInicio para esta loja,
      // rejeitamos qualquer pedido cuja data seja anterior à janela de 7 dias.
      if (p.data && p.data < dataInicioShopee) {
        q5Pulados++;
        console.warn(`[reconciliar] Q5 pedido ${p.id} data=${p.data} anterior à janela ${dataInicioShopee} — ignorado`);
        continue;
      }
      candidatosBrutos.push({ id: p.id, permitirSemNf: false, origem: "q5", dataPedido: p.data ?? null });
    }
    if (q5Pulados > 0) report.detalhes.push(`Q5 pulados por data anterior à janela: ${q5Pulados}`);
  } else {
    const motivo = resFaturadosShopee.status === "rejected" ? resFaturadosShopee.reason : (resFaturadosShopee.value as any)?.status;
    console.error("[reconciliar] GET faturados Shopee falhou:", motivo);
    report.detalhes.push(`Q5 erro ao buscar lista: ${String(motivo)}`);
  }

  const candidatos = agregarCandidatosReconciliacao(candidatosBrutos);
  report.totalCandidatos = candidatos.length;

  if (candidatos.length === 0) {
    console.log("[reconciliar] nenhum candidato");
    report.detalhes.push("nenhum candidato encontrado");
  } else {
    const allIds = candidatos.map((c) => c.id);
    const { data: existentes } = await supabaseAdmin
      .from("pedidos")
      .select("bling_pedido_id, bling_nota_fiscal_id, bling_nota_fiscal_numero, arquivado, updated_at")
      .in("bling_pedido_id", allIds);

    // Pedidos que já existem E já têm NF (id + numero), ou foram arquivados, não precisam ser reprocessados
    const existentesComNfSet = new Set(
      (existentes ?? [])
        .filter((e: any) => (e.bling_nota_fiscal_id != null && e.bling_nota_fiscal_id !== 0 && e.bling_nota_fiscal_numero != null) || e.arquivado)
        .map((e: any) => e.bling_pedido_id)
    );
    // Já existem no banco mas sem NF ainda — tentativa anterior não fechou (ex: aguardando
    // faturamento no Bling, fora do nosso controle). Não tratar como "nunca tentado".
    const existentesSemNfSet = new Set(
      (existentes ?? [])
        .filter((e: any) => !existentesComNfSet.has(e.bling_pedido_id))
        .map((e: any) => e.bling_pedido_id)
    );
    // updated_at de cada "sem NF" existente, pra rotacionar o retry por "checado há mais tempo"
    // em vez de uma chave estática (ver Lição #16 do cron-ml-status — mesmo bug, fila diferente).
    const updatedAtPorId = new Map<number, string | null>(
      (existentes ?? []).map((e: any) => [e.bling_pedido_id, e.updated_at ?? null])
    );

    console.log(`[reconciliar] ${candidatos.length} candidato(s), ${existentesComNfSet.size} já existem com NF no banco`);

    // "Nunca tentados" (candidatos que ainda não existem no banco sem NF) priorizam os mais
    // antigos primeiro (dataPedido ASC) — primeira checagem deve favorecer quem chegou antes.
    const porData = (a: { dataPedido: string | null }, b: { dataPedido: string | null }) => {
      if (!a.dataPedido && !b.dataPedido) return 0;
      if (!a.dataPedido) return 1;
      if (!b.dataPedido) return -1;
      return a.dataPedido.localeCompare(b.dataPedido);
    };
    // "Tentados sem NF" (retry) rotacionam por updated_at ASC — quem está há mais tempo sem
    // ser rechecado vai primeiro. Ordenar esse bucket por dataPedido (chave estática) faria os
    // mesmos pedidos mais antigos monopolizarem os slots pra sempre, deixando pedidos mais
    // recentes ainda sem NF (ex: importado há horas, nunca retentado) travados indefinidamente
    // atrás deles — mesmo padrão da Lição #16, mas aqui na fila do próprio reconciliador.
    const porUpdatedAt = (a: { id: number }, b: { id: number }) => {
      const ua = updatedAtPorId.get(a.id) ?? null;
      const ub = updatedAtPorId.get(b.id) ?? null;
      if (!ua && !ub) return 0;
      if (!ua) return -1;
      if (!ub) return 1;
      return ua.localeCompare(ub);
    };
    const nuncaTentados = candidatos.filter((c) => !existentesSemNfSet.has(c.id)).sort(porData);
    const tentadosSemNf = candidatos.filter((c) => existentesSemNfSet.has(c.id)).sort(porUpdatedAt);
    const candidatosOrdenados = [...nuncaTentados, ...tentadosSemNf];

    for (const cand of candidatosOrdenados) {
      const label = cand.origem === "q1" ? "Q1" : cand.origem === "q3" ? "Q3" : cand.origem === "q4" ? "Q4" : cand.origem === "q5" ? "Q5" : "Q2";
      const bucket = cand.origem === "q1" ? report.query1 : cand.origem === "q3" ? report.query3 : cand.origem === "q4" ? report.query4 : cand.origem === "q5" ? report.query5 : report.query2;
      if (existentesComNfSet.has(cand.id)) {
        bucket.pulados++;
        report.detalhes.push(`${label} skip: ${cand.id} — já existe com NF`);
      }
    }

    const candidatosParaInspecionar = planejarInspecoesReconciliacao(
      candidatosOrdenados.filter((cand) => !existentesComNfSet.has(cand.id)),
      MAX_CANDIDATOS_POR_EXECUCAO,
      Math.floor(Date.now() / 60_000),
      Math.floor(Date.now() / 60_000),
    );
    if (candidatosParaInspecionar.length < candidatosOrdenados.filter((cand) => !existentesComNfSet.has(cand.id)).length) {
      report.detalhes.push(`limite de ${MAX_CANDIDATOS_POR_EXECUCAO} inspeções atingido nesta execução — candidatos pendentes giram na próxima sincronização (1 min)`);
    }

    for (const cand of candidatosParaInspecionar) {
      const label = cand.origem === "q1" ? "Q1" : cand.origem === "q3" ? "Q3" : cand.origem === "q4" ? "Q4" : cand.origem === "q5" ? "Q5" : "Q2";
      const bucket = cand.origem === "q1" ? report.query1 : cand.origem === "q3" ? report.query3 : cand.origem === "q4" ? report.query4 : cand.origem === "q5" ? report.query5 : report.query2;
      const marketplace: "mercadolivre" | "shopee" = cand.origem === "q5" ? "shopee" : "mercadolivre";

      const result = await processarPedidoBling(cand.id, conn.id, token, {
        permitirSemNf: cand.permitirSemNf,
        marketplace,
        atendidoMl: cand.origem === "q4"
          ? { lojaId: String(ML_LOJA_ID), dataInicio, dataFim }
          : undefined,
      });
      console.log(`[reconciliar] pedido ${cand.id} (permitirSemNf=${cand.permitirSemNf}):`, JSON.stringify(result));

      if (!result.ok) {
        const msg = result.error ?? result.detalhe;
        bucket.erros.push(`${cand.id}: ${msg}`);
        report.detalhes.push(`${label} erro: ${cand.id} — ${msg}`);
      } else if (result.skipped) {
        bucket.pulados++;
        report.detalhes.push(`${label} skip: ${cand.id} — ${result.detalhe}`);
      } else {
        bucket.importados++;
        report.detalhes.push(`${label} importado: ${cand.id} — ${result.detalhe}`);
        report.importadosNovos.push({
          numeroLoja: result.numeroLoja ?? null,
          numero: result.numero ?? String(cand.id),
          temNf: result.temNf ?? false,
        });
      }

      // Respeita rate limit da API Bling (3 req/seg)
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  // Passo 2: sync bidirecional — pedidos já existentes (últimos 30 dias, não
  // cancelados) podem ter mudado de situação no Bling/ML (ex: entregue,
  // cancelado) sem que o banco tenha sido atualizado.
  await atualizarSituacoesExistentes(conn.id, token, report);

  // Passo 3: backfill de itens — pedidos já gravados (com NF) que ficaram sem
  // nenhuma linha em pedido_itens por race condition do Bling (payload do
  // webhook chegou com itens: []). Sem isso o pedido aparece com "—" na
  // expedição pra sempre, porque nada no fluxo revisita os itens.
  await reprocessarPedidosSemItens(conn.id, token, report);

  return report;
}

const MAX_CANDIDATOS_ITENS_AUSENTES = 4;

async function reprocessarPedidosSemItens(
  connId: string,
  token: string,
  report: ReconciliarReport,
): Promise<void> {
  const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: pedidos, error } = await supabaseAdmin
    .from("pedidos")
    .select("id, bling_pedido_id, numero, marketplace, pedido_itens(id)")
    .gte("data_pedido", desde)
    .not("bling_nota_fiscal_id", "is", null)
    .neq("situacao_id", 12)
    .order("data_pedido", { ascending: true });

  if (error) {
    console.error("[reconciliar] select itens-ausentes falhou:", error.message);
    report.itensAusentes.erros.push(`erro ao listar pedidos: ${error.message}`);
    return;
  }

  const semItens = (pedidos ?? [])
    .filter((p: any) => (p.pedido_itens?.length ?? 0) === 0)
    .slice(0, MAX_CANDIDATOS_ITENS_AUSENTES);

  report.itensAusentes.verificados = semItens.length;
  if (semItens.length === 0) return;

  console.log(`[reconciliar] ${semItens.length} pedido(s) sem itens — reprocessando`);

  for (const p of semItens) {
    const marketplace: "mercadolivre" | "shopee" =
      (p as any).marketplace === "shopee" ? "shopee" : "mercadolivre";

    const result = await processarPedidoBling((p as any).bling_pedido_id, connId, token, {
      permitirSemNf: true,
      marketplace,
    });

    if (!result.ok) {
      const msg = result.error ?? result.detalhe;
      report.itensAusentes.erros.push(`${(p as any).numero}: ${msg}`);
      report.detalhes.push(`itens-ausentes erro: ${(p as any).numero} — ${msg}`);
    } else {
      const { count } = await supabaseAdmin
        .from("pedido_itens")
        .select("id", { count: "exact", head: true })
        .eq("pedido_id", (p as any).id);

      if ((count ?? 0) > 0) {
        report.itensAusentes.recuperados++;
        report.detalhes.push(`itens-ausentes recuperado: ${(p as any).numero} — ${count} item(ns)`);
      } else {
        report.detalhes.push(`itens-ausentes sem itens no Bling ainda: ${(p as any).numero}`);
      }
    }

    // Respeita rate limit da API Bling (3 req/seg)
    await new Promise((r) => setTimeout(r, 350));
  }
}


// Passo 2 do reconciliar: para pedidos já existentes no banco (últimos 30 dias,
// situacao_id != 12), busca a situação atual no Bling pelo bling_pedido_id e
// atualiza situacao_id/NF caso tenham mudado.
//
// Rotação por situacao_checked_at (mesmo padrão de cronMLStatus/cronNfStatus,
// Lição #16): sem isso, a ordenação estática por data_pedido fazia os mesmos
// MAX_CANDIDATOS_SITUACAO pedidos mais antigos monopolizarem os slots todo
// ciclo, pra sempre — com centenas de pedidos ativos na janela de 30 dias, o
// resto do pool (incluindo pedidos travados sem NF) nunca chegava a ser
// revisitado. Bucket "nunca verificados" tem prioridade (mais antigos
// primeiro); bucket "retry" só usa slots sobrando, rotacionando por quem foi
// verificado há mais tempo.
async function atualizarSituacoesExistentes(
  connId: string,
  token: string,
  report: ReconciliarReport,
): Promise<void> {
  const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const baseQuery = () =>
    supabaseAdmin
      .from("pedidos")
      .select("id, bling_pedido_id, situacao_id, bling_nota_fiscal_id, situacao_checked_at, nf_emissao_modo")
      .eq("bling_connection_id", connId)
      .gte("data_pedido", desde)
      .neq("situacao_id", 12);

  const { data: nuncaVerificados, error: selectError1 } = await baseQuery()
    .is("situacao_checked_at", null)
    .order("data_pedido", { ascending: true })
    .limit(MAX_CANDIDATOS_SITUACAO);

  if (selectError1) {
    console.error("[reconciliar] select nunca-verificados (situação) falhou:", selectError1.message);
    report.situacoes.erros.push(`erro ao listar pedidos: ${selectError1.message}`);
    return;
  }

  const slotsRestantes = MAX_CANDIDATOS_SITUACAO - (nuncaVerificados?.length ?? 0);
  let retry: NonNullable<typeof nuncaVerificados> = [];

  if (slotsRestantes > 0) {
    const { data: retryData, error: selectError2 } = await baseQuery()
      .not("situacao_checked_at", "is", null)
      .order("situacao_checked_at", { ascending: true })
      .limit(slotsRestantes);

    if (selectError2) {
      console.error("[reconciliar] select retry (situação) falhou:", selectError2.message);
      report.situacoes.erros.push(`erro ao listar pedidos (retry): ${selectError2.message}`);
    } else {
      retry = retryData ?? [];
    }
  }

  const rows = [...(nuncaVerificados ?? []), ...retry];
  report.situacoes.verificados = rows.length;
  console.log(
    `[reconciliar] ${rows.length} candidato(s) p/ atualizar situação`,
    `(${nuncaVerificados?.length ?? 0} nunca verificado(s), ${retry.length} retry)`,
  );

  for (const row of rows) {
    const res = await fetch(`${BLING_PEDIDOS_URL}/${row.bling_pedido_id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!res.ok) {
      console.error(`[reconciliar] GET situação ${row.bling_pedido_id} falhou: ${res.status}`);
      report.situacoes.erros.push(`${row.bling_pedido_id}: erro HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    const json: any = await res.json().catch(() => null);
    const d = json?.data;
    const novaSituacaoId: number | null = d?.situacao?.id ?? null;
    const novaNfId: number | null = d?.notaFiscal?.id && d.notaFiscal.id !== 0 ? d.notaFiscal.id : null;

    const situacaoMudou = novaSituacaoId != null && novaSituacaoId !== row.situacao_id;
    // Pedidos importados sem NF (Q2, permitirSemNf) nunca eram revisitados depois — o Bling
    // podia faturar a NF horas/dias depois e o pedido ficava travado fora do Checkout pra
    // sempre. Só preenche (nunca apaga um bling_nota_fiscal_id já salvo por uma resposta transitória).
    const nfSurgiu = novaNfId != null && novaNfId !== row.bling_nota_fiscal_id;

    // situacao_checked_at sempre avança, tenha mudado algo ou não — é o que
    // faz a rotação acima funcionar: sem isso, um pedido que não mudou de
    // situação/NF neste ciclo continuaria com situacao_checked_at antigo (ou
    // nulo) e voltaria a monopolizar um dos slots no próximo ciclo.
    // Update individual (não upsert em lote): objetos com chaves diferentes
    // num upsert em lote do PostgREST preenchem colunas ausentes com NULL, o
    // que apagaria bling_nota_fiscal_id de pedidos que só tiveram a
    // situação/checked_at atualizados nesta rodada.
    const patch: {
      situacao_id?: number;
      bling_nota_fiscal_id?: number;
      bling_nota_fiscal_numero?: string | null;
      nf_emissao_status?: string;
      nf_emissao_locked_at?: null;
      nf_emissao_error?: null;
      situacao_checked_at: string;
    } = { situacao_checked_at: new Date().toISOString() };
    if (situacaoMudou) patch.situacao_id = novaSituacaoId;
    if (nfSurgiu) {
      patch.bling_nota_fiscal_id = novaNfId;
      patch.bling_nota_fiscal_numero =
        d.notaFiscal?.numero != null ? String(d.notaFiscal.numero) : await fetchNfNumeroBling(novaNfId, token);
      if ((row as any).nf_emissao_modo === "automatic") {
        patch.nf_emissao_status = "sent";
        patch.nf_emissao_locked_at = null;
        patch.nf_emissao_error = null;
      }
    }

    const { error: updErr } = await supabaseAdmin.from("pedidos").update(patch).eq("id", row.id);

    if (updErr) {
      console.error(`[reconciliar] update pedido ${row.bling_pedido_id} falhou:`, updErr.message);
      report.situacoes.erros.push(`${row.bling_pedido_id}: erro ao atualizar — ${updErr.message}`);
    } else if (situacaoMudou || nfSurgiu) {
      report.situacoes.atualizados++;
      if (situacaoMudou) report.detalhes.push(`situação atualizada: pedido ${row.bling_pedido_id} (${row.situacao_id} → ${novaSituacaoId})`);
      if (nfSurgiu) report.detalhes.push(`NF sincronizada: pedido ${row.bling_pedido_id} (nota fiscal ${novaNfId})`);
    }

    await new Promise((r) => setTimeout(r, 350));
  }
}

async function fetchNfNumeroBling(nfId: number, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${BLING_NFE_URL}/${nfId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const numero = json?.data?.numero;
    return numero != null ? String(numero) : null;
  } catch {
    return null;
  }
}

/**
 * Consulta a situação real da NF no Bling (autorizada, rejeitada, pendente, etc)
 * — não confundir com "bling_nota_fiscal_id preenchido", que só indica que o
 * Bling criou o registro da NF, não que ela foi autorizada pela SEFAZ.
 * Extração do motivo é best-effort: a API v3 não documenta publicamente um
 * campo de erro/motivo no GET /nfe/{id}, então tentamos os nomes mais
 * prováveis e caímos pra `null` se nenhum vier preenchido — a UI sempre tem
 * o fallback do rótulo da situação (ver nfSituacaoLabel).
 */
export async function fetchNfSituacaoBling(
  nfId: number,
  token: string,
): Promise<{ situacao: number | null; motivo: string | null }> {
  try {
    const res = await fetch(`${BLING_NFE_URL}/${nfId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return { situacao: null, motivo: null };
    const json: any = await res.json().catch(() => null);
    const d = json?.data ?? null;
    if (!d) return { situacao: null, motivo: null };

    console.log("[nf-situacao] resposta bruta Bling", JSON.stringify(d).slice(0, 1000));

    const situacao = d.situacao != null ? Number(d.situacao) : null;
    const motivo: string | null =
      d.motivo ?? d.mensagem ?? d.erro ?? d.observacoes ?? d.xJust ?? null;
    return { situacao, motivo: motivo ? String(motivo) : null };
  } catch (e) {
    console.error("[nf-situacao] erro ao consultar Bling:", e);
    return { situacao: null, motivo: null };
  }
}

/** Situações do Bling que significam NF de fato autorizada/emitida. */
export const NF_SITUACOES_AUTORIZADAS = new Set<number>([5, 6]);

const NF_SITUACAO_LABELS: Record<number, string> = {
  1: "Pendente",
  2: "Cancelada",
  3: "Aguardando recibo",
  4: "Rejeitada",
  5: "Autorizada",
  6: "Emitida DANFE",
  7: "Registrada",
  8: "Aguardando protocolo",
  9: "Denegada",
  10: "Consulta situação",
  11: "Bloqueada",
};

export function nfSituacaoLabel(codigo: number | null): string {
  if (codigo == null) return "não verificada";
  return NF_SITUACAO_LABELS[codigo] ?? `código ${codigo}`;
}

/**
 * true somente quando: a NF existe (bling_nota_fiscal_id preenchido), o cron
 * já verificou a situação real (nf_situacao != null) e essa situação NÃO está
 * no conjunto autorizado. Pedido ainda não verificado (nf_situacao null) não
 * bloqueia — mesma janela de defasagem aceita no design (poucos minutos até
 * o cronNfStatus alcançar o pedido).
 */
export function nfNaoAutorizada(p: {
  bling_nota_fiscal_id: number | null;
  nf_situacao: number | null;
}): boolean {
  if (!p.bling_nota_fiscal_id) return false;
  if (p.nf_situacao == null) return false;
  return !NF_SITUACOES_AUTORIZADAS.has(p.nf_situacao);
}

export const buscarNumeroNF = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { pedidoId: string; notaFiscalId: number }) => d)
  .handler(async ({ data }): Promise<{ numero: string | null }> => {
    const { data: conn } = await supabaseAdmin
      .from("bling_connections")
      .select("id")
      .eq("status", "connected")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!conn) return { numero: null };

    let token: string;
    try {
      token = await getDecryptedAccessToken(conn.id);
    } catch (e) {
      console.error("[buscarNumeroNF] erro ao obter token:", e);
      return { numero: null };
    }

    const numero = await fetchNfNumeroBling(data.notaFiscalId, token);

    if (numero) {
      await supabaseAdmin
        .from("pedidos")
        .update({ bling_nota_fiscal_numero: numero })
        .eq("id", data.pedidoId);
    }

    return { numero };
  });

export const marcarPedidoImpresso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { pedidoId: string }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; printed_at: string | null }> => {
    // Só grava o printed_at na primeira impressão (preserva o horário real de montagem)
    const { data: row } = await supabaseAdmin
      .from("pedidos")
      .select("printed_at")
      .eq("id", data.pedidoId)
      .maybeSingle();

    if (row?.printed_at) return { ok: true, printed_at: row.printed_at as string };

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("pedidos")
      .update({ printed_at: nowIso })
      .eq("id", data.pedidoId)
      .is("printed_at", null);
    if (error) {
      console.error("[marcarPedidoImpresso] erro:", error);
      return { ok: false, printed_at: null };
    }
    return { ok: true, printed_at: nowIso };
  });
