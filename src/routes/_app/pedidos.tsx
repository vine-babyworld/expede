import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Search, ClipboardList, Printer, RefreshCw, Eye } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listarPedidos, buscarNumeroNF, type PedidoRow } from "@/lib/pedidos.functions";
import { buscarEtiquetaBling } from "@/lib/etiqueta.functions";
import { gerarDanfeCustom } from "@/lib/danfe.functions";
import { abrirEtiquetaPDF } from "@/lib/zpl-to-pdf";
import { useQzTray } from "@/hooks/useQzTray";
import { PrinterConfig } from "@/components/PrinterConfig";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";
import { MobileHidden } from "@/components/MobileHidden";
import { RepasseDialog } from "@/components/RepasseDialog";

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

function EmissaoNfBadge({ status, error }: { status: string | null; error: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;

  const config: Record<string, { label: string; className: string }> = {
    pending: { label: "Pendente", className: "bg-yellow-100 text-yellow-800" },
    processing: { label: "Emitindo", className: "bg-blue-100 text-blue-800" },
    created: { label: "NF criada", className: "bg-indigo-100 text-indigo-800" },
    sent: { label: "Enviada", className: "bg-green-100 text-green-800" },
    retry: { label: "Tentar novamente", className: "bg-orange-100 text-orange-800" },
    blocked: { label: "Bloqueada", className: "bg-red-100 text-red-800" },
    manual: { label: "Manual (Flex)", className: "bg-gray-100 text-gray-700" },
  };
  const item = config[status] ?? { label: status, className: "bg-gray-100 text-gray-700" };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${item.className}`}
      title={error ?? undefined}
    >
      {item.label}
    </span>
  );
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
  const [repassePedido, setRepassePedido] = useState<PedidoRow | null>(null);

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

    // Etiqueta: opcional — erro nunca bloqueia a DANFE, mas precisa avisar o operador
    // (pedido marcado como impresso sem etiqueta some da fila sem deixar rastro — Lição #18)
    let etiquetaOk = false;
    if (etiquetaSettled.status === "fulfilled") {
      const et = etiquetaSettled.value;
      if (et.ok && et.tipo === "zpl") {
        try {
          await qzTray.imprimirZpl(et.conteudo, impressora);
          etiquetaOk = true;
        } catch (err) {
          console.warn("[reimprimir] falha ao imprimir etiqueta:", err);
        }
      } else if (et.ok && et.tipo === "pdf_base64") {
        try {
          await qzTray.imprimirPdf(et.conteudo, impressora);
          etiquetaOk = true;
        } catch (err) {
          console.warn("[reimprimir] falha ao imprimir etiqueta PDF:", err);
        }
      } else if (!et.ok) {
        console.warn("[reimprimir] etiqueta não disponível:", (et as any).error);
      }
    } else {
      console.warn("[reimprimir] etiqueta rejeitou:", etiquetaSettled.reason);
    }

    if (!etiquetaOk) {
      toast.warning("Etiqueta de transporte não impressa", { id: "etiqueta-falha", duration: 8000 });
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

  const columns: ResponsiveColumn<PedidoRow>[] = [
    {
      id: "numero",
      header: "Número",
      priority: "primary",
      className: "font-mono",
      cell: (row) => (
        <>
          <button
            type="button"
            onClick={() => setRepassePedido(row)}
            className="hover:underline underline-offset-2 text-left inline-flex items-center min-h-11 min-w-11 md:inline md:min-h-0 md:min-w-0"
            title="Ver repasse do marketplace"
          >
            {row.numero}
          </button>
          {row.numero_loja && row.numero_loja !== row.numero && (
            <span className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {row.numero_loja}
            </span>
          )}
        </>
      ),
    },
    {
      id: "data",
      header: "Data",
      priority: "secondary",
      className: "text-muted-foreground",
      cell: (row) => formatDateTime(row.data_pedido),
    },
    {
      id: "cliente",
      header: "Cliente",
      priority: "primary",
      className: "max-w-[180px] truncate",
      cell: (row) =>
        (row.cliente as any)?.nome ?? (row.cliente as any)?.razaoSocial ?? "—",
    },
    {
      id: "total",
      header: "Total",
      priority: "secondary",
      align: "right",
      className: "tabular-nums",
      cell: (row) => formatBRL(row.total),
    },
    {
      id: "nf",
      header: "NF",
      priority: "secondary",
      className: "font-mono text-xs",
      cell: (row) => row.bling_nota_fiscal_numero ?? "—",
    },
    {
      id: "emissao",
      header: "Emissão NF",
      priority: "secondary",
      cell: (row) => <EmissaoNfBadge status={row.nf_emissao_status} error={row.nf_emissao_error} />,
    },
    {
      id: "situacao",
      header: "Situação",
      priority: "secondary",
      cell: (row) => (
        <SituacaoBadge situacaoId={row.situacao_id} mlShipmentStatus={row.ml_shipment_status} />
      ),
    },
    {
      id: "itens",
      header: "Itens",
      priority: "secondary",
      align: "right",
      className: "text-muted-foreground",
      cell: (row) => row.items_count,
    },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Pedidos</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {total} pedido{total !== 1 ? "s" : ""}
          </span>
          <MobileHidden>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setShowPrinterConfig(true)}
              aria-label="Configurar impressora"
              title="Configurar impressora"
            >
              <Printer className="h-4 w-4" />
            </Button>
          </MobileHidden>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
        <div className="relative w-full md:w-64">
          <label htmlFor="busca-pedidos" className="sr-only">Buscar pedido por número</label>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            id="busca-pedidos"
            placeholder="Buscar por número..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9 h-11 md:h-9"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium min-h-11 md:min-h-0">
          <input
            type="checkbox"
            className="h-5 w-5 md:h-4 md:w-4 rounded border-gray-300"
            checked={hidecanceled}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          Ocultar cancelados
        </label>
      </div>

      {/* Tabela */}
      <div className="md:border md:rounded-lg md:overflow-hidden">
        <ResponsiveTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={q.isLoading}
          rowClassName={(row) => (row.situacao_id === 12 ? "opacity-50" : "")}
          empty={
            <>
              <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p>Nenhum pedido encontrado</p>
            </>
          }
          rowActions={(row) => {
            const isCanceled = row.situacao_id === 12;
            const isLoading = reimprimindo === row.id;
            const isVisualizando = visualizando === row.id;
            const jaImpresso = Boolean(row.etiqueta_zpl);
            return (
              <>
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
              </>
            );
          }}
        />
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm text-muted-foreground">
          <span>
            Página {page} de {totalPages} — {total} pedido{total !== 1 ? "s" : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 md:flex-none h-11 md:h-8"
              disabled={page <= 1 || q.isLoading} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <Button variant="outline" size="sm" className="flex-1 md:flex-none h-11 md:h-8"
              disabled={page >= totalPages || q.isLoading} onClick={() => setPage((p) => p + 1)}>
              Próxima
            </Button>
          </div>
        </div>
      )}

      <RepasseDialog pedido={repassePedido} onClose={() => setRepassePedido(null)} />

      <MobileHidden>
        <PrinterConfig open={showPrinterConfig} onClose={() => setShowPrinterConfig(false)} qzTray={qzTray} />
      </MobileHidden>
    </div>
  );
}
