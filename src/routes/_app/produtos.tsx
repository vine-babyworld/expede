import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { RefreshCw, Loader2, Package, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import {
  listProdutos, listBlingConnectionsForFilter, getActiveSyncJobs,
  getProdutosOverview, syncProductsStart, atualizarProduto, sincronizarProduto,
} from "@/lib/produtos.functions";

export const Route = createFileRoute("/_app/produtos")({
  component: ProdutosPage,
});

function EditProdutoModal({
  produto,
  onClose,
  onSaved,
}: {
  produto: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const atualizar = useServerFn(atualizarProduto);
  const [nome, setNome] = useState(produto.nome ?? "");
  const [gtin, setGtin] = useState(produto.gtin ?? "");
  const [imagemUrl, setImagemUrl] = useState(produto.imagem_url ?? "");
  const [gtinError, setGtinError] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      atualizar({
        data: {
          id: produto.id,
          nome: nome.trim() || undefined,
          gtin: gtin.trim() ? gtin.trim() : null,
          imagem_url: imagemUrl.trim() ? imagemUrl.trim() : null,
        },
      }),
    onSuccess: () => {
      toast.success("Produto atualizado");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSalvar = () => {
    if (gtin.trim() && !/^\d{8,14}$/.test(gtin.trim())) {
      setGtinError("EAN deve ter 8–14 dígitos numéricos");
      return;
    }
    setGtinError("");
    mut.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar produto</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>EAN (GTIN)</Label>
            <Input
              value={gtin}
              onChange={(e) => { setGtin(e.target.value); setGtinError(""); }}
              placeholder="Ex: 7891234567890"
              className={gtinError ? "border-destructive" : ""}
            />
            {gtinError && <p className="text-xs text-destructive">{gtinError}</p>}
          </div>
          <div className="space-y-1">
            <Label>URL da imagem</Label>
            <Input
              value={imagemUrl}
              onChange={(e) => setImagemUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSalvar} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProdutosPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const list = useServerFn(listProdutos);
  const conns = useServerFn(listBlingConnectionsForFilter);
  const activeJobs = useServerFn(getActiveSyncJobs);
  const overview = useServerFn(getProdutosOverview);
  const startSync = useServerFn(syncProductsStart);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [connectionId, setConnectionId] = useState<string>("__all");
  const [status, setStatus] = useState<"ativos" | "inativos" | "todos">("ativos");
  const [tipo, setTipo] = useState<"simples" | "pai" | "filho" | "todos">("todos");
  const [page, setPage] = useState(1);
  const [editingProduto, setEditingProduto] = useState<any | null>(null);
  const [sincronizando, setSincronizando] = useState<Set<number>>(new Set());
  const syncFn = useServerFn(sincronizarProduto);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const ov = useQuery({ queryKey: ["produtos-overview"], queryFn: () => overview() });
  const connsQ = useQuery({ queryKey: ["bling-conns"], queryFn: () => conns() });
  const jobsQ = useQuery({
    queryKey: ["sync-jobs", connectionId],
    queryFn: () => activeJobs({ data: connectionId === "__all" ? {} : { connectionId } }),
    refetchInterval: 3000,
  });
  const listQ = useQuery({
    queryKey: ["produtos", debounced, connectionId, status, tipo, page],
    queryFn: () => list({ data: {
      search: debounced,
      connectionId: connectionId === "__all" ? undefined : connectionId,
      status, tipo, page,
    } }),
  });

  const activeJob = (jobsQ.data ?? []).find((j: any) =>
    ["pendente", "rodando", "pausado"].includes(j.status));
  const recentCompletedJob = (jobsQ.data ?? []).find((j: any) =>
    j.status === "concluido" && j.finalizado_em && Date.now() - new Date(j.finalizado_em).getTime() <= 10_000);
  const errorJob = (jobsQ.data ?? []).find((j: any) => j.status === "erro");
  const bannerJob = activeJob ?? recentCompletedJob ?? errorJob;

  const bannerState = (job: any) => {
    const isDetalhes = job.fase === "detalhes";
    const faseLabel = isDetalhes
      ? "Enriquecendo dados (EAN, peso, dimensões)"
      : "Importando lista de produtos";

    if (job.status === "pendente") {
      return {
        box: "border-blue-200 bg-blue-50",
        text: "text-blue-800",
        barTrack: "bg-blue-100",
        bar: "bg-blue-500",
        message: `${faseLabel}... em fila`,
      };
    }
    if (job.status === "pausado") {
      return {
        box: "border-amber-200 bg-amber-50",
        text: "text-amber-800",
        barTrack: "bg-amber-100",
        bar: "bg-amber-500",
        message: `${faseLabel}... pausado, retomando em breve (${job.total_processados} processados)`,
      };
    }
    if (job.status === "concluido") {
      const hasProducts = Number(job.total_processados ?? 0) > 0;
      const concluidoMsg = isDetalhes
        ? `Enriquecimento concluído: ${job.total_processados} produtos detalhados`
        : `Importação de lista concluída: ${job.total_processados} produtos · enriquecimento iniciando…`;
      return {
        box: hasProducts ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50",
        text: hasProducts ? "text-emerald-800" : "text-amber-800",
        barTrack: hasProducts ? "bg-emerald-100" : "bg-amber-100",
        bar: hasProducts ? "bg-emerald-500" : "bg-amber-500",
        message: hasProducts
          ? concluidoMsg
          : "Sincronização concluída, mas nenhum produto foi processado. Verifique escopo do app Bling.",
      };
    }
    if (job.status === "erro") {
      const firstError = Array.isArray(job.erros) ? job.erros[0]?.mensagem : undefined;
      return {
        box: "border-rose-200 bg-rose-50",
        text: "text-rose-800",
        barTrack: "bg-rose-100",
        bar: "bg-rose-500",
        message: `Erro em ${faseLabel.toLowerCase()}: ${firstError ?? "erro desconhecido"}.`,
      };
    }
    return {
      box: "border-blue-200 bg-blue-50",
      text: "text-blue-800",
      barTrack: "bg-blue-100",
      bar: "bg-blue-500",
      message: `${faseLabel}... ${job.total_processados} processados${job.total_erros ? ` (${job.total_erros} erros)` : ""}`,
    };
  };

  // Quando job conclui, invalida lista
  useEffect(() => {
    if (!activeJob && jobsQ.data && jobsQ.data.length > 0) {
      qc.invalidateQueries({ queryKey: ["produtos"] });
      qc.invalidateQueries({ queryKey: ["produtos-overview"] });
    }
  }, [activeJob, jobsQ.data, qc]);

  const syncMut = useMutation({
    mutationFn: (cid: string) => startSync({ data: { connectionId: cid } }),
    onSuccess: (r) => {
      toast.success(r.reused ? "Sync já em andamento" : "Sincronização iniciada");
      qc.invalidateQueries({ queryKey: ["sync-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSyncProduto = async (p: any) => {
    if (!p.bling_product_id) return;
    setSincronizando((prev) => new Set(prev).add(p.bling_product_id));
    try {
      const result = await syncFn({ data: { blingProductId: p.bling_product_id, blingConnectionId: p.bling_connection_id } });
      if (result.ok) {
        toast.success("Produto sincronizado");
        qc.invalidateQueries({ queryKey: ["produtos"] });
      } else {
        toast.error(result.error ?? "Erro ao sincronizar produto");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao sincronizar produto");
    } finally {
      setSincronizando((prev) => { const s = new Set(prev); s.delete(p.bling_product_id); return s; });
    }
  };

  const handleSync = () => {
    const allConns = (connsQ.data ?? []).filter((c: any) => c.status === "connected");
    if (connectionId !== "__all") {
      syncMut.mutate(connectionId);
    } else if (allConns.length === 1) {
      syncMut.mutate(allConns[0].id);
    } else if (allConns.length === 0) {
      toast.error("Nenhuma conta Bling conectada");
    } else {
      // dispara para todas
      allConns.forEach((c: any) => syncMut.mutate(c.id));
    }
  };

  const connName = (id: string) =>
    (connsQ.data ?? []).find((c: any) => c.id === id)?.bling_account_name ?? "Conta Bling";

  const fmtRel = (iso?: string | null) => {
    if (!iso) return "—";
    const diff = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diff / 3600_000);
    if (h < 1) return `há ${Math.max(1, Math.floor(diff / 60_000))} min`;
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  };

  const total = listQ.data?.total ?? 0;
  const pageSize = listQ.data?.pageSize ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Produtos</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {ov.data?.totalProdutos ?? 0} produtos · última sincronização {fmtRel(ov.data?.lastSyncedAt)}
          </p>
        </div>
        {isAdmin && (
          <Button onClick={handleSync} disabled={syncMut.isPending || !!activeJob}>
            {syncMut.isPending || activeJob ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sincronizar agora
          </Button>
        )}
      </div>

      {bannerJob && (() => {
        const state = bannerState(bannerJob);
        return (
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${state.box}`}>
          <div className={`flex items-center gap-2 ${state.text}`}>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{state.message}</span>
          </div>
          <div className={`mt-2 h-1.5 rounded overflow-hidden ${state.barTrack}`}>
            {bannerJob.total_paginas ? (
              <div className={`h-full transition-all ${state.bar}`}
                style={{ width: `${Math.min(100, (bannerJob.pagina_atual / bannerJob.total_paginas) * 100)}%` }} />
            ) : (
              <div className={`h-full animate-pulse w-1/3 ${state.bar}`} />
            )}
          </div>
        </div>
        );
      })()}

      <div className="flex flex-wrap gap-3 mb-4">
        <Input
          placeholder="Buscar por nome, SKU ou EAN…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-sm"
        />
        <Select value={connectionId} onValueChange={(v) => { setConnectionId(v); setPage(1); }}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Conta Bling" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todas as contas</SelectItem>
            {(connsQ.data ?? []).map((c: any) => (
              <SelectItem key={c.id} value={c.id}>{c.bling_account_name ?? "Conta Bling"}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v: any) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ativos">Ativos</SelectItem>
            <SelectItem value="inativos">Inativos</SelectItem>
            <SelectItem value="todos">Todos</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tipo} onValueChange={(v: any) => { setTipo(v); setPage(1); }}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os tipos</SelectItem>
            <SelectItem value="simples">Simples</SelectItem>
            <SelectItem value="pai">Pai</SelectItem>
            <SelectItem value="filho">Filho</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-3 w-14"></th>
              <th className="px-3 py-3 font-medium">Nome</th>
              <th className="px-3 py-3 font-medium">SKU</th>
              <th className="px-3 py-3 font-medium">EAN</th>
              <th className="px-3 py-3 font-medium text-right">Estoque</th>
              <th className="px-3 py-3 font-medium">Tipo</th>
              {connectionId === "__all" && <th className="px-3 py-3 font-medium">Conta</th>}
              <th className="px-3 py-3 font-medium">Sincronizado</th>
              <th className="px-3 py-3 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr><td colSpan={9} className="px-3 py-12 text-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin inline" />
              </td></tr>
            ) : (listQ.data?.rows ?? []).length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-16 text-center">
                <Package className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                <p className="text-muted-foreground">
                  {debounced || status !== "ativos" || tipo !== "todos" || connectionId !== "__all"
                    ? "Nenhum produto encontrado com esses filtros."
                    : "Nenhum produto importado ainda."}
                </p>
                {isAdmin && !debounced && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Clique em <strong>Sincronizar agora</strong> para começar.
                  </p>
                )}
              </td></tr>
            ) : (listQ.data?.rows ?? []).map((p: any) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-2">
                  {p.imagem_url ? (
                    <img src={p.imagem_url} alt="" className="h-10 w-10 rounded object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                      <Package className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium flex items-center gap-2">
                    <span className="line-clamp-1">{p.nome}</span>
                    {!p.ativo && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Inativo</span>}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                <td className="px-3 py-2 font-mono text-xs">{p.gtin ?? "—"}</td>
                <td className="px-3 py-2 text-right">{p.estoque ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary capitalize">{p.tipo}</span>
                </td>
                {connectionId === "__all" && (
                  <td className="px-3 py-2 text-xs text-muted-foreground">{connName(p.bling_connection_id)}</td>
                )}
                <td className="px-3 py-2 text-xs text-muted-foreground">{fmtRel(p.synced_at)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={!p.bling_product_id || sincronizando.has(p.bling_product_id)}
                      onClick={() => handleSyncProduto(p)}
                      title="Sincronizar produto"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${sincronizando.has(p.bling_product_id) ? "animate-spin" : ""}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditingProduto(p)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {total > pageSize && (
          <div className="px-4 py-3 border-t flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Página {page} de {totalPages} · {total} produtos
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}>Próxima</Button>
            </div>
          </div>
        )}
      </div>

      {editingProduto && (
        <EditProdutoModal
          produto={editingProduto}
          onClose={() => setEditingProduto(null)}
          onSaved={() => {
            setEditingProduto(null);
            qc.invalidateQueries({ queryKey: ["produtos"] });
          }}
        />
      )}
    </div>
  );
}
