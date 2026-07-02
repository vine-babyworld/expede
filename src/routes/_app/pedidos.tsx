import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Search, ClipboardList, Printer, RefreshCw, Eye } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listarPedidos, buscarNumeroNF } from "@/lib/pedidos.functions";
import { buscarEtiquetaBling } from "@/lib/etiqueta.functions";
import { gerarDanfeCustom } from "@/lib/danfe.functions";
import { abrirEtiquetaPDF } from "@/lib/zpl-to-pdf";
import { useQzTray } from "@/hooks/useQzTray";
import { PrinterConfig } from "@/components/PrinterConfig";

const IMPRESSORA_KEY = "qztray_impressora_padrao";
const PAGE_SIZE = 50;

function SituacaoBadge({ situacaoId, mlShipmentStatus }: { situacaoId: number | null; mlShipmentStatus: string | null }) {
  if (mlShipmentStatus === "delivered")
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-600 text-white">Entregue</span>;
  if (mlShipmentStatus === "shipped")
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">A caminho</span>;
  if (situacaoId === 9)
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Faturado</span>;
  if (situacaoId === 12)
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">Cancelado</span>;
  if (situacaoId === 24)
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">Em andamento</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">Em aberto</span>;
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
  const year  = d.getUTCFullYear();
  const hour  = String(d.getUTCHours()).padStart(2, "0");
  const min   = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hour}:${min}`;
}

export const Route = createFileRoute("/_app/pedidos")({
  component: PedidosPage,
});

function PedidosPage() {
  const [search, setSearch] = useState("");
  const [hidecanceled, setHideCanceled] = useState(true);
  const [page, setPage] = useState(1);
  const [showPrinterConfig, setShowPrinterConfig] = useState(false);
  const [reimprimindo, setReimprimindo] = useState<string | null>(null);
  const [visualizando, setVisualizando] = useState<string | null>(null);

  const qzTray = useQzTray();
  const qc = useQueryClient();
  const listFn = useServerFn(listarPedidos);
  const buscarNumeroNFFn = useServerFn(buscarNumeroNF);

  const q = useQuery({
    queryKey: ["pedidos", search, hidecanceled, page],
    queryFn: () => listFn({ data: { search, hidecanceled, page } }),
  });

  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const pageSize = q.data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function handleSearch(value: string) { setSearch(value); setPage(1); }
  function handleToggle(checked: boolean) { setHideCanceled(checked); setPage(1); }

  function garantirNumeroNF(row: { id: string; bling_nota_fiscal_id: number | null; bling_nota_fiscal_numero: string | null }) {
    if (!row.bling_nota_fiscal_id || row.bling_nota_fiscal_numero) return;
    buscarNumeroNFFn({ data: { pedidoId: row.id, notaFiscalId: row.bling_nota_fiscal_id } })
      .then(({ numero }) => {
        if (numero) qc.invalidateQueries({ queryKey: ["pedidos"] });
      })
      .catch((err) => console.warn("[garantirNumeroNF]", err));
  }

  async function handleReimprimir(row: {
    id: string;
    bling_pedido_id: number;
    bling_nota_fiscal_id: number | null;
    bling_nota_fiscal_numero: string | null;
  }) {
    garantirNumeroNF(row);

    const impressora = localStorage.getItem(IMPRESSORA_KEY);
    if (!impressora) {
      setShowPrinterConfig(true);
      toast.info("Selecione uma impressora padrão primeiro");
      return;
    }

    setReimprimindo(row.id);
    toast.loading("Gerando documentos...", { id: "reimp" });

    // Busca etiqueta e DANFE em paralelo — falha de uma não cancela a outra
    const blingId = Number(row.bling_pedido_id);
    const [etiquetaSettled, danfeSettled] = await Promise.allSettled([
      blingId
        ? buscarEtiquetaBling({ data: { pedidoId: blingId } })
        : Promise.reject(new Error("bling_pedido_id ausente")),
      gerarDanfeCustom({ data: { pedidoId: row.id } }),
    ]);

    toast.loading("Imprimindo...", { id: "reimp" });

    // Etiqueta: opcional — erro apenas loga, nunca bloqueia a DANFE
    if (etiquetaSettled.status === "fulfilled") {
      const et = etiquetaSettled.value;
      if (et.ok && et.tipo === "zpl") {
        try {
          await qzTray.imprimirZpl(et.conteudo, impressora);
        } catch (err) {
          console.warn("[reimprimir] falha ao imprimir etiqueta:", err);
        }
      } else if (!et.ok) {
        console.warn("[reimprimir] etiqueta não disponível:", (et as any).error);
      }
    } else {
      console.warn("[reimprimir] etiqueta rejeitou:", etiquetaSettled.reason);
    }

    // DANFE: sempre imprime quando disponível
    if (danfeSettled.status === "fulfilled" && danfeSettled.value.ok) {
      try {
        await qzTray.imprimirPdf(danfeSettled.value.pdf, impressora);
        toast.success("DANFE impressa", { id: "reimp" });
      } catch (err) {
        console.error("[reimprimir] falha ao imprimir DANFE:", err);
        toast.error("Erro ao imprimir DANFE — verifique o QZ Tray", { id: "reimp" });
      }
    } else {
      const motivo =
        danfeSettled.status === "rejected"
          ? String(danfeSettled.reason)
          : (danfeSettled.value as any).error;
      console.warn("[reimprimir] DANFE não gerada:", motivo);
      toast.warning("DANFE não disponível", { id: "reimp" });
    }

    setReimprimindo(null);
  }

  async function handleVisualizar(row: {
    id: string;
    bling_pedido_id: number;
    etiqueta_zpl: string | null;
    bling_nota_fiscal_id: number | null;
    bling_nota_fiscal_numero: string | null;
  }) {
    garantirNumeroNF(row);
    setVisualizando(row.id);
    try {
      let zpl = row.etiqueta_zpl ?? null;
      if (!zpl) {
        const et = await buscarEtiquetaBling({ data: { pedidoId: Number(row.bling_pedido_id) } });
        if (et.ok && et.tipo === "zpl") zpl = et.conteudo;
        else { toast.error("Etiqueta não disponível"); return; }
      }
      await abrirEtiquetaPDF(zpl);
    } catch (err) {
      console.error("[visualizar]", err);
      toast.error("Erro ao renderizar etiqueta via Labelary");
    } finally {
      setVisualizando(null);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pedidos</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {total} pedido{total !== 1 ? "s" : ""}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowPrinterConfig(true)}
            title="Configurar impressora"
          >
            <Printer className="h-4 w-4" />
          </Button>
        </div>
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
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-muted-foreground">
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
                const isCanceled = row.situacao_id === 12;
                const isLoading = reimprimindo === row.id;
                const isVisualizando = visualizando === row.id;
                const jaImpresso = Boolean(row.etiqueta_zpl);
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
                      {formatDateTime(row.data_pedido)}
                    </td>
                    <td
                      className="px-4 py-3 max-w-[180px] truncate"
                      title={nomeCliente}
                    >
                      {nomeCliente}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatBRL(row.total)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {row.bling_nota_fiscal_numero ?? "—"}
                    </td>
                    <td className="px-4 py-3"><SituacaoBadge situacaoId={row.situacao_id} mlShipmentStatus={row.ml_shipment_status} /></td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {row.items_count}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isVisualizando || isCanceled}
                          onClick={() =>
                            handleVisualizar({
                              id: row.id,
                              bling_pedido_id: row.bling_pedido_id,
                              etiqueta_zpl: row.etiqueta_zpl,
                              bling_nota_fiscal_id: row.bling_nota_fiscal_id,
                              bling_nota_fiscal_numero: row.bling_nota_fiscal_numero,
                            })
                          }
                          title="Visualizar etiqueta como PDF"
                          className="gap-1.5 text-muted-foreground hover:text-foreground"
                        >
                          {isVisualizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                          Visualizar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isLoading}
                          onClick={() =>
                            handleReimprimir({
                              id: row.id,
                              bling_pedido_id: row.bling_pedido_id,
                              bling_nota_fiscal_id: row.bling_nota_fiscal_id,
                              bling_nota_fiscal_numero: row.bling_nota_fiscal_numero,
                            })
                          }
                          className="gap-1.5 text-muted-foreground hover:text-foreground"
                        >
                          {isLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : jaImpresso ? (
                            <RefreshCw className="h-4 w-4" />
                          ) : (
                            <Printer className="h-4 w-4" />
                          )}
                          {jaImpresso ? "Reimprimir" : "Imprimir"}
                        </Button>
                      </div>
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

      <PrinterConfig
        open={showPrinterConfig}
        onClose={() => setShowPrinterConfig(false)}
        qzTray={qzTray}
      />
    </div>
  );
}
