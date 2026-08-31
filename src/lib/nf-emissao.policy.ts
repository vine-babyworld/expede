export const ML_BLING_LOJA_ID = "203482894";
export const SHOPEE_BLING_LOJA_ID = "204014269";

export type MarketplacePedido = "mercadolivre" | "shopee";
export type ClassificacaoEmissaoNf =
  | "automatic"
  | "manual"
  | "existing"
  | "cancelled"
  | "unknown_logistics"
  | "out_of_scope";

type PedidoFlexLike = {
  marketplace?: string | null;
  raw_json?: any;
};

export function obterServicoLogistico(p: PedidoFlexLike): string {
  return String(p.raw_json?.transporte?.volumes?.[0]?.servico ?? "").trim();
}

// Fonte única usada pela expedição, histórico e controlador fiscal.
export function isPedidoFlex(p: PedidoFlexLike): boolean {
  if (p.marketplace === "mercadolivreflex") return true;
  return obterServicoLogistico(p).toLowerCase().includes("flex");
}

export function obterLojaBlingId(detalhe: any): string | null {
  const id = detalhe?.loja?.id;
  return id == null ? null : String(id);
}

export function marketplacePelaLojaBling(detalhe: any): MarketplacePedido | null {
  const lojaId = obterLojaBlingId(detalhe);
  if (lojaId === ML_BLING_LOJA_ID) return "mercadolivre";
  if (lojaId === SHOPEE_BLING_LOJA_ID) return "shopee";
  return null;
}

export type OpcoesEmissaoNf = {
  /**
   * `app_config.nf_emissao_flex_ativa`. Desligado (padrão), Flex fica como
   * emissão manual do operador no Bling; ligado, Flex segue a mesma trilha do
   * ML normal e o EXPEDE emite.
   */
  emitirFlex?: boolean;
};

export function classificarEmissaoNf(
  detalhe: any,
  marketplace: MarketplacePedido | null,
  opcoes: OpcoesEmissaoNf = {},
): ClassificacaoEmissaoNf {
  if (marketplace !== "mercadolivre") return "out_of_scope";

  // Com o Flex desligado, "manual" prevalece até quando uma NF já existe: o
  // EXPEDE pode sincronizar o ID, mas nunca deve enviar uma nota Flex criada
  // manualmente pelo operador. Ligado, cai nas mesmas regras do ML normal —
  // inclusive "existing", que sincroniza sem reemitir.
  if (!opcoes.emitirFlex && isPedidoFlex({ marketplace, raw_json: detalhe })) {
    return "manual";
  }
  if (detalhe?.notaFiscal?.id) return "existing";
  if (Number(detalhe?.situacao?.id) === 12) return "cancelled";

  // Falha fechada: sem serviço logístico não há evidência suficiente para
  // afirmar que o pedido é normal e autorizar uma ação fiscal irreversível.
  if (!obterServicoLogistico({ marketplace, raw_json: detalhe })) {
    return "unknown_logistics";
  }

  return "automatic";
}
