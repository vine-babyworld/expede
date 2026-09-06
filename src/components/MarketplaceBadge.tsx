import { marketplaceBadge, marketplaceBadgeOuNulo } from "@/lib/marketplace-labels";

// Identificação do canal. Antes o mesmo <span> colorido estava copiado em
// quatro telas com duas variações de tamanho; agora o formato mora aqui.
//
// Canal conhecido aparece só como a logo, sem moldura: a marca já carrega a
// cor do canal, e o pill colorido em volta virava uma segunda borda competindo
// com ela. A moldura sobrou só para o canal ainda não mapeado, que continua
// aparecendo escrito.
type Tamanho = "sm" | "xs";

// A logo é dimensionada só pela altura: cada canal tem uma proporção própria
// (o símbolo do Mercado Livre é quadrado, a sacola da Shopee é vertical e o
// Magalu só tem a marca horizontal), então travar a largura deformaria uns e
// sobraria nos outros.
const LOGO: Record<Tamanho, string> = {
  sm: "h-5 w-auto",
  xs: "h-4 w-auto",
};

const TEXTO: Record<Tamanho, string> = {
  sm: "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
  xs: "inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold",
};

export function MarketplaceBadge({
  marketplace,
  tamanho = "sm",
  ocultarVazio = false,
  className = "",
}: {
  marketplace: string | null | undefined;
  tamanho?: Tamanho;
  /** Pedido legado sem marketplace não renderiza nada, em vez de "—". */
  ocultarVazio?: boolean;
  className?: string;
}) {
  const badge = ocultarVazio ? marketplaceBadgeOuNulo(marketplace) : marketplaceBadge(marketplace);
  if (!badge) return null;

  // Canal ainda não mapeado: mostra o slug cru dentro da moldura neutra, pra o
  // operador conseguir dizer qual canal é.
  if (!badge.logo) {
    return <span className={`shrink-0 ${TEXTO[tamanho]} ${badge.cor} ${className}`}>{badge.nome}</span>;
  }

  // O nome vai no alt/title, para hover e leitor de tela.
  return (
    <img
      src={badge.logo}
      alt={badge.nome}
      title={badge.nome}
      draggable={false}
      className={`shrink-0 ${LOGO[tamanho]} ${className}`}
    />
  );
}
