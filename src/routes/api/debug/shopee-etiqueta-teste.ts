import { createFileRoute } from "@tanstack/react-router";
import { refreshShopeeTokenIfNeeded, buscarEtiquetaShopee } from "@/lib/shopee";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Diagnóstico não-destrutivo: testa refresh de token + geração/download de
 * etiqueta Shopee sem nunca tocar em QZ Tray/impressora física. Espelha o
 * padrão de /api/debug/etiqueta-teste.ts (Bling). Usado pra achar/confirmar
 * a causa raiz do Erro #28 (ver 05 - Erros e Soluções.md) — mantido pra
 * diagnóstico futuro de qualquer novo problema na cadeia Shopee. `?raw=1`
 * devolve o PDF bruto em vez do JSON de diagnóstico (só quando ok=true).
 */
export const Route = createFileRoute("/api/debug/shopee-etiqueta-teste")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const orderSn = url.searchParams.get("orderSn");
        if (!orderSn) {
          return Response.json({ ok: false, error: "orderSn obrigatório (?orderSn=...)" }, { status: 400 });
        }

        const { data: conn, error: connErr } = await supabaseAdmin
          .from("shopee_connections")
          .select("shop_id, partner_id, is_sandbox, access_token_expires_at, refresh_token_expires_at, updated_at")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (connErr || !conn) {
          return Response.json(
            { ok: false, step: "lookup_connection", error: connErr?.message ?? "no_connection" },
            { status: 500 },
          );
        }

        let refreshed = false;
        let refreshError: string | null = null;
        try {
          await refreshShopeeTokenIfNeeded(conn.shop_id);
          refreshed = true;
        } catch (err) {
          refreshError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }

        const { data: connAfter } = await supabaseAdmin
          .from("shopee_connections")
          .select("access_token_expires_at, updated_at")
          .eq("shop_id", conn.shop_id)
          .maybeSingle();

        let etiquetaResult: unknown = null;
        let pdfBytes: Uint8Array | null = null;
        if (refreshed) {
          try {
            const r = await buscarEtiquetaShopee(orderSn);
            if (r.ok) {
              etiquetaResult = { ok: true, tipo: "pdf_base64", bytes: Math.round((r.conteudo.length * 3) / 4) };
              const binary = atob(r.conteudo);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              pdfBytes = bytes;
            } else {
              etiquetaResult = r;
            }
          } catch (err) {
            etiquetaResult = { ok: false, error: "exception", detail: err instanceof Error ? err.message : String(err) };
          }
        }

        const wantsRaw = url.searchParams.get("raw") === "1";
        if (wantsRaw && pdfBytes) {
          return new Response(new Blob([pdfBytes.slice().buffer]), {
            headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="etiqueta-${orderSn}.pdf"` },
          });
        }

        return Response.json({ orderSn, connBefore: conn, refresh: { refreshed, error: refreshError }, connAfter, etiquetaResult });
      },
    },
  },
});
