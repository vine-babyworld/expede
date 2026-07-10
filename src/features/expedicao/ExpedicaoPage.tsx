import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Search,
  X,
  CheckCircle2,
  XCircle,
  Settings,
  Printer,
  Loader2,
  Package,
  PackageOpen,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { playBeep } from "./beep";
import { registrarBipagem } from "@/lib/bipagem.functions";
import { buscarEtiquetaBling } from "@/lib/etiqueta.functions";
import { gerarDanfeCustom } from "@/lib/danfe.functions";
import { isPedidoFlex, marcarPedidoImpresso } from "@/lib/pedidos.functions";
import { useQzTray } from "@/hooks/useQzTray";
import { PrinterConfig } from "@/components/PrinterConfig";

const IMPRESSORA_KEY = "qztray_impressora_padrao";

// ─── Tipos ───────────────────────────────────────────────────────────────────

type ItemExpedicao = {
  id: string;
  sku: string | null;
  ean: string | null;
  descricao: string;
  quantidade: number;
  quantidade_bipada: number;
  produto_gtin: string | null;
  produto: { imagem_url: string | null; gtin: string | null } | null;
};

type PedidoExpedicao = {
  id: string;
  bling_pedido_id: number;
  numero: string;
  numero_loja: string | null;
  marketplace: string | null;
  data_pedido: string | null;
  cliente: { nome?: string; razaoSocial?: string } | null;
  bling_nota_fiscal_id: number | null;
  bling_nota_fiscal_numero: string | null;
  situacao_valor: number | null;
  raw_json: any;
  itens: ItemExpedicao[];
  printed_at: string | null;
  bling_divergente: boolean;
  ml_shipment_status: string | null;
};

function pedidoProgress(p: PedidoExpedicao) {
  const total = p.itens.reduce((s, i) => s + i.quantidade, 0);
  const bipado = p.itens.reduce((s, i) => s + i.quantidade_bipada, 0);
  return { total, bipado, done: total > 0 && bipado >= total };
}

function nomeCliente(p: PedidoExpedicao): string {
  return p.cliente?.nome ?? p.cliente?.razaoSocial ?? "—";
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

// Retorna "YYYY-MM-DD" do dia atual em Brasília (UTC-3), sem Intl/timeZone nomeado
function hoje(): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day   = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type CategoriaData = "hoje" | "proximos" | "atrasado" | null;

function categoriaDataPrevista(rawJson: any): CategoriaData {
  const dataPrevista: string | null = rawJson?.dataPrevista ?? null;
  if (!dataPrevista) return null;
  const hj = hoje();
  if (dataPrevista === hj) return "hoje";
  if (dataPrevista > hj) return "proximos";
  return "atrasado";
}

type BadgeExpedicao = { label: string; cor: string } | null;

function badgeDataPrevista(rawJson: any): BadgeExpedicao {
  const categoria = categoriaDataPrevista(rawJson);
  if (categoria === "hoje") {
    return { label: "Hoje", cor: "bg-green-100 text-green-800 border-green-300" };
  }
  if (categoria === "proximos") {
    return { label: "Próximos dias", cor: "bg-gray-100 text-gray-600 border-gray-300" };
  }
  if (categoria === "atrasado") {
    return { label: "Atrasado", cor: "bg-red-100 text-red-700 border-red-300" };
  }
  return null;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPedidos(): Promise<PedidoExpedicao[]> {
  const { data, error } = await supabase
    .from("pedidos")
    .select(
      "id, bling_pedido_id, numero, numero_loja, data_pedido, cliente, bling_nota_fiscal_id, bling_nota_fiscal_numero, situacao_id, situacao_valor, marketplace, raw_json, printed_at, bling_divergente, ml_shipment_status, pedido_itens(id, sku, ean, descricao, quantidade, quantidade_bipada, produto:produtos(imagem_url, gtin))",
    )
    .is("printed_at", null)
    .neq("situacao_id", 12)
    .eq("arquivado", false)
    .or("ml_shipment_status.is.null,ml_shipment_status.not.in.(shipped,delivered)")
    .order("data_pedido", { ascending: true, nullsFirst: false });

  if (error) throw error;

  return (data as any[]).map((p) => ({
    id: p.id,
    bling_pedido_id: p.bling_pedido_id,
    numero: p.numero,
    numero_loja: p.numero_loja ?? null,
    marketplace: p.marketplace ?? null,
    data_pedido: p.data_pedido ?? null,
    cliente: p.cliente ?? null,
    bling_nota_fiscal_id: p.bling_nota_fiscal_id ?? null,
    bling_nota_fiscal_numero: p.bling_nota_fiscal_numero ?? null,
    situacao_valor: p.situacao_valor ?? null,
    raw_json: p.raw_json ?? null,
    printed_at: p.printed_at ?? null,
    bling_divergente: p.bling_divergente ?? false,
    ml_shipment_status: p.ml_shipment_status ?? null,
    itens: (p.pedido_itens ?? []).map((i: any) => ({
      id: i.id,
      sku: i.sku ?? null,
      ean: i.ean ?? null,
      descricao: i.descricao ?? "",
      quantidade: Number(i.quantidade ?? 1),
      quantidade_bipada: Number(i.quantidade_bipada ?? 0),
      produto_gtin: i.produto?.gtin ?? null,
      produto: i.produto ?? null,
    })),
  }));
}

// ─── Filtros de marketplace ────────────────────────────────────────────────────

type MarketplaceFiltro = {
  id: string;
  label: string;
  predicate: (p: PedidoExpedicao) => boolean;
};

const MARKETPLACE_FILTROS: MarketplaceFiltro[] = [
  { id: "mercadolivre", label: "Mercado Livre", predicate: (p) => p.marketplace === "mercadolivre" && !isPedidoFlex(p) },
  { id: "ml_flex", label: "ML Flex", predicate: (p) => isPedidoFlex(p) },
  { id: "shopee", label: "Shopee", predicate: (p) => p.marketplace === "shopee" },
  { id: "amazon", label: "Amazon", predicate: (p) => p.marketplace === "amazon" },
];

// ─── Filtros de data de despacho ────────────────────────────────────────────────

type DataFiltroId = "todas" | "hoje" | "atrasados" | "proximos";

const DATA_FILTROS: { id: DataFiltroId; label: string; categoria: CategoriaData }[] = [
  { id: "hoje", label: "Hoje", categoria: "hoje" },
  { id: "atrasados", label: "Atrasados", categoria: "atrasado" },
  { id: "proximos", label: "Próximos dias", categoria: "proximos" },
];

// ─── Página principal ─────────────────────────────────────────────────────────

export function ExpedicaoPage() {
  const queryClient = useQueryClient();
  const qzTray = useQzTray();
  const marcarImpresso = useServerFn(marcarPedidoImpresso);

  const { data: pedidos = [], isLoading } = useQuery({
    queryKey: ["expedicao-pedidos"],
    queryFn: fetchPedidos,
    refetchInterval: 30_000,
  });

  const [busca, setBusca] = useState("");
  const [marketplaceFiltro, setMarketplaceFiltro] = useState<string>("todos");
  const [dataFiltro, setDataFiltro] = useState<DataFiltroId>("todas");
  const [pedidoAtivo, setPedidoAtivo] = useState<PedidoExpedicao | null>(null);
  const [showPrinterConfig, setShowPrinterConfig] = useState(false);

  const pendentes = useMemo(
    () =>
      pedidos.filter((p) => {
        if (pedidoProgress(p).done) return false;
        // Aguardando NF do Bling: some do Checkout até a NF ser emitida (Flex é exceção, pois normalmente não emite NF)
        const semNf = !p.bling_nota_fiscal_id;
        if (semNf && !isPedidoFlex(p)) return false;
        const jaDespachadoOuEntregue = p.ml_shipment_status === "shipped" || p.ml_shipment_status === "delivered";
        if (jaDespachadoOuEntregue) return false;
        return true;
      }),
    [pedidos],
  );

  const marketplaceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of MARKETPLACE_FILTROS) {
      counts[f.id] = pendentes.filter(f.predicate).length;
    }
    return counts;
  }, [pendentes]);

  const dataCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of DATA_FILTROS) {
      counts[f.id] = pendentes.filter((p) => categoriaDataPrevista(p.raw_json) === f.categoria).length;
    }
    return counts;
  }, [pendentes]);

  const filtrados = useMemo(() => {
    const filtro = MARKETPLACE_FILTROS.find((f) => f.id === marketplaceFiltro);
    let base = filtro ? pendentes.filter(filtro.predicate) : pendentes;

    const dataFiltroDef = DATA_FILTROS.find((f) => f.id === dataFiltro);
    if (dataFiltroDef) {
      base = base.filter((p) => categoriaDataPrevista(p.raw_json) === dataFiltroDef.categoria);
    }

    const q = busca.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (p) =>
        p.numero.toLowerCase().includes(q) ||
        (p.numero_loja ?? "").toLowerCase().includes(q) ||
        nomeCliente(p).toLowerCase().includes(q),
    );
  }, [pendentes, busca, marketplaceFiltro, dataFiltro]);

  const handleBiparPedido = useCallback(
    (pedido: PedidoExpedicao) => {
      const semNf = !pedido.bling_nota_fiscal_id;
      if (!isPedidoFlex(pedido) && semNf) {
        toast.info("Este pedido ainda não tem NF emitida no Bling — aguarde o próximo sync");
        return;
      }
      const fresh = pedidos.find((p) => p.id === pedido.id) ?? pedido;
      setPedidoAtivo(fresh);
    },
    [pedidos],
  );

  const handleImpressaoAutomatica = useCallback(
    async (pedido: PedidoExpedicao) => {
      const impressora = localStorage.getItem(IMPRESSORA_KEY);
      if (!impressora) {
        setShowPrinterConfig(true);
        toast.info("Selecione uma impressora padrão antes de continuar");
        return;
      }

      const isFlex = !!(pedido.raw_json as any)
        ?.transporte?.volumes?.[0]?.servico?.toLowerCase().includes("flex");
      const semNf = !pedido.bling_nota_fiscal_id;

      if (!isFlex && semNf) {
        toast.warning("Pedido aguardando NF no Bling — impressão bloqueada até a NF ser emitida");
        return;
      }

      let imprimiuAlgo = false;

      // FLEX sem NF: imprime apenas etiqueta, sem DANFE (esperado não ter NF)
      if (isFlex && semNf) {
        toast.loading("Buscando etiqueta FLEX...", { id: "print" });
        const blingId = Number(pedido.bling_pedido_id);
        if (!blingId) { toast.warning("Pedido FLEX sem ID Bling", { id: "print" }); return; }
        try {
          const et = await buscarEtiquetaBling({ data: { pedidoId: blingId } });
          if (et.ok && et.tipo === "zpl") {
            await qzTray.imprimirZpl(et.conteudo, impressora);
            imprimiuAlgo = true;
            toast.success("Etiqueta impressa — pedido FLEX sem NF", { id: "print" });
          } else {
            console.warn("[impressao] etiqueta FLEX indisponível:", (et as any).error);
            toast.warning("Etiqueta FLEX não disponível", { id: "print" });
          }
        } catch (err) {
          console.error("[impressao] erro FLEX:", err);
          toast.error("Erro ao imprimir etiqueta — verifique o QZ Tray", { id: "print" });
        }
        if (imprimiuAlgo) {
          try {
            await marcarImpresso({ data: { pedidoId: pedido.id } });
            queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] });
            queryClient.invalidateQueries({ queryKey: ["dash-expedicao"] });
          } catch (err) {
            console.warn("[printed_at] falha ao registrar:", err);
          }
        }
        return;
      }

      toast.loading("Gerando documentos...", { id: "print" });

      // Busca etiqueta e DANFE em paralelo — falha de uma não cancela a outra
      const blingId = Number(pedido.bling_pedido_id);
      const [etiquetaSettled, danfeSettled] = await Promise.allSettled([
        blingId
          ? buscarEtiquetaBling({ data: { pedidoId: blingId } })
          : Promise.reject(new Error("bling_pedido_id ausente")),
        gerarDanfeCustom({ data: { pedidoId: pedido.id } }),
      ]);

      toast.loading("Imprimindo...", { id: "print" });

      // Etiqueta: opcional — erro apenas loga, nunca bloqueia a DANFE
      if (etiquetaSettled.status === "fulfilled") {
        const et = etiquetaSettled.value;
        if (et.ok && et.tipo === "zpl") {
          try {
            await qzTray.imprimirZpl(et.conteudo, impressora);
            imprimiuAlgo = true;
          } catch (err) {
            console.warn("[impressao] falha ao imprimir etiqueta:", err);
          }
        } else if (et.ok && et.tipo === "pdf_base64") {
          try {
            await qzTray.imprimirPdf(et.conteudo, impressora);
            imprimiuAlgo = true;
          } catch (err) {
            console.warn("[impressao] falha ao imprimir etiqueta PDF:", err);
          }
        } else if (!et.ok) {
          console.warn("[impressao] etiqueta não disponível:", (et as any).error);
        }
      } else {
        console.warn("[impressao] etiqueta rejeitou:", etiquetaSettled.reason);
      }

      // DANFE: sempre imprime quando disponível
      if (danfeSettled.status === "fulfilled" && danfeSettled.value.ok) {
        try {
          await qzTray.imprimirPdf(danfeSettled.value.pdf, impressora);
          imprimiuAlgo = true;
          toast.success("DANFE impressa", { id: "print" });
        } catch (err) {
          console.error("[impressao] falha ao imprimir DANFE:", err);
          toast.error("Erro ao imprimir DANFE — verifique o QZ Tray", { id: "print" });
        }
      } else {
        const motivo =
          danfeSettled.status === "rejected"
            ? String(danfeSettled.reason)
            : (danfeSettled.value as any).error;
        console.warn("[impressao] DANFE não gerada:", motivo);
        toast.warning("DANFE não disponível", { id: "print" });
      }

      if (imprimiuAlgo) {
        try {
          await marcarImpresso({ data: { pedidoId: pedido.id } });
          queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] });
          queryClient.invalidateQueries({ queryKey: ["dash-expedicao"] });
        } catch (err) {
          console.warn("[printed_at] falha ao registrar:", err);
        }
      }
    },
    [qzTray, marcarImpresso, queryClient],
  );

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-6 mb-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Checkout por Produto
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            Selecione um pedido e bipe os itens para liberar a expedição
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary text-primary-foreground px-6 py-4 text-center shadow-md min-w-[160px]">
            <div className="text-4xl font-bold leading-none">{filtrados.length}</div>
            <div className="text-xs uppercase tracking-wider opacity-80 mt-1">
              pedidos pendentes
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowPrinterConfig(true)}
            title="Configurar impressora"
            className="h-12 w-12"
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Filtro */}
      <div className="bg-card rounded-xl border p-4 mb-6 shadow-sm space-y-3">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por número, loja ou cliente..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="pl-9 h-11"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant={marketplaceFiltro === "todos" ? "default" : "outline"}
            size="sm"
            className="rounded-full"
            onClick={() => setMarketplaceFiltro("todos")}
          >
            Todos ({pendentes.length})
          </Button>
          {MARKETPLACE_FILTROS.filter((f) => marketplaceCounts[f.id] > 0).map((f) => (
            <Button
              key={f.id}
              variant={marketplaceFiltro === f.id ? "default" : "outline"}
              size="sm"
              className="rounded-full"
              onClick={() => setMarketplaceFiltro(f.id)}
            >
              {f.label} ({marketplaceCounts[f.id]})
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant={dataFiltro === "todas" ? "default" : "outline"}
            size="sm"
            className="rounded-full"
            onClick={() => setDataFiltro("todas")}
          >
            Todas as datas
          </Button>
          {DATA_FILTROS.map((f) => (
            <Button
              key={f.id}
              variant={dataFiltro === f.id ? "default" : "outline"}
              size="sm"
              className="rounded-full"
              onClick={() => setDataFiltro(f.id)}
            >
              {f.label} ({dataCounts[f.id]})
            </Button>
          ))}
        </div>
      </div>

      {/* Lista */}
      {isLoading ? (
        <div className="text-center py-20 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3" />
          Carregando pedidos...
        </div>
      ) : filtrados.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground bg-card border rounded-xl">
          <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
          {busca || marketplaceFiltro !== "todos" ? "Nenhum pedido com esse filtro." : "Nenhum pedido pendente."}
        </div>
      ) : (
        <div className="space-y-3">
          {filtrados.map((pedido) => (
            <PedidoCard
              key={pedido.id}
              pedido={pedido}
              onBipar={() => handleBiparPedido(pedido)}
              onReimprimir={() => handleImpressaoAutomatica(pedido)}
            />
          ))}
        </div>
      )}

      {/* Modal de bipagem */}
      <BipagemModal
        pedido={pedidoAtivo}
        onClose={() => setPedidoAtivo(null)}
        onConcluido={(pedido) => {
          queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] });
          setPedidoAtivo(null);
          handleImpressaoAutomatica(pedido);
        }}
        onRegistered={() =>
          queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] })
        }
      />

      {/* Config de impressora */}
      <PrinterConfig
        open={showPrinterConfig}
        onClose={() => setShowPrinterConfig(false)}
        qzTray={qzTray}
      />
    </div>
  );
}

// ─── Card de pedido ───────────────────────────────────────────────────────────

function detectarMarketplace(marketplace: string | null): { nome: string; cor: string } | null {
  if (!marketplace) return null;
  if (marketplace === "mercadolivre" || marketplace === "mercadolivreflex") {
    return { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300" };
  }
  if (marketplace === "shopee") return { nome: "Shopee", cor: "bg-orange-100 text-orange-800 border-orange-300" };
  if (marketplace === "amazon") return { nome: "Amazon", cor: "bg-amber-100 text-amber-800 border-amber-300" };
  return { nome: "Outros", cor: "bg-gray-100 text-gray-700 border-gray-300" };
}

function PedidoCard({
  pedido,
  onBipar,
  onReimprimir,
}: {
  pedido: PedidoExpedicao;
  onBipar: () => void;
  onReimprimir: () => void;
}) {
  const { done } = pedidoProgress(pedido);
  const item = pedido.itens[0] ?? null;
  const imageUrl = item?.produto?.imagem_url || null;
  const logistica = (pedido.raw_json as any)?.transporte?.volumes?.[0]?.servico ?? null;
  const ean = item?.ean ?? item?.produto_gtin ?? "—";
  const marketplace = detectarMarketplace(pedido.marketplace);
  const numeroPrincipal = pedido.numero_loja || pedido.numero;
  const numeroSecundario = pedido.numero_loja ? pedido.numero : null;
  const isFlex = logistica?.toLowerCase().includes("flex") ?? false;
  const semNf = !pedido.bling_nota_fiscal_id;
  const blingDivergente = pedido.bling_divergente;
  const badgeData = badgeDataPrevista(pedido.raw_json);

  return (
    <div
      className={`bg-card border rounded-xl shadow-sm p-4 flex items-center gap-4 transition-shadow hover:shadow-md ${
        done ? "opacity-60" : ""
      }`}
    >
      {/* Imagem do produto */}
      <div className="shrink-0 w-[150px] h-[150px] rounded-lg bg-muted flex flex-col items-center justify-center overflow-hidden border">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={item?.descricao ?? ""}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground p-2">
            <PackageOpen className="h-10 w-10" />
            <span className="text-[10px] text-center leading-tight">(Falta imagem)</span>
          </div>
        )}
      </div>

      {/* Dados */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <h3 className="font-bold text-base leading-tight truncate">
            {item?.descricao ?? "—"}
          </h3>
          {marketplace && (
            <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border ${marketplace.cor}`}>
              {marketplace.nome}
            </span>
          )}
          {isFlex && (
            <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border bg-yellow-100 text-yellow-800 border-yellow-300">
              FLEX
            </span>
          )}
          {semNf && (
            <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border bg-orange-100 text-orange-700 border-orange-300">
              ⚠ Sem NF
            </span>
          )}
          {!isFlex && semNf && (
            <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded border bg-gray-100 text-gray-500 border-gray-300">
              Aguardando NF do Bling
            </span>
          )}
          {blingDivergente && (
            <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border bg-amber-100 text-amber-800 border-amber-300">
              ⚠ Despachado no ML — Bling não baixou
            </span>
          )}
          {badgeData && (
            <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border ${badgeData.cor}`}>
              {badgeData.label}
            </span>
          )}
          {done && (
            <span className="shrink-0 text-xs bg-success/20 text-success font-semibold px-2 py-0.5 rounded">
              Concluído
            </span>
          )}
          {pedido.printed_at && (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded border bg-blue-50 text-blue-700 border-blue-200"
              title={`Impresso em ${formatDateTime(pedido.printed_at)}`}
            >
              <Printer className="h-3 w-3" />
              Impresso {formatDateTime(pedido.printed_at)}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-x-6 gap-y-1 text-xs">
          <span className="text-muted-foreground">SKU</span>
          <span className="text-muted-foreground">EAN</span>
          <span className="text-muted-foreground">Qtd</span>
          <span className="font-mono font-medium">{item?.sku ?? "—"}</span>
          <span className="font-mono">{ean}</span>
          <span className="font-semibold text-sm">{item?.quantidade ?? "—"}</span>

          <span className="text-muted-foreground">Pedido</span>
          <span className="text-muted-foreground">Data</span>
          <span className="text-muted-foreground">Logística</span>
          <span className="font-mono">
            <span>{numeroPrincipal}</span>
            {numeroSecundario && (
              <span className="block text-muted-foreground font-normal">
                Bling #{numeroSecundario}
              </span>
            )}
          </span>
          <span>{formatDateTime(pedido.data_pedido)}</span>
          <span>
            {logistica ? (
              <span className="inline-block bg-muted text-muted-foreground text-[10px] px-1.5 py-0.5 rounded font-medium truncate max-w-[120px]">
                {logistica}
              </span>
            ) : (
              "—"
            )}
          </span>
        </div>
      </div>

      {/* Ações */}
      <div className="flex gap-2 shrink-0">
        {done && (
          <Button variant="outline" size="sm" onClick={onReimprimir} className="gap-1.5">
            <Printer className="h-4 w-4" />
            Reimprimir
          </Button>
        )}
        {!done && !isFlex && semNf ? (
          <div className="text-center text-xs text-muted-foreground leading-tight px-3">
            <span className="block font-medium">Aguardando</span>
            <span className="block">NF do Bling</span>
          </div>
        ) : !done ? (
          <Button
            onClick={onBipar}
            className="bg-success hover:bg-success/90 text-success-foreground font-bold px-8 h-auto py-3"
          >
            BIPAR
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Modal de bipagem ─────────────────────────────────────────────────────────

type ResultadoStatus = "ok" | "erro" | null;

function BipagemModal({
  pedido,
  onClose,
  onConcluido,
  onRegistered,
}: {
  pedido: PedidoExpedicao | null;
  onClose: () => void;
  onConcluido: (pedido: PedidoExpedicao) => void;
  onRegistered: () => void;
}) {
  const { user, profile } = useAuth();
  const registrarFn = useServerFn(registrarBipagem);

  const [valor, setValor] = useState("");
  const [status, setStatus] = useState<ResultadoStatus>(null);
  const [mensagem, setMensagem] = useState("");
  const [itens, setItens] = useState<ItemExpedicao[]>([]);
  const [itemAtivo, setItemAtivo] = useState<ItemExpedicao | null>(null);
  const [imprimindo, setImprimindo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Seleciona automaticamente o primeiro item incompleto
  useEffect(() => {
    if (!pedido) {
      setItens([]);
      setItemAtivo(null);
      return;
    }
    setItens(pedido.itens);
    const incompleto = pedido.itens.find(
      (i) => i.quantidade_bipada < i.quantidade,
    );
    setItemAtivo(incompleto ?? null);
    setValor("");
    setStatus(null);
    setMensagem("");
    setEnviando(false);
    setTimeout(() => inputRef.current?.focus(), 120);
  }, [pedido]);

  if (!pedido) return null;

  const handleEnter = async () => {
    if (!valor.trim() || enviando) return;
    const code = valor.trim();

    // Tenta encontrar item que corresponde ao código bipado e ainda precisa de bipes
    // (usa o estado local `itens`, atualizado otimisticamente a cada bipe — evitando que um
    // segundo scan muito rápido, antes do refetch do servidor, "encontre" um item que já
    // acabou de ser completado e empurre quantidade_bipada além do pedido)
    const match = itens.find(
      (i) =>
        ((i.ean && i.ean === code) ||
          (!i.ean && i.produto_gtin && i.produto_gtin === code)) &&
        i.quantidade_bipada < i.quantidade,
    );

    const alvoItem = match ?? itemAtivo;

    if (!alvoItem || alvoItem.quantidade_bipada >= alvoItem.quantidade) {
      playBeep(false);
      setStatus("erro");
      setMensagem("Nenhum item pendente com esse EAN");
      return;
    }

    let ok: boolean;
    if (!alvoItem.ean && !alvoItem.produto_gtin) {
      ok = true; // sem EAN cadastrado — aceita qualquer código
    } else if (alvoItem.ean) {
      ok = alvoItem.ean === code;
    } else {
      ok = alvoItem.produto_gtin === code;
    }

    setEnviando(true);
    try {
      if (ok) {
        setStatus("ok");
        setMensagem(`✓ ${alvoItem.descricao}`);
        playBeep(true);

        // Atualização otimista local — trava a próxima leitura contra o mesmo item
        // antes mesmo da resposta do servidor voltar
        const itensAtualizados = itens.map((i) =>
          i.id === alvoItem.id
            ? { ...i, quantidade_bipada: Math.min(i.quantidade, i.quantidade_bipada + 1) }
            : i,
        );
        setItens(itensAtualizados);
        const proximoIncompleto = itensAtualizados.find((i) => i.quantidade_bipada < i.quantidade);
        setItemAtivo(proximoIncompleto ?? null);

        const result = await registrarFn({
          data: {
            pedidoItemId: alvoItem.id,
            pedidoId: pedido.id,
            codigoBipado: code,
            resultado: "sucesso",
            usuario: profile?.nome ?? user?.email ?? null,
          },
        });

        onRegistered();

        if (result.ok && result.pedidoConcluido) {
          setImprimindo(true);
          setTimeout(() => {
            setImprimindo(false);
            onConcluido(pedido);
          }, 800);
          return;
        }
      } else {
        setStatus("erro");
        setMensagem(
          `EAN não confere — esperado: ${alvoItem.ean ?? "—"}, recebido: ${code}`,
        );
        playBeep(false);
        await registrarFn({
          data: {
            pedidoItemId: alvoItem.id,
            pedidoId: pedido.id,
            codigoBipado: code,
            resultado: "erro_ean_invalido",
            usuario: profile?.nome ?? user?.email ?? null,
          },
        });
        onRegistered();
      }

      setTimeout(() => {
        setValor("");
        setStatus(null);
        setMensagem("");
        inputRef.current?.focus();
      }, ok ? 600 : 1200);
    } finally {
      setEnviando(false);
    }
  };

  const excecao = async (
    resultado: "sem_codigo" | "produto_errado" | "sem_estoque",
    label: string,
  ) => {
    if (!itemAtivo) return;
    await registrarFn({
      data: {
        pedidoItemId: itemAtivo.id,
        pedidoId: pedido.id,
        codigoBipado: "",
        resultado,
        usuario: profile?.nome ?? user?.email ?? null,
      },
    });
    onRegistered();
    toast.success(`Registrado: ${label}`);
    onClose();
  };

  const total = itens.reduce((s, i) => s + i.quantidade, 0);
  const bipado = itens.reduce((s, i) => s + i.quantidade_bipada, 0);

  return (
    <Dialog open={!!pedido} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b flex flex-row items-center justify-between space-y-0">
          <div>
            <DialogTitle className="text-lg">
              Bipagem — Pedido #{pedido.numero}
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              {bipado}/{total} itens bipados
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </DialogHeader>

        {/* Overlay de impressão */}
        {imprimindo && (
          <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="font-semibold text-lg">Pedido concluído — Imprimindo...</p>
          </div>
        )}

        <div className="grid grid-cols-5">
          {/* Lista de itens */}
          <div className="col-span-2 border-r bg-muted/30 p-4 space-y-2 max-h-[500px] overflow-y-auto">
            {itens.map((item) => {
              const done = item.quantidade_bipada >= item.quantidade;
              const isAtivo = itemAtivo?.id === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => !done && setItemAtivo(item)}
                  className={`w-full text-left p-3 rounded-lg border text-sm transition-colors ${
                    done
                      ? "border-success/40 bg-success/10 text-muted-foreground"
                      : isAtivo
                        ? "border-primary bg-primary/5 font-medium"
                        : "border-border bg-card hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.sku ?? "—"}
                    </span>
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <span className="text-xs font-semibold text-primary">
                        {item.quantidade_bipada}/{item.quantidade}
                      </span>
                    )}
                  </div>
                  <p className="leading-tight line-clamp-2">{item.descricao}</p>
                  {item.ean && (
                    <p className="text-xs font-mono text-muted-foreground mt-1">
                      {item.ean}
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Área de scan */}
          <div className="col-span-3 p-6 space-y-5">
            {itemAtivo ? (
              <>
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-1">
                    Item ativo
                  </p>
                  <h2 className="text-xl font-bold leading-tight">
                    {itemAtivo.descricao}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    SKU: <span className="font-mono">{itemAtivo.sku ?? "—"}</span>
                    {" "}•{" "}
                    {itemAtivo.quantidade_bipada}/{itemAtivo.quantidade} unid.
                  </p>
                </div>

                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-1">
                    EAN esperado
                  </p>
                  <p className="text-3xl font-mono font-bold tracking-tight">
                    {itemAtivo.ean ?? "—"}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium block mb-2">
                    Bipe o código de barras
                  </label>
                  <input
                    ref={inputRef}
                    value={valor}
                    onChange={(e) => {
                      setValor(e.target.value);
                      if (status) { setStatus(null); setMensagem(""); }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleEnter(); }
                    }}
                    disabled={enviando}
                    className={`w-full h-14 px-4 text-xl font-mono rounded-lg border-4 outline-none transition-colors bg-background disabled:opacity-60 ${
                      status === "ok"
                        ? "border-success"
                        : status === "erro"
                          ? "border-destructive"
                          : "border-input focus:border-primary"
                    }`}
                    placeholder="Aguardando leitura..."
                    autoComplete="off"
                  />
                  {status === "ok" && (
                    <div className="mt-2 flex items-center gap-2 text-success font-semibold text-sm">
                      <CheckCircle2 className="h-5 w-5" />
                      {mensagem}
                    </div>
                  )}
                  {status === "erro" && (
                    <div className="mt-2 flex items-center gap-2 text-destructive font-semibold text-sm">
                      <XCircle className="h-5 w-5" />
                      {mensagem}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => excecao("sem_codigo", "Produto sem código de barras")}
                  >
                    Sem código de barras
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => excecao("produto_errado", "Produto errado")}
                  >
                    Produto errado
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => excecao("sem_estoque", "Sem estoque")}
                  >
                    Sem estoque
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full py-12 text-center text-muted-foreground gap-3">
                <CheckCircle2 className="h-12 w-12 text-success" />
                <p className="font-semibold text-success text-lg">Todos os itens bipados!</p>
                <p className="text-sm">Aguardando impressão automática...</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
