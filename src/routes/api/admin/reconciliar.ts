import { createFileRoute } from "@tanstack/react-router";
import { reconciliarPedidos } from "@/lib/pedidos.functions";

export const Route = createFileRoute("/api/admin/reconciliar")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        try {
          const resultado = await reconciliarPedidos();
          return Response.json({ ok: true, resultado });
        } catch (err) {
          console.error("[reconciliar-admin] erro:", err);
          return Response.json(
            { ok: false, error: String(err instanceof Error ? err.message : err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
