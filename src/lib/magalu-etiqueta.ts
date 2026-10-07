/**
 * Magalu Entregas — busca da etiqueta de transporte DIRETO na API do Magalu.
 *
 * Server-only (importa `magalu.functions.ts`, que fala com Supabase e env).
 * A lógica de decisão vive em `magalu.ts` e tem teste; aqui só tem I/O.
 *
 * O Bling NÃO é fonte de etiqueta de marketplace (regra do dono do projeto,
 * confirmada pelo pedido 9634: o Bling não entregou nada). Por isso este
 * módulo nunca chama o Bling.
 *
 * Regra que não pode ser quebrada: **uma única chamada** a `shipping-labels`
 * por execução. Não se sabe se cada chamada gera etiqueta/rastreio novo
 * (lacuna #4/#14 de `docs/integrations/magalu.md`) — então nada de retry, nada
 * de "tenta ZPL e depois PDF". Quem chama tem de gravar o resultado no cache
 * para que reimpressão não volte aqui.
 */

import { chamarMagalu, getMagaluAccessToken } from "@/lib/magalu.functions";
import {
  coletarEntregas,
  detectarFormatoBinario,
  montarCorpoEtiquetaMagalu,
  selecionarEntregasParaEtiqueta,
  traduzirErroEtiquetaMagalu,
} from "@/lib/magalu";
import { uint8ToBase64 } from "@/lib/zpl-to-pdf";

const LOG = "[etiqueta-magalu]";
const TIMEOUT_DOWNLOAD_MS = 20_000;

export type EtiquetaMagaluResult =
  | { ok: true; tipo: "zpl"; conteudo: string }
  | { ok: true; tipo: "pdf_base64"; conteudo: string; recortarA4: false }
  | { ok: false; error: string };

/** Só host + começo do path: a query da signed_url é a assinatura, não vai para log. */
function urlParaLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.slice(0, 24)}…`;
  } catch {
    return "(url inválida)";
  }
}

function msgErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function buscarEtiquetaMagalu(numeroLoja: string): Promise<EtiquetaMagaluResult> {
  const code = String(numeroLoja ?? "").trim();
  if (!code) return { ok: false, error: "magalu_sem_numero_loja" };

  // ── 1. Token ──────────────────────────────────────────────────────────────
  let token: string;
  try {
    token = await getMagaluAccessToken();
  } catch (err) {
    console.error(LOG, "token falhou:", msgErro(err));
    return { ok: false, error: "magalu_token_error: " + msgErro(err) };
  }

  // ── 2. Pedido → entregas ─────────────────────────────────────────────────
  // `GET /seller/v1/orders/{code}` com o numero_loja cru funcionou no 9262
  // (seção 16). O `code` da ENTREGA tem prefixo `LU-`, mas aqui é o do pedido.
  let pedido;
  try {
    pedido = await chamarMagalu(`/seller/v1/orders/${encodeURIComponent(code)}`, { token });
  } catch (err) {
    console.error(LOG, "GET pedido exception:", code, msgErro(err));
    return { ok: false, error: "magalu_pedido_exception: " + msgErro(err) };
  }
  console.log(LOG, "GET pedido", code, "status", pedido.status, "ms", pedido.ms, "request_id", pedido.request_id);

  if (!pedido.ok) {
    return { ok: false, error: traduzirErroEtiquetaMagalu(pedido.status, pedido.json) };
  }

  const entregas = coletarEntregas(pedido.json);
  const selecao = selecionarEntregasParaEtiqueta(entregas);
  console.log(
    LOG,
    "entregas",
    code,
    entregas.map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).status : null)),
    "→",
    selecao.ok ? `${selecao.ids.length} elegível(is)` : selecao.motivo,
  );
  if (!selecao.ok) return { ok: false, error: selecao.motivo };

  // ── 3. Etiqueta — UMA chamada, formato ZPL ──────────────────────────────
  let etiqueta;
  try {
    etiqueta = await chamarMagalu("/seller/v1/logistics/shipping-labels", {
      token,
      method: "POST",
      body: montarCorpoEtiquetaMagalu(selecao.ids, "zpl", "summary"),
    });
  } catch (err) {
    // Timeout/rede: a etiqueta PODE ter sido gerada do lado do Magalu. Não
    // repetir — devolver o erro e deixar a próxima bipagem decidir.
    console.error(LOG, "POST shipping-labels exception:", code, msgErro(err));
    return { ok: false, error: "magalu_etiqueta_exception: " + msgErro(err) };
  }
  console.log(
    LOG,
    "POST shipping-labels",
    code,
    "status",
    etiqueta.status,
    "ms",
    etiqueta.ms,
    "request_id",
    etiqueta.request_id,
  );

  if (!etiqueta.ok) {
    const erro = traduzirErroEtiquetaMagalu(etiqueta.status, etiqueta.json);
    console.warn(LOG, "shipping-labels recusou", code, erro, etiqueta.texto.slice(0, 300));
    return { ok: false, error: erro };
  }

  const signedUrl = (etiqueta.json as { label?: { signed_url?: unknown } } | null)?.label?.signed_url;
  if (typeof signedUrl !== "string" || !signedUrl.startsWith("http")) {
    console.error(LOG, "resposta 200 sem label.signed_url", code);
    return { ok: false, error: "magalu_sem_signed_url" };
  }

  // ── 4. Download do arquivo ───────────────────────────────────────────────
  let bytes: Uint8Array;
  const inicioDownload = Date.now();
  try {
    const res = await fetch(signedUrl, { signal: AbortSignal.timeout(TIMEOUT_DOWNLOAD_MS) });
    if (!res.ok) {
      console.error(LOG, "download falhou", code, "status", res.status, urlParaLog(signedUrl));
      return { ok: false, error: `magalu_download_error:${res.status}` };
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error(LOG, "download exception", code, msgErro(err), urlParaLog(signedUrl));
    return { ok: false, error: "magalu_download_exception: " + msgErro(err) };
  }

  const formato = detectarFormatoBinario(bytes);
  console.log(
    LOG,
    "download",
    code,
    "ms",
    Date.now() - inicioDownload,
    "bytes",
    bytes.length,
    "formato",
    formato,
    urlParaLog(signedUrl),
  );

  if (formato === "zpl") {
    return { ok: true, tipo: "zpl", conteudo: new TextDecoder().decode(bytes) };
  }
  if (formato === "pdf") {
    // PDF do Magalu é A4 com 3 etiquetas: o recorte da Shopee o destruiria.
    return { ok: true, tipo: "pdf_base64", conteudo: uint8ToBase64(bytes), recortarA4: false };
  }
  return { ok: false, error: `magalu_formato_inesperado:${formato}` };
}
