import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Search, ClipboardList } from "lucide-react";
import { Input } from "@/components/ui/input";
import { getPedidosAExpedir, type PedidoAExpedir } from "@/lib/dashboard.functions";
import { isPedidoFlex } from "@/lib/pedidos.functions";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";

export const Route = createFileRoute("/_app/a-expedir")({
  component: AExpedirPage,
});

function SituacaoBadge({ situacaoId }: { situacaoId: number | null }) {
  if (situacaoId === 9)
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Faturado</span>;
  if (situacaoId === 6)
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">Em aberto</span>;
  if (situacaoId === 15)
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-100 text-teal-800">Atendido</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">Situação {situacaoId ?? "—"}</span>;
}

function detectarMarketplace(numeroLoja: string | null): { nome: string; cor: string } | null {
  if (!numeroLoja) return null;
  if (numeroLoja.startsWith("2000")) return { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300" };
  return { nome: "Outros", cor: "bg-gray-100 text-gray-700 border-gray-300" };
}

function formatBRL(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  // Brasília = UTC-3: subtrai 3h manualmente para compatibilidade com CF Workers
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  const day   = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hour  = String(d.getUTCHours()).padStart(2, "0");
  const min   = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}/${month} ${hour}:${min}`;
}

function matchesSearch(p: PedidoAExpedir, term: string): boolean {
  const nomeCliente = (p.cliente?.nome ?? p.cliente?.razaoSocial ?? "") as string;
  return (
    p.numero?.toLowerCase().includes(term) ||
    (p.numero_loja ?? "").toLowerCase().includes(term) ||
    nomeCliente.toLowerCase().includes(term)
  );
}

function AExpedirPage() {
  const [search, setSearch] = useState("");
  const fn = useServerFn(getPedidosAExpedir);

  const q = useQuery({
    queryKey: ["a-expedir"],
    queryFn: () => fn(),
    refetchInterval: 60_000,
  });

  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;

  const term = search.trim().toLowerCase();
  const filtered = term ? rows.filter((p) => matchesSearch(p, term)) : rows;

  const columns: ResponsiveColumn<PedidoAExpedir>[] = [
    {
      id: "numero", header: "Número", priority: "primary", className: "font-mono",
      cell: (p) => (
        <>
          {p.numero_loja ?? p.numero}
          {p.numero_loja && p.numero_loja !== p.numero && (
            <div className="text-xs text-muted-foreground">{p.numero}</div>
          )}
        </>
      ),
    },
    {
      id: "cliente", header: "Cliente", priority: "primary", className: "max-w-[180px] truncate",
      cell: (p) => p.cliente?.nome ?? p.cliente?.razaoSocial ?? "—",
    },
    {
      id: "marketplace", header: "Marketplace", priority: "secondary",
      cell: (p) => {
        const marketplace = detectarMarketplace(p.numero_loja);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {marketplace && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${marketplace.cor}`}>
                {marketplace.nome}
              </span>
            )}
            {isPedidoFlex(p) && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-yellow-100 text-yellow-800 border-yellow-300">
                FLEX
              </span>
            )}
          </div>
        );
      },
    },
    { id: "situacao", header: "Situação", priority: "secondary", cell: (p) => <SituacaoBadge situacaoId={p.situacao_id} /> },
    {
      id: "logistica", header: "Logística", priority: "secondary", className: "text-muted-foreground",
      cell: (p) => (p.raw_json as any)?.transporte?.volumes?.[0]?.servico ?? "—",
    },
    { id: "data", header: "Data", priority: "secondary", className: "text-muted-foreground", cell: (p) => formatDateTime(p.data_pedido) },
    { id: "total", header: "Total", priority: "secondary", align: "right", className: "tabular-nums", cell: (p) => formatBRL(p.total) },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">A expedir</h1>
        <span className="text-sm text-muted-foreground">
          {total} pedido{total !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="relative w-full md:w-64">
        <label htmlFor="busca-a-expedir" className="sr-only">Buscar por número ou cliente</label>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          id="busca-a-expedir"
          placeholder="Buscar por número ou cliente..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-11 md:h-9"
        />
      </div>

      <div className="md:border md:rounded-lg md:overflow-hidden">
        <ResponsiveTable
          columns={columns}
          rows={filtered}
          rowKey={(p) => p.id}
          loading={q.isLoading}
          empty={
            <>
              <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p>Nenhum pedido encontrado</p>
            </>
          }
        />
      </div>
    </div>
  );
}
