// Uma linha da quebra de tarifas. `chave` é o campo de origem na API do
// marketplace — mantida para rastreabilidade quando um valor for contestado.
export type LinhaRepasse = {
  chave: string;
  rotulo: string;
  valor: number;
};

// Formato normalizado de repasse do marketplace. Único tipo que a UI e o banco
// conhecem. O ML devolve uma linha só; a Shopee devolve até seis.
export type RepasseMarketplace = {
  marketplace: "mercado_livre" | "shopee";
  valor_bruto: number;
  tarifa_venda: number;
  tarifa_percentual: number | null;
  custo_envio: number;
  valor_liquido: number;
  final: boolean;
  linhas: LinhaRepasse[];
  // Líquido informado pelo próprio marketplace. A Shopee fornece (escrow_amount);
  // o ML não tem equivalente, então é null e o líquido é o que nós calculamos.
  liquido_informado: number | null;
  envio_coberto_pelo_marketplace: boolean;
  // (bruto − tarifa − envio) − liquido_informado. Auto-conferência: diferente de
  // zero significa que existe uma linha de taxa que não estamos somando.
  divergencia: number | null;
};

export type ItemRepasseMl = {
  unit_price: number;
  quantity: number;
  sale_fee: number;
};

export type PayloadRepasseMl = {
  order_items: ItemRepasseMl[];
  custo_envio: number;
  shipment_status: string | null;
};

function arredondar(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

// O líquido é sempre calculado por nós (bruto − tarifa − envio), nunca copiado
// de um campo do ML: é o número que o usuário confere contra o painel.
export function normalizarRepasseMl(payload: PayloadRepasseMl): RepasseMarketplace {
  const itens = payload.order_items ?? [];

  const valor_bruto = arredondar(itens.reduce((acc, i) => acc + i.unit_price * i.quantity, 0));
  const tarifa_venda = arredondar(itens.reduce((acc, i) => acc + i.sale_fee * i.quantity, 0));
  const custo_envio = arredondar(payload.custo_envio ?? 0);
  const valor_liquido = arredondar(valor_bruto - tarifa_venda - custo_envio);

  // Percentual efetivo (calculado), não a alíquota nominal da categoria: pode
  // divergir da segunda casa do que o painel do ML exibe.
  const tarifa_percentual =
    valor_bruto === 0 ? null : arredondar((tarifa_venda / valor_bruto) * 100);

  return {
    marketplace: "mercado_livre",
    valor_bruto,
    tarifa_venda,
    tarifa_percentual,
    custo_envio,
    valor_liquido,
    final: payload.shipment_status === "delivered",
    linhas: [{ chave: "sale_fee", rotulo: "Tarifa de venda", valor: tarifa_venda }],
    liquido_informado: null,
    envio_coberto_pelo_marketplace: false,
    divergencia: null,
  };
}

// Concatena os dois buckets da rotação do cron respeitando o orçamento. Os
// "nunca verificados" vêm primeiro; o retry só ocupa o que sobrar.
export function montarCandidatosRepasse<T>(
  nuncaVerificados: T[],
  retry: T[],
  orcamento: number,
): T[] {
  return [...nuncaVerificados, ...retry].slice(0, orcamento);
}
