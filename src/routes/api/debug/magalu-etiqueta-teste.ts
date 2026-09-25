import { createFileRoute } from "@tanstack/react-router";
import { chamarMagalu, getMagaluAccessToken } from "@/lib/magalu.functions";
import {
  coletarEntregas,
  detectarFormatoBinario,
  extrairDiscriminadoresDeModalidade,
  MAGALU_CHANNEL_ID,
} from "@/lib/magalu";
import { uint8ToBase64, zplParaPdf } from "@/lib/zpl-to-pdf";

/**
 * Rota de descoberta da Etapa 2 do spike Magalu. Existe para responder cinco
 * perguntas com dado real do pedido 9262 (`numero_loja 1570070104300104`), e
 * morre quando elas estiverem respondidas:
 *
 * 1. A etiqueta existe do lado do Magalu? (o PDF que o dono tem veio do portal,
 *    origem nunca confirmada)
 * 2. Qual campo distingue Magalu Entregas de frete próprio? O `is_mle` que a
 *    base antiga documentava **não existe** no spec OpenAPI — por isso aqui se
 *    DUMPA `shipping.provider` e `shipping.logistic_network` crus em vez de
 *    codar regra de roteamento.
 * 3. `format: "zpl"` devolve ZPL imprimível? (`^XA` nos primeiros bytes)
 * 4. A etiqueta exige NF-e emitida ou basta `approved`?
 * 5. O PDF nativo da API é igual ao derivado do ZPL via Labelary?
 *
 * **A emissão de etiqueta é uma escrita de verdade num marketplace real** — o
 * sandbox não suporta `shipping-labels`, então não há onde ensaiar. Por isso
 * ela NÃO acontece por padrão: só com `?emitir=zpl|pdf|ambos` explícito. Sem
 * esse parâmetro a rota é leitura pura, e isso já basta para as perguntas 1 e 2.
 *
 * Lacuna #4 da base continua aberta e é o motivo de `emitir=ambos` existir:
 * não se sabe se chamar `shipping-labels` duas vezes gera duas etiquetas ou
 * dois rastreios. Usar `ambos` uma vez só, de propósito, e olhar o resultado.
 *
 * Exige o header `X-Admin-Key` (401 sem ele) — a rota emite etiqueta de verdade.
 *
 * Parâmetros:
 *   ?code=1570070104300104   código do pedido no Magalu (default: o 9262)
 *   ?deliveryId=<uuid>       pula a busca e usa esta entrega direto
 *   ?emitir=zpl|pdf|ambos    emite etiqueta (ESCRITA REAL — omitido = não emite)
 *   ?tipo=summary|full       `label.type` (default summary)
 *   ?labelary=1              deriva PDF do ZPL via Labelary, para a pergunta 5
 *   ?raw=zpl|pdf             devolve o arquivo baixado em vez do JSON
 */

const CODE_PADRAO = "1570070104300104";
const LIMITE_TEXTO = 1200;

type Passo = { passo: string; [k: string]: unknown };

/** Amostra segura de um corpo qualquer, sem estourar a resposta. */
function amostra(texto: string): string {
  return texto.length > LIMITE_TEXTO ? `${texto.slice(0, LIMITE_TEXTO)}…[+${texto.length - LIMITE_TEXTO}]` : texto;
}

async function baixarArquivo(url: string): Promise<{
  ok: boolean;
  status?: number;
  bytes?: number;
  formato?: string;
  content_type?: string | null;
  inicio?: string;
  conteudo?: Uint8Array;
  erro?: string;
}> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    const formato = detectarFormatoBinario(buf);
    return {
      ok: res.ok,
      status: res.status,
      bytes: buf.length,
      formato,
      content_type: res.headers.get("content-type"),
      // Para ZPL/texto, o começo do arquivo é o dado que interessa; para PDF é
      // só o cabeçalho, que confirma o formato e nada mais.
      inicio: new TextDecoder().decode(buf.slice(0, formato === "pdf" ? 32 : 600)),
      conteudo: buf,
    };
  } catch (err) {
    return { ok: false, erro: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export const Route = createFileRoute("/api/debug/magalu-etiqueta-teste")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const code = url.searchParams.get("code") ?? CODE_PADRAO;
        const deliveryIdParam = url.searchParams.get("deliveryId");
        const emitir = url.searchParams.get("emitir");
        const tipoEtiqueta = url.searchParams.get("tipo") === "full" ? "full" : "summary";
        const querLabelary = url.searchParams.get("labelary") === "1";
        const raw = url.searchParams.get("raw");

        const passos: Passo[] = [];
        const baixados: Record<string, Uint8Array> = {};

        // ── 1. Token ─────────────────────────────────────────────────────────
        let token: string;
        try {
          token = await getMagaluAccessToken();
          passos.push({ passo: "token", ok: true, tamanho: token.length });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              passo_que_falhou: "token",
              erro: err instanceof Error ? err.message : String(err),
              dica: "Autorize o canal abrindo /api/magalu/auth e escolhendo o tenant 'organization' (Baby Magia LTDA).",
            },
            { status: 428 },
          );
        }

        // ── 2. Achar a entrega ───────────────────────────────────────────────
        // Nenhuma dessas rotas foi testada com credencial ainda. Tenta todas e
        // reporta cada uma: qual responde o quê é, por si só, uma descoberta.
        const tentativas = deliveryIdParam
          ? [`/seller/v1/deliveries/${deliveryIdParam}`]
          : [
              `/seller/v1/orders/${encodeURIComponent(code)}`,
              `/seller/v1/deliveries?code=${encodeURIComponent(code)}`,
              `/seller/v1/deliveries?code=${encodeURIComponent(`${code}-1`)}`,
            ];

        let entregas: unknown[] = [];
        for (const caminho of tentativas) {
          const r = await chamarMagalu(caminho, { token });
          const achadas = r.ok ? coletarEntregas(r.json) : [];
          passos.push({
            passo: "buscar_entrega",
            caminho,
            status: r.status,
            ms: r.ms,
            request_id: r.request_id,
            entregas_encontradas: achadas.length,
            corpo: r.ok ? undefined : amostra(r.texto),
          });
          if (achadas.length > 0) {
            entregas = achadas;
            break;
          }
        }

        // ── 3. Discriminadores de modalidade (pergunta 2) ────────────────────
        const modalidade = entregas.map((d) => ({
          id: (d as Record<string, unknown>)?.id ?? null,
          code: (d as Record<string, unknown>)?.code ?? null,
          status: (d as Record<string, unknown>)?.status ?? null,
          chaves_da_entrega: d && typeof d === "object" ? Object.keys(d as object) : [],
          ...extrairDiscriminadoresDeModalidade(d),
        }));

        const deliveryId =
          deliveryIdParam ??
          (modalidade.find((m) => typeof m.id === "string")?.id as string | undefined) ??
          null;

        // O `channel.id` da própria entrega vale mais que a constante: se
        // divergirem, a constante é que está errada.
        const channelDaEntrega = entregas
          .map((d) => (d as Record<string, unknown>)?.channel)
          .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).id : undefined))
          .find((v) => typeof v === "string") as string | undefined;
        const channelId = channelDaEntrega ?? MAGALU_CHANNEL_ID;

        // ── 4. Etiqueta (só com ?emitir=) ────────────────────────────────────
        const formatos =
          emitir === "ambos" ? ["zpl", "pdf"] : emitir === "zpl" || emitir === "pdf" ? [emitir] : [];

        const etiquetas: Passo[] = [];
        for (const formato of formatos) {
          if (!deliveryId) {
            etiquetas.push({ passo: "etiqueta", formato, erro: "sem delivery id — a busca não achou a entrega" });
            continue;
          }

          const corpo = {
            channel: { id: channelId, extras: {} },
            deliveries: [{ id: deliveryId }],
            label: { format: formato, type: tipoEtiqueta, extras: {} },
          };

          const r = await chamarMagalu("/seller/v1/logistics/shipping-labels", {
            token,
            method: "POST",
            body: corpo,
          });

          const registro: Passo = {
            passo: "etiqueta",
            formato,
            requisicao: corpo,
            status: r.status,
            ms: r.ms,
            request_id: r.request_id,
            resposta: r.ok ? r.json : amostra(r.texto),
          };

          const signedUrl = (r.json as any)?.label?.signed_url;
          if (r.ok && typeof signedUrl === "string") {
            registro.expires_on = (r.json as any)?.label?.expires_on ?? null;
            const arquivo = await baixarArquivo(signedUrl);
            if (arquivo.conteudo) baixados[formato] = arquivo.conteudo;
            registro.download = {
              ok: arquivo.ok,
              status: arquivo.status,
              bytes: arquivo.bytes,
              formato_detectado: arquivo.formato,
              content_type: arquivo.content_type,
              inicio: arquivo.inicio,
              erro: arquivo.erro,
            };

            // Pergunta 5: o PDF nativo é igual ao derivado do ZPL?
            if (querLabelary && arquivo.formato === "zpl" && arquivo.conteudo) {
              const zpl = new TextDecoder().decode(arquivo.conteudo);
              try {
                const pdfBase64 = await zplParaPdf(zpl);
                baixados.labelary = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
                registro.labelary = { ok: true, bytes: baixados.labelary.length };
              } catch (err) {
                registro.labelary = { ok: false, erro: err instanceof Error ? err.message : String(err) };
              }
            }
          }

          etiquetas.push(registro);
        }

        // ── 5. Devolução ─────────────────────────────────────────────────────
        if (raw && baixados[raw]) {
          const bytes = baixados[raw];
          const formato = detectarFormatoBinario(bytes);
          return new Response(new Blob([bytes.slice().buffer]), {
            headers: {
              "Content-Type": formato === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
              "Content-Disposition": `attachment; filename="magalu-${code}.${formato === "pdf" ? "pdf" : "zpl"}"`,
            },
          });
        }

        return Response.json({
          ok: true,
          testado_em: new Date().toISOString(),
          pedido: { code, delivery_id: deliveryId, channel_id_usado: channelId, channel_veio_da_entrega: !!channelDaEntrega },
          emitiu_etiqueta: formatos,
          passos,
          // O bloco que a pergunta 2 existe para ler. Nada aqui é interpretado
          // de propósito: é o dado cru que vai decidir a regra de roteamento.
          modalidade,
          etiquetas,
          // Para conferir o PDF derivado sem baixar: `?raw=labelary` devolve o
          // arquivo, e este campo só diz se ele existe.
          derivado_labelary: baixados.labelary
            ? { bytes: baixados.labelary.length, amostra_base64: uint8ToBase64(baixados.labelary.slice(0, 64)) }
            : null,
        });
      },
    },
  },
});
