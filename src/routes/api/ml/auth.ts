import { createFileRoute } from "@tanstack/react-router";
import { getMLAuthUrl } from "@/lib/ml.functions";

export const Route = createFileRoute("/api/ml/auth")({
  server: {
    handlers: {
      GET: async () => {
        const url = getMLAuthUrl();
        return Response.redirect(url, 302);
      },
    },
  },
});
