import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, X, CheckCircle2, XCircle, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { playBeep } from "./beep";

type Canal = {
  id: string;
  nome: string;
  slug: string;
  cor: string | null;
};

type Produto = {
  id: string;
  sku: string;
  nome: string;
  ean_principal: string | null;
  eans_alternativos: string[];
  foto_url: string | null;
  localizacao: string | null;
};

type ItemRow = {
  id: string;
  quantidade: number;
  produto: Produto;
  pedido: {
    id: string;
    numero_pedido: string;
    metodo_envio: string | null;
    bloco_separacao: string | null;
    data_pedido: string | null;
    canal: Canal | null;
    total_itens: number;
  };
};

async function fetchCanais(): Promise<Canal[]> {
  const { data, error } = await supabase
    .from("canais")
    .select("id, nome, slug, cor")
    .order("nome");
  if (error) throw error;
  return data as Canal[];
}

async function fetchItens(): Promise<ItemRow[]> {
  const { data, error } = await supabase
    .from("pedido_itens")
    .select(
      `id, quantidade,
       produto:produtos(id, sku, nome, ean_principal, eans_alternativos, foto_url, localizacao),
       pedido:pedidos!inner(id, numero_pedido, metodo_envio, bloco_separacao, data_pedido, status,
         canal:canais(id, nome, slug, cor),
         itens:pedido_itens(id)
       )`,
    )
    .eq("pedido.status", "pendente");
  if (error) throw error;
  type RawRow = {
    id: string;
    quantidade: number;
    produto: Produto;
    pedido: {
      id: string;
      numero_pedido: string;
      metodo_envio: string | null;
      bloco_separacao: string | null;
      data_pedido: string | null;
      canal: Canal | null;
      itens: { id: string }[];
    };
  };
  return (data as unknown as RawRow[]).map((r) => ({
    id: r.id,
    quantidade: r.quantidade,
    produto: r.produto,
    pedido: {
      id: r.pedido.id,
      numero_pedido: r.pedido.numero_pedido,
      metodo_envio: r.pedido.metodo_envio,
      bloco_separacao: r.pedido.bloco_separacao,
      data_pedido: r.pedido.data_pedido,
      canal: r.pedido.canal,
      total_itens: r.pedido.itens?.length ?? 1,
    },
  }));
}

export function ExpedicaoPage() {
  const queryClient = useQueryClient();
  const { data: canais = [] } = useQuery({
    queryKey: ["canais"],
    queryFn: fetchCanais,
  });
  const { data: itens = [], isLoading } = useQuery({
    queryKey: ["expedicao-itens"],
    queryFn: fetchItens,
  });

  const [busca, setBusca] = useState("");
  const [canalFiltro, setCanalFiltro] = useState("todos");
  const [blocoFiltro, setBlocoFiltro] = useState("todos");
  const [itemAtivo, setItemAtivo] = useState<ItemRow | null>(null);

  const pedidosPendentes = useMemo(() => {
    return new Set(itens.map((i) => i.pedido.id)).size;
  }, [itens]);

  const blocos = useMemo(() => {
    const s = new Set<string>();
    itens.forEach((i) => i.pedido.bloco_separacao && s.add(i.pedido.bloco_separacao));
    return Array.from(s).sort();
  }, [itens]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return itens.filter((i) => {
      if (canalFiltro !== "todos" && i.pedido.canal?.id !== canalFiltro)
        return false;
      if (blocoFiltro !== "todos" && i.pedido.bloco_separacao !== blocoFiltro)
        return false;
      if (q) {
        const eans = [
          i.produto.ean_principal ?? "",
          ...(i.produto.eans_alternativos ?? []),
        ].join(" ");
        const hay = `${i.produto.sku} ${eans}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [itens, busca, canalFiltro, blocoFiltro]);

  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      <div className="flex items-start justify-between gap-6 mb-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Checkout por Produto
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            Bipe o código de barras de cada produto para liberar o faturamento
          </p>
        </div>
        <div className="rounded-xl bg-primary text-primary-foreground px-6 py-4 text-center shadow-md min-w-[200px]">
          <div className="text-4xl font-bold leading-none">{pedidosPendentes}</div>
          <div className="text-xs uppercase tracking-wider opacity-80 mt-1">
            pedidos pendentes
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-card rounded-xl border p-4 mb-6 flex flex-wrap gap-3 items-center shadow-sm">
        <div className="relative flex-1 min-w-[280px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por SKU ou EAN..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="pl-9 h-11"
          />
        </div>
        <Select value={canalFiltro} onValueChange={setCanalFiltro}>
          <SelectTrigger className="w-[200px] h-11">
            <SelectValue placeholder="Canal de Venda" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os canais</SelectItem>
            {canais.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.nome}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={blocoFiltro} onValueChange={setBlocoFiltro}>
          <SelectTrigger className="w-[200px] h-11">
            <SelectValue placeholder="Bloco" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os blocos</SelectItem>
            {blocos.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Lista */}
      {isLoading ? (
        <div className="text-center py-20 text-muted-foreground">Carregando...</div>
      ) : filtrados.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground bg-card border rounded-xl">
          Nenhum item encontrado com os filtros atuais.
        </div>
      ) : (
        <div className="space-y-4">
          {filtrados.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onBipar={() => setItemAtivo(item)}
            />
          ))}
        </div>
      )}

      <BipagemModal
        item={itemAtivo}
        onClose={() => setItemAtivo(null)}
        onRegistered={() => {
          queryClient.invalidateQueries({ queryKey: ["expedicao-itens"] });
        }}
      />
    </div>
  );
}

function ItemCard({
  item,
  onBipar,
}: {
  item: ItemRow;
  onBipar: () => void;
}) {
  const facil = item.pedido.total_itens === 1;
  const canal = item.pedido.canal;
  const data = item.pedido.data_pedido
    ? new Date(item.pedido.data_pedido).toLocaleDateString("pt-BR")
    : "—";

  return (
    <div className="bg-card border rounded-xl shadow-sm hover:shadow-md transition-shadow p-5 flex gap-5 items-center">
      <div className="relative shrink-0">
        <img
          src={item.produto.foto_url ?? ""}
          alt={item.produto.nome}
          className="w-[180px] h-[180px] object-cover rounded-lg bg-muted"
        />
        {facil && (
          <div className="absolute bottom-2 left-2 right-2 bg-success text-success-foreground text-xs font-semibold px-2 py-1.5 rounded-md text-center flex items-center justify-center gap-1 shadow">
            <Sparkles className="h-3 w-3" />
            Fácil separação
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="text-xl font-bold text-foreground mb-4 leading-tight">
          {item.produto.nome}
        </h3>
        <div className="grid grid-cols-4 gap-6">
          <Field label="Canal de venda">
            <span
              className="inline-block px-3 py-1 rounded-full text-xs font-semibold"
              style={{
                backgroundColor: canal?.cor ?? "#e5e7eb",
                color: pickTextColor(canal?.cor ?? "#e5e7eb"),
              }}
            >
              {canal?.nome ?? "—"}
            </span>
          </Field>
          <Field label="SKU">
            <span className="font-mono font-semibold">{item.produto.sku}</span>
          </Field>
          <Field label="EAN">
            <span className="font-mono text-sm">
              {item.produto.ean_principal ?? "—"}
            </span>
          </Field>
          <Field label="Quantidade">
            <span className="text-2xl font-bold">{item.quantidade}</span>
          </Field>
        </div>
        <div className="mt-4 text-xs text-muted-foreground">
          Pedido #{item.pedido.numero_pedido} • Envio:{" "}
          {item.pedido.metodo_envio ?? "—"} • Data: {data} • Local:{" "}
          {item.produto.localizacao ?? "—"}
        </div>
      </div>

      <div className="shrink-0">
        <Button
          onClick={onBipar}
          className="bg-success hover:bg-success/90 text-success-foreground font-bold text-lg py-7 px-10 h-auto rounded-lg shadow"
        >
          BIPAR
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function pickTextColor(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#000";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#fff";
}

type ResultadoStatus = "ok" | "erro" | null;

function BipagemModal({
  item,
  onClose,
  onRegistered,
}: {
  item: ItemRow | null;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const { user, profile } = useAuth();
  const [valor, setValor] = useState("");
  const [status, setStatus] = useState<ResultadoStatus>(null);
  const [mensagem, setMensagem] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (item) {
      setValor("");
      setStatus(null);
      setMensagem("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [item]);

  if (!item) return null;

  const registrarBipagem = async (
    codigo: string,
    resultado:
      | "sucesso"
      | "erro_ean_invalido"
      | "sem_codigo"
      | "produto_errado"
      | "sem_estoque",
  ) => {
    await supabase.from("bipagens").insert({
      pedido_item_id: item.id,
      codigo_bipado: codigo,
      resultado,
      usuario: profile?.nome ?? user?.email ?? null,
      user_id: user?.id ?? null,
    });
  };

  const handleEnter = async () => {
    if (!valor.trim()) return;
    const code = valor.trim();
    const eans = [
      item.produto.ean_principal ?? "",
      ...(item.produto.eans_alternativos ?? []),
    ].filter(Boolean);
    const ok = eans.includes(code);

    if (ok) {
      setStatus("ok");
      setMensagem("EAN confirmado");
      playBeep(true);
      await registrarBipagem(code, "sucesso");
      onRegistered();
    } else {
      setStatus("erro");
      setMensagem(
        `EAN não confere — esperado: ${item.produto.ean_principal ?? "—"}, recebido: ${code}`,
      );
      playBeep(false);
      await registrarBipagem(code, "erro_ean_invalido");
      onRegistered();
      setTimeout(() => {
        setValor("");
        setStatus(null);
        setMensagem("");
        inputRef.current?.focus();
      }, 1000);
    }
  };

  const excecao = async (
    resultado: "sem_codigo" | "produto_errado" | "sem_estoque",
    label: string,
  ) => {
    await registrarBipagem("", resultado);
    onRegistered();
    toast.success(`Registrado: ${label}`);
    onClose();
  };

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-xl">Bipagem de Produto</DialogTitle>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-0">
          {/* Foto */}
          <div className="col-span-2 bg-muted p-6 flex items-center justify-center">
            <img
              src={item.produto.foto_url ?? ""}
              alt={item.produto.nome}
              className="w-full aspect-square object-cover rounded-xl shadow"
            />
          </div>

          {/* Conteúdo */}
          <div className="col-span-3 p-8 space-y-5">
            <div>
              <h2 className="text-2xl font-bold leading-tight">
                {item.produto.nome}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                SKU: <span className="font-mono">{item.produto.sku}</span> •
                Canal: {item.pedido.canal?.nome ?? "—"}
              </p>
            </div>

            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">
                EAN esperado
              </div>
              <div className="text-4xl font-mono font-bold tracking-tight text-foreground">
                {item.produto.ean_principal ?? "—"}
              </div>
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
                  if (status) {
                    setStatus(null);
                    setMensagem("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleEnter();
                  }
                }}
                className={`w-full h-16 px-4 text-2xl font-mono rounded-lg border-4 outline-none transition-colors bg-background ${
                  status === "ok"
                    ? "border-success"
                    : status === "erro"
                      ? "border-destructive"
                      : "border-input focus:border-primary"
                }`}
                placeholder="Aguardando leitura..."
              />
              {status === "ok" && (
                <div className="mt-3 flex items-center gap-2 text-success font-semibold">
                  <CheckCircle2 className="h-6 w-6" />
                  <span>✅ {mensagem}</span>
                </div>
              )}
              {status === "erro" && (
                <div className="mt-3 flex items-center gap-2 text-destructive font-semibold">
                  <XCircle className="h-6 w-6" />
                  <span>❌ {mensagem}</span>
                </div>
              )}
            </div>

            {status === "ok" && (
              <Button
                onClick={() =>
                  toast.info("Será implementado na próxima fase")
                }
                className="w-full bg-success hover:bg-success/90 text-success-foreground font-bold text-lg py-7 h-auto"
              >
                FATURAR E IMPRIMIR
              </Button>
            )}

            <div className="pt-4 border-t flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => excecao("sem_codigo", "Produto sem código de barras")}
              >
                Produto sem código de barras
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => excecao("produto_errado", "Produto está dando errado")}
              >
                Produto está dando errado
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => excecao("sem_estoque", "Produto sem estoque")}
              >
                Produto sem estoque
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
