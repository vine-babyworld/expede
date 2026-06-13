import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getExpedidosHoje } from "@/lib/dashboard.functions";

export const Route = createFileRoute("/_app/expedidos-hoje")({
  component: ExpedidosHojePage,
});

function formatBRL(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  // Brasília = UTC-3: subtrai 3h manualmente para compatibilidade com CF Workers
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min  = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hour}:${min}`;
}

function marketplaceBadge(marketplace: string | null): { nome: string; cor: string } {
  if (marketplace === "shopee") return { nome: "Shopee", cor: "bg-orange-100 text-orange-800 border-orange-300" };
  if (marketplace === "mercadolivre") return { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300" };
  return { nome: marketplace ?? "—", cor: "bg-gray-100 text-gray-700 border-gray-300" };
}

function ExpedidosHojePage() {
  const navigate = useNavigate();
  const fn = useServerFn(getExpedidosHoje);

  const q = useQuery({
    queryKey: ["expedidos-hoje"],
    queryFn: () => fn(),
    refetchInterval: 60_000,
  });

  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/dashboard" })} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
          <h1 className="text-2xl font-semibold">Expedidos hoje</h1>
        </div>
        <span className="text-sm text-muted-foreground">
          {total} pedido{total !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Nº Pedido</th>
              <th className="text-left px-4 py-3 font-medium">Marketplace</th>
              <th className="text-left px-4 py-3 font-medium">Cliente</th>
              <th className="text-right px-4 py-3 font-medium">Valor</th>
              <th className="text-left px-4 py-3 font-medium">Horário</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-muted-foreground">
                  <PackageCheck className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  <p>Nenhum pedido expedido hoje</p>
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const marketplace = marketplaceBadge(p.marketplace);
                return (
                  <tr key={p.id} className="border-t hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono">{p.numero_loja}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${marketplace.cor}`}>
                        {marketplace.nome}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[220px] truncate" title={p.cliente_nome}>
                      {p.cliente_nome}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatBRL(p.valor_total)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatTime(p.printed_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
