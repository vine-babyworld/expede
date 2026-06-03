import { createFileRoute } from "@tanstack/react-router";
import { exchangeMLCode } from "@/lib/ml.functions";

export const Route = createFileRoute("/api/ml/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const code = new URL(request.url).searchParams.get("code");

        if (!code) {
          return Response.redirect(`${origin}/configuracoes/bling?ml=erro`, 302);
        }

        try {
          await exchangeMLCode(code);
          return Response.redirect(`${origin}/configuracoes/bling?ml=conectado`, 302);
        } catch (err) {
          console.error("[ml-callback] erro:", err);
          const msg = encodeURIComponent(String(err instanceof Error ? err.message : err));
          return Response.redirect(`${origin}/configuracoes/bling?ml=erro&msg=${msg}`, 302);
        }
      },
    },
  },
});
