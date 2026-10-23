// Regras de "quando este pedido precisa sair" usadas pela Expedição e pelo card
// "A expedir" do Dashboard. Módulo puro (sem imports) para rodar no node:test.

// Substatus do envio no ML enquanto a etiqueta ainda não foi liberada — no painel
// do ML aparece como "Para entregar na coleta do dia X / você poderá imprimir a
// etiqueta no dia X". Bipar nesse estado só imprime a NF (etiqueta indisponível),
// então o pedido fica fora da tela até o ML liberar (substatus muda para
// ready_to_print, detectado pelo cronMLStatus).
export const ML_SUBSTATUS_ETIQUETA_FUTURA = "buffered";

export function etiquetaMlAguardandoLiberacao(p: { ml_shipment_substatus?: string | null }): boolean {
  return p.ml_shipment_substatus === ML_SUBSTATUS_ETIQUETA_FUTURA;
}

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

// "YYYY-MM-DD" em Brasília (UTC-3) de um timestamp, sem Intl/timeZone nomeado
// (compatível com CF Workers).
export function diaBrasilia(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type PedidoDespacho = {
  raw_json?: any;
  ml_etiqueta_liberada_em?: string | null;
};

// Dia em que o pedido deveria sair. O Bling manda `dataPrevista = "0000-00-00"`
// para boa parte dos pedidos ML com coleta futura (122 de 644 impressos entre
// 23/09 e 23/10/2026) — antes isso caía como "Atrasado" desde o primeiro dia.
// Quando o EXPEDE viu o ML liberar a etiqueta, o dia da liberação também vale:
// o pedido não pode estar atrasado antes de a etiqueta existir.
export function dataReferenciaDespacho(p: PedidoDespacho): string | null {
  const prevista: unknown = p.raw_json?.dataPrevista;
  const previstaValida =
    typeof prevista === "string" && DIA_RE.test(prevista) && prevista !== "0000-00-00" ? prevista : null;
  const liberada = diaBrasilia(p.ml_etiqueta_liberada_em);
  if (previstaValida && liberada) return previstaValida > liberada ? previstaValida : liberada;
  return previstaValida ?? liberada;
}

export type CategoriaData = "hoje" | "proximos" | "atrasado" | null;

export function categoriaDespacho(p: PedidoDespacho, hoje: string): CategoriaData {
  const data = dataReferenciaDespacho(p);
  if (!data) return null;
  if (data === hoje) return "hoje";
  if (data > hoje) return "proximos";
  return "atrasado";
}
