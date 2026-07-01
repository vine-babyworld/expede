import { createFileRoute } from "@tanstack/react-router";
import { getShopeeAuthUrl } from "@/lib/shopee";

export const Route = createFileRoute("/api/shopee/auth")({
  server: {
    handlers: {
      GET: async () => {
        const url = await getShopeeAuthUrl();
        return Response.redirect(url, 302);
      },
    },
  },
});
