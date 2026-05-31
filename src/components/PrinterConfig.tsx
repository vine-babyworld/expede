import { useEffect, useState } from "react";
import { Printer, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QzTrayHook } from "@/hooks/useQzTray";

const IMPRESSORA_KEY = "qztray_impressora_padrao";
const ZPL_TESTE = "^XA^FO50,50^ADN,36,20^FDTeste EXPEDE^FS^XZ";

type Props = {
  open: boolean;
  onClose: () => void;
  qzTray: QzTrayHook;
};

export function PrinterConfig({ open, onClose, qzTray }: Props) {
  const [impressoras, setImpressoras] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [selecionada, setSelecionada] = useState<string>(
    () => localStorage.getItem(IMPRESSORA_KEY) ?? "",
  );
  const [testando, setTestando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCarregando(true);
    qzTray
      .listarImpressoras()
      .then(setImpressoras)
      .catch((err) => toast.error("Erro ao listar impressoras: " + String(err)))
      .finally(() => setCarregando(false));
  }, [open, qzTray]);

  function salvar(nome: string) {
    setSelecionada(nome);
    localStorage.setItem(IMPRESSORA_KEY, nome);
    toast.success(`Impressora padrão: ${nome}`);
  }

  async function testar() {
    if (!selecionada) {
      toast.error("Selecione uma impressora primeiro");
      return;
    }
    setTestando(true);
    try {
      await qzTray.imprimirZpl(ZPL_TESTE, selecionada);
      toast.success("Teste enviado para " + selecionada);
    } catch (err) {
      toast.error("Erro no teste: " + String(err));
    } finally {
      setTestando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            Configurar Impressora
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {carregando ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Buscando impressoras...
            </div>
          ) : impressoras.length === 0 ? (
            <p className="text-center py-6 text-muted-foreground text-sm">
              Nenhuma impressora encontrada. Verifique se o QZ Tray está rodando.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {impressoras.map((nome) => (
                <li key={nome}>
                  <button
                    onClick={() => salvar(nome)}
                    className={`w-full text-left px-4 py-3 rounded-lg border text-sm transition-colors flex items-center justify-between ${
                      selecionada === nome
                        ? "border-primary bg-primary/5 font-medium"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <span className="truncate">{nome}</span>
                    {selecionada === nome && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={testar}
              disabled={!selecionada || testando}
              className="flex-1"
            >
              {testando ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Printer className="h-4 w-4 mr-2" />
              )}
              Imprimir teste
            </Button>
            <Button size="sm" onClick={onClose} className="flex-1">
              Fechar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
