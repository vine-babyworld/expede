import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Search, ClipboardList } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listarPedidos } from "@/lib/pedidos.functions";

// TODO: verificar todos os valores da Bling API v3 para pedidos/vendas e completar mapa
const SITUACAO_LABEL: Record<number, string> = {
  6:  "Em aberto",
  9:  "Atendido",
  12: "Cancelado",
};

function situacaoLabel(valor: number | null): string {
  if (valor === null) return "—";
  return SITUACAO_LABEL[valor] ?? String(valor);
}

function formatBRL(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR");
}

export const Route = createFileRoute("/_app/pedidos")({
  component: PedidosPage,
});

function PedidosPage() {
  const [search, setSearch] = useState("");
  const [hidecanceled, setHideCanceled] = useState(true);
  const [page, setPage] = useState(1);

  const listFn = useServerFn(listarPedidos);

  const q = useQuery({
    queryKey: ["pedidos", search, hidecanceled, page],
    queryFn: () => listFn({ data: { search, hidecanceled, page } }),
  });

  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const pageSize = q.data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function handleSearch(value: string) {
    setSearch(value);
    setPage(1);
  }

  function handleToggle(checked: boolean) {
    setHideCanceled(checked);
    setPage(1);
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pedidos</h1>
        <span className="text-sm text-muted-foreground">
          {total} pedido{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-4">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por número..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300"
            checked={hidecanceled}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          Ocultar cancelados
        </label>
      </div>

      {/* Tabela */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Número</th>
              <th className="text-left px-4 py-3 font-medium">Data</th>
              <th className="text-left px-4 py-3 font-medium">Cliente</th>
              <th className="text-right px-4 py-3 font-medium">Total</th>
              <th className="text-left px-4 py-3 font-medium">NF</th>
              <th className="text-left px-4 py-3 font-medium">Situação</th>
              <th className="text-right px-4 py-3 font-medium">Itens</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground">
                  <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  <p>Nenhum pedido encontrado</p>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const nomeCliente =
                  (row.cliente as any)?.nome ??
                  (row.cliente as any)?.razaoSocial ??
                  "—";
                const isCanceled = row.situacao_valor === 12;
                return (
                  <tr
                    key={row.id}
                    className={`border-t transition-colors ${
                      isCanceled ? "opacity-50" : "hover:bg-muted/30"
                    }`}
                  >
                    <td className="px-4 py-3 font-mono">
                      {row.numero}
                      {row.numero_loja && row.numero_loja !== row.numero && (
                        <span className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {row.numero_loja}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(row.data_pedido)}
                    </td>
                    <td className="px-4 py-3 max-w-[200px] truncate" title={nomeCliente}>
                      {nomeCliente}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatBRL(row.total)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {row.bling_nota_fiscal_numero ?? "—"}
                    </td>
                    <td className="px-4 py-3">{situacaoLabel(row.situacao_valor)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {row.items_count}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Página {page} de {totalPages} — {total} pedido{total !== 1 ? "s" : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || q.isLoading}
              onClick={() => setPage((p) => p - 1)}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || q.isLoading}
              onClick={() => setPage((p) => p + 1)}
            >
              Próxima
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;
