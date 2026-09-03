import * as React from "react";

/**
 * AMARRADO AO `md:` DO TAILWIND (768px). Não mude um sem mudar o outro.
 *
 * O app decide "é celular?" em dois lugares: nas classes `md:` (CSS) e neste hook (JS).
 * `<MobileHidden>` depende dos dois concordarem. Se este valor mudar sem que as classes
 * mudem, aparece uma faixa de largura em que o CSS acha que é desktop e o JS acha que é
 * celular — e a UI passa a mentir sobre quais ações existem.
 */
const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
