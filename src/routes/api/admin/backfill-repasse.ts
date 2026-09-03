import { createFileRoute } from "@tanstack/react-router";
import { backfillRepasseMl } from "@/lib/repasse.functions";

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

        try {
          const resultado = await backfillRepasseMl(limite);
          return Response.json({ ok: true, resultado });
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
