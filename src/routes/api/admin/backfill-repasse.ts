import { createFileRoute } from "@tanstack/react-router";
import { backfillRepasse } from "@/lib/repasse.functions";

export const Route = createFileRoute("/api/admin/backfill-repasse")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const limiteParam = Number(url.searchParams.get("limite") ?? "40");
        const limite =
          Number.isFinite(limiteParam) && limiteParam > 0 ? Math.min(limiteParam, 100) : 40;

        const marketplaceParam = url.searchParams.get("marketplace") ?? "mercadolivre";
        if (marketplaceParam !== "mercadolivre" && marketplaceParam !== "shopee") {
          return Response.json(
            { ok: false, error: "marketplace deve ser mercadolivre ou shopee" },
            { status: 400 },
          );
        }

        try {
          const resultado = await backfillRepasse(marketplaceParam, limite);
          return Response.json({ ok: true, marketplace: marketplaceParam, resultado });
        } catch (err) {
          console.error("[backfill-repasse] erro:", err);
          return Response.json(
            { ok: false, error: String(err instanceof Error ? err.message : err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
