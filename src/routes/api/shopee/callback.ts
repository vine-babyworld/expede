import { createFileRoute } from "@tanstack/react-router";
import { exchangeShopeeCode } from "@/lib/shopee";

export const Route = createFileRoute("/api/shopee/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const shopId = url.searchParams.get("shop_id");

        if (!code || !shopId) {
          return Response.redirect(`${origin}/configuracoes/marketplaces?shopee=erro`, 302);
        }

        try {
          await exchangeShopeeCode(code, shopId);
          return Response.redirect(`${origin}/configuracoes/marketplaces?shopee=conectado`, 302);
        } catch (err) {
          console.error("[shopee-callback] erro:", err);
          const msg = encodeURIComponent(String(err instanceof Error ? err.message : err));
          return Response.redirect(`${origin}/configuracoes/marketplaces?shopee=erro&msg=${msg}`, 302);
        }
      },
    },
  },
});
