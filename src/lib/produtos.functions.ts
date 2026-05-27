import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken, refreshConnectionById } from "@/lib/bling.functions";

const BLING_PRODUTOS_URL = "https://www.bling.com.br/Api/v3/produtos";
const PAGES_PER_RUN = 5;
const PAGE_LIMIT = 100;
const REQUEST_DELAY_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Determina tipo e bipavel a partir do payload do Bling. */
function classifyProduct(p: any): { tipo: "simples" | "pai" | "filho"; bipavel: boolean; parentId: number | null } {
  const variacoes = p?.variacoes;
  const hasVariacoes = Array.isArray(variacoes) && variacoes.length > 0;
  const parent = p?.produtoPai ?? p?.variacao?.produtoPai;
  const parentId = parent?.id ? Number(parent.id) : null;
  if (hasVariacoes) return { tipo: "pai", bipavel: false, parentId: null };
  if (parentId) return { tipo: "filho", bipavel: true, parentId };
  return { tipo: "simples", bipavel: true, parentId: null };
}

function mapProduct(p: any, connectionId: string) {
  const cls = classifyProduct(p);
  const dim = p?.dimensoes ?? {};
  return {
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
}

/** Dispara `syncProductsRun` em background (fire-and-forget) via fetch interno. */
async function fireAndForgetRun(jobId: string, origin: string) {
  // Importante: usar URL absoluta pra Cloudflare Workers fetch interno
  fetch(`${origin}/api/public/hooks/bling-sync-products-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
    },
    body: JSON.stringify({ jobId }),
  }).catch(() => { /* ignore */ });
}

/** Cria (ou retorna existente) job de sync para uma conexão. Admin only. */
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

    // Job ativo já existente?
    const { data: existing } = await supabaseAdmin
      .from("sync_jobs")
      .select("id, status")
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
        status: "pendente",
        iniciado_por: userId,
      })
      .select("id, status")
      .single();
    if (insErr || !job) throw new Error(insErr?.message ?? "Falha ao criar job");

    // Disparar run (fire-and-forget)
    try {
      const origin = process.env.PUBLIC_APP_URL
        ?? `https://project--${process.env.VITE_SUPABASE_PROJECT_ID ?? ""}.lovable.app`;
      await fireAndForgetRun(job.id, origin);
    } catch { /* ignore */ }

    return { jobId: job.id, status: job.status, reused: false };
  });

/**
 * Workhorse de importação. Roda até 5 páginas e, se houver mais, agenda continuação.
 * Não exige auth (usado pelo cron e pelo fire-and-forget); seguro por idempotência.
 */
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

  let token: string;
  try {
    token = await getDecryptedAccessToken(job.bling_connection_id);
  } catch (e: any) {
    await supabaseAdmin
      .from("sync_jobs")
      .update({ status: "erro", finalizado_em: new Date().toISOString(),
        erros: [...(job.erros as any[] ?? []), { mensagem: String(e?.message ?? e) }] })
      .eq("id", jobId);
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
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (e: any) {
      erros.push({ pagina, mensagem: String(e?.message ?? e) });
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado",
        pagina_atual: pagina - 1,
        total_erros: totalErros + 1,
        erros,
        proxima_execucao_em: new Date(Date.now() + 30_000).toISOString(),
      }).eq("id", jobId);
      return { done: false, status: "pausado" };
    }

    if (res.status === 401) {
      const r = await refreshConnectionById(job.bling_connection_id);
      if (!r.ok) {
        await supabaseAdmin.from("sync_jobs").update({
          status: "erro",
          pagina_atual: pagina - 1,
          finalizado_em: new Date().toISOString(),
          erros: [...erros, { pagina, mensagem: "401 e refresh falhou: " + r.error }],
        }).eq("id", jobId);
        return { done: true, status: "erro" };
      }
      try { token = await getDecryptedAccessToken(job.bling_connection_id); }
      catch (e: any) {
        await supabaseAdmin.from("sync_jobs").update({
          status: "erro", pagina_atual: pagina - 1,
          finalizado_em: new Date().toISOString(),
          erros: [...erros, { pagina, mensagem: String(e?.message ?? e) }],
        }).eq("id", jobId);
        return { done: true, status: "erro" };
      }
      pagina -= 1; // retry mesma página
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (res.status === 429) {
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado",
        pagina_atual: pagina - 1,
        proxima_execucao_em: new Date(Date.now() + 60_000).toISOString(),
        erros: [...erros, { pagina, mensagem: "429 rate limit" }],
      }).eq("id", jobId);
      return { done: false, status: "pausado" };
    }

    if (res.status >= 500) {
      erros.push({ pagina, mensagem: `HTTP ${res.status}` });
      await supabaseAdmin.from("sync_jobs").update({
        status: "pausado",
        pagina_atual: pagina - 1,
        total_erros: totalErros + 1,
        erros,
        proxima_execucao_em: new Date(Date.now() + 30_000).toISOString(),
      }).eq("id", jobId);
      return { done: false, status: "pausado" };
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      await supabaseAdmin.from("sync_jobs").update({
        status: "erro",
        pagina_atual: pagina - 1,
        finalizado_em: new Date().toISOString(),
        erros: [...erros, { pagina, mensagem: `HTTP ${res.status}: ${txt.slice(0, 200)}` }],
      }).eq("id", jobId);
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
        if (upErr) {
          totalErros += 1;
          erros.push({ pagina, produto_id: p.id, mensagem: upErr.message });
        } else {
          totalProcessados += 1;
        }
      } catch (e: any) {
        totalErros += 1;
        erros.push({ pagina, produto_id: p?.id, mensagem: String(e?.message ?? e) });
      }
    }

    // Fim quando página vem vazia ou parcial
    if (produtos.length < PAGE_LIMIT) {
      finalizado = true;
      totalPaginas = pagina;
      break;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  if (finalizado) {
    await supabaseAdmin.from("sync_jobs").update({
      status: "concluido",
      pagina_atual: pagina,
      total_paginas: totalPaginas,
      total_processados: totalProcessados,
      total_erros: totalErros,
      erros: erros.slice(-50),
      finalizado_em: new Date().toISOString(),
      proxima_execucao_em: null,
    }).eq("id", jobId);
    return { done: true, status: "concluido" };
  }

  await supabaseAdmin.from("sync_jobs").update({
    status: "pausado",
    pagina_atual: pagina,
    total_paginas: totalPaginas,
    total_processados: totalProcessados,
    total_erros: totalErros,
    erros: erros.slice(-50),
    proxima_execucao_em: new Date(Date.now() + 3_000).toISOString(),
  }).eq("id", jobId);
  return { done: false, status: "pausado" };
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
      .select("id, bling_connection_id, status, pagina_atual, total_paginas, total_processados, total_erros, iniciado_em, finalizado_em")
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
