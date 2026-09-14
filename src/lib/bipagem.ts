// Validação de bipagem de EAN — lógica pura, sem dependência de React ou Supabase,
// para poder ser usada tanto na tela (feedback imediato ao operador) quanto no servidor
// (defesa em profundidade: o servidor não confia no resultado que o cliente mandou).
//
// Contexto: até 09/2026 a tela aceitava QUALQUER código quando o item não tinha EAN
// cadastrado (ExpedicaoPage.tsx, commit 366b4ec). Como 90% dos itens não têm EAN, na
// prática a conferência nunca acontecia e a etiqueta era impressa de qualquer jeito.

export type ItemBipagem = {
  id: string;
  sku: string | null;
  ean: string | null;
  produto_gtin: string | null;
  descricao: string;
  quantidade: number;
  quantidade_bipada: number;
};

export type ResultadoBipagem =
  | { status: "sucesso"; item: ItemBipagem; mensagem: string }
  | { status: "ean_divergente"; item: ItemBipagem; esperado: string; mensagem: string }
  | { status: "ean_nao_cadastrado"; item: ItemBipagem; podeLiberarSemEan: true; mensagem: string }
  | { status: "ja_bipado"; item: ItemBipagem; mensagem: string }
  | { status: "pedido_completo"; mensagem: string }
  | { status: "codigo_vazio"; mensagem: string };

/**
 * Canoniza um código de barras para comparação.
 *
 * GTIN-8, UPC-A (12), EAN-13 e GTIN-14 são a mesma numeração com zeros à esquerda
 * diferentes — o padrão GS1 compara todos preenchidos até 14 dígitos. Sem isso, um
 * leitor que devolve UPC-A de 12 dígitos nunca casaria com o EAN-13 cadastrado.
 *
 * Códigos não numéricos (SKU interno, por exemplo) só perdem espaços e viram maiúsculas.
 */
export function normalizarGtin(codigo: string | null | undefined): string | null {
  if (codigo == null) return null;
  const limpo = String(codigo).trim().replace(/[\s\-.]/g, "");
  if (limpo === "") return null;
  if (/^\d+$/.test(limpo)) {
    return limpo.length <= 14 ? limpo.padStart(14, "0") : limpo;
  }
  return limpo.toUpperCase();
}

/** Códigos que o sistema tem cadastrados para o item (do pedido e do produto). */
export function codigosCadastrados(item: ItemBipagem): string[] {
  const out: string[] = [];
  for (const candidato of [item.ean, item.produto_gtin]) {
    const texto = candidato == null ? "" : String(candidato).trim();
    if (texto !== "") out.push(texto);
  }
  return out;
}

export function temEanCadastrado(item: ItemBipagem): boolean {
  return codigosCadastrados(item).length > 0;
}

function pendente(item: ItemBipagem): boolean {
  return Number(item.quantidade_bipada ?? 0) < Number(item.quantidade ?? 1);
}

/**
 * Decide o que fazer com um código bipado. NUNCA devolve "sucesso" sem que o código
 * confira com um EAN cadastrado — item sem EAN cadastrado devolve "ean_nao_cadastrado",
 * que a tela mostra em vermelho e só passa por liberação explícita do operador.
 */
export function validarBipagem({
  itens,
  itemAtivoId,
  codigo,
}: {
  itens: ItemBipagem[];
  itemAtivoId: string | null;
  codigo: string;
}): ResultadoBipagem {
  const alvo = normalizarGtin(codigo);
  if (!alvo) {
    return { status: "codigo_vazio", mensagem: "Bipe um código de barras" };
  }

  const lista = itens ?? [];
  const pendentes = lista.filter(pendente);

  if (pendentes.length === 0) {
    return {
      status: "pedido_completo",
      mensagem: "Todos os itens deste pedido já foram bipados",
    };
  }

  const confere = (item: ItemBipagem) =>
    codigosCadastrados(item).some((c) => normalizarGtin(c) === alvo);

  const match = pendentes.find(confere);
  if (match) {
    return { status: "sucesso", item: match, mensagem: match.descricao };
  }

  // Código válido, mas de um item que já completou a quantidade — avisa em vez de
  // deixar o operador achar que o leitor falhou.
  const jaCompleto = lista.find((i) => !pendente(i) && confere(i));
  if (jaCompleto) {
    return {
      status: "ja_bipado",
      item: jaCompleto,
      mensagem: `"${jaCompleto.descricao}" já está com a quantidade completa`,
    };
  }

  const ativo = pendentes.find((i) => i.id === itemAtivoId) ?? pendentes[0];

  if (!temEanCadastrado(ativo)) {
    return {
      status: "ean_nao_cadastrado",
      item: ativo,
      podeLiberarSemEan: true,
      mensagem:
        `EAN NÃO CADASTRADO — o produto "${ativo.descricao}" (SKU ${ativo.sku ?? "—"}) ` +
        "não tem EAN no sistema. Cadastre o EAN no Bling ou use a liberação do supervisor.",
    };
  }

  const esperado = codigosCadastrados(ativo)[0];
  return {
    status: "ean_divergente",
    item: ativo,
    esperado,
    mensagem: `EAN NÃO CONFERE — esperado ${esperado}, recebido ${String(codigo).trim()}`,
  };
}
