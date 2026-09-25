import { createFileRoute } from "@tanstack/react-router";

/**
 * Diagnóstico não-destrutivo: o Cloudflare Worker consegue alcançar a API do
 * Magalu direto, sem proxy?
 *
 * Contexto (15/09/2026): o Mercado Livre precisou de Edge Function do Supabase
 * (`supabase/functions/ml-label`) porque o Worker recebe 1016/530 de
 * `api.mercadolibre.com`, e a Shopee precisou de gateway de IP fixo
 * (`ops/shopee-gateway/`). Se o Magalu passar direto, é o primeiro canal do
 * EXPEDE sem proxy — e isso muda o custo da integração inteira. Descobrir isso
 * ANTES de escrever o cliente HTTP é o ponto todo desta rota.
 *
 * Não usa credencial nenhuma de propósito: um 401 com JSON limpo já prova que
 * o Worker chegou no servidor do Magalu, que é a única coisa que se quer saber
 * aqui. Medido de IP residencial, `api.magalu.com` responde por Azion
 * (`Server: azion webserver`), não Cloudflare — indício favorável, mas teste de
 * fora do Worker não vale como prova.
 *
 * Não grava nada, não lê banco, não toca em QZ Tray. Espelha o padrão de
 * `/api/debug/shopee-etiqueta-teste` e `/api/debug/etiqueta-teste`.
 *
 * Exige o header `X-Admin-Key` (401 sem ele).
 */

const ALVOS = [
  // O que de fato importa: o host das APIs de seller (pedidos, entregas, etiqueta).
  { nome: "api_prod", url: "https://api.magalu.com/seller/v1/deliveries?_limit=1" },
  // Onde o token é emitido — outro host, outra infra (Google LB), pode falhar sozinho.
  { nome: "id_token", url: "https://id.magalu.com/oauth/token" },
  // Sandbox: não serve para etiqueta, mas serve para consulta de pedidos.
  { nome: "api_sandbox", url: "https://api-sandbox.magalu.com/seller/v1/deliveries?_limit=1" },
];

const TIMEOUT_MS = 8000;

export const Route = createFileRoute("/api/debug/magalu-ping")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const resultados = await Promise.all(
          ALVOS.map(async (alvo) => {
            const inicio = Date.now();
            try {
              const resposta = await fetch(alvo.url, {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(TIMEOUT_MS),
              });

              const corpo = await resposta.text();

              return {
                alvo: alvo.nome,
                url: alvo.url,
                alcancou: true,
                status: resposta.status,
                ms: Date.now() - inicio,
                // Quem respondeu importa tanto quanto o status: um challenge de
                // bot ou um erro de borda aparece aqui antes de aparecer no corpo.
                servidor: resposta.headers.get("server"),
                content_type: resposta.headers.get("content-type"),
                cf_ray: resposta.headers.get("cf-ray"),
                azion_request_id: resposta.headers.get("x-azion-request-id"),
                azion_edge: resposta.headers.get("x-azion-edge-location"),
                corpo_inicio: corpo.slice(0, 300),
              };
            } catch (err) {
              return {
                alvo: alvo.nome,
                url: alvo.url,
                alcancou: false,
                ms: Date.now() - inicio,
                erro: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
              };
            }
          }),
        );

        // `alcancou` só diz que houve resposta HTTP. 401/403 são ótimos sinais
        // aqui — significam que o servidor do Magalu processou a requisição e
        // recusou por falta de credencial, que é exatamente o esperado.
        const prodOk = resultados.find((r) => r.alvo === "api_prod")?.alcancou === true;

        return Response.json({
          ok: true,
          veredito: prodOk
            ? "Worker alcanca api.magalu.com — integracao direta viavel, sem proxy"
            : "Worker NAO alcancou api.magalu.com — vai precisar de proxy (Edge Function ou gateway de IP fixo)",
          precisa_proxy: !prodOk,
          testado_em: new Date().toISOString(),
          resultados,
        });
      },
    },
  },
});
