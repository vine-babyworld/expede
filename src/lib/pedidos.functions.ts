import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
const DEPOSITO_ALVO = "Geral";
const ML_LOJA_ID = "203482894";
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
        "id, bling_pedido_id, numero, numero_loja, situacao_id, situacao_valor, data_pedido, total, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, etiqueta_zpl, created_at, updated_at, pedido_itens(count)",
        { count: "exact" },
      );

    if (search.trim()) {
      query = query.ilike("numero", `%${search.trim()}%`);
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

async function buscarProdutoPorSku(
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
  opts: { permitirSemNf?: boolean } = {},
): Promise<{ ok: boolean; skipped?: string; error?: string; detalhe: string }> {
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
    if (!servico.toLowerCase().includes("flex")) {
      return { ok: true, skipped: "no_invoice_not_flex", detalhe: `não é FLEX (servico: ${servico || "—"})` };
    }
    console.log(`[processarPedido] FLEX sem NF: pedido ${blingPedidoId} servico="${servico}"`);
  }

  const itens: any[] = d.itens ?? [];
  const itemForaDoDeposito = itens.find(
    (it: any) => it.deposito?.descricao !== undefined && it.deposito?.descricao !== DEPOSITO_ALVO,
  );
  if (itemForaDoDeposito) return { ok: true, skipped: "wrong_warehouse", detalhe: "depósito incorreto" };

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
    console.error("[processarPedido] upsert falhou:", upsertErr?.message);
    return { ok: false, error: "upsert_error: " + upsertErr?.message, detalhe: "falha ao salvar pedido no banco" };
  }

  const pedidoDbId: string = upserted.id;

  // Identifica SKUs de componentes de kits neste pedido (antes do delete)
  const componentSkusFromKits = new Set<string>();
  for (const it of itens) {
    const componentes = parseComponentesKit(it.codigo ?? "");
    if (componentes.length >= 2) componentes.forEach((s) => componentSkusFromKits.add(s));
  }

  // Verifica quais componentes já existem no DB (para preservar quantidade_bipada)
  let jaExplodidosSkus = new Set<string>();
  if (componentSkusFromKits.size > 0) {
    const { data: existentes } = await supabaseAdmin
      .from("pedido_itens")
      .select("sku")
      .eq("pedido_id", pedidoDbId)
      .in("sku", [...componentSkusFromKits]);
    jaExplodidosSkus = new Set((existentes ?? []).map((r: any) => r.sku as string).filter(Boolean));
  }

  // Delete: preserva rows de componentes já explodidos (carregam progresso de bipagem)
  if (jaExplodidosSkus.size > 0) {
    const { data: toDelete } = await supabaseAdmin
      .from("pedido_itens")
      .select("id, sku")
      .eq("pedido_id", pedidoDbId);
    const idsToDelete = (toDelete ?? [])
      .filter((r: any) => !jaExplodidosSkus.has(r.sku))
      .map((r: any) => r.id as string);
    if (idsToDelete.length > 0) {
      await supabaseAdmin.from("pedido_itens").delete().in("id", idsToDelete);
    }
  } else {
    await supabaseAdmin.from("pedido_itens").delete().eq("pedido_id", pedidoDbId);
  }

  // Monta rows de itens — kits são explodidos em componentes individuais
  const itensPrepared: any[] = [];

  for (const it of itens) {
    const sku = it.codigo ?? null;
    const componentes = parseComponentesKit(sku ?? "");

    if (componentes.length < 2) {
      // Item simples — comportamento existente
      let produtoId: string | null = null;
      const gtin = it.gtin ?? null;

      if (gtin) {
        const { data: p } = await supabaseAdmin
          .from("produtos").select("id")
          .eq("gtin", gtin).eq("bling_connection_id", connId).maybeSingle();
        produtoId = p?.id ?? null;
      }
      if (!produtoId && sku) {
        const { data: p } = await supabaseAdmin
          .from("produtos").select("id")
          .eq("sku", sku).eq("bling_connection_id", connId).maybeSingle();
        produtoId = p?.id ?? null;
      }

      itensPrepared.push({
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
    const { error: itemsErr } = await supabaseAdmin.from("pedido_itens").insert(itensPrepared);
    if (itemsErr) console.error("[processarPedido] insert itens falhou:", itemsErr.message);
  }

  console.log(
    `[processarPedido] OK pedido=${blingPedidoId} db_id=${pedidoDbId}` +
    ` inseridos=${itensPrepared.length} preservados=${jaExplodidosSkus.size}`,
  );
  const nfDetalhe = pedidoPayload.bling_nota_fiscal_numero
    ? `NF ${pedidoPayload.bling_nota_fiscal_numero}`
    : "FLEX sem NF";
  return { ok: true, detalhe: nfDetalhe };
}

export type ReconciliarQueryReport = {
  encontrados: number;
  importados: number;
  pulados: number;
  erros: string[];
};

export type ReconciliarReport = {
  query1: ReconciliarQueryReport;
  query2: ReconciliarQueryReport;
  query3: ReconciliarQueryReport;
  query4: ReconciliarQueryReport;
  detalhes: string[];
};

function novoQueryReport(): ReconciliarQueryReport {
  return { encontrados: 0, importados: 0, pulados: 0, erros: [] };
}

export async function reconciliarPedidos(): Promise<ReconciliarReport> {
  const report: ReconciliarReport = {
    query1: novoQueryReport(),
    query2: novoQueryReport(),
    query3: novoQueryReport(),
    query4: novoQueryReport(),
    detalhes: [],
  };

  const { data: conn } = await supabaseAdmin
    .from("bling_connections")
    .select("id")
    .eq("status", "connected")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!conn) {
    console.log("[reconciliar] nenhuma conexão ativa");
    report.detalhes.push("nenhuma conexão Bling ativa");
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

  // Janela de 10 dias — traz os pedidos mais recentes primeiro, evita reprocessar antigos
  const dataInicio = new Date(Date.now() - 10 * 86_400_000).toISOString().substring(0, 10);

  // Query 1: faturados (idSituacao=9) — últimos 10 dias, loja ML FLEX
  // Query 2: loja ML FLEX (idLoja=203482894) — últimos 10 dias, inclui pedidos sem NF
  // Query 3: atendidos (idSituacao=15) — últimos 10 dias, qualquer marketplace
  const [resFaturados, resLoja] = await Promise.allSettled([
    fetch(`${BLING_PEDIDOS_URL}?idSituacao=9&idLoja=${ML_LOJA_ID}&limite=50&pagina=1&dataInicio=${dataInicio}`, { headers }),
    fetch(`${BLING_PEDIDOS_URL}?idLoja=${ML_LOJA_ID}&limite=50&pagina=1&dataInicio=${dataInicio}`, { headers }),
  ]);
  const resAtendidos: PromiseSettledResult<Response> = { status: "rejected", reason: "desativado" } as PromiseSettledResult<Response>;
  const resAtendidosML: PromiseSettledResult<Response> = { status: "rejected", reason: "desativado" } as PromiseSettledResult<Response>;

  // Agrega candidatos das quatro listas; loja (Q2) sempre promove para permitirSemNf=true
  const candidatos = new Map<number, { id: number; permitirSemNf: boolean; origem: "q1" | "q2" | "q3" | "q4" }>();

  if (resFaturados.status === "fulfilled" && resFaturados.value.ok) {
    const json: any = await resFaturados.value.json().catch(() => null);
    const lista = json?.data ?? [];
    report.query1.encontrados = lista.length;
    for (const p of lista) {
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q1" });
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
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q3" });
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
      if (!candidatos.has(p.id)) candidatos.set(p.id, { id: p.id, permitirSemNf: false, origem: "q4" });
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
      candidatos.set(p.id, { id: p.id, permitirSemNf: true, origem: "q2" });
    }
  } else {
    const motivo = resLoja.status === "rejected" ? resLoja.reason : (resLoja.value as any)?.status;
    console.error("[reconciliar] GET loja ML falhou:", motivo);
    report.detalhes.push(`Q2 erro ao buscar lista: ${String(motivo)}`);
  }

  if (candidatos.size === 0) {
    console.log("[reconciliar] nenhum candidato");
    report.detalhes.push("nenhum candidato encontrado");
    return report;
  }

  const allIds = [...candidatos.keys()];
  const { data: existentes } = await supabaseAdmin
    .from("pedidos")
    .select("bling_pedido_id, bling_nota_fiscal_id")
    .in("bling_pedido_id", allIds);

  // Pedidos que já existem E já têm NF não precisam ser reprocessados
  const existentesComNfSet = new Set(
    (existentes ?? [])
      .filter((e: any) => e.bling_nota_fiscal_id != null)
      .map((e: any) => e.bling_pedido_id)
  );

  console.log(`[reconciliar] ${candidatos.size} candidato(s), ${existentesComNfSet.size} já existem com NF no banco`);

  for (const cand of candidatos.values()) {
    const label = cand.origem === "q1" ? "Q1" : cand.origem === "q3" ? "Q3" : cand.origem === "q4" ? "Q4" : "Q2";
    const bucket = cand.origem === "q1" ? report.query1 : cand.origem === "q3" ? report.query3 : cand.origem === "q4" ? report.query4 : report.query2;

    if (existentesComNfSet.has(cand.id)) {
      bucket.pulados++;
      report.detalhes.push(`${label} skip: ${cand.id} — já existe com NF`);
      continue;
    }

    const result = await processarPedidoBling(cand.id, conn.id, token, { permitirSemNf: cand.permitirSemNf });
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
    }

    // Respeita rate limit da API Bling (3 req/seg)
    await new Promise((r) => setTimeout(r, 350));
  }

  return report;
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

    const res = await fetch(BLING_NFE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return { numero: null };

    const json: any = await res.json().catch(() => null);
    const nf = (json?.data ?? []).find((n: any) => n.id === data.notaFiscalId);
    const numero = nf?.numero != null ? String(nf.numero) : null;

    if (numero) {
      await supabaseAdmin
        .from("pedidos")
        .update({ bling_nota_fiscal_numero: numero })
        .eq("id", data.pedidoId);
    }

    return { numero };
  });
