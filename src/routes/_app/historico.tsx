import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronLeft,
  ChevronRight,
  PackageCheck,
  Printer,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getHistorico, HISTORICO_LIMIT, type HistoricoRow } from "@/lib/dashboard.functions";
import { isPedidoFlex, nfNaoAutorizada, nfSituacaoLabel } from "@/lib/pedidos.functions";
import { buscarEtiquetaBling } from "@/lib/etiqueta.functions";
import { gerarDanfeCustom } from "@/lib/danfe.functions";
import { useQzTray } from "@/hooks/useQzTray";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";

export const Route = createFileRoute("/_app/historico")({
  component: HistoricoPage,
});

const IMPRESSORA_KEY = "qztray_impressora_padrao";

const MARKETPLACE_OPTIONS = [
  { value: "todos", label: "Todos os marketplaces" },
  { value: "mercadolivre", label: "Mercado Livre" },
  { value: "mercadolivreflex", label: "ML Flex" },
  { value: "shopee", label: "Shopee" },
  { value: "amazon", label: "Amazon" },
] as const;

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

function marketplaceBadge(marketplace: string | null): { nome: string; cor: string } {
  if (marketplace === "shopee") return { nome: "Shopee", cor: "bg-orange-100 text-orange-800 border-orange-300" };
  if (marketplace === "mercadolivre" || marketplace === "mercadolivreflex") {
    return { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300" };
  }
  if (marketplace === "amazon") return { nome: "Amazon", cor: "bg-gray-100 text-gray-700 border-gray-300" };
  return { nome: marketplace ?? "—", cor: "bg-gray-100 text-gray-700 border-gray-300" };
}

function formatBRL(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function HistoricoPage() {
  const [page, setPage] = useState(1);
  const [busca, setBusca] = useState("");
  const [buscaDebounced, setBuscaDebounced] = useState("");
  const [marketplace, setMarketplace] = useState("todos");
  const fn = useServerFn(getHistorico);
  const qzTray = useQzTray();

  useEffect(() => {
    const t = setTimeout(() => {
      setBuscaDebounced(busca.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [busca]);

  const { data, isLoading } = useQuery({
    queryKey: ["historico", page, buscaDebounced, marketplace],
    queryFn: () =>
      fn({
        data: {
          page,
          busca: buscaDebounced,
          marketplace: marketplace === "todos" ? undefined : marketplace,
        },
      }),
  });

  const rows: HistoricoRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / HISTORICO_LIMIT));

  const handleReimprimir = useCallback(
    async (pedido: HistoricoRow) => {
      const impressora = localStorage.getItem(IMPRESSORA_KEY);
      if (!impressora) {
        toast.info("Selecione uma impressora padrão nas Configurações de impressão");
        return;
      }

      const isFlex = isPedidoFlex(pedido);
      const semNf = !pedido.bling_nota_fiscal_id;

      if (!isFlex && semNf) {
        toast.warning("Pedido sem NF — impressão de DANFE indisponível");
        return;
      }
      if (!isFlex && nfNaoAutorizada(pedido)) {
        toast.warning(`NF não autorizada (${nfSituacaoLabel(pedido.nf_situacao)}) — corrija no Bling antes de reimprimir`);
        return;
      }

      // FLEX sem NF: só etiqueta
      if (isFlex && semNf) {
        const blingId = Number(pedido.bling_pedido_id);
        if (!blingId) { toast.warning("Pedido sem ID Bling"); return; }
        toast.loading("Buscando etiqueta FLEX...", { id: "reprint" });
        try {
          const et = await buscarEtiquetaBling({ data: { pedidoId: blingId } });
          if (et.ok && et.tipo === "zpl") {
            await qzTray.imprimirZpl(et.conteudo, impressora);
            toast.success("Etiqueta reimprimida", { id: "reprint" });
          } else {
            toast.warning("Etiqueta FLEX não disponível", { id: "reprint" });
          }
        } catch {
          toast.error("Erro ao reimprimir — verifique o QZ Tray", { id: "reprint" });
        }
        return;
      }

      toast.loading("Gerando documentos...", { id: "reprint" });
      const blingId = Number(pedido.bling_pedido_id);
      const [etiquetaSettled, danfeSettled] = await Promise.allSettled([
        blingId
          ? buscarEtiquetaBling({ data: { pedidoId: blingId } })
          : Promise.reject(new Error("sem bling_pedido_id")),
        gerarDanfeCustom({ data: { pedidoId: pedido.id } }),
      ]);

      toast.loading("Imprimindo...", { id: "reprint" });

      // (pedido marcado como impresso sem etiqueta some da fila sem deixar rastro — Lição #18)
      let etiquetaOk = false;
      if (etiquetaSettled.status === "fulfilled") {
        const et = etiquetaSettled.value;
        if (et.ok && et.tipo === "zpl") {
          try {
            await qzTray.imprimirZpl(et.conteudo, impressora);
            etiquetaOk = true;
          } catch (err) {
            console.warn("[reprint] etiqueta:", err);
          }
        } else if (et.ok && et.tipo === "pdf_base64") {
          try {
            await qzTray.imprimirPdf(et.conteudo, impressora);
            etiquetaOk = true;
          } catch (err) {
            console.warn("[reprint] etiqueta PDF:", err);
          }
        } else if (!et.ok) {
          console.warn("[reprint] etiqueta não disponível:", (et as any).error);
        }
      } else {
        console.warn("[reprint] etiqueta rejeitou:", etiquetaSettled.reason);
      }

      if (!etiquetaOk) {
        toast.warning("Etiqueta de transporte não impressa", { id: "etiqueta-falha", duration: 8000 });
      }

      if (danfeSettled.status === "fulfilled" && danfeSettled.value.ok) {
        try {
          await qzTray.imprimirPdf(danfeSettled.value.pdf, impressora);
          toast.success("DANFE reimprimida", { id: "reprint" });
        } catch {
          toast.error("Erro ao reimprimir DANFE — verifique o QZ Tray", { id: "reprint" });
        }
      } else {
        const motivo =
          danfeSettled.status === "rejected"
            ? String((danfeSettled as any).reason)
            : (danfeSettled.value as any).error;
        console.warn("[reprint] DANFE:", motivo);
        toast.warning("DANFE não disponível", { id: "reprint" });
      }
    },
    [qzTray],
  );

  type Row = HistoricoRow;

  const columns: ResponsiveColumn<Row>[] = [
    {
      id: "numero",
      header: "Nº Pedido",
      priority: "primary",
      cell: (p) => (
        <>
          <span className="font-mono text-xs md:text-xs">{p.numero_loja ?? p.numero}</span>
          {p.numero_loja && (
            <span className="block text-xs md:text-[11px] text-muted-foreground">Bling #{p.numero}</span>
          )}
        </>
      ),
    },
    {
      id: "marketplace",
      header: "Marketplace",
      priority: "secondary",
      cell: (p) => {
        const badge = marketplaceBadge(p.marketplace);
        return (
          <div className="flex flex-wrap gap-1.5">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${badge.cor}`}>
              {badge.nome}
            </span>
            {isPedidoFlex(p) && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-yellow-100 text-yellow-800 border-yellow-300">
                FLEX
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: "cliente",
      header: "Cliente",
      priority: "primary",
      className: "max-w-[200px] truncate",
      cell: (p) => p.cliente_nome,
    },
    {
      id: "valor",
      header: "Valor",
      priority: "secondary",
      align: "right",
      className: "tabular-nums",
      cell: (p) => formatBRL(p.valor_total),
    },
    {
      id: "expedido",
      header: "Expedido em",
      priority: "secondary",
      className: "text-muted-foreground",
      cell: (p) => formatDateTime(p.printed_at),
    },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Histórico de Expedição</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Pedidos expedidos nos últimos 30 dias</p>
        </div>
        <span className="text-sm text-muted-foreground">
          {total} pedido{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Filtros */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative w-full md:max-w-sm">
          <label htmlFor="busca-historico" className="sr-only">Buscar por número, nº da loja ou cliente</label>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            id="busca-historico"
            placeholder="Buscar por número, nº da loja ou cliente..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="pl-9 pr-9 h-11 md:h-9"
          />
          {busca && (
            <button
              onClick={() => setBusca("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 flex h-11 w-11 md:h-8 md:w-8 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label="Limpar busca"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <Select value={marketplace} onValueChange={(value) => { setMarketplace(value); setPage(1); }}>
          <SelectTrigger className="w-full md:w-[220px] h-11 md:h-9" aria-label="Filtrar por marketplace">
            <SelectValue placeholder="Marketplace" />
          </SelectTrigger>
          <SelectContent>
            {MARKETPLACE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="min-h-11 md:min-h-0">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tabela */}
      <div className="md:border md:rounded-lg md:overflow-hidden">
        <ResponsiveTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={isLoading}
          empty={
            <>
              <PackageCheck className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p>
                {buscaDebounced || marketplace !== "todos"
                  ? "Nenhum pedido encontrado com esses filtros"
                  : "Nenhum pedido expedido nos últimos 30 dias"}
              </p>
            </>
          }
          rowActions={(p) => (
            <Button variant="outline" size="sm" onClick={() => handleReimprimir(p)} className="gap-1.5">
              <Printer className="h-3.5 w-3.5" />
              Reimprimir
            </Button>
          )}
        />
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || isLoading}
            className="gap-1.5 h-11 md:h-8"
          >
            <ChevronLeft className="h-4 w-4" />
            Anterior
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {page} de {totalPages} ({total} pedidos)
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || isLoading}
            className="gap-1.5 h-11 md:h-8"
          >
            Próxima
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
