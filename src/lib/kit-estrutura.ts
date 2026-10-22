// Explosão de kits do Bling (produto formato "E" — "com composição") nos componentes
// físicos que a expedição tem que bipar. Lógica pura, sem Supabase, para ser usada pelos
// três caminhos que gravam pedido_itens (reconciliador, webhook e importação admin) e
// testada em test/kit-estrutura.test.mjs.
//
// Contexto (22/10/2026, pedido ML 2000019102234438): o kit BB1269-KIT3 = 3x BB1269 entrava
// como item simples de quantidade 1 e, como o kit tem o mesmo GTIN da unidade no Bling, um
// único bipe concluía o pedido e imprimia a etiqueta. O único kit que o EXPEDE reconhecia
// era o de SKU com "/" (parseComponentesKit); a estrutura cadastrada no Bling, que já vinha
// em produtos.raw_data pelo sync de detalhe, era ignorada.

/** Produto do cadastro local (tabela produtos) no formato mínimo que a explosão precisa. */
export type ProdutoCadastro = {
  id: string;
  bling_product_id: number;
  sku: string | null;
  gtin: string | null;
  nome: string | null;
  raw_data: any;
};

export type ComponenteKit = { blingProductId: number; quantidade: number };

export type LinhaItemPedido = {
  blingItemId: number | null;
  produtoId: string | null;
  sku: string | null;
  /** GTIN do componente quando explodido; null quando o item passou direto (o chamador resolve). */
  ean: string | null;
  descricao: string;
  quantidade: number;
  valorUnitario: number | null;
  explodido: boolean;
  /** Item original do Bling — o chamador usa para depósito e para resolver produto/EAN. */
  original: any;
};

export type ResultadoExplosao = {
  linhas: LinhaItemPedido[];
  /** SKUs dos kits que viraram componentes. */
  kitsExplodidos: string[];
  /** Kits formato E que ficaram como item simples porque falta componente no cadastro. */
  kitsSemComponente: string[];
};

// Kit dentro de kit é raro; o limite só protege contra estrutura circular no cadastro.
const PROFUNDIDADE_MAXIMA = 4;

/**
 * Componentes de um produto formato "E" a partir do raw_data do detalhe do Bling.
 * Devolve null quando o produto não é kit ou quando o detalhe ainda não foi sincronizado
 * (sem estrutura não há como saber o que tem dentro).
 */
export function componentesDaEstrutura(rawData: any): ComponenteKit[] | null {
  if (!rawData || rawData.formato !== "E") return null;
  const lista = rawData.estrutura?.componentes;
  if (!Array.isArray(lista) || lista.length === 0) return null;

  const out: ComponenteKit[] = [];
  for (const c of lista) {
    const blingProductId = Number(c?.produto?.id);
    const quantidade = Number(c?.quantidade);
    if (!Number.isFinite(blingProductId) || blingProductId <= 0) return null;
    if (!Number.isFinite(quantidade) || quantidade <= 0) return null;
    out.push({ blingProductId, quantidade });
  }
  return out;
}

/** Ids Bling dos produtos dos itens do pedido (para o chamador carregar o cadastro). */
export function blingProductIdsDosItens(itens: any[]): number[] {
  const ids = new Set<number>();
  for (const it of itens ?? []) {
    const id = Number(it?.produto?.id);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** Ids Bling dos componentes dos kits presentes no cadastro carregado que ainda faltam nele. */
export function componentesFaltando(cadastro: Map<number, ProdutoCadastro>): number[] {
  const faltando = new Set<number>();
  for (const p of cadastro.values()) {
    for (const c of componentesDaEstrutura(p.raw_data) ?? []) {
      if (!cadastro.has(c.blingProductId)) faltando.add(c.blingProductId);
    }
  }
  return [...faltando];
}

/**
 * Abre o produto até as unidades físicas. Devolve null se algum componente (em qualquer
 * nível) não estiver no cadastro — nesse caso o kit não é explodido pela metade.
 */
function abrir(
  produto: ProdutoCadastro,
  multiplicador: number,
  cadastro: Map<number, ProdutoCadastro>,
  profundidade: number,
): { produto: ProdutoCadastro; quantidade: number }[] | null {
  const componentes = componentesDaEstrutura(produto.raw_data);
  if (!componentes) return [{ produto, quantidade: multiplicador }];
  if (profundidade >= PROFUNDIDADE_MAXIMA) return null;

  const out: { produto: ProdutoCadastro; quantidade: number }[] = [];
  for (const c of componentes) {
    const filho = cadastro.get(c.blingProductId);
    if (!filho) return null;
    const aberto = abrir(filho, multiplicador * c.quantidade, cadastro, profundidade + 1);
    if (!aberto) return null;
    out.push(...aberto);
  }
  return out;
}

/**
 * Converte os itens do pedido do Bling nas linhas de pedido_itens, explodindo kits formato E
 * pela estrutura cadastrada. Linhas com o mesmo SKU são somadas: pedido_itens é único por
 * (pedido_id, sku), e um kit + a unidade avulsa no mesmo pedido têm que virar uma linha só.
 */
export function explodirItensPorEstrutura(
  itens: any[],
  cadastro: Map<number, ProdutoCadastro>,
  opts: { manterComoItem?: Set<string> } = {},
): ResultadoExplosao {
  const linhas: LinhaItemPedido[] = [];
  const kitsExplodidos: string[] = [];
  const kitsSemComponente: string[] = [];

  for (const it of itens ?? []) {
    const quantidadeItem = Number(it?.quantidade ?? 1);
    const produto = cadastro.get(Number(it?.produto?.id));
    const ehKit = produto != null && componentesDaEstrutura(produto.raw_data) != null;
    // Kit que o chamador mandou manter inteiro (pedido já impresso, ou linha do kit já bipada).
    const manter = opts.manterComoItem?.has(String(it?.codigo ?? "")) ?? false;
    const aberto = ehKit && !manter ? abrir(produto, quantidadeItem, cadastro, 0) : null;

    if (!aberto) {
      if (ehKit && !manter) kitsSemComponente.push(String(it?.codigo ?? produto.sku ?? ""));
      linhas.push({
        blingItemId: it?.id ?? null,
        produtoId: null,
        sku: it?.codigo ?? null,
        ean: null,
        descricao: it?.descricao ?? "",
        quantidade: quantidadeItem,
        valorUnitario: it?.valor ?? null,
        explodido: false,
        original: it,
      });
      continue;
    }

    kitsExplodidos.push(String(it?.codigo ?? produto!.sku ?? ""));
    for (const { produto: comp, quantidade } of aberto) {
      linhas.push({
        blingItemId: it?.id ?? null,
        produtoId: comp.id,
        sku: comp.sku,
        ean: comp.gtin && String(comp.gtin).trim() !== "" ? String(comp.gtin).trim() : null,
        descricao: comp.nome ?? `${it?.descricao ?? ""} (componente ${comp.sku ?? ""})`,
        quantidade,
        // O valor é do kit; dividir entre componentes seria inventar preço.
        valorUnitario: null,
        explodido: true,
        original: it,
      });
    }
  }

  return { linhas: agregarPorSku(linhas), kitsExplodidos, kitsSemComponente };
}

function agregarPorSku(linhas: LinhaItemPedido[]): LinhaItemPedido[] {
  const porSku = new Map<string, LinhaItemPedido>();
  const out: LinhaItemPedido[] = [];
  for (const l of linhas) {
    const chave = l.sku ?? "";
    const existente = chave !== "" ? porSku.get(chave) : undefined;
    if (!existente) {
      const copia = { ...l };
      if (chave !== "") porSku.set(chave, copia);
      out.push(copia);
      continue;
    }
    existente.quantidade += l.quantidade;
    existente.explodido = existente.explodido || l.explodido;
    existente.produtoId = existente.produtoId ?? l.produtoId;
    existente.ean = existente.ean ?? l.ean;
    // Linha somada de kit + avulso não tem um preço unitário único.
    if (existente.valorUnitario !== l.valorUnitario) existente.valorUnitario = null;
  }
  return out;
}
