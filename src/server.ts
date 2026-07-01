import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { runSyncJob } from "./lib/produtos.functions";
import { reconciliarPedidos } from "./lib/pedidos.functions";
import { checarStatusEnvioML } from "./lib/ml.functions";
import { supabaseAdmin } from "./integrations/supabase/client.server";

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

    // Candidatos: faturados (NF emitida) mas ainda não impressos no EXPEDE
    const { data: candidatos, error: selectError } = await supabaseAdmin
      .from("pedidos")
      .select("id, numero_loja, situacao_id, bling_pedido_id")
      .is("printed_at", null)
      .not("bling_nota_fiscal_id", "is", null)
      .eq("marketplace", "mercadolivre")
      .order("data_pedido", { ascending: true })
      .limit(4) as any;

    if (selectError) {
      console.error("[cron-ml-status] select candidatos falhou:", selectError.message);
      return;
    }

    console.log(`[cron-ml-status] ${candidatos?.length ?? 0} candidato(s) encontrado(s)`);

    for (const pedido of candidatos ?? []) {
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

// Desativado em 18/06/2026: Bling bloqueia IP de datacenter no endpoint /Api/v3/produtos.
// Sync de produtos passou a ser manual via scripts/sync-produtos-local.mjs.
// Reativar removendo o early return abaixo se o bloqueio for resolvido.
export async function cronSyncPoll() {
  console.log("[cron-sync] desativado — sync de produtos agora é manual via scripts/sync-produtos-local.mjs");
  return;

  // eslint-disable-next-line no-unreachable
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
  },
};
