import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, FileText, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { getNfConfig, setNfFlexAtiva } from "@/lib/nf-config.functions";

export const Route = createFileRoute("/_app/configuracoes/notas-fiscais")({
  component: NotasFiscaisPage,
});

function NotasFiscaisPage() {
  const getFn = useServerFn(getNfConfig);
  const setFn = useServerFn(setNfFlexAtiva);
  const qc = useQueryClient();
  const [confirmarAtivacao, setConfirmarAtivacao] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["nf-config"],
    queryFn: () => getFn(),
  });

  const salvar = useMutation({
    mutationFn: (ativa: boolean) => setFn({ data: { ativa } }),
    onSuccess: (config) => {
      qc.setQueryData(["nf-config"], config);
      toast.success(
        config.flexAtiva
          ? "NF automática ligada para pedidos ML Flex"
          : "NF do ML Flex voltou a ser manual",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const flexAtiva = data?.flexAtiva ?? false;

  // Ligar produz documento fiscal irreversível; desligar não. Só a ativação
  // passa pela confirmação.
  const handleToggle = (valor: boolean) => {
    if (valor) setConfirmarAtivacao(true);
    else salvar.mutate(false);
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border rounded-xl shadow-sm p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-start gap-3">
            <FileText className="h-6 w-6 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold">
                Emitir NF automaticamente para pedidos ML Flex
              </h2>
              <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
                Desmarcado, o EXPEDE trata todo pedido Flex como emissão manual — a
                nota fica por sua conta, direto no Bling, quando você quiser. Marcado,
                o Flex passa a seguir a mesma trilha do Mercado Livre normal: o EXPEDE
                gera e envia a NF sozinho.
              </p>
              <p className="text-xs text-muted-foreground mt-2 max-w-2xl">
                Vale só para os <strong>pedidos Flex futuros</strong>, a partir do
                momento em que você marcar. Os Flex que já estão na base continuam
                manuais e não são reprocessados.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {(isLoading || salvar.isPending) && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={flexAtiva}
              disabled={isLoading || salvar.isPending}
              onCheckedChange={handleToggle}
              aria-label="Emitir NF automaticamente para pedidos ML Flex"
            />
          </div>
        </div>

        <div className="mt-4 pt-4 border-t">
          <span
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${
              flexAtiva
                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                : "bg-gray-100 text-gray-600 border-gray-200"
            }`}
          >
            {flexAtiva ? "Flex: NF automática pelo EXPEDE" : "Flex: emissão manual no Bling"}
          </span>
        </div>
      </div>

      <div className="flex items-start gap-2 text-xs text-muted-foreground px-1">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-px text-amber-500" />
        <p className="max-w-2xl">
          Se a automação nativa do Bling (&quot;Automatizar emissão de nota fiscal&quot;)
          estiver ligada na loja do Mercado Livre, os dois emitem em paralelo. Mantenha
          os toggles do Bling desligados enquanto o EXPEDE estiver no comando.
        </p>
      </div>

      <AlertDialog open={confirmarAtivacao} onOpenChange={setConfirmarAtivacao}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ligar emissão de NF para o Flex?</AlertDialogTitle>
            <AlertDialogDescription>
              A partir de agora o EXPEDE vai gerar e enviar nota fiscal para cada
              pedido ML Flex que entrar. Nota fiscal emitida é documento fiscal
              real — desligar depois não desfaz o que já saiu. Os pedidos Flex que
              já estão na base continuam manuais.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => salvar.mutate(true)}>
              Ligar emissão automática
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
