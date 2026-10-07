// Traduz o código de erro de uma etiqueta que não pôde ser buscada (EtiquetaResult
// com ok:false, ou o motivo de rejeição da chamada) numa frase curta para o operador.
// Códigos do Magalu ganham texto próprio; qualquer outro código volta cru, de propósito,
// para o operador poder repassar exatamente o que apareceu ao suporte.
export function descreverErroEtiqueta(codigo: string): string {
  const c = (codigo ?? "").trim();
  if (!c) return "Motivo não informado";

  if (c === "magalu_etiqueta_ja_despachada") {
    return "Magalu: a entrega já consta como despachada — a etiqueta não pode mais ser gerada pela API";
  }
  if (c === "magalu_sem_entrega") return "Magalu: pedido sem entrega para gerar etiqueta";
  if (c === "magalu_sem_numero_loja") return "Pedido sem número do Magalu";
  if (c === "magalu_entrega_congelada") {
    return "Magalu: entrega congelada no momento — tente reimprimir mais tarde em Pedidos";
  }
  if (c === "magalu_entregas_canceladas") return "Magalu: a entrega deste pedido foi cancelada";
  if (c.startsWith("magalu_token_error")) {
    return "Magalu desconectado — reconecte em Configurações > Marketplaces";
  }
  if (c.startsWith("magalu_")) return `Magalu recusou a etiqueta (${c})`;

  return c;
}
