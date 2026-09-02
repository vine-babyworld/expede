# Design: EXPEDE responsivo para uso administrativo em celular

**Data:** 2026-09-02
**Status:** Aguardando revisão do Vinicius
**Origem:** brainstorm de 2026-09-02 (Claude Code, sessão iniciada em `main` @ `a51cef2`)

---

## Contexto

O EXPEDE hoje é **desktop-only por construção**, não por acidente de estilo. Levantamento
feito no código antes deste design:

| Constatação | Evidência |
|---|---|
| Sidebar fixa de 240px, sempre no fluxo, sem drawer | `src/components/layout/AppShell.tsx:19` — `w-60 shrink-0 ... min-h-screen` |
| Shell em flex horizontal sem nenhum breakpoint | `src/routes/_app.tsx:47` |
| **6 ocorrências** de classes responsivas (`sm:`/`md:`) em ~3.050 linhas de telas | `src/routes/_app/*.tsx` |
| Tabelas HTML cruas de 8–9 colunas, sem contenção | `pedidos.tsx:261`, `historico.tsx`, `a-expedir.tsx`, `expedidos-hoje.tsx` |
| `Header` não tem navegação — só nome, avatar e Sair | `AppShell.tsx:60` |

O que **já está pronto** e reduz muito o custo deste trabalho:

- `src/hooks/use-mobile.tsx` já existe (`useIsMobile()`, breakpoint 768px) e **não é usado
  em lugar nenhum** do projeto.
- `src/components/ui/sheet.tsx` e `drawer.tsx` já instalados (shadcn) — o drawer da sidebar
  sai sem dependência nova.
- Tailwind v4 (`@tailwindcss/vite` 4.2.1) com `@theme inline` em `src/styles.css`;
  breakpoints padrão disponíveis, nada a configurar.
- `<meta name="viewport" content="width=device-width, initial-scale=1">` já presente em
  `src/routes/__root.tsx`.
- **A camada de dados já é mobile-ready.** Todas as telas usam `useServerFn` + `useQuery`
  com `refetchInterval: 60_000`: `getDashboardExpedicao`, `getDashboardVendas`,
  `getMLConnection`, `getShopeeConnection`, `getBlingConnection`, `getProdutosOverview`,
  `getFunilExpedicao`. Os três dados pedidos no enunciado (quantos pedidos processar,
  filtro por marketplace, status das conexões) **já existem e já se atualizam sozinhos**.
- `ExpedicaoPage.tsx` já renderiza `PedidoCard` — é baseada em cards, não em tabela.

**Conclusão do levantamento:** este é um trabalho ~90% de apresentação. Nenhum server
function novo, nenhuma migration, nenhuma mudança de schema.

---

## Objetivo

Permitir que o **administrador**, fora do escritório e pelo celular, consiga:

1. Ver **quantos pedidos há para processar** (funil de expedição e contagens).
2. **Filtrar pedidos por marketplace**.
3. Verificar se os **marketplaces e o Bling estão conectados** (e quando o token expira).
4. **Disparar a sincronização** para puxar pedidos novos e alimentar o banco.

Explicitamente **não** é objetivo dar suporte à operação de expedição pelo celular.

## Não-objetivos (YAGNI — fora deste escopo)

- PWA, instalação na tela inicial, service worker, notificação push.
- Qualquer ação operacional pelo celular além do sync (ver tabela na seção 4).
- Modo escuro. O `@custom-variant dark` está declarado em `src/styles.css`, mas **nada no
  app aplica a classe `.dark`** — não há alternador de tema hoje, e este trabalho não cria
  um.
- Introduzir framework de teste unitário no projeto.
- Refatorar `ExpedicaoPage.tsx` (1.117 linhas) para além do necessário à responsividade.
- Migrar a navegação para o `components/ui/sidebar.tsx` do shadcn.

---

## Decisões tomadas (confirmadas pelo Vinicius em 2026-09-02)

| # | Decisão | Escolha | Alternativas descartadas |
|---|---|---|---|
| D1 | Arquitetura | **Responsivo na mesma base de código** (breakpoints Tailwind) | Rotas `/m/*` dedicadas; híbrido shell + telas novas |
| D2 | Tabelas no celular | **Opção A — componente `<ResponsiveTable>` dirigido por definição de colunas** | B: markup duplicado `hidden md:block`; C: só `overflow-x-auto` |
| D3 | Escopo de ação no mobile | **Somente visualização**, com uma única exceção: **disparar sync** | Reconectar OAuth; emitir NF; ações sobre pedido |
| D4 | Telas no escopo | Dashboard, Expedição, Histórico, Produtos, Configurações, **e Pedidos** | — |
| D5 | PWA | **Não agora** — apenas site responsivo | PWA instalável; PWA + push |

**Razão de D2 (registrada porque é a decisão que mais paga juros):** a opção B parece mais
barata na primeira escrita, mas obriga toda mudança futura de coluna a ser feita em dois
lugares — que é exatamente a divergência de UI que D1 existe para evitar. A opção C não
resolve o problema real: 9 colunas num viewport de 390px é ilegível mesmo rolando.

---

## Arquitetura

### 1. Breakpoint único e coerente

O sistema inteiro usa **um** ponto de corte: `md` = **768px**.

Isso não é arbitrário — é a única escolha que mantém CSS e JavaScript concordando: o
Tailwind v4 usa `md: 768px` e o `useIsMobile()` já existente usa `(max-width: 767px)`.
**Os dois batem exatamente.** Se alguém mudar `MOBILE_BREAKPOINT` em `use-mobile.tsx` sem
mudar as classes, a UI passa a mentir: haverá uma faixa de largura em que o CSS acha que é
desktop e o JS acha que é mobile.

**Exigência:** `MOBILE_BREAKPOINT` em `src/hooks/use-mobile.tsx` recebe um comentário
apontando essa amarração com o `md:` do Tailwind.

### 2. `AppShell` responsivo — a única mudança estrutural

Arquivos: `src/components/layout/AppShell.tsx`, `src/routes/_app.tsx`.

- Extrair o conteúdo de navegação (o array `items` + o `<Link>` de cada item) para um
  `<SidebarNav />` interno, **usado pelos dois modos**. Uma fonte só de verdade para
  navegação; adicionar um item novo aparece automaticamente no drawer e na sidebar.
- `< md`: a `<aside>` sai do fluxo (`hidden md:flex`). O `<Header>` ganha, à esquerda, um
  botão hambúrguer que abre `<Sheet side="left">` contendo `<SidebarNav />`, e o **título
  da página atual** (derivado do `pathname` contra o mesmo array `items` — sem string
  duplicada).
- `< md`: o bloco nome/cargo colapsa; sobra o avatar, que abre um `<DropdownMenu>` com
  nome, cargo e **Sair**.
- `>= md`: comportamento e aparência **idênticos aos de hoje**. Este é um requisito de
  aceitação, não uma intenção — ver seção 7.
- O `<Sheet>` fecha ao navegar (`onOpenChange` amarrado à mudança de `pathname`), senão o
  drawer fica aberto por cima da página nova.

### 3. `<ResponsiveTable>` — o componente que resolve D2

Arquivo novo: `src/components/ResponsiveTable.tsx` (estimativa ~140 linhas).

Contrato:

```ts
export type ColumnPriority = "primary" | "secondary" | "desktop-only";

export interface ResponsiveColumn<T> {
  id: string;
  header: string;
  /** Renderiza a célula. O MESMO render é usado na <td> e no card. */
  cell: (row: T) => React.ReactNode;
  /**
   * primary      -> linha de destaque no topo do card (máx. 2 por tabela)
   * secondary    -> par rótulo/valor no corpo do card
   * desktop-only -> existe só na tabela; não aparece no card
   */
  priority: ColumnPriority;
  align?: "left" | "right";
  /** Classes aplicadas só à <th>/<td> no modo tabela. */
  className?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Navegação para o detalhe. Permitida no mobile (é leitura). */
  onRowClick?: (row: T) => void;
  /** Botões de ação da linha. NUNCA renderizados abaixo de md — ver seção 4. */
  rowActions?: (row: T) => React.ReactNode;
  loading?: boolean;
  empty?: React.ReactNode;
}
```

Comportamento:

- **`>= md`**: `<table>` com as mesmas classes visuais das tabelas atuais, para que a
  migração não altere o desktop.
- **`< md`**: lista de `<Card>`, um por linha. Colunas `primary` no cabeçalho do card
  (destaque tipográfico), colunas `secondary` num `grid grid-cols-2 gap-x-4 gap-y-1` como
  `rótulo: valor`, colunas `desktop-only` omitidas.
- `loading` renderiza `<Skeleton>` na forma do modo corrente (linhas de tabela ou cards) —
  reserva de espaço, para não gerar layout shift (seção 6, prioridade 3).
- Cada card inteiro é o alvo de toque quando há `onRowClick`, com altura mínima de 44px
  (seção 6, prioridade 2).

**Migração:** `pedidos.tsx`, `historico.tsx`, `a-expedir.tsx`, `expedidos-hoje.tsx` e
`produtos.tsx` trocam a `<table>` manuscrita pela definição de colunas. Isso reduz linhas
em cada uma dessas telas, e não só adiciona.

### 4. Regra de "somente visualização" no mobile

| Ação | `< md` | Onde vive hoje |
|---|---|---|
| **Disparar sincronização / reconciliar** | **única ação permitida** | `dashboard.tsx` (`triggerReconciliar`, `syncMutation`) |
| Bipagem / leitura de código de barras | bloqueada | `BipagemModal` em `ExpedicaoPage.tsx:780` |
| Imprimir etiqueta / DANFE (QZ Tray) | bloqueada | `ExpedicaoPage.tsx`, `pedidos.tsx`, `historico.tsx`, `useQzTray.ts` |
| Emitir NF / ações sobre pedido | bloqueada | `ExpedicaoPage.tsx`, `pedidos.tsx` |
| Reconectar OAuth Bling/ML/Shopee | bloqueada | `configuracoes.bling.tsx`, `configuracoes.marketplaces.tsx` |
| Importar pedido/produto manualmente | bloqueada | `dashboard.tsx`, `produtos.tsx` |
| Filtros, busca, paginação, ver detalhe | permitidas | todas |

**Como isso é implementado — duas camadas, e a razão de serem duas:**

O projeto usa TanStack Start com **SSR**. `useIsMobile()` devolve `false` no primeiro
render (servidor e hidratação) porque `window.matchMedia` não existe no servidor. Se o
esconder dependesse só do hook, **o HTML do servidor entregaria o botão de imprimir
etiqueta**, e ele ficaria tocável durante a janela até a hidratação. Se dependesse só de
CSS (`hidden`), o botão continuaria no DOM — alcançável por leitor de tela e por foco de
teclado.

Portanto, toda ação bloqueada no mobile é envolvida por:

```tsx
<MobileHidden>{/* ação */}</MobileHidden>
```

que aplica **as duas**: `className="hidden md:flex"` (cobre SSR e o primeiro paint) e o
gate por `useIsMobile()` (remove do DOM depois de montado). `<MobileHidden>` mora em
`src/components/MobileHidden.tsx` para que a regra seja um lugar só, auditável por grep,
em vez de 30 condicionais espalhadas.

---

## 5. Telas — o que muda em cada uma

Ordem de entrega deliberada: o item 1 destrava todos os outros.

1. **`AppShell` + `_app.tsx`** — seção 2. Nada mais funciona no celular antes disto.
2. **`ResponsiveTable` + `MobileHidden`** — seções 3 e 4. Componentes base.
3. **`dashboard.tsx` (514 linhas)** — `StatCard` em `grid-cols-2 md:grid-cols-4`;
   `FunilExpedicao` já tem `grid-cols-2 md:grid-cols-4` (`dashboard.tsx:201`), nada a
   fazer; `QueryReportSection` tem `grid-cols-3` fixo (`dashboard.tsx:124`) e precisa de
   breakpoint; cartão de status ML/Bling promovido para o topo no mobile; **botão de sync
   mantido e com alvo >= 44px**; gráficos (Recharts) dentro de container de largura fluida.
4. **`configuracoes.marketplaces.tsx` (149) + `configuracoes.bling.tsx` (403) +
   `configuracoes.index.tsx` + `configuracoes.notas-fiscais.tsx`** — cards de status
   (conectado/desconectado + expiração do token) empilhados; todo botão de conexão,
   desconexão e edição envolto em `<MobileHidden>`. Em `configuracoes.tsx`, as abas viram
   scroll horizontal contido, sem quebrar a página.
5. **`pedidos.tsx` (424)** — migra para `<ResponsiveTable>`; **o filtro por marketplace
   precisa estar alcançável sem zoom** (é um dos quatro objetivos); ações da linha em
   `<MobileHidden>`.
6. **`historico.tsx` (376)**, **`a-expedir.tsx` (161)**, **`expedidos-hoje.tsx` (110)** —
   migram para `<ResponsiveTable>`.
7. **`produtos.tsx` (468)** — migra para `<ResponsiveTable>`.
8. **`ExpedicaoPage.tsx` (1.117)** — já é card-based; ajustar largura/padding do
   `PedidoCard`, envolver ações operacionais em `<MobileHidden>`, e **não abrir o
   `BipagemModal` no mobile**. Deixada por último por ser o arquivo mais arriscado e o
   mais usado em produção pela operação.
9. **`login.tsx`** — verificar; é a porta de entrada, e não adianta o resto funcionar se
   não der para entrar pelo celular.

---

## 6. Exigências de qualidade (checklist ui-ux-pro-max)

> **Procedência:** a skill `ui-ux-pro-max` está **parcialmente instalada** nesta máquina —
> só o `SKILL.md`, sem `scripts/search.py` nem as bases CSV. Os itens abaixo vêm da
> **tabela de prioridades 1 a 10 do próprio SKILL.md**, aplicada manualmente ao EXPEDE.
> **Não** vêm de consulta ao banco de 98 diretrizes UX / 192 paletas — essa consulta não
> foi executada porque os scripts não existem aqui. Instalação completa:
> `npx ui-ux-pro-max-cli init --ai claude`.

| Pri | Categoria | Exigência neste projeto |
|---|---|---|
| 1 | **Acessibilidade** | Hambúrguer e avatar são ícone puro e **exigem `aria-label`**. Contraste >= 4.5:1 nos badges de status (o "Desconectado" atual precisa ser verificado). Nunca remover focus ring. Status de conexão **não pode depender só de cor** — texto "Conectado"/"Desconectado" junto do ponto colorido. |
| 2 | **Toque e interação** | Alvos >= **44x44px**: hambúrguer, avatar, botão de sync, cada card clicável, cada item do drawer. Espaçamento >= 8px entre alvos. O botão de sync **precisa de estado de carregando visível** — `syncMutation.isPending` já existe em `dashboard.tsx`. Nada pode depender de `hover` (não existe hover no celular): tooltip com informação essencial vira texto visível. |
| 3 | **Performance** | `<Skeleton>` reservando espaço em toda lista, para CLS < 0.1. Logo `expede-logo-light.png` com `width`/`height` explícitos. Sem `refetchInterval` novo — os 60s existentes já bastam e economizam bateria e dados em 4G. |
| 4 | **Estilo** | Reusar os componentes shadcn já instalados (`card`, `badge`, `sheet`, `skeleton`, `dropdown-menu`). **Zero emoji como ícone** — `lucide-react` já é o padrão do projeto. Não introduzir uma segunda linguagem visual. |
| 5 | **Layout / responsivo** | **Critério objetivo: nenhum scroll horizontal na página em 390px** (seção 7). Nada de largura fixa em px em container. `viewport` já correto e **não pode ganhar `user-scalable=no`**. |
| 6 | **Tipografia e cor** | Corpo >= 16px no mobile (evita o zoom automático do iOS em campos de formulário). Nada abaixo de 12px — hoje existem `text-[11px]` em `AppShell.tsx:63` e no rodapé da sidebar; no mobile precisam subir. Usar tokens semânticos do `styles.css`, sem hex cru. |
| 7 | **Animação** | Transições de 150 a 300ms. O `<Sheet>` do shadcn já respeita `prefers-reduced-motion`. Não animar `width`/`height`. |
| 8 | **Formulários** | Rótulo visível (nunca só placeholder) nos filtros. Erro junto do campo. |
| 9 | **Navegação** | O botão voltar do Android/iOS precisa funcionar — TanStack Router já dá isso, mas **o drawer aberto não pode capturar o voltar** e prender o usuário. Deep link direto para `/pedidos` e demais rotas deve funcionar. |
| 10 | **Gráficos** | Recharts no dashboard: legenda e tooltip legíveis em 390px, ou gráfico simplificado no mobile. |

---

## 7. Verificação

O projeto **não tem framework de teste** hoje, e este design não introduz um (seria efeito
colateral fora de escopo). A verificação é feita com o **Playwright MCP**, já conectado.

Para **cada** rota (`/login`, `/dashboard`, `/expedicao`, `/historico`, `/pedidos`,
`/produtos`, `/configuracoes`, `/configuracoes/marketplaces`, `/configuracoes/bling`,
`/a-expedir`, `/expedidos-hoje`):

**Critério A — sem estouro horizontal (390x844, iPhone 12/13/14):**

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

Deve ser `true`. Este é o critério objetivo de "está responsivo"; sem ele a avaliação vira
gosto pessoal.

**Critério B — não-regressão do desktop (1440x900):** screenshot comparado com o estado
atual antes das mudanças. Diferença visual no desktop é **falha**, não melhoria — a
operação de expedição usa essas telas em produção todo dia.

**Critério C — alvos de toque (390x844):** todo elemento clicável com
`getBoundingClientRect()` de altura e largura >= 44px.

**Critério D — ações bloqueadas ausentes do DOM (390x844):** para cada ação bloqueada na
tabela da seção 4, o elemento **não existe** no DOM após hidratação. Verificar também no
HTML do servidor (`view-source`), que é o caso que só o CSS cobriria.

**Critério E — os quatro objetivos, manualmente, em 390px:** contagem de pedidos a
processar visível; filtro por marketplace usável; status das conexões legível; sync dispara
e mostra feedback.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| **Regressão na expedição em produção.** `ExpedicaoPage.tsx` é o coração operacional e tem 1.117 linhas num arquivo só. | É a **última** tela da fila (seção 5, item 8). O Critério B (screenshot desktop) roda antes e depois. Mudanças limitadas a classes de layout e a envolver ações em `<MobileHidden>` — sem tocar em lógica de negócio. |
| **`useIsMobile` + SSR entregando ação bloqueada no HTML.** | Resolvido por design com as duas camadas do `<MobileHidden>` (seção 4), e verificado pelo Critério D no HTML do servidor. |
| **Migração para `ResponsiveTable` alterar o desktop sem querer.** | O modo `>= md` copia as classes das tabelas atuais. O Critério B pega qualquer desvio. |
| **Escopo inflar para "arrumar o design do EXPEDE".** | Os não-objetivos estão listados. Este trabalho é responsividade, não redesign. |
| **Skill `ui-ux-pro-max` incompleta** dar falsa sensação de cobertura. | Declarado na seção 6. Se o Vinicius rodar `npx ui-ux-pro-max-cli init --ai claude`, a seção 6 pode ser refeita com consulta real ao banco. |

---

## 9. Recomendação sobre GSD

O `.planning/` deste repositório tem apenas um `HANDOFF.json` de auto-checkpoint vazio
(`phase: null`, `plan: null`, sem tarefas). **GSD não está inicializado** neste projeto, e
os 5 designs anteriores em `docs/superpowers/specs/` seguiram o fluxo Superpowers
(spec -> plan -> execução), não GSD.

**Recomendação: seguir com Superpowers (`writing-plans` -> `executing-plans`) para este
trabalho**, e não inicializar GSD agora. Razões: (a) o trabalho é uma fila linear de 9
itens com dependência única e óbvia (o item 1 destrava o resto) — não há descoberta de
requisito nem incerteza arquitetural que justifique o overhead de roadmap e fases do GSD;
(b) inicializar GSD no meio de um projeto com histórico de specs Superpowers cria duas
fontes de verdade de planejamento; (c) o plugin GSD instalado aqui está **100 dias
desatualizado** (v2.44.5, de 2026-05-25), conforme aviso na abertura da sessão.

GSD faz sentido para o EXPEDE num escopo maior — por exemplo a produtização gerenciada
descrita em `2026-09-01-expede-produto-gerenciado-vendavel-design.md`. Se o Vinicius
preferir GSD mesmo assim, o caminho é `/gsd:new-milestone` e este spec vira o insumo de
`/gsd:plan-phase`; o design desta página não muda.

---

## 10. Prompt de implementação

Prompt autocontido para abrir a execução numa sessão nova (Claude Code, na raiz do
repositório EXPEDE):

```
Torne o EXPEDE responsivo para uso administrativo em celular, seguindo
docs/superpowers/specs/2026-09-02-expede-mobile-responsivo-admin-design.md.

Leia o spec inteiro antes de escrever qualquer codigo. Ele e a fonte da verdade;
em qualquer divergencia entre este prompt e o spec, vale o spec.

Restricoes inegociaveis:
- Uma base de codigo so. Nada de rotas /m/* nem de markup duplicado por breakpoint.
- Breakpoint unico: md (768px), amarrado ao MOBILE_BREAKPOINT de
  src/hooks/use-mobile.tsx, que ja existe e hoje nao e usado.
- O desktop (>= md) nao pode mudar de aparencia nem de comportamento. A operacao de
  expedicao usa essas telas em producao diariamente. Regressao visual no desktop e
  falha, nao melhoria.
- No celular, a UNICA acao permitida e disparar a sincronizacao (triggerReconciliar,
  em dashboard.tsx). Todas as demais acoes da tabela da secao 4 do spec ficam
  indisponiveis, via o componente <MobileHidden> com as DUAS camadas descritas na
  secao 4 (classe CSS + gate por useIsMobile), porque o projeto usa SSR.
- Sem PWA, sem service worker, sem push. Sem framework de teste novo.
- Nenhum server function novo, nenhuma migration. O trabalho e de apresentacao.

Ordem de execucao (a secao 5 do spec detalha cada item; o item 1 destrava o resto):
1. AppShell + _app.tsx responsivos (sidebar vira Sheet no mobile)
2. <ResponsiveTable> e <MobileHidden>
3. dashboard.tsx
4. telas de configuracoes
5. pedidos.tsx
6. historico.tsx, a-expedir.tsx, expedidos-hoje.tsx
7. produtos.tsx
8. ExpedicaoPage.tsx
9. login.tsx

Qualidade: aplique o checklist da secao 6 do spec (prioridades 1 a 10 do
ui-ux-pro-max). Os itens 1 (acessibilidade) e 2 (toque, alvos >= 44px) sao
bloqueantes; do 3 ao 10, aponte no relatorio o que ficou de fora e por que.

Verificacao: use o Playwright MCP e os criterios A a E da secao 7, em 390x844 e
1440x900, para cada rota listada. Reporte os resultados de verdade: se um criterio
falhar, diga qual e onde, nao arredonde.

Commits atomicos, um por item da ordem de execucao, em branch propria a partir de main.
```

---

## Alterações previstas

**Novos:**

- `src/components/ResponsiveTable.tsx`
- `src/components/MobileHidden.tsx`

**Editados:**

- `src/components/layout/AppShell.tsx`, `src/routes/_app.tsx`
- `src/hooks/use-mobile.tsx` (só comentário amarrando o breakpoint ao Tailwind)
- `src/routes/_app/dashboard.tsx`, `pedidos.tsx`, `historico.tsx`, `produtos.tsx`,
  `a-expedir.tsx`, `expedidos-hoje.tsx`, `configuracoes.tsx`, `configuracoes.index.tsx`,
  `configuracoes.bling.tsx`, `configuracoes.marketplaces.tsx`,
  `configuracoes.notas-fiscais.tsx`
- `src/features/expedicao/ExpedicaoPage.tsx`
- `src/routes/login.tsx`

**Sem alteração:** `src/routes/api/**`, `src/integrations/supabase/**`, `supabase/**`,
`src/hooks/useQzTray.ts`, schema do banco.
