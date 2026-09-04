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

// Recorte de `order_income` da Escrow API. Só os campos que entram na conta —
// a resposta real tem ~100 campos, a maioria irrelevante ou zerada no Brasil.
export type OrderIncomeShopee = {
  order_selling_price?: number;
  commission_fee?: number;
  service_fee?: number;
  ads_escrow_top_up_fee_or_technical_support_fee?: number;
  order_ams_commission_fee?: number;
  voucher_from_seller?: number;
  shipping_seller_protection_fee_amount?: number;
  actual_shipping_fee?: number;
  buyer_paid_shipping_fee?: number;
  shopee_shipping_rebate?: number;
  escrow_amount?: number;
  escrow_amount_after_adjustment?: number;
  total_adjustment_amount?: number;
};

export type PayloadRepasseShopee = {
  order_income: OrderIncomeShopee;
  order_status: string | null;
};

// Linhas que a Shopee debita do vendedor, na ordem em que o modal exibe.
// `voucher_from_seller` é desconto dado pelo vendedor, não tarifa da Shopee —
// mas reduz o repasse, então entra. NÃO usar net_commission_fee/net_service_fee:
// eles vêm preenchidos e parecem certos, mas o que a Shopee debita é o bruto
// (o rebate que gera o "net" já está em voucher_from_shopee, bancado por ela).
// Medido em 42/42 pedidos: com os brutos a conta fecha, com os "net" não.
const LINHAS_SHOPEE: Array<{ chave: keyof OrderIncomeShopee; rotulo: string }> = [
  { chave: "commission_fee", rotulo: "Comissão" },
  { chave: "service_fee", rotulo: "Taxa de serviço" },
  { chave: "ads_escrow_top_up_fee_or_technical_support_fee", rotulo: "Taxa de suporte técnico" },
  { chave: "order_ams_commission_fee", rotulo: "Comissão de anúncios (AMS)" },
  { chave: "voucher_from_seller", rotulo: "Cupom do vendedor" },
  { chave: "shipping_seller_protection_fee_amount", rotulo: "Proteção de envio" },
];

// Diferente do ML, aqui o líquido não é calculado por nós: a Shopee informa o
// escrow_amount, que é o que ela de fato deposita. Nós calculamos em paralelo
// só para conferir (campo `divergencia`).
export function normalizarRepasseShopee(payload: PayloadRepasseShopee): RepasseMarketplace {
  const oi = payload.order_income ?? {};
  const num = (v: number | undefined): number => arredondar(v ?? 0);

  const linhas: LinhaRepasse[] = LINHAS_SHOPEE.map(({ chave, rotulo }) => ({
    chave: chave as string,
    rotulo,
    valor: num(oi[chave]),
  })).filter((l) => l.valor !== 0);

  const valor_bruto = num(oi.order_selling_price);
  const tarifa_venda = arredondar(linhas.reduce((acc, l) => acc + l.valor, 0));

  // O rebate da Shopee cobre o frete em 40 dos 42 pedidos medidos: sob o
  // Programa de Frete Grátis o vendedor não paga frete, paga comissão maior.
  const rebate = num(oi.shopee_shipping_rebate);
  const custo_envio = arredondar(
    num(oi.actual_shipping_fee) - num(oi.buyer_paid_shipping_fee) - rebate,
  );

  const houveAjuste = num(oi.total_adjustment_amount) !== 0;
  const liquido_informado = houveAjuste
    ? num(oi.escrow_amount_after_adjustment)
    : num(oi.escrow_amount);

  const calculado = arredondar(valor_bruto - tarifa_venda - custo_envio);

  return {
    marketplace: "shopee",
    valor_bruto,
    tarifa_venda,
    tarifa_percentual:
      valor_bruto === 0 ? null : arredondar((tarifa_venda / valor_bruto) * 100),
    custo_envio,
    valor_liquido: liquido_informado,
    // Na Shopee entregue ≠ liquidado: só em COMPLETED o escrow foi liberado e
    // os valores param de mudar.
    final: payload.order_status === "COMPLETED",
    linhas,
    liquido_informado,
    envio_coberto_pelo_marketplace: custo_envio === 0 && rebate > 0,
    divergencia: arredondar(calculado - liquido_informado),
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
