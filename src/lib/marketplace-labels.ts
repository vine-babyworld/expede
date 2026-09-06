// Fonte única de nome, cor e logo de cada marketplace na UI.
//
// Antes isto vivia duplicado em quatro telas (Checkout, Histórico, Expedidos
// hoje e A expedir), cada uma com uma variação: a Amazon era âmbar numa e
// cinza noutra, o desconhecido virava "Outros" numa e o slug cru noutra, e a
// tela "A expedir" nem lia a coluna `marketplace` — deduzia o canal pelo
// prefixo "2000" do `numero_loja`, o que classificava errado qualquer canal
// novo. Um canal novo aparecia sem nome em três lugares.

export type MarketplaceBadge = { nome: string; cor: string; logo: string | null };

// Os arquivos em public/marketplaces/ são as marcas oficiais dos canais,
// baixadas do CDN do próprio Mercado Livre e do Wikimedia Commons. Mercado
// Livre, Shopee e Amazon publicam um símbolo; o Magalu só publica a marca
// horizontal, então o badge dele fica mais largo que os outros.
const BADGES: Record<string, MarketplaceBadge> = {
  mercadolivre: { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300", logo: "/marketplaces/mercadolivre.svg" },
  mercadolivreflex: { nome: "Mercado Livre", cor: "bg-yellow-100 text-yellow-800 border-yellow-300", logo: "/marketplaces/mercadolivre.svg" },
  shopee: { nome: "Shopee", cor: "bg-orange-100 text-orange-800 border-orange-300", logo: "/marketplaces/shopee.svg" },
  magalu: { nome: "Magalu", cor: "bg-blue-100 text-blue-800 border-blue-300", logo: "/marketplaces/magalu.svg" },
  amazon: { nome: "Amazon", cor: "bg-amber-100 text-amber-800 border-amber-300", logo: "/marketplaces/amazon.svg" },
};

const COR_DESCONHECIDO = "bg-gray-100 text-gray-700 border-gray-300";

// Canal desconhecido mostra o próprio slug, não "Outros": quando um canal novo
// começa a cair na fila antes de ser mapeado aqui, o operador consegue dizer
// qual é olhando a tela. Sem logo — quem renderiza cai no texto.
export function marketplaceBadge(marketplace: string | null | undefined): MarketplaceBadge {
  if (!marketplace) return { nome: "—", cor: COR_DESCONHECIDO, logo: null };
  return BADGES[marketplace] ?? { nome: marketplace, cor: COR_DESCONHECIDO, logo: null };
}

// Variante para o card do Checkout, que não renderiza badge nenhum quando o
// pedido não tem marketplace definido (pedido legado).
export function marketplaceBadgeOuNulo(marketplace: string | null | undefined): MarketplaceBadge | null {
  if (!marketplace) return null;
  return marketplaceBadge(marketplace);
}

// Logo isolada, para telas que já escrevem o nome do canal (configurações).
export function marketplaceLogo(marketplace: string): string | null {
  return BADGES[marketplace]?.logo ?? null;
}
