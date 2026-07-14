import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
const DEPOSITO_ALVO = "Geral";
const MAX_CANDIDATOS_POR_EXECUCAO = 4;
const ML_LOJA_ID = "203482894";
const SHOPEE_LOJA_ID = "204014269";
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
        "id, bling_pedido_id, numero, numero_loja, situacao_id, situacao_valor, data_pedido, total, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, etiqueta_zpl, created_at, updated_at, ml_shipment_status, ml_shipment_substatus, bling_divergente, pedido_itens(count)",
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

// Identifica pedidos FLEX (Mercado Livre Flex): pelo campo marketplace
// ou pela presença da tag "flex" no serviço de transporte do pedido.
export function isPedidoFlex(p: { marketplace?: string | null; raw_json?: any }): boolean {
  if (p.marketplace === "mercadolivreflex") return true;
  const servico: string = p.raw_json?.transporte?.volumes?.[0]?.servico ?? "";
  return servico.toLowerCase().includes("flex");
}

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

// Shared helper — mesma lógica do webhook bling-pedidos.ts
async function processarPedidoBling(
  blingPedidoId: number | string,
  connId: string,
  token: string,
  opts: { permitirSemNf?: boolean; marketplace?: "mercadolivre" | "shopee" } = {},
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

export async function reconciliarPedidos(): Promise<ReconciliarReport> {
  const report: ReconciliarReport = {
    query1: novoQueryReport(),
    query2: novoQueryReport(),
    query3: novoQueryReport(),
    query4: novoQueryReport(),
    query5: novoQueryReport(),
    situacoes: novaSituacoesReport(),
    detalhes: [],
    totalCandidatos: 0,
    importadosNovos: [],
  };

  // Não filtra por status="connected" aqui de propósito: getDecryptedAccessToken já
  // decide sozinho se precisa renovar (checa expiração + status). Se filtrássemos aqui,
  // uma única falha de renovação (ex: erro transitório na API do Bling) marca a conexão
  // como "expired" e ela nunca mais seria selecionada por esta query — travando a
  // sincronização inteira até alguém reconectar manualmente, mesmo com refresh_token
  // ainda válido. Sem o filtro, toda execução (a cada 1 min) tenta renovar de novo,
  // autocurando o problema assim que o Bling voltar a responder.
  const { data: conn, error: errConn } = await supabaseAdmin
    .from("bling_connections")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

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
  const dataInicio = new Date(Date.now() - 10 * 86_400_000).toISOString().substring(0, 10);
  // Shopee usa janela menor (7 dias) para nunca reimportar pedidos antigos que já foram
  // processados fora do EXPEDE e chegaram duplicados via sync sem filtro de data.
  const dataInicioShopee = new Date(Date.now() - 7 * 86_400_000).toISOString().substring(0, 10);

  // Query 1: faturados (idSituacao=9) — últimos 10 dias, loja ML FLEX
  // Query 2: loja ML FLEX (idLoja=203482894) — últimos 10 dias, inclui pedidos sem NF
  // Query 3: atendidos (idSituacao=15) — últimos 10 dias, qualquer marketplace
  // Query 5: faturados (idSituacao=9) — últimos 7 dias, loja Shopee (sempre exige NF, sem variante "sem NF")
  const urlQ5 = `${BLING_PEDIDOS_URL}?idSituacao=9&idLoja=${SHOPEE_LOJA_ID}&limite=50&pagina=1&dataInicio=${dataInicioShopee}`;
  console.log(`[reconciliar] Q5 url=${urlQ5}`);

  const [resFaturados, resLoja, resFaturadosShopee] = await Promise.allSettled([
    fetch(`${BLING_PEDIDOS_URL}?idSituacao=9&idLoja=${ML_LOJA_ID}&limite=50&pagina=1&dataInicio=${dataInicio}`, { headers }),
    fetch(`${BLING_PEDIDOS_URL}?idLoja=${ML_LOJA_ID}&limite=50&pagina=1&dataInicio=${dataInicio}`, { headers }),
    fetch(urlQ5, { headers }),
  ]);
  const resAtendidos: PromiseSettledResult<Response> = { status: "rejected", reason: "desativado" } as PromiseSettledResult<Response>;
  const resAtendidosML: PromiseSettledResult<Response> = { status: "rejected", reason: "desativado" } as PromiseSettledResult<Response>;

  // Agrega candidatos das cinco listas; loja ML (Q2) sempre promove para permitirSemNf=true
  const candidatos = new Map<number, { id: number; permitirSemNf: boolean; origem: "q1" | "q2" | "q3" | "q4" | "q5"; dataPedido: string | null }>();

  if (resFaturados.status === "fulfilled" && resFaturados.value.ok) {
    const json: any = await resFaturados.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query1.encontrados = lista.length;
    for (const p of lista) {
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q1", dataPedido: p.data ?? null });
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
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q3", dataPedido: p.data ?? null });
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
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q4", dataPedido: p.data ?? null });
    }
  } else {
    const motivo = resAtendidosML.status === "rejected" ? resAtendidosML.reason : (resAtendidosML.value as any)?.status;
    console.error("[reconciliar] GET atendidos ML falhou:", motivo);
    report.detalhes.push(`Q4 erro ao buscar lista: ${String(motivo)}`);
  }

  if (resLoja.status === "fulfilled" && resLoja.value.ok) {
    const json: any = await resLoja.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query2.encontrados = lista.length;
    for (const p of lista) {
      // Se já estava como permitirSemNf=false (Q1), promove para true e re-atribui à Q2 (loja pode ser FLEX)
      candidatos.set(p.id, { id: p.id, permitirSemNf: true, origem: "q2", dataPedido: p.data ?? null });
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
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q5", dataPedido: p.data ?? null });
    }
    if (q5Pulados > 0) report.detalhes.push(`Q5 pulados por data anterior à janela: ${q5Pulados}`);
  } else {
    const motivo = resFaturadosShopee.status === "rejected" ? resFaturadosShopee.reason : (resFaturadosShopee.value as any)?.status;
    console.error("[reconciliar] GET faturados Shopee falhou:", motivo);
    report.detalhes.push(`Q5 erro ao buscar lista: ${String(motivo)}`);
  }

  report.totalCandidatos = candidatos.size;

  if (candidatos.size === 0) {
    console.log("[reconciliar] nenhum candidato");
    report.detalhes.push("nenhum candidato encontrado");
  } else {
    const allIds = [...candidatos.keys()];
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

    console.log(`[reconciliar] ${candidatos.size} candidato(s), ${existentesComNfSet.size} já existem com NF no banco`);

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
    const nuncaTentados = [...candidatos.values()].filter((c) => !existentesSemNfSet.has(c.id)).sort(porData);
    const tentadosSemNf = [...candidatos.values()].filter((c) => existentesSemNfSet.has(c.id)).sort(porUpdatedAt);
    const candidatosOrdenados = [...nuncaTentados, ...tentadosSemNf];

    let processadosNestaExecucao = 0;
    for (const cand of candidatosOrdenados) {
      const label = cand.origem === "q1" ? "Q1" : cand.origem === "q3" ? "Q3" : cand.origem === "q4" ? "Q4" : cand.origem === "q5" ? "Q5" : "Q2";
      const bucket = cand.origem === "q1" ? report.query1 : cand.origem === "q3" ? report.query3 : cand.origem === "q4" ? report.query4 : cand.origem === "q5" ? report.query5 : report.query2;
      const marketplace: "mercadolivre" | "shopee" = cand.origem === "q5" ? "shopee" : "mercadolivre";

      if (existentesComNfSet.has(cand.id)) {
        bucket.pulados++;
        report.detalhes.push(`${label} skip: ${cand.id} — já existe com NF`);
        continue;
      }

      if (processadosNestaExecucao >= MAX_CANDIDATOS_POR_EXECUCAO) {
        report.detalhes.push(`limite de ${MAX_CANDIDATOS_POR_EXECUCAO} candidatos processados atingido nesta execução — restante será processado na próxima sincronização (1 min), priorizando os mais antigos`);
        break;
      }

      processadosNestaExecucao++;
      const result = await processarPedidoBling(cand.id, conn.id, token, { permitirSemNf: cand.permitirSemNf, marketplace });
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

  return report;
}

// Passo 2 do reconciliar: para pedidos já existentes no banco (últimos 30 dias,
// situacao_id != 12), busca a situação atual no Bling pelo bling_pedido_id e
// atualiza apenas o campo situacao_id caso tenha mudado.
async function atualizarSituacoesExistentes(
  connId: string,
  token: string,
  report: ReconciliarReport,
): Promise<void> {
  const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: existentes, error } = await supabaseAdmin
    .from("pedidos")
    .select("id, bling_pedido_id, situacao_id")
    .eq("bling_connection_id", connId)
    .gte("data_pedido", desde)
    .neq("situacao_id", 12)
    .order("data_pedido", { ascending: true })
    .limit(4); // reduzido de 8 para 4 (controle de subrequests CF)

  if (error) {
    console.error("[reconciliar] erro ao listar pedidos p/ atualizar situação:", error.message);
    report.situacoes.erros.push(`erro ao listar pedidos: ${error.message}`);
    return;
  }

  const rows = existentes ?? [];
  report.situacoes.verificados = rows.length;

  // Coleta mudanças em memória; um único upsert em lote ao final (1 subrequest total)
  const pendentes: { id: string; situacao_id: number }[] = [];

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
    const novaSituacaoId: number | null = json?.data?.situacao?.id ?? null;

    if (novaSituacaoId != null && novaSituacaoId !== row.situacao_id) {
      pendentes.push({ id: row.id, situacao_id: novaSituacaoId });
      report.situacoes.atualizados++;
      report.detalhes.push(`situação atualizada: pedido ${row.bling_pedido_id} (${row.situacao_id} → ${novaSituacaoId})`);
    }

    await new Promise((r) => setTimeout(r, 350));
  }

  if (pendentes.length > 0) {
    const { error: updErr } = await supabaseAdmin
      .from("pedidos")
      .upsert(pendentes as any[]);

    if (updErr) {
      console.error("[reconciliar] upsert situações em lote falhou:", updErr.message);
      report.situacoes.erros.push(`erro ao atualizar situações em lote: ${updErr.message}`);
      report.situacoes.atualizados = 0;
    }
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
