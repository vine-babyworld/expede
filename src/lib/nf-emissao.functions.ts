import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { classificarEmissaoNf } from "@/lib/nf-emissao.policy";
import { fetchNfSituacaoBling, NF_SITUACOES_AUTORIZADAS } from "@/lib/pedidos.functions";

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
const BLING_NFE_URL = "https://api.bling.com.br/Api/v3/nfe";
const CONFIG_KEY = "nf_emissao_ml_ativa";
const MAX_POR_CICLO = 2;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const LEASE_MS = 5 * 60 * 1000;
const BLING_THROTTLE_MS = 450;

type FilaStatus = "pending" | "processing" | "created" | "retry";

type CandidatoEmissao = {
  id: string;
  bling_connection_id: string;
  bling_pedido_id: number;
  bling_nota_fiscal_id: number | null;
  nf_emissao_status: FilaStatus;
  nf_emissao_attempts: number;
  nf_emissao_error: string | null;
  nf_situacao: number | null;
  nf_emissao_last_attempt_at: string | null;
  nf_emissao_locked_at: string | null;
};

type BlingResult<T> =
  | { ok: true; data: T }
  | {
    ok: false;
    retryable: boolean;
    error: string;
    status: number | null;
    retryAfterMs?: number | null;
  };

export type EmissaoNfReport = {
  ativo: boolean;
  candidatos: number;
  processados: number;
  enviados: number;
  manuais: number;
  bloqueados: number;
  retries: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeMessage(value: unknown): string {
  return String(value ?? "erro desconhecido")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    // CPF/CNPJ podem vir no texto de erro por campo do Bling; nunca persistir.
    .replace(/\d{11,}/g, "[redigido]")
    .trim()
    .slice(0, 500);
}

/**
 * Achata `error.fields[]` da API v3 do Bling em `element:code:msg`, incluindo
 * o indice de itens de colecao. E ai que mora o motivo real da recusa.
 */
function achatarCamposBling(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const pedaco = (partes: unknown[]) =>
    partes
      .filter((parte) => parte != null && String(parte).trim() !== "")
      .join(":");

  return fields.flatMap((field: any) => {
    // Campo só com `element` é contêiner (ex.: "itens"): o motivo está nos
    // filhos, então não vira ruído na mensagem.
    const detalhe = field?.msg ?? field?.message;
    const base = field?.code == null && detalhe == null
      ? ""
      : pedaco([field?.element, field?.code, detalhe]);
    const colecao = Array.isArray(field?.collection)
      ? field.collection.map((item: any) =>
        pedaco([
          item?.index != null ? `[${item.index}]` : null,
          item?.element,
          item?.code,
          item?.msg ?? item?.message,
        ]),
      )
      : [];
    return [base, ...colecao].filter((parte: string) => parte !== "");
  });
}

async function blingError(response: Response): Promise<BlingResult<never>> {
  let message = `HTTP ${response.status}`;
  try {
    const body: any = await response.json();
    // `error.message` e generico por contrato ("Nao foi possivel emitir a nota
    // fiscal"). O motivo util vive em type/description/fields[] — compor tudo.
    const partes = [
      body?.error?.type,
      body?.error?.message ?? body?.message,
      body?.error?.description ?? body?.description,
      ...achatarCamposBling(body?.error?.fields),
    ].filter((parte) => parte != null && String(parte).trim() !== "");
    if (partes.length > 0) message = partes.join(" | ");
  } catch {
    // O status HTTP ja e suficiente; nao persiste corpo bruto potencialmente sensivel.
  }

  const retryAfterSeg = Number(response.headers?.get?.("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfterSeg) && retryAfterSeg > 0
    ? Math.min(retryAfterSeg * 1000, RETRY_BACKOFF_MAX_MS)
    : null;

  return {
    ok: false,
    retryable: response.status === 429 || response.status >= 500,
    error: sanitizeMessage(message),
    status: response.status,
    retryAfterMs,
  };
}

async function buscarPedidoBling(
  blingPedidoId: number,
  token: string,
): Promise<BlingResult<any>> {
  try {
    const response = await fetch(`${BLING_PEDIDOS_URL}/${blingPedidoId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) return blingError(response);
    const body: any = await response.json();
    if (!body?.data) {
      return { ok: false, retryable: true, error: "BLING_EMPTY_ORDER", status: response.status };
    }
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, retryable: true, error: sanitizeMessage(error), status: null };
  }
}

async function gerarNfBling(
  blingPedidoId: number,
  token: string,
): Promise<BlingResult<number>> {
  try {
    const response = await fetch(`${BLING_PEDIDOS_URL}/${blingPedidoId}/gerar-nfe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) return blingError(response);

    const body: any = await response.json().catch(() => null);
    const id = Number(
      body?.data?.idNotaFiscal
      ?? body?.idNotaFiscal
      ?? body?.data?.id,
    );
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, retryable: true, error: "BLING_INVALID_INVOICE_ID", status: response.status };
    }
    return { ok: true, data: id };
  } catch (error) {
    return { ok: false, retryable: true, error: sanitizeMessage(error), status: null };
  }
}

async function enviarNfBling(
  notaFiscalId: number,
  token: string,
): Promise<BlingResult<true>> {
  try {
    const response = await fetch(`${BLING_NFE_URL}/${notaFiscalId}/enviar?enviarEmail=false`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) return blingError(response);
    return { ok: true, data: true };
  } catch (error) {
    return { ok: false, retryable: true, error: sanitizeMessage(error), status: null };
  }
}

async function atualizarFalha(
  candidato: Pick<CandidatoEmissao, "id" | "nf_emissao_attempts">,
  result: Extract<BlingResult<never>, { ok: false }>,
): Promise<"retry" | "blocked"> {
  const status = result.retryable ? "retry" : "blocked";
  const patch: Record<string, unknown> = {
    nf_emissao_status: status,
    nf_emissao_locked_at: null,
    nf_emissao_error: `${result.status ?? "NETWORK"}:${result.error}`,
  };

  // 429 é limite de taxa, não tentativa de emissão: devolve o contador que o
  // claim consumiu, senão o rate limit sozinho esgota MAX_ATTEMPTS.
  if (result.status === 429) {
    patch.nf_emissao_attempts = Math.max(0, (candidato.nf_emissao_attempts ?? 1) - 1);
  }

  // Respeita Retry-After empurrando a âncora do backoff pra frente: o próximo
  // ciclo mede disponibilidade a partir de nf_emissao_last_attempt_at.
  if (result.retryAfterMs != null) {
    patch.nf_emissao_last_attempt_at = new Date(Date.now() + result.retryAfterMs).toISOString();
  }

  await (supabaseAdmin as any).from("pedidos").update(patch).eq("id", candidato.id);
  return status;
}

async function controladorAtivo(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.error("[nf-emissao] falha ao ler chave de ativação:", error.message);
    return false;
  }
  return data?.value === true;
}

/** Backoff exponencial com teto: 5min, 10, 20, 40... até 6h. */
function backoffMs(attempts: number): number {
  const expoente = Math.max(0, (attempts ?? 0) - 1);
  return Math.min(RETRY_INTERVAL_MS * 2 ** expoente, RETRY_BACKOFF_MAX_MS);
}

function candidatoDisponivel(candidato: CandidatoEmissao, now: number): boolean {
  if (candidato.nf_emissao_status === "retry") {
    const last = candidato.nf_emissao_last_attempt_at
      ? new Date(candidato.nf_emissao_last_attempt_at).getTime()
      : 0;
    return now - last >= backoffMs(candidato.nf_emissao_attempts);
  }
  if (candidato.nf_emissao_status === "processing") {
    const locked = candidato.nf_emissao_locked_at
      ? new Date(candidato.nf_emissao_locked_at).getTime()
      : 0;
    return now - locked >= LEASE_MS;
  }
  return true;
}

async function claimCandidato(
  candidato: CandidatoEmissao,
  nowIso: string,
  leaseCutoffIso: string,
): Promise<CandidatoEmissao | null> {
  const db = supabaseAdmin as any;
  let query = db
    .from("pedidos")
    .update({
      nf_emissao_status: "processing",
      nf_emissao_attempts: (candidato.nf_emissao_attempts ?? 0) + 1,
      nf_emissao_last_attempt_at: nowIso,
      nf_emissao_locked_at: nowIso,
      // Não zera nf_emissao_error: apagar aqui escondeu 179 erros 429 seguidos
      // e fez o pedido parecer preso num loop de 400.
    })
    .eq("id", candidato.id)
    .eq("nf_emissao_status", candidato.nf_emissao_status);

  query = candidato.nf_emissao_status === "processing"
    ? query.lt("nf_emissao_locked_at", leaseCutoffIso)
    : query.or(`nf_emissao_locked_at.is.null,nf_emissao_locked_at.lt.${leaseCutoffIso}`);

  const { data, error } = await query
    .select(
      "id, bling_connection_id, bling_pedido_id, bling_nota_fiscal_id, nf_emissao_status, nf_emissao_attempts, nf_emissao_last_attempt_at, nf_emissao_locked_at, nf_emissao_error, nf_situacao",
    )
    .maybeSingle();

  if (error) {
    console.error(`[nf-emissao] claim do pedido ${candidato.id} falhou:`, error.message);
    return null;
  }
  return data as CandidatoEmissao | null;
}

/**
 * Guarda P0: nunca chamar POST /nfe/{id}/enviar sobre nota já autorizada.
 * Prefere a coluna nf_situacao (mantida de graça pelo cronNfStatus) e só
 * consulta o Bling quando ela ainda não afirma autorização.
 */
async function consultarAutorizacao(
  situacaoConhecida: number | null,
  notaFiscalId: number,
  token: string,
): Promise<{ autorizada: boolean; situacao: number | null }> {
  if (situacaoConhecida != null && NF_SITUACOES_AUTORIZADAS.has(situacaoConhecida)) {
    return { autorizada: true, situacao: situacaoConhecida };
  }
  await sleep(BLING_THROTTLE_MS);
  const { situacao } = await fetchNfSituacaoBling(notaFiscalId, token);
  return {
    autorizada: situacao != null && NF_SITUACOES_AUTORIZADAS.has(situacao),
    situacao,
  };
}

async function marcarEnviada(pedidoId: string, situacao: number | null): Promise<"sent"> {
  const patch: Record<string, unknown> = {
    nf_emissao_status: "sent",
    nf_emissao_locked_at: null,
    nf_emissao_error: null,
  };
  if (situacao != null) patch.nf_situacao = situacao;
  await (supabaseAdmin as any).from("pedidos").update(patch).eq("id", pedidoId);
  return "sent";
}

async function processarCandidato(
  candidato: CandidatoEmissao,
  token: string,
): Promise<"sent" | "manual" | "blocked" | "retry"> {
  const db = supabaseAdmin as any;
  const pedidoResult = await buscarPedidoBling(candidato.bling_pedido_id, token);
  if (!pedidoResult.ok) return atualizarFalha(candidato, pedidoResult);

  const detalhe = pedidoResult.data;
  const classificacao = classificarEmissaoNf(detalhe, "mercadolivre");

  if (classificacao === "manual") {
    await db
      .from("pedidos")
      .update({
        nf_emissao_modo: "manual",
        nf_emissao_status: "manual",
        nf_emissao_locked_at: null,
        nf_emissao_error: null,
        raw_json: detalhe,
      })
      .eq("id", candidato.id);
    return "manual";
  }

  if (classificacao === "cancelled" || classificacao === "unknown_logistics") {
    await db
      .from("pedidos")
      .update({
        nf_emissao_status: "blocked",
        nf_emissao_locked_at: null,
        nf_emissao_error: classificacao === "cancelled"
          ? "ORDER_CANCELLED"
          : "UNKNOWN_LOGISTICS_SERVICE",
        raw_json: detalhe,
      })
      .eq("id", candidato.id);
    return "blocked";
  }

  let notaFiscalId = candidato.bling_nota_fiscal_id;
  let recemCriada = false;
  const notaExistenteNoBling = Number(detalhe?.notaFiscal?.id ?? 0) || null;

  if (classificacao === "existing" && notaExistenteNoBling) {
    // A nota já existe no Bling. Sincroniza identificação e deixa a guarda de
    // autorização abaixo decidir entre "já autorizada" e "rascunho a enviar".
    // Antes, "existing" não tinha ramo próprio e caía direto na emissão.
    await db
      .from("pedidos")
      .update({
        bling_nota_fiscal_id: notaExistenteNoBling,
        bling_nota_fiscal_numero: detalhe?.notaFiscal?.numero != null
          ? String(detalhe.notaFiscal.numero)
          : null,
        nf_emissao_status: "created",
        raw_json: detalhe,
      })
      .eq("id", candidato.id);
    notaFiscalId = notaExistenteNoBling;
  }

  if (!notaFiscalId) {
    await sleep(BLING_THROTTLE_MS);
    const gerarResult = await gerarNfBling(candidato.bling_pedido_id, token);
    if (!gerarResult.ok) {
      // Cerca de corrida: se outra origem criou a nota entre o preflight e o
      // POST, sincroniza o ID em vez de tentar gerar novamente.
      const recheck = await buscarPedidoBling(candidato.bling_pedido_id, token);
      if (recheck.ok && Number(recheck.data?.notaFiscal?.id ?? 0) > 0) {
        const idRecheck = Number(recheck.data.notaFiscal.id);
        await db
          .from("pedidos")
          .update({
            bling_nota_fiscal_id: idRecheck,
            bling_nota_fiscal_numero: recheck.data?.notaFiscal?.numero != null
              ? String(recheck.data.notaFiscal.numero)
              : null,
            nf_emissao_status: "created",
            nf_emissao_error: null,
            raw_json: recheck.data,
          })
          .eq("id", candidato.id);
        notaFiscalId = idRecheck;
      } else {
        return atualizarFalha(candidato, gerarResult);
      }
    } else {
      notaFiscalId = gerarResult.data;
      recemCriada = true;
      const { error } = await db
        .from("pedidos")
        .update({
          bling_nota_fiscal_id: notaFiscalId,
          nf_emissao_status: "created",
          nf_emissao_error: null,
        })
        .eq("id", candidato.id);

      if (error) {
        console.error(
          `[nf-emissao] NF ${notaFiscalId} criada, mas persistência falhou para pedido ${candidato.id}:`,
          error.message,
        );
        // Não chama gerar novamente nesta execução. O recheck do próximo ciclo
        // encontrará a NF no próprio Bling e fechará a corrida com segurança.
        await db
          .from("pedidos")
          .update({ nf_emissao_status: "retry", nf_emissao_locked_at: null, nf_emissao_error: "INVOICE_ID_PERSIST_FAILED" })
          .eq("id", candidato.id);
        return "retry";
      }
    }
  }

  // P0: nota recém-criada nesta execução é rascunho por construção; qualquer
  // outra pode já estar autorizada — reenviar produz o 400 que travava a fila.
  if (!recemCriada) {
    const antes = await consultarAutorizacao(candidato.nf_situacao, notaFiscalId, token);
    if (antes.autorizada) return marcarEnviada(candidato.id, antes.situacao);
  }

  await sleep(BLING_THROTTLE_MS);
  const enviarResult = await enviarNfBling(notaFiscalId, token);
  if (!enviarResult.ok) {
    // O Bling pode ter processado a emissão e falhado só na resposta (429).
    // Reconsulta antes de classificar: 5/6 é sucesso, não bloqueio.
    const depois = await consultarAutorizacao(null, notaFiscalId, token);
    if (depois.autorizada) return marcarEnviada(candidato.id, depois.situacao);
    return atualizarFalha(candidato, enviarResult);
  }

  return marcarEnviada(candidato.id, null);
}

export async function processarFilaEmissaoNfML(): Promise<EmissaoNfReport> {
  const report: EmissaoNfReport = {
    ativo: false,
    candidatos: 0,
    processados: 0,
    enviados: 0,
    manuais: 0,
    bloqueados: 0,
    retries: 0,
  };

  if (!(await controladorAtivo())) {
    console.log("[nf-emissao] controlador desarmado");
    return report;
  }
  report.ativo = true;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseCutoffIso = new Date(now - LEASE_MS).toISOString();
  const db = supabaseAdmin as any;

  const { data, error } = await db
    .from("pedidos")
    .select(
      "id, bling_connection_id, bling_pedido_id, bling_nota_fiscal_id, nf_emissao_status, nf_emissao_attempts, nf_emissao_last_attempt_at, nf_emissao_locked_at, nf_emissao_error, nf_situacao",
    )
    .eq("marketplace", "mercadolivre")
    .eq("nf_emissao_modo", "automatic")
    .in("nf_emissao_status", ["pending", "processing", "created", "retry"])
    .eq("arquivado", false)
    .neq("situacao_id", 12)
    .order("nf_emissao_last_attempt_at", { ascending: true, nullsFirst: true })
    .order("data_pedido", { ascending: true, nullsFirst: false })
    .limit(20);

  if (error) {
    console.error("[nf-emissao] falha ao listar candidatos:", error.message);
    return report;
  }

  const todos = (data ?? []) as CandidatoEmissao[];

  // Teto de tentativas: aposenta a linha antes de qualquer chamada ao Bling e
  // deixa rastro operacional, em vez de repetir para sempre em silêncio.
  // Roda fora do backoff e do MAX_POR_CICLO — é só escrita local.
  const esgotados = todos.filter((c) => (c.nf_emissao_attempts ?? 0) >= MAX_ATTEMPTS);
  for (const candidato of esgotados) {
    const ultimoErro = candidato.nf_emissao_error
      ? ` | último erro: ${candidato.nf_emissao_error}`
      : "";
    await db
      .from("pedidos")
      .update({
        nf_emissao_status: "blocked",
        nf_emissao_locked_at: null,
        nf_emissao_error: sanitizeMessage(
          `MAX_ATTEMPTS_EXCEEDED (${candidato.nf_emissao_attempts} tentativas)${ultimoErro}`,
        ),
      })
      .eq("id", candidato.id);
    report.bloqueados++;
    console.warn(
      `[nf-emissao] pedido ${candidato.id} atingiu MAX_ATTEMPTS (${candidato.nf_emissao_attempts}); bloqueado para revisão manual`,
    );
  }

  const candidatos = todos
    .filter((candidato) => (candidato.nf_emissao_attempts ?? 0) < MAX_ATTEMPTS)
    .filter((candidato) => candidatoDisponivel(candidato, now))
    .slice(0, MAX_POR_CICLO);
  report.candidatos = candidatos.length;

  const tokens = new Map<string, string>();

  for (const candidato of candidatos) {
    const claimed = await claimCandidato(candidato, nowIso, leaseCutoffIso);
    if (!claimed) continue;
    report.processados++;

    let token = tokens.get(claimed.bling_connection_id);
    if (!token) {
      try {
        token = await getDecryptedAccessToken(claimed.bling_connection_id);
        tokens.set(claimed.bling_connection_id, token);
      } catch (error) {
        await atualizarFalha(claimed, {
          ok: false,
          retryable: true,
          error: sanitizeMessage(error),
          status: null,
        });
        report.retries++;
        continue;
      }
    }

    try {
      const result = await processarCandidato(claimed, token);
      if (result === "sent") report.enviados++;
      if (result === "manual") report.manuais++;
      if (result === "blocked") report.bloqueados++;
      if (result === "retry") report.retries++;
    } catch (error) {
      // Sem isto, uma exceção deixa a linha presa em "processing" até o lease
      // vencer — mesmo sintoma de fila travada, por outro caminho.
      console.error(`[nf-emissao] exceção ao processar pedido ${claimed.id}:`, error);
      await atualizarFalha(claimed, {
        ok: false,
        retryable: true,
        error: sanitizeMessage(error),
        status: null,
      });
      report.retries++;
    }
  }

  console.log("[nf-emissao] ciclo concluído", report);
  return report;
}
