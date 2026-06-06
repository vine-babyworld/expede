import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ShoppingCart, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getMLConnection } from "@/lib/ml.functions";
import { getDashboardExpedicao } from "@/lib/dashboard.functions";

export const Route = createFileRoute("/_app/configuracoes/marketplaces")({
  component: MarketplacesPage,
});

function fmtExpira(iso?: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "expirado";
  const h = Math.floor(diff / 3600_000);
  const min = Math.floor((diff % 3600_000) / 60_000);
  return h > 0 ? `expira em ${h}h ${min}min` : `expira em ${min}min`;
}

function MarketplacesPage() {
  const mlFn = useServerFn(getMLConnection);
  const expFn = useServerFn(getDashboardExpedicao);

  const mlQ = useQuery({ queryKey: ["ml-connection"], queryFn: () => mlFn(), refetchInterval: 60_000 });
  const expQ = useQuery({ queryKey: ["dash-expedicao"], queryFn: () => expFn(), refetchInterval: 60_000 });

  return (
    <div className="space-y-4">
      {/* Mercado Livre */}
      <div className="bg-card border rounded-xl shadow-sm p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <ShoppingCart className="h-6 w-6 text-yellow-500" />
            <div>
              <h2 className="text-base font-semibold">Mercado Livre</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Autenticação para importação de pedidos e etiquetas de transporte.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { window.location.href = "/api/ml/auth"; }}
          >
            <Plug className="h-4 w-4 mr-2" />
            Reconectar
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {mlQ.isLoading ? (
            <div className="h-6 w-48 bg-muted rounded animate-pulse" />
          ) : mlQ.data?.connected ? (
            <>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-700 border-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Conectado · user {mlQ.data.ml_user_id}
              </span>
              <span className="text-xs text-muted-foreground">{fmtExpira(mlQ.data.expires_at)}</span>
              {!expQ.isLoading && expQ.data != null && (
                <span className="text-xs text-muted-foreground">
                  · {expQ.data.totalHoje} pedido{expQ.data.totalHoje !== 1 ? "s" : ""} hoje
                </span>
              )}
            </>
          ) : (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border bg-red-100 text-red-700 border-red-200">
              Desconectado
            </span>
          )}
        </div>
      </div>

      {/* Shopee placeholder */}
      <div className="bg-card border rounded-xl shadow-sm p-6 opacity-60">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 rounded bg-orange-200 flex items-center justify-center text-orange-700 text-xs font-bold shrink-0">
              S
            </div>
            <div>
              <h2 className="text-base font-semibold">Shopee</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Integração Shopee disponível em breve.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 border border-gray-200">
              Em breve
            </span>
            <Button size="sm" disabled>
              <Plug className="h-4 w-4 mr-2" /> Conectar
            </Button>
          </div>
        </div>
      </div>

      {/* Amazon placeholder */}
      <div className="bg-card border rounded-xl shadow-sm p-6 opacity-60">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 rounded bg-amber-200 flex items-center justify-center text-amber-700 text-xs font-bold shrink-0">
              A
            </div>
            <div>
              <h2 className="text-base font-semibold">Amazon</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Integração Amazon disponível em breve.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 border border-gray-200">
              Em breve
            </span>
            <Button size="sm" disabled>
              <Plug className="h-4 w-4 mr-2" /> Conectar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
