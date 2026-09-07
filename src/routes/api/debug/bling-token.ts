import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";

/**
 * Token Bling em texto plano para o import local (scripts/sync-produtos-local.mjs),
 * que roda do IP residencial porque o WAF do Bling bloqueia IPs de datacenter.
 *
 * GET                       → token da conexão mais antiga conectada (compatibilidade)
 * GET ?listar=1             → lista as conexões conectadas, sem nenhum token
 * GET ?connection_id=<uuid> → token daquela conexão específica
 *
 * Em todos os casos o token vem de getDecryptedAccessToken, que renova sozinho
 * quando está expirado (ou a menos de 60s disso).
 */
export const Route = createFileRoute("/api/debug/bling-token")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = request.headers.get("X-Admin-Key");
        const expected = process.env.ADMIN_KEY;
        if (!expected || key !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const params = new URL(request.url).searchParams;

        // ── Listagem: nenhum token é devolvido aqui ──────────────────────────
        if (params.get("listar")) {
          const { data, error } = await supabaseAdmin
            .from("bling_connections")
            .select("id, bling_account_name, access_expires_at")
            .eq("status", "connected")
            .order("created_at", { ascending: true });
          if (error) {
            return Response.json({ ok: false, error: error.message }, { status: 500 });
          }
          return Response.json({
            connections: (data ?? []).map((c: any) => ({
              id: c.id,
              nome: c.bling_account_name ?? null,
              expira_em: c.access_expires_at ?? null,
            })),
          });
        }

        // ── Seleção da conexão ───────────────────────────────────────────────
        const pedida = params.get("connection_id");
        const query = supabaseAdmin
          .from("bling_connections")
          .select("id, bling_account_name, access_expires_at");

        const { data: conn } = pedida
          ? await query.eq("id", pedida).maybeSingle()
          : await query
              .eq("status", "connected")
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();

        if (!conn) {
          return Response.json(
            {
              ok: false,
              error: pedida
                ? `conexão Bling ${pedida} não encontrada`
                : "nenhuma conexão Bling ativa",
            },
            { status: 404 },
          );
        }

        try {
          const access_token = await getDecryptedAccessToken(conn.id);
          return Response.json({
            access_token,
            connection_id: conn.id,
            nome: (conn as any).bling_account_name ?? null,
            expira_em: conn.access_expires_at ?? null,
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: String(err instanceof Error ? err.message : err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
