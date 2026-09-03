import type { ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/**
 * Esconde uma ação abaixo de `md` (768px) em DUAS camadas — e as duas são necessárias:
 *
 * 1. CSS (`hidden md:contents`): o projeto usa SSR. `useIsMobile()` devolve `false` no
 *    primeiro render (servidor e hidratação), porque `window.matchMedia` não existe no
 *    servidor. Sem a classe, o HTML do servidor entregaria o botão e ele ficaria tocável
 *    na janela até a hidratação.
 * 2. Gate por `useIsMobile()`: só CSS deixaria o elemento no DOM — alcançável por leitor
 *    de tela e por foco de teclado, e visível no `view-source`.
 *
 * O `md:contents` faz o wrapper sumir do layout no desktop (não vira uma <div> a mais
 * dentro de um flex/grid), então envolver uma ação existente não muda o desktop.
 * Se o wrapper precisar ser um contêiner de verdade, passe `className="hidden md:flex ..."`.
 *
 * Regra do design (seção 4): no celular a ÚNICA ação permitida é disparar a sincronização
 * de pedidos. Toda outra ação mora dentro deste componente.
 * `grep -rn "MobileHidden" src/` audita a regra.
 */
export function MobileHidden({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return <div className={cn("hidden md:contents", className)}>{children}</div>;
}
