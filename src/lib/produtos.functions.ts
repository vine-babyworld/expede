import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken, refreshConnectionById } from "@/lib/bling.functions";
import { getServerOrigin } from "@/lib/produtos.server";

const BLING_PRODUTOS_URL = "https://api.bling.com.br/Api/v3/produtos";
const PAGES_PER_RUN = 5;
const PAGE_LIMIT = 100;
const REQUEST_DELAY_MS = 350;
const DETAIL_BATCH_SIZE = 15; // produtos enriquecidos por execução (reduzido de 40 para caber no timeout de 30s do Worker)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compactText(value: string, maxLength = 180) {
  const clean = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function getJsonErrorMessage(payload: any) {
  return (
    payload?.error?.description ??
    payload?.error?.message ??
    payload?.error_description ??
    payload?.message ??
    payload?.error ??
    payload?.data?.error?.description ??
    payload?.data?.message
  );
}

async function formatBlingApiError(res: Response) {
  if (res.status === 403) {
    return "Bling recusou a sincronização de produtos (HTTP 403). Reautorize a conta Bling e confirme o escopo Produtos no app Bling.";
  }

  if (res.status === 429) {
    return "Bling limitou temporariamente as requisições (HTTP 429). A sincronização será retomada automaticamente.";
  }

  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }

  if (text) {
    try {
      const payload = JSON.parse(text);
      const apiMessage = getJsonErrorMessage(payload);
      if (apiMessage) return `Bling API HTTP ${res.status}: ${compactText(String(apiMessage))}`;
    } catch {
      // Non-JSON responses are handled below.
    }

    if (/<!doctype|<html|just a moment/i.test(text)) {
      return `Bling retornou uma resposta HTML inesperada (HTTP ${res.status}). Tente novamente e, se persistir, reautorize a conta Bling.`;
    }

    const clean = compactText(text);
    if (clean) return `Bling API HTTP ${res.status}: ${clean}`;
  }

  if (res.status >= 500) {
    return `Bling está temporariamente indisponível (HTTP ${res.status}). A sincronização será retomada automaticamente.`;
  }

  return `Bling API HTTP ${res.status}.`;
}

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas administradores podem executar esta ação.");
}

function classifyProduct(p: any): { tipo: "simples" | "pai" | "filho"; bipavel: boolean; parentId: number | null } {
  const variacoes = p?.variacoes;
  const hasVariacoes = Array.isArray(variacoes) && variacoes.length > 0;
  const parent = p?.produtoPai ?? p?.variacao?.produtoPai;
  const parentId = parent?.id ? Number(parent.id) : null;
  if (hasVariacoes) return { tipo: "pai", bipavel: false, parentId: null };
  if (parentId) return { tipo: "filho", bipavel: true, parentId };
  return { tipo: "simples", bipavel: true, parentId: null };
}

function mapProduct(p: any, connectionId: string, opts?: { detail?: boolean }) {
  const cls = classifyProduct(p);
  const dim = p?.dimensoes ?? {};
  const row: any = {
    bling_connection_id: connectionId,
    bling_product_id: Number(p.id),
    bling_parent_id: cls.parentId,
    sku: String(p.codigo ?? p.sku ?? ""),
    gtin: p.gtin ? String(p.gtin) : null,
    nome: String(p.nome ?? "(sem nome)"),
    tipo: cls.tipo,
    bipavel: cls.bipavel,
    ativo: p.situacao === "A" || p.situacao === "Ativo" || p.situacao === true || p.situacao === undefined ? true : false,
    peso_bruto: p.pesoBruto != null ? Number(p.pesoBruto) : null,
    peso_liquido: p.pesoLiquido != null ? Number(p.pesoLiquido) : null,
    altura: dim.altura != null ? Number(dim.altura) : null,
    largura: dim.largura != null ? Number(dim.largura) : null,
    profundidade: dim.profundidade != null ? Number(dim.profundidade) : null,
    estoque: p?.estoque?.saldoVirtualTotal != null
      ? Number(p.estoque.saldoVirtualTotal)
      : (p?.estoque?.saldoFisicoTotal != null ? Number(p.estoque.saldoFisicoTotal) : null),
    imagem_url: p?.imagemURL ?? p?.midia?.imagens?.externas?.[0]?.link ?? null,
    raw_data: p,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (opts?.detail) row.detail_synced_at = new Date().toISOString();
  return row;
}

async function fireAndForgetRun(jobId: string, origin: string) {
  fetch(`${origin}/api/public/hooks/bling-sync-products-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(() => { /* ignore */ });
}

async function createAndFireDetalhesJob(connectionId: string, origin: string, userId: string | null) {
  // Reusa job ativo de detalhes se existir
  const { data: existing } = await supabaseAdmin
    .from("sync_jobs")
    .select("id")
    .eq("bling_connection_id", connectionId)
    .eq("tipo", "produtos")
    .eq("fase", "detalhes")
    .in("status", ["pendente", "rodando", "pausado"])
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: job } = await supabaseAdmin
    .from("sync_jobs")
    .insert({
      bling_connection_id: connectionId,
      tipo: "produtos",
      fase: "detalhes",
      status: "pendente",
      iniciado_por: userId,
    })
    .select("id")
    .single();
  if (job) {
    fireAndForgetRun(job.id, origin).catch(() => {});
    return job.id;
  }
  return null;
}

export const syncProductsStart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { data: conn } = await supabaseAdmin
      .from("bling_connections")
      .select("id, status")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (!conn) throw new Error("Conexão Bling não encontrada");

    const { data: existing } = await supabaseAdmin
      .from("sync_jobs")
      .select("id, status, fase")
      .eq("bling_connection_id", data.connectionId)
      .eq("tipo", "produtos")
      .in("status", ["pendente", "rodando", "pausado"])
      .order("iniciado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { jobId: existing.id, status: existing.status, reused: true };

    const { data: job, error: insErr } = await supabaseAdmin
      .from("sync_jobs")
      .insert({
        bling_connection_id: data.connectionId,
        tipo: "produtos",
        fase: "listagem",
        status: "pendente",
        iniciado_por: userId,
      })
      .select("id, status")
      .single();
    if (insErr || !job) throw new Error(insErr?.message ?? "Falha ao criar job");

    try {
      const origin = await getServerOrigin();
      if (origin) await fireAndForgetRun(job.id, origin);
    } catch { /* ignore */ }

    return { jobId: job.id, status: job.status, reused: false };
  });

/** Workhorse: roteia entre listagem e detalhes. */
export async function runSyncJob(jobId: string): Promise<{ done: boolean; status: string }> {
  const { data: job, error: jobErr } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) throw new Error("Job não encontrado");
  if (job.status === "concluido" || job.status === "erro") {
    return { done: true, status: job.status };
  }

  await supabaseAdmin
    .from("sync_jobs")
    .update({ status: "rodando", ultima_execucao_em: new Date().toISOString() })
    .eq("id", jobId);

  const fase = (job as any).fase ?? "listagem";
  if (fase === "detalhes") return runDetalhesJob(job);
  return runListagemJob(job);
}

// ============================================================
// FASE 1: LISTAGEM
// ============================================================
async function runListagemJob(job: any): Promise<{ done: boolean; status: string }> {
  let token: string;
  try {
    token = await getDecryptedAccessToken(job.bling_connection_id);
  } catch (e: any) {
    await supabaseAdmin
      .from("sync_jobs")
      .update({ status: "erro", finalizado_em: new Date().toISOString(),
        erros: [...(job.erros as any[] ?? []), { mensagem: String(e?.message ?? e) }] })
      .eq("id", job.id);
    return { done: true, status: "erro" };
  }

  let pagina = job.pagina_atual ?? 0;
  let totalProcessados = job.total_processados ?? 0;
  let totalErros = job.total_erros ?? 0;
  const erros: any[] = Array.isArray(job.erros) ? [...(job.erros as any[])] : [];
  let finalizado = false;
  let totalPaginas: number | null = job.total_paginas ?? null;

  for (let i = 0; i < PAGES_PER_RUN; i++) {
    pagina += 1;
    const url = `${BLING_PRODUTOS_URL}?pagina=${pagina}&limite=${PAGE_LIMIT}&criterio=2`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (e: any) {
      erros.push({ pagina, mensagem: String(e?.message ?? e) });
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado", pagina_atual: pagina - 1, total_erros: totalErros + 1, erros,
        proxima_execucao_em: new Date(Date.now() + 30_000).toISOString(),
      }).eq("id", job.id);
      return { done: false, status: "pausado" };
    }

    if (res.status === 401) {
      const r = await refreshConnectionById(job.bling_connection_id);
      if (!r.ok) {
        await supabaseAdmin.from("sync_jobs").update({
          status: "erro", pagina_atual: pagina - 1, finalizado_em: new Date().toISOString(),
          erros: [...erros, { pagina, mensagem: "401 e refresh falhou: " + r.error }],
        }).eq("id", job.id);
        return { done: true, status: "erro" };
      }
      try { token = await getDecryptedAccessToken(job.bling_connection_id); }
      catch (e: any) {
        await supabaseAdmin.from("sync_jobs").update({
          status: "erro", pagina_atual: pagina - 1, finalizado_em: new Date().toISOString(),
          erros: [...erros, { pagina, mensagem: String(e?.message ?? e) }],
        }).eq("id", job.id);
        return { done: true, status: "erro" };
      }
      pagina -= 1;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (res.status === 429) {
      const mensagem = await formatBlingApiError(res);
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado", pagina_atual: pagina - 1,
        proxima_execucao_em: new Date(Date.now() + 60_000).toISOString(),
        erros: [...erros, { pagina, mensagem }],
      }).eq("id", job.id);
      return { done: false, status: "pausado" };
    }

    if (res.status >= 500) {
      erros.push({ pagina, mensagem: await formatBlingApiError(res) });
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado", pagina_atual: pagina - 1, total_erros: totalErros + 1, erros,
        proxima_execucao_em: new Date(Date.now() + 30_000).toISOString(),
      }).eq("id", job.id);
      return { done: false, status: "pausado" };
    }

    if (!res.ok) {
      const mensagem = await formatBlingApiError(res);
      await supabaseAdmin.from("sync_jobs").update({
        status: "erro", pagina_atual: pagina - 1, finalizado_em: new Date().toISOString(),
        erros: [...erros, { pagina, mensagem }],
      }).eq("id", job.id);
      return { done: true, status: "erro" };
    }

    const payload: any = await res.json().catch(() => ({}));
    const produtos: any[] = Array.isArray(payload?.data) ? payload.data : [];

    for (const p of produtos) {
      try {
        const row = mapProduct(p, job.bling_connection_id);
        const { error: upErr } = await supabaseAdmin
          .from("produtos")
          .upsert(row as any, { onConflict: "bling_connection_id,bling_product_id" });
        if (upErr) { totalErros += 1; erros.push({ pagina, produto_id: p.id, mensagem: upErr.message }); }
        else { totalProcessados += 1; }
      } catch (e: any) {
        totalErros += 1;
        erros.push({ pagina, produto_id: p?.id, mensagem: String(e?.message ?? e) });
      }
    }

    if (produtos.length < PAGE_LIMIT) {
      finalizado = true;
      totalPaginas = pagina;
      break;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (finalizado) {
    await supabaseAdmin.from("sync_jobs").update({
      status: "concluido", pagina_atual: pagina, total_paginas: totalPaginas,
      total_processados: totalProcessados, total_erros: totalErros,
      erros: erros.slice(-50),
      finalizado_em: new Date().toISOString(), proxima_execucao_em: null,
    }).eq("id", job.id);

    // Dispara fase de detalhes
    try {
      const origin = await getServerOrigin();
      if (origin) await createAndFireDetalhesJob(job.bling_connection_id, origin, job.iniciado_por ?? null);
    } catch { /* ignore */ }

    return { done: true, status: "concluido" };
  }

  await supabaseAdmin.from("sync_jobs").update({
    status: "pausado", pagina_atual: pagina, total_paginas: totalPaginas,
    total_processados: totalProcessados, total_erros: totalErros,
    erros: erros.slice(-50),
    proxima_execucao_em: new Date(Date.now() + 3_000).toISOString(),
  }).eq("id", job.id);
  return { done: false, status: "pausado" };
}

// ============================================================
// FASE 2: DETALHES (enriquecimento)
// ============================================================
async function runDetalhesJob(job: any): Promise<{ done: boolean; status: string }> {
  let token: string;
  try {
    token = await getDecryptedAccessToken(job.bling_connection_id);
  } catch (e: any) {
    await supabaseAdmin.from("sync_jobs").update({
      status: "erro", finalizado_em: new Date().toISOString(),
      erros: [...(job.erros as any[] ?? []), { mensagem: String(e?.message ?? e) }],
    }).eq("id", job.id);
    return { done: true, status: "erro" };
  }

  let totalProcessados = job.total_processados ?? 0;
  let totalErros = job.total_erros ?? 0;
  const erros: any[] = Array.isArray(job.erros) ? [...(job.erros as any[])] : [];

  // Seleciona próximo lote de produtos sem detail_synced_at (ou desatualizados)
  const { data: pendentes, error: selErr } = await supabaseAdmin
    .from("produtos")
    .select("id, bling_product_id, tipo")
    .eq("bling_connection_id", job.bling_connection_id)
    .is("detail_synced_at", null)
    .limit(DETAIL_BATCH_SIZE);
  if (selErr) {
    await supabaseAdmin.from("sync_jobs").update({
      status: "pausado", erros: [...erros, { mensagem: selErr.message }],
      proxima_execucao_em: new Date(Date.now() + 30_000).toISOString(),
    }).eq("id", job.id);
    return { done: false, status: "pausado" };
  }

  // Total restante (pra barra de progresso)
  const { count: pendingCount } = await supabaseAdmin
    .from("produtos")
    .select("id", { count: "exact", head: true })
    .eq("bling_connection_id", job.bling_connection_id)
    .is("detail_synced_at", null);

  if (!pendentes || pendentes.length === 0) {
    await supabaseAdmin.from("sync_jobs").update({
      status: "concluido", total_processados: totalProcessados, total_erros: totalErros,
      erros: erros.slice(-50),
      finalizado_em: new Date().toISOString(), proxima_execucao_em: null,
    }).eq("id", job.id);
    return { done: true, status: "concluido" };
  }

  for (const pend of pendentes) {
    const url = `${BLING_PRODUTOS_URL}/${pend.bling_product_id}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (e: any) {
      totalErros += 1;
      erros.push({ produto_id: pend.bling_product_id, mensagem: String(e?.message ?? e) });
      continue;
    }

    if (res.status === 401) {
      const r = await refreshConnectionById(job.bling_connection_id);
      if (!r.ok) {
        await supabaseAdmin.from("sync_jobs").update({
          status: "erro", finalizado_em: new Date().toISOString(),
          erros: [...erros, { mensagem: "401 e refresh falhou: " + r.error }],
        }).eq("id", job.id);
        return { done: true, status: "erro" };
      }
      try { token = await getDecryptedAccessToken(job.bling_connection_id); }
      catch (e: any) {
        await supabaseAdmin.from("sync_jobs").update({
          status: "erro", finalizado_em: new Date().toISOString(),
          erros: [...erros, { mensagem: String(e?.message ?? e) }],
        }).eq("id", job.id);
        return { done: true, status: "erro" };
      }
      // pula este e segue (será reprocessado na próxima run)
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (res.status === 429) {
      const mensagem = await formatBlingApiError(res);
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado",
        total_processados: totalProcessados, total_erros: totalErros,
        erros: [...erros, { mensagem }].slice(-50),
        total_paginas: pendingCount ?? null,
        pagina_atual: totalProcessados,
        proxima_execucao_em: new Date(Date.now() + 60_000).toISOString(),
      }).eq("id", job.id);
      return { done: false, status: "pausado" };
    }

    if (!res.ok) {
      totalErros += 1;
      const mensagem = await formatBlingApiError(res);
      erros.push({ produto_id: pend.bling_product_id, mensagem });
      // marca como sincronizado mesmo assim pra não travar (raw_data preservado)
      await supabaseAdmin.from("produtos")
        .update({ detail_synced_at: new Date().toISOString() })
        .eq("id", pend.id);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const payload: any = await res.json().catch(() => ({}));
    const produto: any = payload?.data ?? payload;

    try {
      const row = mapProduct(produto, job.bling_connection_id, { detail: true });
      const { error: upErr } = await supabaseAdmin
        .from("produtos")
        .upsert(row as any, { onConflict: "bling_connection_id,bling_product_id" });
      if (upErr) {
        totalErros += 1;
        erros.push({ produto_id: pend.bling_product_id, mensagem: upErr.message });
      } else {
        totalProcessados += 1;
      }

      // Trata variações: se produto-pai tem array `variacoes`, insere filhos
      const variacoes: any[] = Array.isArray(produto?.variacoes) ? produto.variacoes : [];
      for (const v of variacoes) {
        try {
          const variacaoCompleta = { ...v, produtoPai: { id: produto.id } };
          const childRow = mapProduct(variacaoCompleta, job.bling_connection_id, { detail: true });
          await supabaseAdmin
            .from("produtos")
            .upsert(childRow as any, { onConflict: "bling_connection_id,bling_product_id" });
        } catch (e: any) {
          erros.push({ produto_id: v?.id, mensagem: "variação: " + String(e?.message ?? e) });
        }
      }
    } catch (e: any) {
      totalErros += 1;
      erros.push({ produto_id: pend.bling_product_id, mensagem: String(e?.message ?? e) });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Continua se ainda há pendentes
  const restantes = (pendingCount ?? 0) - pendentes.length;
  if (restantes > 0) {
    await supabaseAdmin.from("sync_jobs").update({
      status: "pausado",
      total_processados: totalProcessados, total_erros: totalErros,
      erros: erros.slice(-50),
      total_paginas: pendingCount ?? null,
      pagina_atual: totalProcessados,
      proxima_execucao_em: new Date(Date.now() + 3_000).toISOString(),
    }).eq("id", job.id);
    return { done: false, status: "pausado" };
  }

  await supabaseAdmin.from("sync_jobs").update({
    status: "concluido",
    total_processados: totalProcessados, total_erros: totalErros,
    erros: erros.slice(-50),
    total_paginas: pendingCount ?? null,
    pagina_atual: totalProcessados,
    finalizado_em: new Date().toISOString(), proxima_execucao_em: null,
  }).eq("id", job.id);
  return { done: true, status: "concluido" };
}

// =====================================================
// Leitura para a UI
// =====================================================

const listSchema = z.object({
  search: z.string().trim().max(200).optional().default(""),
  connectionId: z.string().uuid().optional(),
  status: z.enum(["ativos", "inativos", "todos"]).optional().default("ativos"),
  tipo: z.enum(["simples", "pai", "filho", "todos"]).optional().default("todos"),
  page: z.number().int().min(1).max(10000).optional().default(1),
});

export const listProdutos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listSchema.parse(d))
  .handler(async ({ data }) => {
    const PAGE_SIZE = 50;
    let q = supabaseAdmin
      .from("produtos")
      .select("id, bling_connection_id, sku, gtin, nome, tipo, bipavel, ativo, estoque, imagem_url, synced_at, bling_product_id", { count: "exact" })
      .order("nome", { ascending: true });

    if (data.connectionId) q = q.eq("bling_connection_id", data.connectionId);
    if (data.status === "ativos") q = q.eq("ativo", true);
    else if (data.status === "inativos") q = q.eq("ativo", false);
    if (data.tipo !== "todos") q = q.eq("tipo", data.tipo);
    if (data.search) {
      const s = data.search.replace(/,/g, " ");
      q = q.or(`nome.ilike.%${s}%,sku.ilike.%${s}%,gtin.ilike.%${s}%`);
    }
    const from = (data.page - 1) * PAGE_SIZE;
    q = q.range(from, from + PAGE_SIZE - 1);
    const { data: rows, count, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [], total: count ?? 0, page: data.page, pageSize: PAGE_SIZE };
  });

export const listBlingConnectionsForFilter = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("bling_connections")
      .select("id, bling_account_name, status, user_id")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getActiveSyncJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId?: string }) => d)
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("sync_jobs")
      .select("id, bling_connection_id, status, fase, pagina_atual, total_paginas, total_processados, total_erros, erros, iniciado_em, finalizado_em")
      .order("iniciado_em", { ascending: false })
      .limit(10);
    if (data?.connectionId) q = q.eq("bling_connection_id", data.connectionId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getProdutosOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data: lastSync } = await supabaseAdmin
      .from("produtos")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { count } = await supabaseAdmin
      .from("produtos")
      .select("id", { count: "exact", head: true });
    return {
      lastSyncedAt: lastSync?.synced_at ?? null,
      totalProdutos: count ?? 0,
    };
  });

const atualizarProdutoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string().trim().min(1).max(500).optional(),
  gtin: z.string().regex(/^\d{8,14}$/).nullable().optional(),
  imagem_url: z.string().max(2000).nullable().optional(),
});

export const atualizarProduto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => atualizarProdutoSchema.parse(d))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("produtos")
      .update({
        ...(data.nome !== undefined ? { nome: data.nome } : {}),
        ...("gtin" in data ? { gtin: data.gtin ?? null } : {}),
        ...("imagem_url" in data ? { imagem_url: data.imagem_url ?? null } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const sincronizarProdutoSchema = z.object({
  blingProductId: z.number().int().positive(),
  blingConnectionId: z.string().uuid(),
});

export const sincronizarProduto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => sincronizarProdutoSchema.parse(d))
  .handler(async ({ data }) => {
    let token: string;
    try {
      token = await getDecryptedAccessToken(data.blingConnectionId);
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message ?? e) };
    }

    const res = await fetch(`${BLING_PRODUTOS_URL}/${data.blingProductId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false as const, error: await formatBlingApiError(res) };
    }

    const payload: any = await res.json().catch(() => ({}));
    const p = payload?.data ?? payload;
    const now = new Date().toISOString();

    const { error: upErr } = await supabaseAdmin
      .from("produtos")
      .update({
        nome: String(p.nome ?? "(sem nome)"),
        gtin: p.gtin ? String(p.gtin) : null,
        imagem_url: p?.imagemURL ?? p?.midia?.imagens?.externas?.[0]?.link ?? null,
        raw_data: p,
        synced_at: now,
        detail_synced_at: now,
        updated_at: now,
      })
      .eq("bling_product_id", data.blingProductId)
      .eq("bling_connection_id", data.blingConnectionId);

    if (upErr) return { ok: false as const, error: upErr.message };
    return { ok: true as const };
  });
