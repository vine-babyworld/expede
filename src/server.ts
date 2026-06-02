import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { runSyncJob } from "./lib/produtos.functions";
import { reconciliarPedidos } from "./lib/pedidos.functions";
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
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

async function cronReconciliar() {
  const now = Date.now();
  if (now - lastReconciliationAt < RECONCILIATION_INTERVAL_MS) return;
  lastReconciliationAt = now;
  await reconciliarPedidos();
}

async function cronSyncPoll() {
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
