import { createFileRoute } from "@tanstack/react-router";
import {
  exchangeCodeAndStore,
  findLatestConnectionByState,
  updateBlingAccountNameInternal,
} from "@/lib/bling.functions";

export const Route = createFileRoute("/oauth/bling/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const errParam = url.searchParams.get("error");

        const redirect = (status: string, msg?: string) => {
          const target = new URL("/configuracoes/bling", url.origin);
          target.searchParams.set("status", status);
          if (msg) target.searchParams.set("message", msg);
          return new Response(null, { status: 302, headers: { Location: target.toString() } });
        };

        if (errParam) return redirect("error", errParam);
        if (!code || !state) return redirect("error", "Parâmetros ausentes");

        const result = await exchangeCodeAndStore({ code, state });
        if (!result.ok) return redirect("error", result.error);

        // Best-effort: atualizar nome real da empresa (não falha o fluxo se der erro)
        try {
          const connId = await findLatestConnectionByState(state);
          if (connId) await updateBlingAccountNameInternal(connId);
        } catch { /* ignore */ }

        return redirect("ok");
      },
    },
  },
});
