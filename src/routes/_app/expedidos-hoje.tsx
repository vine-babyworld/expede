import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getExpedidosHoje } from "@/lib/dashboard.functions";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";

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

  const columns: ResponsiveColumn<(typeof rows)[number]>[] = [
    { id: "numero", header: "Nº Pedido", priority: "primary", className: "font-mono", cell: (p) => p.numero_loja },
    {
      id: "marketplace", header: "Marketplace", priority: "secondary",
      cell: (p) => {
        const m = marketplaceBadge(p.marketplace);
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${m.cor}`}>
            {m.nome}
          </span>
        );
      },
    },
    { id: "cliente", header: "Cliente", priority: "primary", className: "max-w-[220px] truncate", cell: (p) => p.cliente_nome },
    { id: "valor", header: "Valor", priority: "secondary", align: "right", className: "tabular-nums", cell: (p) => formatBRL(p.valor_total) },
    { id: "horario", header: "Horário", priority: "secondary", className: "text-muted-foreground", cell: (p) => formatTime(p.printed_at) },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/dashboard" })} className="gap-2 h-11 md:h-8">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
          <h1 className="text-2xl font-semibold">Expedidos hoje</h1>
        </div>
        <span className="text-sm text-muted-foreground">
          {total} pedido{total !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="md:border md:rounded-lg md:overflow-hidden">
        <ResponsiveTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={q.isLoading}
          empty={
            <>
              <PackageCheck className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p>Nenhum pedido expedido hoje</p>
            </>
          }
        />
      </div>
    </div>
  );
}
