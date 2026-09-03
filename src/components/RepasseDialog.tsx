import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PedidoRow } from "@/lib/pedidos.functions";

function formatBRL(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  // Brasília = UTC-3: subtrai 3h manualmente para compatibilidade com CF Workers
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hour}:${min}`;
}

function Linha({ label, valor, negativo }: { label: string; valor: string; negativo?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`tabular-nums text-sm ${negativo ? "text-red-600" : ""}`}>{valor}</span>
    </div>
  );
}

export function RepasseDialog({
  pedido,
  onClose,
}: {
  pedido: PedidoRow | null;
  onClose: () => void;
}) {
  const aberto = pedido !== null;

  function corpo() {
    if (!pedido) return null;

    if (pedido.marketplace !== "mercadolivre") {
      return (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Repasse indisponível para este marketplace.
        </p>
      );
    }

    if (pedido.repasse_checked_at === null) {
      return (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Aguardando sincronização com o Mercado Livre.
        </p>
      );
    }

    if (pedido.repasse_error) {
      return (
        <div className="py-6 text-center space-y-1">
          <p className="text-sm text-red-600">Não foi possível buscar o repasse.</p>
          <p className="text-xs text-muted-foreground font-mono">{pedido.repasse_error}</p>
        </div>
      );
    }

    const percentual =
      pedido.repasse_tarifa_percentual === null
        ? ""
        : ` (${pedido.repasse_tarifa_percentual.toString().replace(".", ",")}%)`;

    return (
      <div className="space-y-1">
        <Linha label="Valor da venda" valor={formatBRL(pedido.repasse_valor_bruto)} />
        <Linha
          label={`Tarifa de venda total${percentual}`}
          valor={`- ${formatBRL(pedido.repasse_tarifa_venda)}`}
          negativo
        />
        <Linha
          label="Custo do envio"
          valor={`- ${formatBRL(pedido.repasse_custo_envio)}`}
          negativo
        />
        <div className="flex items-baseline justify-between pt-3 mt-2 border-t-2">
          <span className="font-medium">Total</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatBRL(pedido.repasse_valor_liquido)}
          </span>
        </div>

        {!pedido.repasse_final && (
          <p className="text-xs text-muted-foreground pt-3">
            O envio ainda não foi entregue — estes valores podem mudar.
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-1">
          Atualizado em {formatDateTime(pedido.repasse_checked_at)}
        </p>
      </div>
    );
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repasse do marketplace</DialogTitle>
          <DialogDescription>
            Pedido {pedido?.numero}
            {pedido?.numero_loja && pedido.numero_loja !== pedido.numero
              ? ` · ${pedido.numero_loja}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {corpo()}
      </DialogContent>
    </Dialog>
  );
}
