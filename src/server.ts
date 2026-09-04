import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { runSyncJob } from "./lib/produtos.functions";
import { reconciliarPedidos, fetchNfSituacaoBling, NF_SITUACOES_AUTORIZADAS } from "./lib/pedidos.functions";
import { checarStatusEnvioML } from "./lib/ml.functions";
import { getDecryptedAccessToken } from "./lib/bling.functions";
import { processarFilaEmissaoNfML } from "./lib/nf-emissao.functions";
import { supabaseAdmin } from "./integrations/supabase/client.server";
import {
  atualizarRepassePedido,
  selecionarCandidatosRepasse,
} from "./lib/repasse.functions";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

let lastReconciliationAt = 0;
const RECONCILIATION_INTERVAL_MS = 60 * 1000;

let lastMLStatusAt = 0;
const ML_STATUS_INTERVAL_MS = 5 * 60 * 1000; // 5 min — independente do reconciliador
const MAX_CANDIDATOS_ML_STATUS = 4;

let lastNfStatusAt = 0;
const NF_STATUS_INTERVAL_MS = 2 * 60 * 1000; // 2 min — mais curto que o ML (bloqueia bipagem)
const MAX_CANDIDATOS_NF_STATUS = 4;

let lastNfEmissaoAt = 0;
const NF_EMISSAO_INTERVAL_MS = 60 * 1000;

let lastRepasseAt = 0;
const REPASSE_INTERVAL_MS = 5 * 60 * 1000; // 5 min — mesmo ritmo do cron de status ML
let lastRepasseShopeeAt = 0;

// Situacao_ids Bling que indicam pedido já baixado/faturado pelo Bling
const BLING_SITUACAO_FINALIZADA = new Set([9, 15]); // 9=Atendido, 15=Faturado

export async function cronMLStatus() {
  const now = Date.now();
  console.log("[cron-ml-status] iniciando verificação de gate", { now: new Date(now).toISOString() });

  try {
    const diffMemMs = now - lastMLStatusAt;
    if (diffMemMs < ML_STATUS_INTERVAL_MS) {
      console.log("[cron-ml-status] bloqueado pelo gate em memória", {
        lastMLStatusAt: new Date(lastMLStatusAt).toISOString(),
        diffMemMs,
      });
      return;
    }

    const db = supabaseAdmin as any;
    const { data: state, error: stateError } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "ml_status")
      .maybeSingle();

    console.log("[cron-ml-status] select cron_state", { data: state, error: stateError });

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    const diffMs = now - lastRun;
    const willRun = diffMs >= ML_STATUS_INTERVAL_MS;
    console.log("[cron-ml-status] gate check", { lastRunAt: state?.last_run_at ?? null, diffMs, willRun });

    if (!willRun) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert({ job_name: "ml_status", last_run_at: new Date(now).toISOString() }, { onConflict: "job_name" });

    if (upsertError) {
      console.error("[cron-ml-status] upsert cron_state falhou", { message: upsertError.message });
      return;
    }

    lastMLStatusAt = now;

    // Candidatos: faturados (NF emitida) mas ainda não impressos no EXPEDE.
    // Mesmo padrão de priorização já usado no reconciliador (commit 68b03f5):
    // separa "nunca verificados" (prioridade, mais antigos primeiro) de "já
    // verificados, ainda não delivered" (retry, só usa slots que sobrarem) —
    // evita que pedidos presos em "shipped" monopolizem os slots e impeçam
    // pedidos novos de serem verificados pela primeira vez.
    // Constante própria (não compartilha MAX_CANDIDATOS_POR_EXECUCAO do
    // reconciliador): são crons independentes, e este faz só 1 chamada de API
    // + 1 update por candidato — orçamento de subrequests bem mais leve.
    const baseQuery = () =>
      supabaseAdmin
        .from("pedidos")
        .select("id, numero_loja, situacao_id, bling_pedido_id")
        .is("printed_at", null)
        .not("bling_nota_fiscal_id", "is", null)
        .eq("marketplace", "mercadolivre")
        .neq("situacao_id", 12)
        .eq("arquivado", false);

    const { data: nuncaVerificados, error: selectError1 } = await baseQuery()
      .is("ml_shipment_status", null)
      .order("data_pedido", { ascending: true })
      .limit(MAX_CANDIDATOS_ML_STATUS) as any;

    if (selectError1) {
      console.error("[cron-ml-status] select nunca-verificados falhou:", selectError1.message);
      return;
    }

    const slotsRestantes = MAX_CANDIDATOS_ML_STATUS - (nuncaVerificados?.length ?? 0);
    let retry: any[] = [];

    if (slotsRestantes > 0) {
      // Rotação por ml_status_checked_at (não data_pedido): quem está há mais
      // tempo sem rechecagem vai primeiro. Evita que os mesmos pedidos (presos
      // em empate de data_pedido) monopolizem os slots pra sempre — starvation
      // intra-retry descoberta em 02/07/2026 (ver Lição no Obsidian).
      const { data: retryData, error: selectError2 } = await baseQuery()
        .not("ml_shipment_status", "is", null)
        .neq("ml_shipment_status", "delivered")
        .order("ml_status_checked_at", { ascending: true, nullsFirst: true })
        .limit(slotsRestantes) as any;

      if (selectError2) {
        console.error("[cron-ml-status] select retry falhou:", selectError2.message);
      } else {
        retry = retryData ?? [];
      }
    }

    const candidatos = [...(nuncaVerificados ?? []), ...retry];

    console.log(
      `[cron-ml-status] ${candidatos.length} candidato(s) encontrado(s)`,
      `(${nuncaVerificados?.length ?? 0} nunca verificado(s), ${retry.length} retry)`,
    );

    for (const pedido of candidatos) {
      const mlOrderId: string | null = pedido.numero_loja;
      if (!mlOrderId) {
        console.log(`[cron-ml-status] pedido ${pedido.bling_pedido_id} sem numero_loja, pulando`);
        continue;
      }

      const result = await checarStatusEnvioML(mlOrderId);

      if (!result.ok) {
        console.warn(`[cron-ml-status] pedido ${pedido.bling_pedido_id} ml_order=${mlOrderId} erro:`, result.error);
        continue;
      }

      const divergente =
        result.despachado && !BLING_SITUACAO_FINALIZADA.has(pedido.situacao_id ?? -1);

      console.log(
        `[cron-ml-status] pedido ${pedido.bling_pedido_id} ml_order=${mlOrderId}`,
        `status=${result.status} substatus=${result.substatus ?? "null"}`,
        `situacao_id=${pedido.situacao_id} despachado=${result.despachado} divergente=${divergente}`,
      );

      await supabaseAdmin
        .from("pedidos")
        .update({
          ml_shipment_status: result.status,
          ml_shipment_substatus: result.substatus ?? null,
          ml_status_checked_at: new Date(now).toISOString(),
          bling_divergente: divergente,
        } as any)
        .eq("id", pedido.id);
    }

    console.log("[cron-ml-status] ciclo concluído");
  } catch (e) {
    console.error("[cron-ml-status] exceção não tratada", {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
  }
}

// Busca o repasse financeiro (tarifa de venda, custo de envio) na API do ML.
// O Bling não fornece esses valores — seu campo `taxas` chega zerado.
// Gate de 5 min + orçamento de 4 pedidos por execução: com ~15 pedidos/dia isso
// é folgado, e pedidos entregues saem da rotação (repasse_final), então o custo
// não cresce com o histórico.
export async function cronRepasseMl() {
  const now = Date.now();

  try {
    if (now - lastRepasseAt < REPASSE_INTERVAL_MS) return;

    const db = supabaseAdmin as any;
    const { data: state } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "repasse_ml")
      .maybeSingle();

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    if (now - lastRun < REPASSE_INTERVAL_MS) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert(
        { job_name: "repasse_ml", last_run_at: new Date(now).toISOString() },
        { onConflict: "job_name" },
      );

    if (upsertError) {
      console.error("[cron-repasse] upsert cron_state falhou", { message: upsertError.message });
      return;
    }

    lastRepasseAt = now;

    const candidatos = await selecionarCandidatosRepasse("mercadolivre");
    console.log(`[cron-repasse] ${candidatos.length} candidato(s)`);

    for (const pedido of candidatos) {
      const res = await atualizarRepassePedido(pedido);
      if (res.ok) {
        console.log(
          `[cron-repasse] pedido ${pedido.bling_pedido_id} liquido=${res.liquido} final=${res.final}`,
        );
      } else {
        console.warn(`[cron-repasse] pedido ${pedido.bling_pedido_id} erro: ${res.error}`);
      }
    }

    console.log("[cron-repasse] ciclo concluído");
  } catch (e) {
    console.error("[cron-repasse] exceção não tratada", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
// Irmão de cronRepasseMl com gate e orçamento próprios: uma indisponibilidade
// da Shopee não pode consumir os slots do ML, nem o contrário.
export async function cronRepasseShopee() {
  const now = Date.now();

  try {
    if (now - lastRepasseShopeeAt < REPASSE_INTERVAL_MS) return;

    const db = supabaseAdmin as any;
    const { data: state } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "repasse_shopee")
      .maybeSingle();

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    if (now - lastRun < REPASSE_INTERVAL_MS) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert(
        { job_name: "repasse_shopee", last_run_at: new Date(now).toISOString() },
        { onConflict: "job_name" },
      );

    if (upsertError) {
      console.error("[cron-repasse-shopee] upsert cron_state falhou", { message: upsertError.message });
      return;
    }

    lastRepasseShopeeAt = now;

    const candidatos = await selecionarCandidatosRepasse("shopee");
    console.log(`[cron-repasse-shopee] ${candidatos.length} candidato(s)`);

    for (const pedido of candidatos) {
      const res = await atualizarRepassePedido(pedido);
      if (res.ok) {
        console.log(
          `[cron-repasse-shopee] pedido ${pedido.bling_pedido_id} liquido=${res.liquido} final=${res.final}`,
        );
      } else {
        console.warn(`[cron-repasse-shopee] pedido ${pedido.bling_pedido_id} erro: ${res.error}`);
      }
    }

    console.log("[cron-repasse-shopee] ciclo concluído");
  } catch (e) {
    console.error("[cron-repasse-shopee] exceção não tratada", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function cronNfStatus() {
  const now = Date.now();
  console.log("[cron-nf-status] iniciando verificação de gate", { now: new Date(now).toISOString() });

  try {
    const diffMemMs = now - lastNfStatusAt;
    if (diffMemMs < NF_STATUS_INTERVAL_MS) {
      console.log("[cron-nf-status] bloqueado pelo gate em memória", { diffMemMs });
      return;
    }

    const db = supabaseAdmin as any;
    const { data: state } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "nf_status")
      .maybeSingle();

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    const diffMs = now - lastRun;
    if (diffMs < NF_STATUS_INTERVAL_MS) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert({ job_name: "nf_status", last_run_at: new Date(now).toISOString() }, { onConflict: "job_name" });
    if (upsertError) {
      console.error("[cron-nf-status] upsert cron_state falhou", { message: upsertError.message });
      return;
    }

    lastNfStatusAt = now;

    // Prefere uma conexão "connected" (ver reconciliarPedidos em pedidos.functions.ts
    // para o histórico do bug: com múltiplas contas, a mais antiga por created_at nem
    // sempre é a saudável). Sem nenhuma "connected", cai para a mais antiga mesmo assim.
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
    if (!conn) {
      const { data } = await supabaseAdmin
        .from("bling_connections")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      conn = data;
    }

    if (!conn) {
      console.log("[cron-nf-status] nenhuma conexão Bling cadastrada");
      return;
    }

    let token: string;
    try {
      token = await getDecryptedAccessToken(conn.id);
    } catch (e) {
      console.error("[cron-nf-status] erro ao obter token:", e);
      return;
    }

    const situacoesAutorizadas = Array.from(NF_SITUACOES_AUTORIZADAS);

    // Não colocar o filtro "not in (autorizadas)" aqui: `NOT (coluna IN (...))`
    // em SQL exclui silenciosamente qualquer linha com coluna NULL (mesma
    // classe da Lição #10 do projeto) — quebraria o bucket "nunca verificados"
    // abaixo, que depende de `nf_situacao IS NULL` passar por este filtro
    // compartilhado. A exclusão de "já autorizada" só é aplicada dentro do
    // bucket de retry, onde `nf_situacao` já está garantidamente não-nulo.
    const baseQuery = () =>
      supabaseAdmin
        .from("pedidos")
        .select("id, bling_nota_fiscal_id, nf_situacao, nf_situacao_checked_at")
        .is("printed_at", null)
        .not("bling_nota_fiscal_id", "is", null)
        .neq("situacao_id", 12)
        .eq("arquivado", false);

    const { data: nuncaVerificados, error: selectError1 } = await baseQuery()
      .is("nf_situacao", null)
      .order("data_pedido", { ascending: true })
      .limit(MAX_CANDIDATOS_NF_STATUS) as any;

    if (selectError1) {
      console.error("[cron-nf-status] select nunca-verificados falhou:", selectError1.message);
      return;
    }

    const slotsRestantes = MAX_CANDIDATOS_NF_STATUS - (nuncaVerificados?.length ?? 0);
    let retry: any[] = [];

    if (slotsRestantes > 0) {
      const { data: retryData, error: selectError2 } = await baseQuery()
        .not("nf_situacao", "is", null)
        .not("nf_situacao", "in", `(${situacoesAutorizadas.join(",")})`)
        .order("nf_situacao_checked_at", { ascending: true, nullsFirst: true })
        .limit(slotsRestantes) as any;

      if (selectError2) {
        console.error("[cron-nf-status] select retry falhou:", selectError2.message);
      } else {
        retry = retryData ?? [];
      }
    }

    const candidatos = [...(nuncaVerificados ?? []), ...retry];
    console.log(
      `[cron-nf-status] ${candidatos.length} candidato(s) encontrado(s)`,
      `(${nuncaVerificados?.length ?? 0} nunca verificado(s), ${retry.length} retry)`,
    );

    for (const pedido of candidatos) {
      if (!pedido.bling_nota_fiscal_id) continue;

      const { situacao, motivo } = await fetchNfSituacaoBling(pedido.bling_nota_fiscal_id, token);

      console.log(
        `[cron-nf-status] pedido ${pedido.id} nf=${pedido.bling_nota_fiscal_id} situacao=${situacao} motivo=${motivo ?? "null"}`,
      );

      if (situacao == null) continue; // não sobrescreve com null — mantém o que já sabia (ou continua null)

      await supabaseAdmin
        .from("pedidos")
        .update({
          nf_situacao: situacao,
          nf_situacao_motivo: motivo,
          nf_situacao_checked_at: new Date(now).toISOString(),
        } as any)
        .eq("id", pedido.id);
    }

    console.log("[cron-nf-status] ciclo concluído");
  } catch (e) {
    console.error("[cron-nf-status] exceção não tratada", {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
  }
}

export async function cronNfEmissao() {
  const now = Date.now();

  try {
    if (now - lastNfEmissaoAt < NF_EMISSAO_INTERVAL_MS) return;

    const db = supabaseAdmin as any;
    const { data: state, error: stateError } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "nf_emissao_ml")
      .maybeSingle();

    if (stateError) {
      console.error("[cron-nf-emissao] select cron_state falhou:", stateError.message);
      return;
    }

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    if (now - lastRun < NF_EMISSAO_INTERVAL_MS) return;

    const { error: upsertError } = await db
      .from("cron_state")
      .upsert(
        { job_name: "nf_emissao_ml", last_run_at: new Date(now).toISOString() },
        { onConflict: "job_name" },
      );

    if (upsertError) {
      console.error("[cron-nf-emissao] upsert cron_state falhou:", upsertError.message);
      return;
    }

    lastNfEmissaoAt = now;
    await processarFilaEmissaoNfML();
  } catch (error) {
    console.error("[cron-nf-emissao] exceção não tratada", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

export async function cronReconciliar() {
  const now = Date.now();
  console.log("[cron] iniciando verificação de gate", { now: new Date(now).toISOString() });

  try {
    // Verificação rápida em memória — evita subrequest ao banco quando o mesmo isolate já rodou recentemente
    const diffMemMs = now - lastReconciliationAt;
    if (diffMemMs < RECONCILIATION_INTERVAL_MS) {
      console.log("[cron] bloqueado pelo gate em memória", { lastReconciliationAt: new Date(lastReconciliationAt).toISOString(), diffMemMs });
      return;
    }

    // Verificação durável via Supabase — protege contra múltiplos isolates rodando em paralelo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any;
    const { data: state, error: stateError } = await db
      .from("cron_state")
      .select("last_run_at")
      .eq("job_name", "reconciliar")
      .maybeSingle();

    console.log("[cron] select cron_state", { data: state, error: stateError });

    const lastRun = state?.last_run_at ? new Date(state.last_run_at as string).getTime() : 0;
    const diffMs = now - lastRun;
    const willRun = diffMs >= RECONCILIATION_INTERVAL_MS;
    console.log("[cron] gate check", { lastRunAt: state?.last_run_at ?? null, diffMs, willRun });

    if (!willRun) return;

    // Registra ANTES de executar para bloquear execuções concorrentes de outros isolates
    const { error: upsertError } = await db
      .from("cron_state")
      .upsert({ job_name: "reconciliar", last_run_at: new Date(now).toISOString() }, { onConflict: "job_name" });

    if (upsertError) {
      console.error("[cron] upsert cron_state falhou", { message: upsertError.message, details: upsertError.details, hint: upsertError.hint, code: upsertError.code });
      return;
    }

    lastReconciliationAt = now;
    console.log("[cron] gate liberado — chamando reconciliarPedidos()");
    await reconciliarPedidos();
    console.log("[cron] reconciliarPedidos() concluído");
  } catch (e) {
    console.error("[cron] exceção não tratada em cronReconciliar", {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
  }
}

export async function cronSyncPoll() {
  const now = new Date().toISOString();
  const { data: jobs } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, proxima_execucao_em")
    .in("status", ["pendente", "pausado", "rodando"])
    .limit(5);

  const runnable = (jobs ?? []).filter(
    (j: any) => !j.proxima_execucao_em || j.proxima_execucao_em <= now,
  );
  if (runnable.length === 0) return;

  for (const job of runnable) {
    try {
      await runSyncJob((job as any).id);
    } catch (e) {
      console.error("[cron-sync] job", (job as any).id, "erro:", e);
    }
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },

  // NUNCA é chamado em produção: o preset Nitro cloudflare-module gera seu próprio
  // entry point e expõe scheduled triggers via hook "cloudflare:scheduled"
  // (registrado em plugins/cloudflare-scheduled.ts), não via este export default.
  // Mantido para paridade de tipo com o ServerEntry e como referência da lógica.
  async scheduled(
    _event: unknown,
    _env: unknown,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ) {
    ctx.waitUntil(
      cronSyncPoll().catch((e) => console.error("[cron-sync] poll erro:", e)),
    );
    ctx.waitUntil(
      cronReconciliar().catch((e) => console.error("[cron-reconciliar] erro:", e)),
    );
    ctx.waitUntil(
      cronNfEmissao().catch((e) => console.error("[cron-nf-emissao] erro:", e)),
    );
  },
};
