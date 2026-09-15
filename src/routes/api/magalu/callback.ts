import { createFileRoute } from "@tanstack/react-router";
import { exchangeMagaluCode } from "@/lib/magalu.functions";

/**
 * Volta do consentimento do IDMagalu. `redirect_uri` registrado no client
 * (UUID `fe3df874-5759-4e43-8e94-7be72d49698d`) é exatamente
 * `https://babyworld.expede.workers.dev/api/magalu/callback` — qualquer
 * diferença de path ou barra final derruba o fluxo antes de chegar aqui.
 *
 * O `code` vale 10 minutos e é de uso único: se a troca falhar, não adianta
 * recarregar esta URL, tem de refazer o consentimento a partir de
 * `/api/magalu/auth`.
 */

function lerCookie(request: Request, nome: string): string | null {
  const bruto = request.headers.get("cookie");
  if (!bruto) return null;
  for (const parte of bruto.split(";")) {
    const [k, ...resto] = parte.trim().split("=");
    if (k === nome) return resto.join("=");
  }
  return null;
}

const COOKIE_EXPIRADO = "magalu_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

export const Route = createFileRoute("/api/magalu/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        const destino = `${origin}/configuracoes/marketplaces`;

        const redirecionar = (qs: string) =>
          new Response(null, {
            status: 302,
            headers: { Location: `${destino}?${qs}`, "Set-Cookie": COOKIE_EXPIRADO },
          });

        // O IDMagalu devolve `error`/`error_description` quando o seller recusa
        // o consentimento ou quando falta escopo.
        const erroOAuth = url.searchParams.get("error");
        if (erroOAuth) {
          const desc = url.searchParams.get("error_description") ?? "";
          console.error("[magalu-callback] consentimento recusado:", erroOAuth, desc);
          return redirecionar(`magalu=erro&msg=${encodeURIComponent(`${erroOAuth}: ${desc}`)}`);
        }

        const code = url.searchParams.get("code");
        if (!code) return redirecionar("magalu=erro&msg=sem_code");

        const stateRecebido = url.searchParams.get("state");
        const stateEsperado = lerCookie(request, "magalu_oauth_state");
        if (!stateEsperado || !stateRecebido || stateEsperado !== stateRecebido) {
          console.error("[magalu-callback] state não confere — fluxo não começou em /api/magalu/auth");
          return redirecionar("magalu=erro&msg=state_invalido");
        }

        try {
          await exchangeMagaluCode(code);
          return redirecionar("magalu=conectado");
        } catch (err) {
          console.error("[magalu-callback] erro:", err);
          const msg = encodeURIComponent(String(err instanceof Error ? err.message : err));
          return redirecionar(`magalu=erro&msg=${msg}`);
        }
      },
    },
  },
});
