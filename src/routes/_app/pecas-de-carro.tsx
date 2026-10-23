import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Car, Loader2, MapPin, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";
import { MobileHidden } from "@/components/MobileHidden";
import { MarketplaceBadge } from "@/components/MarketplaceBadge";
import {
  PECAS_ESTOQUE_KEY, PEDIDOS_COM_PECA_KEY, contarPedidos, excluirPeca,
  fetchPecasEstoque, fetchPedidosComPeca, salvarPeca,
  type PecaEstoque, type PedidoComPeca,
} from "@/lib/pecas-estoque";

export const Route = createFileRoute("/_app/pecas-de-carro")({
  component: PecasDeCarroPage,
});

function formatQtd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR");
}

function formatData(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// ─── Modal de cadastro / edição ───────────────────────────────────────────────

function PecaModal({
  peca,
  onClose,
  onSaved,
}: {
  /** `null` = peça nova. */
  peca: PecaEstoque | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sku, setSku] = useState(peca?.sku ?? "");
  const [nome, setNome] = useState(peca?.nome ?? "");
  const [quantidade, setQuantidade] = useState(String(peca?.quantidade ?? 1));
  const [localizacao, setLocalizacao] = useState(peca?.localizacao ?? "");

  const qtd = Number(quantidade);
  const qtdValida = quantidade.trim() !== "" && Number.isInteger(qtd) && qtd >= 0;
  const podeSalvar = sku.trim() !== "" && nome.trim() !== "" && qtdValida;

  const mut = useMutation({
    mutationFn: () =>
      salvarPeca(peca?.id ?? null, {
        sku: sku.trim(),
        nome: nome.trim(),
        quantidade: qtd,
        localizacao: localizacao.trim() || null,
      }),
    onSuccess: () => {
      toast.success(peca ? "Peça atualizada" : "Peça cadastrada");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{peca ? "Editar peça" : "Nova peça"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (podeSalvar && !mut.isPending) mut.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="peca-sku">SKU</Label>
            <Input
              id="peca-sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="Igual ao SKU do Bling / marketplace"
              className="font-mono"
              autoFocus={!peca}
            />
            <p className="text-xs text-muted-foreground">
              O aviso só acende se o SKU for idêntico ao do pedido (maiúsculas e espaços não importam).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="peca-nome">Nome</Label>
            <Input id="peca-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="peca-qtd">Quantidade</Label>
              <Input
                id="peca-qtd"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={quantidade}
                onChange={(e) => setQuantidade(e.target.value)}
                aria-invalid={!qtdValida}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="peca-local">Localização</Label>
              <Input
                id="peca-local"
                value={localizacao}
                onChange={(e) => setLocalizacao(e.target.value)}
                placeholder="Ex.: Prateleira B2"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!podeSalvar || mut.isPending}>
              {mut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Aviso: pedidos a expedir com peça no estoque ─────────────────────────────

function AvisoPedidos({ linhas }: { linhas: PedidoComPeca[] }) {
  const total = contarPedidos(linhas);
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3">
      <div className="flex items-start gap-2 text-amber-900">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div>
          <h2 className="font-semibold">
            {total} pedido{total !== 1 ? "s" : ""} a expedir com peça no estoque do galpão
          </h2>
          <p className="text-sm text-amber-800">
            O estoque não baixa sozinho — ao tirar a peça da prateleira, ajuste a quantidade abaixo.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-amber-200">
        {linhas.map((l) => (
          <li
            key={`${l.pedido_id}-${l.peca_id}`}
            className="py-2 flex flex-col md:flex-row md:items-center gap-1 md:gap-4 text-sm"
          >
            <div className="flex items-center gap-2 md:w-64 min-w-0">
              <MarketplaceBadge marketplace={l.marketplace} tamanho="xs" />
              <span className="font-mono font-medium break-all">{l.numero_loja ?? l.numero ?? "—"}</span>
              <span className="text-xs text-muted-foreground shrink-0">{formatData(l.data_pedido)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <span className="font-mono break-all">{l.sku}</span>
              <span className="text-muted-foreground"> · vendido {formatQtd(l.quantidade_pedido)} un.</span>
              <div className="text-xs text-muted-foreground truncate">{l.peca_nome}</div>
            </div>
            <div className="flex items-center gap-3 text-amber-900 font-medium">
              <span>{l.peca_quantidade} em estoque</span>
              {l.localizacao && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {l.localizacao}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────────

function PecasDeCarroPage() {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  // undefined = fechado; null = nova peça; objeto = editando.
  const [editando, setEditando] = useState<PecaEstoque | null | undefined>(undefined);
  const [excluindo, setExcluindo] = useState<PecaEstoque | null>(null);

  const pecasQ = useQuery({ queryKey: PECAS_ESTOQUE_KEY, queryFn: fetchPecasEstoque });
  const pedidosQ = useQuery({
    queryKey: PEDIDOS_COM_PECA_KEY,
    queryFn: fetchPedidosComPeca,
    refetchInterval: 60_000,
  });

  const recarregar = () => {
    queryClient.invalidateQueries({ queryKey: PECAS_ESTOQUE_KEY });
    queryClient.invalidateQueries({ queryKey: PEDIDOS_COM_PECA_KEY });
  };

  const excluirMut = useMutation({
    mutationFn: (id: string) => excluirPeca(id),
    onSuccess: () => {
      toast.success("Peça excluída");
      setExcluindo(null);
      recarregar();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pecas = pecasQ.data ?? [];
  const pedidos = pedidosQ.data ?? [];

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return pecas;
    return pecas.filter(
      (p) =>
        p.sku.toLowerCase().includes(termo) ||
        p.nome.toLowerCase().includes(termo) ||
        (p.localizacao ?? "").toLowerCase().includes(termo),
    );
  }, [pecas, busca]);

  const pecasComPedido = useMemo(() => new Set(pedidos.map((l) => l.peca_id)), [pedidos]);
  const totalUnidades = pecas.reduce((s, p) => s + p.quantidade, 0);

  const columns: ResponsiveColumn<PecaEstoque>[] = [
    {
      id: "sku", header: "SKU", priority: "primary", className: "font-mono",
      cell: (p) => (
        <span className="inline-flex items-center gap-2 break-all">
          {p.sku}
          {pecasComPedido.has(p.id) && (
            <span className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 text-[11px] font-sans font-semibold whitespace-nowrap">
              vendida
            </span>
          )}
        </span>
      ),
    },
    { id: "nome", header: "Nome", priority: "primary", className: "max-w-[320px] truncate", cell: (p) => p.nome },
    {
      id: "quantidade", header: "Quantidade", priority: "secondary", align: "right", className: "tabular-nums",
      cell: (p) => (
        <span className={p.quantidade === 0 ? "text-muted-foreground" : "font-semibold"}>{p.quantidade}</span>
      ),
    },
    { id: "localizacao", header: "Localização", priority: "secondary", cell: (p) => p.localizacao ?? "—" },
    {
      id: "atualizado", header: "Atualizado", priority: "desktop-only", className: "text-muted-foreground",
      cell: (p) => formatData(p.updated_at),
    },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Car className="h-7 w-7 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-semibold">Peças de Carro</h1>
            <p className="text-sm text-muted-foreground">
              Estoque físico Rufato no galpão · {pecas.length} peça{pecas.length !== 1 ? "s" : ""},{" "}
              {totalUnidades} un.
            </p>
          </div>
        </div>
        <MobileHidden>
          <Button onClick={() => setEditando(null)} className="gap-2">
            <Plus className="h-4 w-4" />
            Nova peça
          </Button>
        </MobileHidden>
      </div>

      {pedidos.length > 0 && <AvisoPedidos linhas={pedidos} />}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por SKU, nome ou localização"
          className="pl-9 h-11 md:h-9"
        />
      </div>

      <div className="md:border md:rounded-lg md:overflow-hidden">
        <ResponsiveTable
          columns={columns}
          rows={filtradas}
          rowKey={(p) => p.id}
          loading={pecasQ.isLoading}
          rowActions={(p) => (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditando(p)} aria-label="Editar peça">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => setExcluindo(p)} aria-label="Excluir peça"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
          empty={
            <>
              <Car className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p>{busca ? "Nenhuma peça encontrada" : "Nenhuma peça cadastrada ainda"}</p>
            </>
          }
        />
      </div>

      {editando !== undefined && (
        <PecaModal
          peca={editando}
          onClose={() => setEditando(undefined)}
          onSaved={() => {
            setEditando(undefined);
            recarregar();
          }}
        />
      )}

      <AlertDialog open={!!excluindo} onOpenChange={(o) => !o && setExcluindo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir peça?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{excluindo?.sku}</span> — {excluindo?.nome}. Para registrar que a peça
              acabou, prefira editar e colocar quantidade 0.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (excluindo) excluirMut.mutate(excluindo.id);
              }}
              disabled={excluirMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
