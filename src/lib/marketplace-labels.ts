// Fonte única de nome e cor de cada marketplace na UI.
//
// Antes isto vivia duplicado em quatro telas (Checkout, Histórico, Expedidos
// hoje e A expedir), cada uma com uma variação: a Amazon era âmbar numa e
// cinza noutra, o desconhecido virava "Outros" numa e o slug cru noutra, e a
// tela "A expedir" nem lia a coluna `marketplace` — deduzia o canal pelo
// prefixo "2000" do `numero_loja`, o que classificava errado qualquer canal
// novo. Um canal novo aparecia sem nome em três lugares.

export type MarketplaceBadge = { nome: string; cor: string };

const BADGES: Record<string, MarketplaceBadge> = {
  mercadolivre: { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300" },
  mercadolivreflex: { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300" },
  shopee: { nome: "Shopee", cor: "bg-orange-100 text-orange-800 border-orange-300" },
  magalu: { nome: "Magalu", cor: "bg-blue-100 text-blue-800 border-blue-300" },
  amazon: { nome: "Amazon", cor: "bg-amber-100 text-amber-800 border-amber-300" },
};

const COR_DESCONHECIDO = "bg-gray-100 text-gray-700 border-gray-300";

// Canal desconhecido mostra o próprio slug, não "Outros": quando um canal novo
// começa a cair na fila antes de ser mapeado aqui, o operador consegue dizer
// qual é olhando a tela.
export function marketplaceBadge(marketplace: string | null | undefined): MarketplaceBadge {
  if (!marketplace) return { nome: "—", cor: COR_DESCONHECIDO };
  return BADGES[marketplace] ?? { nome: marketplace, cor: COR_DESCONHECIDO };
}

// Variante para o card do Checkout, que não renderiza badge nenhum quando o
// pedido não tem marketplace definido (pedido legado).
export function marketplaceBadgeOuNulo(marketplace: string | null | undefined): MarketplaceBadge | null {
  if (!marketplace) return null;
  return marketplaceBadge(marketplace);
}
