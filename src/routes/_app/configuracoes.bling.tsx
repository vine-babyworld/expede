import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plug, RefreshCw, Trash2, CheckCircle2, AlertTriangle, XCircle, Pencil, ShoppingCart } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  blingOAuthStart, getBlingConnection, blingRefreshToken, blingDisconnect,
  setBlingConnectionName, getProdutoCountByConnection,
} from "@/lib/bling.functions";
import { getMLConnection, disconnectML } from "@/lib/ml.functions";



type Search = {
  status?: "ok" | "error";
  message?: string;
  ml?: string;
  msg?: string;
};

export const Route = createFileRoute("/_app/configuracoes/bling")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    status: s.status === "ok" || s.status === "error" ? (s.status as "ok" | "error") : undefined,
    message: typeof s.message === "string" ? s.message : undefined,
    ml: typeof s.ml === "string" ? s.ml : undefined,
    msg: typeof s.msg === "string" ? s.msg : undefined,
  }),
  component: BlingPage,
});

function BlingPage() {
  const search = useSearch({ from: "/_app/configuracoes/bling" });
  const qc = useQueryClient();
  const getConn = useServerFn(getBlingConnection);
  const startFn = useServerFn(blingOAuthStart);
  const refreshFn = useServerFn(blingRefreshToken);
  const setNameFn = useServerFn(setBlingConnectionName);
  const disconnectFn = useServerFn(blingDisconnect);
  const getCountFn = useServerFn(getProdutoCountByConnection);





  const { data: conn, isLoading } = useQuery({
    queryKey: ["bling-connection"],
    queryFn: () => getConn(),
  });

  useEffect(() => {
    if (search.status === "ok") {
      toast.success("Conta Bling conectada");
      qc.invalidateQueries({ queryKey: ["bling-connection"] });
      window.history.replaceState({}, "", "/configuracoes/bling");
    } else if (search.status === "error") {
      toast.error("Erro ao conectar: " + (search.message ?? "desconhecido"));
      window.history.replaceState({}, "", "/configuracoes/bling");
    }
    if (search.ml === "conectado") {
      toast.success("Mercado Livre conectado");
      qc.invalidateQueries({ queryKey: ["ml-connection"] });
      window.history.replaceState({}, "", "/configuracoes/bling");
    } else if (search.ml === "erro") {
      toast.error("Erro ao conectar ML: " + (search.msg ?? "desconhecido"));
      window.history.replaceState({}, "", "/configuracoes/bling");
    }
  }, [search.status, search.message, search.ml, search.msg, qc]);

  const startMut = useMutation({
    mutationFn: () => startFn(),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e: Error) => toast.error(e.message),
  });

  const refreshMut = useMutation({
    mutationFn: (id: string) => refreshFn({ data: { connectionId: id } }),
    onSuccess: () => {
      toast.success("Token renovado");
      qc.invalidateQueries({ queryKey: ["bling-connection"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const setNameMut = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      setNameFn({ data: { connectionId: vars.id, name: vars.name } }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success("Nome atualizado");
        setIsEditingName(false);
        qc.invalidateQueries({ queryKey: ["bling-connection"] });
      } else {
        toast.error(r.message);
      }
    },
    onError: () => toast.error("Falha de comunicação. Tente novamente."),
  });


  const { data: countData, isLoading: isLoadingCount } = useQuery({
    queryKey: ["bling-produto-count", conn?.id],
    queryFn: () => getCountFn({ data: { connectionId: conn!.id! } }),
    enabled: !!conn?.id,
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectFn({ data: { connectionId: id } }),
    onSuccess: () => {
      toast.success("Conta desconectada");
      qc.invalidateQueries({ queryKey: ["bling-connection"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });




  const getMLConn = useServerFn(getMLConnection);
  const disconnectMLFn = useServerFn(disconnectML);

  const { data: mlConn, isLoading: mlLoading } = useQuery({
    queryKey: ["ml-connection"],
    queryFn: () => getMLConn(),
  });

  const disconnectMLMut = useMutation({
    mutationFn: () => disconnectMLFn(),
    onSuccess: () => {
      toast.success("Mercado Livre desconectado");
      qc.invalidateQueries({ queryKey: ["ml-connection"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="bg-card border rounded-xl shadow-sm p-10 flex flex-col items-center text-center">
        <Plug className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">Conectar com o Bling</h2>
        <p className="text-sm text-muted-foreground max-w-md mb-6">
          Autorize o EXPEDE a ler pedidos e produtos da sua conta Bling. Os tokens
          ficam criptografados e renovados automaticamente.
        </p>
        <Button size="lg" disabled={startMut.isPending} onClick={() => startMut.mutate()}>
          {startMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plug className="h-4 w-4 mr-2" />}
          Conectar com Bling
        </Button>
      </div>
    );
  }

  const status = conn.status as string;
  const statusBadge =
    status === "connected" ? { cls: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2, label: "Conectado" } :
    status === "expired" ? { cls: "bg-amber-100 text-amber-700 border-amber-200", icon: AlertTriangle, label: "Expirado" } :
    { cls: "bg-rose-100 text-rose-700 border-rose-200", icon: XCircle, label: status === "revoked" ? "Revogado" : "Erro" };
  const Icon = statusBadge.icon;

  const fmt = (d?: string | null) => d ? new Date(d).toLocaleString("pt-BR") : "—";

  const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleString("pt-BR") : "—";

  return (
    <>
    {/* ── Mercado Livre ───────────────────────────────────────────────────── */}
    <div className="bg-card border rounded-xl shadow-sm overflow-hidden mb-6">
      <div className="p-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <ShoppingCart className="h-6 w-6 text-yellow-500" />
          <div>
            <h2 className="text-base font-semibold">Mercado Livre</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Usado como fallback para etiquetas de transporte quando o Bling não retorna ZPL.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {mlLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : mlConn?.connected ? (
            <>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-700 border-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Conectado · user {mlConn.ml_user_id}
              </span>
              <span className="text-xs text-muted-foreground">expira {fmtDate(mlConn.expires_at)}</span>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-rose-600 hover:text-rose-700">
                    <Trash2 className="h-4 w-4 mr-2" /> Desconectar
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Desconectar Mercado Livre?</AlertDialogTitle>
                    <AlertDialogDescription>
                      O fallback de etiquetas ML ficará indisponível até reconectar.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={() => disconnectMLMut.mutate()}>
                      Desconectar
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <Button size="sm" onClick={() => { window.location.href = "/api/ml/auth"; }}>
              <Plug className="h-4 w-4 mr-2" />
              Conectar Mercado Livre
            </Button>
          )}
        </div>
      </div>
    </div>

    <div className="bg-card border rounded-xl shadow-sm overflow-hidden">

      <div className="p-6 border-b flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${statusBadge.cls}`}>
              <Icon className="h-3.5 w-3.5" />
              {statusBadge.label}
            </span>
          </div>
          {isEditingName ? (
            <div className="flex items-center gap-2">
              <Input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (conn.id) setNameMut.mutate({ id: conn.id, name: nameInput });
                  } else if (e.key === "Escape") {
                    setIsEditingName(false);
                  }
                }}
                autoFocus
                disabled={setNameMut.isPending}
                maxLength={100}
                className="h-9 w-64"
              />
              <Button
                size="sm"
                onClick={() => conn.id && setNameMut.mutate({ id: conn.id, name: nameInput })}
                disabled={setNameMut.isPending}
              >
                {setNameMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsEditingName(false)}
                disabled={setNameMut.isPending}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameInput(conn.bling_account_name ?? "Conta Bling");
                setIsEditingName(true);
              }}
              className="group flex items-center gap-2 text-left"
            >
              <span className="text-xl font-semibold">
                {conn.bling_account_name ?? "Conta Bling"}
              </span>
              <Pencil className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            </button>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Apelido da conta Bling. Útil quando você tiver múltiplas contas conectadas.
          </p>
          {conn.bling_account_id && (
            <p className="text-xs text-muted-foreground mt-0.5">ID: {conn.bling_account_id}</p>
          )}

        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={refreshMut.isPending || !conn.id}
            onClick={() => conn.id && refreshMut.mutate(conn.id)}
          >
            {refreshMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Forçar renovação
          </Button>
          {status !== "connected" && (
            <Button
              variant="outline"
              size="sm"
              disabled={startMut.isPending}
              onClick={() => startMut.mutate()}
              title="Refaz a autorização com o Bling sem apagar produtos/pedidos já importados"
            >
              {startMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plug className="h-4 w-4 mr-2" />}
              Reconectar
            </Button>
          )}
          {/* disconnect-confirm v2 */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-rose-600 hover:text-rose-700">
                <Trash2 className="h-4 w-4 mr-2" /> Desconectar
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Desconectar conta Bling?</AlertDialogTitle>
                <AlertDialogDescription>
                  {getDisconnectBody(isLoadingCount, countData)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  disabled={isLoadingCount}
                  onClick={() => conn.id && disconnectMut.mutate(conn.id)}
                >
                  Desconectar mesmo assim
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="p-6 grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
        <Field label="Última renovação" value={fmt(conn.last_refresh_at)} />
        <Field label="Access token expira em" value={fmt(conn.access_expires_at)} />
        <Field label="Refresh token expira em" value={fmt(conn.refresh_expires_at)} />
        <Field label="Escopo" value={conn.scope ?? "—"} />
      </div>

      {conn.last_error && (
        <div className="px-6 pb-6">
          <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <strong className="font-semibold">Último erro:</strong> {conn.last_error}
          </div>
        </div>
      )}
    </div>
    </>
  );
}



function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

type CountResult =
  | { ok: true; count: number }
  | { ok: false; reason: string }
  | undefined;

function getDisconnectBody(isLoading: boolean, data: CountResult): ReactNode {
  if (isLoading) return "Verificando quantos produtos serão apagados...";
  if (!data || !data.ok)
    return "Não foi possível verificar a quantidade de produtos. Verifique se realmente deseja continuar.";
  if (data.count === 0)
    return "A conexão será removida. Nenhum produto cadastrado será afetado.";
  const n = data.count;
  return (
    <>
      <strong>{n} produto{n !== 1 ? "s" : ""}</strong>{" "}
      {n !== 1 ? "serão apagados" : "será apagado"} permanentemente. Esta ação não pode ser desfeita.
    </>
  );
}
