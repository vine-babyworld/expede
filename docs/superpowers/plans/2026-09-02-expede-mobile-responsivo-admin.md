# EXPEDE responsivo para uso administrativo em celular — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar todas as telas do EXPEDE utilizáveis em 390px de largura para consulta administrativa, sem alterar um pixel do desktop (>= 768px) e sem liberar no celular nenhuma ação além do disparo de sincronização.

**Architecture:** Uma base de código só, um breakpoint só (`md` = 768px, amarrado ao `MOBILE_BREAKPOINT` de `use-mobile.tsx`). Dois componentes novos carregam o peso: `<ResponsiveTable>` (uma definição de colunas gera tabela no desktop e cards no celular) e `<MobileHidden>` (esconde ação em duas camadas — CSS para o SSR/primeiro paint, gate por `useIsMobile()` para remover do DOM após hidratação). Nenhum server function novo, nenhuma migration.

**Tech Stack:** TanStack Start (SSR) + TanStack Router/Query, React 18, Tailwind v4, shadcn/ui (`sheet`, `dropdown-menu`, `card`, `skeleton`, `select` já instalados), lucide-react, Recharts. Verificação por Playwright MCP — **o projeto não tem framework de teste e este plano não introduz um** (não-objetivo explícito do spec). Onde um plano normal teria TDD, aqui cada tarefa termina em uma verificação objetiva no browser (`scrollWidth`, `getBoundingClientRect`, screenshot desktop) antes do commit.

**Spec fonte da verdade:** `docs/superpowers/specs/2026-09-02-expede-mobile-responsivo-admin-design.md`

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/components/MobileHidden.tsx` | Única definição da regra "esta ação não existe no celular" (duas camadas). Auditável por grep. | Criar |
| `src/components/ResponsiveTable.tsx` | Uma definição de colunas → `<table>` em `>= md`, lista de cards em `< md`. Skeleton e empty state nos dois modos. | Criar |
| `src/hooks/use-mobile.tsx` | Comentário amarrando `MOBILE_BREAKPOINT` ao `md:` do Tailwind. | Editar |
| `src/components/layout/AppShell.tsx` | `SidebarNav` extraído (fonte única de navegação), `Sidebar` `hidden md:flex`, `Header` com hambúrguer + título + dropdown do avatar no celular. | Editar |
| `src/routes/_app.tsx` | Verificado; muda só se a verificação exigir. | Verificar |
| `src/routes/_app/dashboard.tsx` | Grids com breakpoint, conexões promovidas ao topo no celular, botão de sync >= 44px, gráfico legível. | Editar |
| `src/routes/_app/configuracoes*.tsx` (5 arquivos) | Abas em scroll horizontal contido; cards empilhados; toda ação em `<MobileHidden>`. | Editar |
| `pedidos.tsx`, `historico.tsx`, `a-expedir.tsx`, `expedidos-hoje.tsx`, `produtos.tsx` | Trocam `<table>` manuscrita por definição de colunas. | Editar |
| `src/features/expedicao/ExpedicaoPage.tsx` | Padding/largura do `PedidoCard`, ações em `<MobileHidden>`, `BipagemModal` não abre no celular. | Editar |
| `src/routes/login.tsx` | Porta de entrada; `role="alert"` no erro, dimensões explícitas no logo. | Editar |

**Sem alteração:** `src/routes/api/**`, `src/integrations/supabase/**`, `supabase/**`, `src/hooks/useQzTray.ts`, `src/components/ui/**` (mexer em `button.tsx`/`input.tsx` mudaria o desktop inteiro — alvos de toque são resolvidos por instância com `h-11 md:h-9`).

---

## Convenções que valem para todas as tarefas

1. **Toda classe nova de mobile vem com o par `md:` que restaura o desktop.** `p-4 md:p-6`, `h-11 md:h-8`, `grid-cols-1 md:grid-cols-3`. Se um step não tem `md:`, ele está mudando o desktop — é bug.
2. **Um breakpoint só.** Nada de `sm:`/`lg:` em código novo. Os `sm:` pré-existentes de `historico.tsx` são convertidos para `md:` na Tarefa 6 (em `>= 768px` o resultado é idêntico).
3. **Nada abaixo de 12px no celular:** `text-[11px]`/`text-[10px]` viram `text-xs md:text-[11px]` (ou `md:text-[10px]`).
4. **Alvo de toque >= 44px:** `h-11 md:h-8` para `size="sm"`, `h-11 w-11 md:h-9 md:w-9` para `size="icon"`, `min-h-11 md:min-h-0` para linhas/itens.
5. **Ícone sozinho exige `aria-label`.**
6. **Commit ao fim de cada tarefa**, um por item da ordem de execução do spec.

---

## Tarefa 0: Linha de base do desktop (pré-requisito do Critério B)

O Critério B compara screenshots do desktop **antes e depois**. Sem esta tarefa não existe "antes".

**Files:** nenhum arquivo do repositório é alterado. Saídas no diretório `scratchpad/baseline/` da sessão.

- [ ] **Step 1: Subir o dev server**

Run: `npm run dev` (em background). Ler a porta na saída do Vite (o preset `@lovable.dev/vite-tanstack-config` define a porta; não presuma 5173 nem 3000 — leia da saída).

- [ ] **Step 2: Autenticar no browser do Playwright**

`browser_navigate` para `http://localhost:<porta>/login`.

**CHECKPOINT — parar e pedir ao Vinicius.** As rotas `/_app/*` exigem sessão. Credenciais são arquivo bloqueado por `CLAUDE.md` e nunca devem ser digitadas pelo agente. Peça ao Vinicius que faça o login **ele mesmo** na janela do Playwright. Sem isso, só `/login` é verificável e as tarefas 1-8 ficam sem Critérios B/C/D/E.

- [ ] **Step 3: Capturar o baseline do desktop**

Para cada rota abaixo, com `browser_resize` em **1440x900**, `browser_take_screenshot` salvando como `baseline/<rota>-1440.png`:

```
/login  /dashboard  /expedicao  /historico  /pedidos  /produtos
/configuracoes  /configuracoes/marketplaces  /configuracoes/bling
/configuracoes/notas-fiscais  /a-expedir  /expedidos-hoje
```

- [ ] **Step 4: Registrar o estado de build**

Run: `npm run build`
Expected: build conclui sem erro. Se já estiver quebrado **antes** das mudanças, isso precisa ser dito no relatório e não pode ser confundido com regressão.

- [ ] **Step 5: Sem commit**

Esta tarefa não altera o repositório.

---

## Tarefa 1: `AppShell` + `_app.tsx` responsivos

**Files:**
- Modify: `src/components/layout/AppShell.tsx` (arquivo inteiro reescrito)
- Verify: `src/routes/_app.tsx`

- [ ] **Step 1: Reescrever `src/components/layout/AppShell.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard, Package, ShoppingBag, Settings, LogOut,
  ClipboardList, History, Menu,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const items = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Expedição", to: "/expedicao", icon: Package },
  { label: "Histórico", to: "/historico", icon: History },
  { label: "Pedidos", to: "/pedidos", icon: ClipboardList },
  { label: "Produtos", to: "/produtos", icon: ShoppingBag },
  { label: "Configurações", to: "/configuracoes", icon: Settings },
];

function isActive(pathname: string, to: string) {
  return pathname === to || (to !== "/" && pathname.startsWith(to));
}

/** Título da rota atual, derivado do mesmo array `items` — sem string duplicada. */
function tituloDaRota(pathname: string): string {
  return items.find((it) => isActive(pathname, it.to))?.label ?? "EXPEDE";
}

/**
 * Conteúdo de navegação — fonte única de verdade.
 * Usado pela <aside> do desktop e pelo <Sheet> do celular.
 */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-6 border-b border-white/10">
        <Link to="/expedicao" className="block" onClick={onNavigate}>
          <img
            src="/expede-logo-light.png"
            alt="EXPEDE"
            width={240}
            height={96}
            className="h-12 w-auto"
          />
        </Link>
        <p className="text-xs text-white/50 mt-1">Gestão de Expedição</p>
      </div>
      <nav className="flex-1 py-4">
        {items.map((it) => {
          const active = isActive(pathname, it.to);
          const Icon = it.icon;
          return (
            <Link
              key={it.to}
              to={it.to}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors border-l-[3px] ${
                active
                  ? "bg-sidebar-active border-[#60A5FA] text-white"
                  : "border-transparent text-white/70 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="h-5 w-5" />
              {it.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 text-xs md:text-[11px] text-white/40 border-t border-white/10">
        v0.2 — fase 2
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-60 shrink-0 bg-sidebar text-sidebar-foreground flex-col min-h-screen">
      <SidebarNav />
    </aside>
  );
}

/** Avatar — uma definição só, usada no desktop e no gatilho do menu do celular. */
function AvatarChip({ inicial }: { inicial: string }) {
  return (
    <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-semibold">
      {inicial}
    </div>
  );
}

export function Header() {
  const { profile, isAdmin, signOut } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);

  // Fecha o drawer ao navegar — senão ele fica aberto por cima da página nova.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const nome = profile?.nome ?? "—";
  const inicial = nome.charAt(0).toUpperCase();
  const cargo = isAdmin ? "Administrador" : "Operador";

  return (
    <header className="h-14 border-b bg-card flex items-center justify-between md:justify-end px-4 md:px-6 gap-3">
      {/* Celular: hambúrguer + título da rota */}
      <div className="flex items-center gap-2 min-w-0 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label="Abrir menu de navegação"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-72 p-0 bg-sidebar text-sidebar-foreground border-white/10"
          >
            <SheetTitle className="sr-only">Navegação</SheetTitle>
            <SidebarNav onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>
        <span className="truncate text-base font-semibold">{tituloDaRota(pathname)}</span>
      </div>

      {/* Desktop: nome/cargo + avatar + Sair — idêntico ao de hoje */}
      <div className="hidden md:flex items-center gap-3">
        <div className="text-right">
          <div className="text-sm font-medium leading-tight">{nome}</div>
          <div className="text-[11px] text-muted-foreground leading-tight">{cargo}</div>
        </div>
        <AvatarChip inicial={inicial} />
        <Button variant="ghost" size="sm" onClick={() => signOut()} className="ml-2" title="Sair">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Celular: avatar abre menu com nome, cargo e Sair */}
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Conta de ${nome}`}
            >
              <AvatarChip inicial={inicial} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-sm font-medium">{nome}</div>
              <div className="text-xs font-normal text-muted-foreground">{cargo}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()} className="min-h-11 text-base">
              <LogOut className="mr-2 h-4 w-4" />
              Sair
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
```

Três coisas para não errar aqui:
- A `<aside>` passou de `flex flex-col` para `hidden md:flex ... flex-col`. Em `>= md` é o mesmo elemento com as mesmas classes.
- `SheetContent` do shadcn já traz `p-6` — por isso o `p-0` no `className`. E o Radix Dialog exige título acessível: o `<SheetTitle className="sr-only">` existe para isso, não é decoração.
- O rodapé "v0.2 — fase 2" era `text-[11px]`; virou `text-xs md:text-[11px]` — 12px no celular, 11px no desktop (prioridade 6).

- [ ] **Step 2: Confirmar que `_app.tsx` não precisa mudar**

Run: `sed -n '45,60p' src/routes/_app.tsx`

O shell é `<div className="flex min-h-screen w-full">` com `<Sidebar/>` + `<div className="flex-1 flex flex-col min-w-0">`. Com a `<aside>` em `hidden md:flex`, ela sai do fluxo no celular e a coluna direita (que já tem `min-w-0`) ocupa 100%. **Não altere `_app.tsx` neste step.** Se o Critério A falhar depois, a causa estará no conteúdo da rota.

- [ ] **Step 3: Verificar em 390x844**

`browser_resize` 390x844, navegar para `/dashboard`, rodar via `browser_evaluate`:

```js
({
  overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  overflowMain: (() => { const m = document.querySelector('main'); return m ? m.scrollWidth - m.clientWidth : null; })(),
  asideVisivel: !!document.querySelector('aside')?.offsetParent,
  hamburguer: (() => { const b = document.querySelector('[aria-label="Abrir menu de navegação"]'); return b && { w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }; })(),
})
```

Expected: `overflowDoc <= 0`, `overflowMain <= 0`, `asideVisivel: false`, `hamburguer: { w: 44, h: 44 }`.

`overflowMain` entra junto porque `<main>` tem `overflow-auto`: ele pode rolar horizontalmente sem que `documentElement` estoure, e aí o Critério A passaria mentindo.

- [ ] **Step 4: Abrir o drawer e conferir alvos e fechamento**

Clicar no hambúrguer, screenshot, conferir os 6 itens, clicar em "Pedidos", confirmar que a URL virou `/pedidos` **e o drawer fechou**. Depois `browser_navigate_back` e confirmar volta para `/dashboard` sem drawer preso (prioridade 9).

```js
[...document.querySelectorAll('[role="dialog"] a')].map(a => a.getBoundingClientRect().height)
```
Expected: todos >= 44 (`py-3` = 12+12 + `text-sm` line-height 20 = 44).

- [ ] **Step 5: Não-regressão do desktop**

`browser_resize` 1440x900, screenshot de `/dashboard` e `/expedicao`, comparar com `baseline/`. Diferença visual = falha; corrigir antes de commitar.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/AppShell.tsx
git commit -m "feat(mobile): AppShell responsivo com drawer de navegacao"
```

---

## Tarefa 2: `<MobileHidden>` e `<ResponsiveTable>`

**Files:**
- Create: `src/components/MobileHidden.tsx`
- Create: `src/components/ResponsiveTable.tsx`
- Modify: `src/hooks/use-mobile.tsx`

- [ ] **Step 1: Criar `src/components/MobileHidden.tsx`**

```tsx
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
 * Regra do spec (seção 4): no celular a ÚNICA ação permitida é disparar a sincronização.
 * Toda outra ação mora dentro deste componente. `grep -rn "MobileHidden" src/` audita a regra.
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
```

- [ ] **Step 2: Criar `src/components/ResponsiveTable.tsx`**

```tsx
import type { ReactNode } from "react";
import { MobileHidden } from "@/components/MobileHidden";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type ColumnPriority = "primary" | "secondary" | "desktop-only";

export interface ResponsiveColumn<T> {
  id: string;
  header: string;
  /** Renderiza a célula. O MESMO render é usado na <td> e no card. */
  cell: (row: T) => ReactNode;
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
  /** Navegação para o detalhe. Permitida no celular (é leitura). */
  onRowClick?: (row: T) => void;
  /**
   * Botões de ação da linha. NUNCA renderizados abaixo de md: o componente já os
   * envolve em <MobileHidden>, então a tela que chama não precisa lembrar disso.
   */
  rowActions?: (row: T) => ReactNode;
  /** Classes extras por linha (ex.: `opacity-50` em cancelado). Vale nos dois modos. */
  rowClassName?: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  /** Quantas linhas/cards de skeleton mostrar enquanto carrega. */
  skeletonRows?: number;
}

export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowActions,
  rowClassName,
  loading = false,
  empty,
  skeletonRows = 6,
}: ResponsiveTableProps<T>) {
  const colSpan = columns.length + (rowActions ? 1 : 0);
  const primary = columns.filter((c) => c.priority === "primary");
  const secondary = columns.filter((c) => c.priority === "secondary");

  return (
    <>
      {/* ── Desktop (>= md): tabela, com as mesmas classes visuais das tabelas atuais ── */}
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className={cn(
                    "px-4 py-3 font-medium",
                    c.align === "right" ? "text-right" : "text-left",
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
              {rowActions && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-t">
                  {Array.from({ length: colSpan }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="text-center py-12 text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-t transition-colors hover:bg-muted/30",
                    onRowClick && "cursor-pointer",
                    rowClassName?.(row),
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        "px-4 py-3",
                        c.align === "right" && "text-right",
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <MobileHidden>{rowActions(row)}</MobileHidden>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Celular (< md): um card por linha ── */}
      <div className="md:hidden space-y-2">
        {loading ? (
          Array.from({ length: skeletonRows }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
              <Skeleton className="h-5 w-2/3" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
          ))
        ) : rows.length === 0 ? (
          <div className="rounded-lg border bg-card py-12 text-center text-muted-foreground">
            {empty}
          </div>
        ) : (
          rows.map((row) => {
            const conteudo = (
              <>
                <div className="space-y-0.5">
                  {primary.map((c) => (
                    <div key={c.id} className="text-base font-medium leading-tight break-words">
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
                {secondary.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    {secondary.map((c) => (
                      <div key={c.id} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{c.header}</dt>
                        <dd className="break-words">{c.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            );

            const classes = cn(
              "w-full text-left rounded-lg border bg-card p-4 min-h-11 flex flex-col gap-3",
              rowClassName?.(row),
            );

            return onRowClick ? (
              <button
                key={rowKey(row)}
                type="button"
                onClick={() => onRowClick(row)}
                className={cn(
                  classes,
                  "active:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              >
                {conteudo}
              </button>
            ) : (
              <div key={rowKey(row)} className={classes}>
                {conteudo}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
```

Duas decisões embutidas, para quem for mexer depois:
- **Os dois modos são renderizados e um é escondido por CSS.** É de propósito: escolher o modo com `useIsMobile()` faria o servidor mandar a tabela e o cliente trocar por cards na hidratação — mismatch de hidratação e um flash de tabela estourando a tela. Como as ações da linha já entram em `<MobileHidden>`, o DOM do celular fica sem ação (Critério D) mesmo com a `<table>` presente e em `display:none`.
- **O wrapper visual (`border rounded-lg overflow-hidden`) fica na tela, não aqui**, porque `produtos.tsx` usa `rounded-xl shadow-sm` e coloca a paginação dentro do mesmo wrapper. Cada tela aplica o seu wrapper com `md:` (no celular os cards já têm borda própria).

- [ ] **Step 3: Amarrar o breakpoint em `src/hooks/use-mobile.tsx`**

Trocar a linha `const MOBILE_BREAKPOINT = 768;` por:

```tsx
/**
 * AMARRADO AO `md:` DO TAILWIND (768px). Não mude um sem mudar o outro.
 *
 * O app decide "é celular?" em dois lugares: nas classes `md:` (CSS) e neste hook (JS).
 * `<MobileHidden>` depende dos dois concordarem. Se este valor mudar sem que as classes
 * mudem, aparece uma faixa de largura em que o CSS acha que é desktop e o JS acha que é
 * celular — e a UI passa a mentir sobre quais ações existem.
 */
const MOBILE_BREAKPOINT = 768;
```

- [ ] **Step 4: Verificar que compila**

Run: `npm run build`
Expected: sucesso. Os componentes ainda não têm consumidor — o build só prova que tipam e compilam.

- [ ] **Step 5: Commit**

```bash
git add src/components/MobileHidden.tsx src/components/ResponsiveTable.tsx src/hooks/use-mobile.tsx
git commit -m "feat(mobile): componentes base ResponsiveTable e MobileHidden"
```

---

## Tarefa 3: `dashboard.tsx`

**Files:** Modify `src/routes/_app/dashboard.tsx`

- [ ] **Step 1: Container e cabeçalho**

`<div className="p-6 max-w-6xl space-y-8">` →

```tsx
<div className="p-4 md:p-6 max-w-6xl flex flex-col gap-6 md:gap-8">
```

(`space-y-8` vira `flex flex-col gap-8` porque no Step 4 a seção de conexões precisa de `order-first`, e `order` só funciona em flex/grid. Em `>= md` o espaçamento é o mesmo.)

Cabeçalho e botão de sync:

```tsx
<div className="flex flex-wrap items-center justify-between gap-3">
  <h1 className="text-2xl font-semibold">Dashboard</h1>
  <Button
    variant="outline"
    size="sm"
    onClick={() => syncMutation.mutate()}
    disabled={syncMutation.isPending}
    className="gap-2 h-11 md:h-8"
  >
    <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
    {syncMutation.isPending ? "Sincronizando..." : "Sincronizar pedidos"}
  </Button>
</div>
```

O botão de sync é a única ação liberada no celular — **não** envolver em `<MobileHidden>`. `h-11 md:h-8` dá 44px no celular e mantém o `size="sm"` (32px) no desktop. O estado de carregando já existe (`isPending` troca ícone e texto).

- [ ] **Step 2: Cards de expedição**

`<div className="grid grid-cols-3 gap-4">` → `<div className="grid grid-cols-1 md:grid-cols-3 gap-4">`

- [ ] **Step 3: `StatCard` clicável vira `<button>` (prioridade 1 — acessibilidade)**

Hoje é uma `<div onClick>`: não recebe foco de teclado e não é anunciada como ação. Substituir o corpo do componente por:

```tsx
function StatCard({
  title, value, loading, icon: Icon, bg, onClick,
}: {
  title: string;
  value: string | number;
  loading: boolean;
  icon: React.ElementType;
  bg: string;
  onClick?: () => void;
}) {
  const classes = `w-full text-left rounded-xl p-6 flex items-center gap-4 ${bg} text-white shadow-sm ${
    onClick ? "cursor-pointer transition-opacity hover:opacity-90" : ""
  }`;
  const conteudo = (
    <>
      <Icon className="h-10 w-10 opacity-80 shrink-0" />
      <div>
        <p className="text-sm font-medium opacity-80">{title}</p>
        {loading ? (
          <div className="mt-1 h-8 w-24 bg-white/20 rounded animate-pulse" />
        ) : (
          <p className="text-3xl font-bold tracking-tight">{value}</p>
        )}
      </div>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={classes}>
      {conteudo}
    </button>
  ) : (
    <div className={classes}>{conteudo}</div>
  );
}
```

Navegar para `/a-expedir` é leitura — continua permitido no celular.

- [ ] **Step 4: Conexões — empilhar e promover ao topo no celular**

`<div className="grid grid-cols-2 gap-4">` (seção 3, ML/Bling) →

```tsx
<div className="order-first md:order-none grid grid-cols-1 md:grid-cols-2 gap-4">
```

O spec pede o status de conexão no topo no celular: é um dos quatro objetivos e não deve exigir rolagem.

- [ ] **Step 5: Badge de status não pode depender só de cor (prioridade 1)**

Os badges já trazem o texto "Conectado"/"Desconectado" — o requisito **já está atendido**. Adicionar apenas o ícone que falta no badge desconectado, para paridade com o conectado, nos dois cards:

```tsx
<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
  <XCircle className="h-3 w-3" /> Desconectado
</span>
```

Adicionar `XCircle` à lista de imports de `lucide-react` no topo do arquivo.

- [ ] **Step 6: Gráfico legível em 390px (prioridade 10)**

No topo de `DashboardPage`, adicionar `const isMobile = useIsMobile();` (importar de `@/hooks/use-mobile`). No `LineChart`:

```tsx
<LineChart data={vendas} margin={{ top: 5, right: isMobile ? 8 : 40, left: isMobile ? -16 : 10, bottom: 5 }}>
```

e no eixo direito:

```tsx
<YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} hide={isMobile} />
```

O eixo da direita ("Pedidos") some no celular — a linha continua desenhada e o tooltip continua mostrando o valor. Recharts renderiza no cliente, então `useIsMobile()` aqui não cria mismatch de SSR.

- [ ] **Step 7: Modal do relatório de sincronização**

O contêiner dos `QueryReportSection`: `<div className="grid grid-cols-2 gap-3">` → `<div className="grid grid-cols-1 md:grid-cols-2 gap-3">`.

O `grid-cols-3` **interno** do `QueryReportSection` (Encontrados/Importados/Pulados) fica como está: são três números curtos e, com o contêiner já em uma coluna, cada célula tem ~110px em 390px. Medir no Step 8; se estourar, aí sim `grid-cols-1 md:grid-cols-3`. Registrar no relatório qual das duas saídas foi usada (o spec pediu breakpoint no `grid-cols-3`; se a medição mostrar que cabe, o desvio é deliberado e precisa estar escrito).

- [ ] **Step 8: Verificar**

390x844 em `/dashboard`:

```js
({
  overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  overflowMain: (() => { const m = document.querySelector('main'); return m ? m.scrollWidth - m.clientWidth : null; })(),
  sync: (() => { const b = [...document.querySelectorAll('button')].find(x => /Sincronizar/.test(x.textContent||'')); return b && b.getBoundingClientRect().height; })(),
  alvosPequenos: [...document.querySelectorAll('button, a, [role="button"], input, select')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({ t: (el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,30), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
    .filter(x => x.h < 44 || x.w < 44),
})
```

Expected: `overflowDoc <= 0`, `overflowMain <= 0`, `sync >= 44`, `alvosPequenos: []`.

Abrir o modal de sync (clicar em "Sincronizar pedidos"), esperar o resultado e repetir a medida de overflow com o modal aberto.

Depois, 1440x900: screenshot de `/dashboard` comparado com `baseline/dashboard-1440.png`. Atenção especial à fileira de `StatCard` (viraram `<button>`) e ao espaçamento vertical (`space-y-8` virou `gap-8`).

- [ ] **Step 9: Commit**

```bash
git add src/routes/_app/dashboard.tsx
git commit -m "feat(mobile): dashboard responsivo com conexoes no topo"
```

---

## Tarefa 4: Telas de configurações

**Files:**
- Modify: `src/routes/_app/configuracoes.tsx`
- Modify: `src/routes/_app/configuracoes.index.tsx`
- Modify: `src/routes/_app/configuracoes.bling.tsx`
- Modify: `src/routes/_app/configuracoes.marketplaces.tsx`
- Modify: `src/routes/_app/configuracoes.notas-fiscais.tsx`

Esta é a tela mais importante do celular depois do dashboard: dois dos quatro objetivos (status das conexões e expiração do token) vivem aqui.

- [ ] **Step 1: `configuracoes.tsx` — container e abas em scroll horizontal contido**

`<div className="p-8 max-w-5xl">` → `<div className="p-4 md:p-8 max-w-5xl">` (nos dois retornos do componente, inclusive o de "Apenas administradores": `p-8 max-w-3xl` → `p-4 md:p-8 max-w-3xl`).

Título: `<h1 className="text-3xl font-bold tracking-tight">` → `<h1 className="text-2xl md:text-3xl font-bold tracking-tight">`.

A barra de abas:

```tsx
<div className="mb-6 -mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto">
  <div className="border-b flex gap-1 min-w-max md:min-w-0">
    {tabs.map((t) => {
      const active = t.match(pathname);
      return (
        <Link
          key={t.to}
          to={t.to}
          aria-current={active ? "page" : undefined}
          className={`flex items-center whitespace-nowrap px-4 py-2 min-h-11 md:min-h-0 text-sm font-medium border-b-2 -mb-px transition-colors ${
            active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </Link>
      );
    })}
  </div>
</div>
```

O que cada pedaço faz: o `-mx-4 px-4` deixa a faixa de scroll sangrar até a borda da tela no celular (e é anulado por `md:mx-0 md:px-0`); `min-w-max` faz as 4 abas ficarem numa linha só e rolarem em vez de quebrar; `min-h-11 md:min-h-0` dá os 44px de toque sem mexer nos 32px do desktop; `whitespace-nowrap` impede quebra de "Notas Fiscais".

**Risco a verificar no Step 6:** `overflow-x-auto` também torna o overflow vertical computado como `auto`, o que pode clipar 1px do `-mb-px` da aba ativa. Se o sublinhado da aba ativa sumir ou pular no desktop, trocar por `pb-px -mb-px` no contêiner interno.

- [ ] **Step 2: `configuracoes.marketplaces.tsx` — cards empilhados e botões bloqueados**

Nos três cards (Mercado Livre, Shopee, Amazon), o cabeçalho `<div className="flex items-start justify-between gap-4">` → `<div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">`, e cada botão de conexão envolto:

```tsx
<MobileHidden>
  <Button size="sm" variant="outline" onClick={() => { window.location.href = "/api/ml/auth"; }}>
    <Plug className="h-4 w-4 mr-2" />
    Reconectar
  </Button>
</MobileHidden>
```

O mesmo para o botão da Shopee (`/api/shopee/auth`) e para o botão desabilitado da Amazon. Import: `import { MobileHidden } from "@/components/MobileHidden";`.

Padding dos cards: `p-6` → `p-4 md:p-6` nos três.

O bloco de status (`mt-4 flex flex-wrap items-center gap-3`) já quebra sozinho — **não mexer**, é justamente o que precisa ficar legível no celular.

- [ ] **Step 3: `configuracoes.bling.tsx` — toda ação em `<MobileHidden>`**

Ações a envolver (linhas aproximadas do arquivo atual — confirmar por contexto, não por número):
- botão "Conectar ao Bling" do estado vazio (`size="lg"`, `startMut.mutate()`)
- "Desconectar" do ML + o `AlertDialog` inteiro que ele abre
- "Conectar/Reconectar ML" (`window.location.href = "/api/ml/auth"`)
- lápis de editar nome da conta e os botões Salvar/Cancelar da edição
- "Atualizar token" (`refreshMut`)
- "Adicionar conta" (`startMut`)
- "Desconectar" do Bling + o `AlertDialog` correspondente

Padrão para um `AlertDialog`: envolver o conjunto `<AlertDialog>...</AlertDialog>` inteiro (o gatilho e o conteúdo), não só o botão — senão o diálogo continua montável.

```tsx
<MobileHidden>
  <AlertDialog>
    {/* ...trigger e content como estão hoje... */}
  </AlertDialog>
</MobileHidden>
```

Layout: `<div className="p-6 flex items-center justify-between gap-4">` → `<div className="p-4 md:p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">`; o mesmo para `p-6 border-b flex items-start justify-between gap-4`. E a grade de detalhes `<div className="p-6 grid grid-cols-2 gap-x-8 gap-y-4 text-sm">` → `<div className="p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 text-sm">`.

- [ ] **Step 4: `configuracoes.index.tsx` — tabela de usuários**

Migrar a `<table>` de usuários para `<ResponsiveTable>` seguindo o mesmo padrão da Tarefa 5 (que traz o exemplo completo). Colunas: nome (`primary`), e-mail (`primary`), cargo (`secondary`), status/`Switch` (`secondary`).

**O `<Switch>` de ativar/desativar usuário é ação** — não pode aparecer no celular. Como ele vive numa célula (não em `rowActions`), envolvê-lo explicitamente:

```tsx
cell: (u) => (
  <MobileHidden>
    <Switch checked={u.ativo} onCheckedChange={...} />
  </MobileHidden>
),
```

No celular a coluna fica com o rótulo e sem controle; para não deixar um par rótulo/valor vazio, use uma coluna `secondary` de texto puro ("Ativo"/"Inativo") e uma coluna `desktop-only` com o `Switch`:

```tsx
{ id: "status", header: "Status", priority: "secondary", cell: (u) => (u.ativo ? "Ativo" : "Inativo") },
{ id: "toggle", header: "", priority: "desktop-only", cell: (u) => <MobileHidden><Switch ... /></MobileHidden> },
```

O botão "Novo usuário" e o formulário/modal de criação: `<MobileHidden>`.

Container: `p-8`/`p-6` → `p-4 md:p-8` conforme o que estiver no arquivo.

- [ ] **Step 5: `configuracoes.notas-fiscais.tsx`**

O `<Switch>` de emissão automática e o `AlertDialogAction` de salvar são ações: `<MobileHidden>`. No celular, mostrar o estado atual em texto no lugar do controle:

```tsx
<MobileHidden>
  <Switch checked={...} onCheckedChange={...} />
</MobileHidden>
<span className="md:hidden text-sm text-muted-foreground">
  {valorAtual ? "Ativada" : "Desativada"}
</span>
```

(Aqui o `md:hidden` sozinho basta: é texto de leitura, não ação — não precisa sair do DOM.)

Os `max-w-2xl` de parágrafo não estouram em 390px (`max-width` não força largura mínima) — não mexer.

- [ ] **Step 6: Verificar as quatro rotas**

Em 390x844, para `/configuracoes`, `/configuracoes/bling`, `/configuracoes/marketplaces`, `/configuracoes/notas-fiscais`:

```js
({
  rota: location.pathname,
  overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  overflowMain: (() => { const m = document.querySelector('main'); return m ? m.scrollWidth - m.clientWidth : null; })(),
  acoesProibidas: [...document.querySelectorAll('button, a[href^="/api"]')]
    .map(el => (el.textContent || '').trim())
    .filter(t => /Reconectar|Conectar|Desconectar|Atualizar token|Adicionar conta|Novo usuário|Salvar|Editar/i.test(t)),
  switches: document.querySelectorAll('[role="switch"]').length,
})
```

Expected: `overflowDoc <= 0`, `overflowMain <= 0`, `acoesProibidas: []`, `switches: 0`.

**Critério D no HTML do servidor** (o caso que só CSS não cobriria) — rodar no terminal, não no browser:

```bash
curl -s http://localhost:<porta>/configuracoes/marketplaces | grep -c "Reconectar"
```

Nas rotas autenticadas o SSR devolve a tela de loading/redirect, então o esperado é `0`. Se vier `> 0`, a ação está no HTML do servidor e o `<MobileHidden>` não foi aplicado — corrigir.

Depois, 1440x900: screenshot das quatro rotas contra `baseline/`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/_app/configuracoes.tsx src/routes/_app/configuracoes.index.tsx src/routes/_app/configuracoes.bling.tsx src/routes/_app/configuracoes.marketplaces.tsx src/routes/_app/configuracoes.notas-fiscais.tsx
git commit -m "feat(mobile): configuracoes responsivas com acoes bloqueadas no celular"
```

---

## Tarefa 5: `pedidos.tsx`

**Files:** Modify `src/routes/_app/pedidos.tsx`

Esta é a tela-modelo da migração: as três seguintes repetem o padrão.

- [ ] **Step 1: Imports**

Adicionar:

```tsx
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";
import { MobileHidden } from "@/components/MobileHidden";
```

- [ ] **Step 2: Container, cabeçalho e filtros**

```tsx
<div className="p-4 md:p-6 space-y-4">
  <div className="flex flex-wrap items-center justify-between gap-3">
    <h1 className="text-2xl font-semibold">Pedidos</h1>
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">
        {total} pedido{total !== 1 ? "s" : ""}
      </span>
      <MobileHidden>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setShowPrinterConfig(true)}
          aria-label="Configurar impressora"
          title="Configurar impressora"
        >
          <Printer className="h-4 w-4" />
        </Button>
      </MobileHidden>
    </div>
  </div>

  {/* Filtros */}
  <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
    <div className="relative w-full md:w-64">
      <label htmlFor="busca-pedidos" className="sr-only">Buscar pedido por número</label>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        id="busca-pedidos"
        placeholder="Buscar por número..."
        value={search}
        onChange={(e) => handleSearch(e.target.value)}
        className="pl-9 h-11 md:h-9"
      />
    </div>
    <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium min-h-11 md:min-h-0">
      <input
        type="checkbox"
        className="h-5 w-5 md:h-4 md:w-4 rounded border-gray-300"
        checked={hidecanceled}
        onChange={(e) => handleToggle(e.target.checked)}
      />
      Ocultar cancelados
    </label>
  </div>
```

O `aria-label` no botão da impressora é obrigatório (ícone puro, prioridade 1) — `title` sozinho não conta, e no celular não existe hover para lê-lo.

- [ ] **Step 3: Definir as colunas**

Colocar **dentro** de `PedidosPage`, depois dos handlers (as células usam `formatBRL`/`formatDateTime`, que são de módulo, e nada de estado — mas a definição precisa enxergar os componentes de badge):

```tsx
type PedidoRow = (typeof rows)[number];

const columns: ResponsiveColumn<PedidoRow>[] = [
  {
    id: "numero",
    header: "Número",
    priority: "primary",
    className: "font-mono",
    cell: (row) => (
      <>
        {row.numero}
        {row.numero_loja && row.numero_loja !== row.numero && (
          <span className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {row.numero_loja}
          </span>
        )}
      </>
    ),
  },
  {
    id: "cliente",
    header: "Cliente",
    priority: "primary",
    className: "max-w-[180px] truncate",
    cell: (row) =>
      (row.cliente as any)?.nome ?? (row.cliente as any)?.razaoSocial ?? "—",
  },
  {
    id: "data",
    header: "Data",
    priority: "secondary",
    className: "text-muted-foreground",
    cell: (row) => formatDateTime(row.data_pedido),
  },
  {
    id: "total",
    header: "Total",
    priority: "secondary",
    align: "right",
    className: "tabular-nums",
    cell: (row) => formatBRL(row.total),
  },
  {
    id: "nf",
    header: "NF",
    priority: "secondary",
    className: "font-mono text-xs",
    cell: (row) => row.bling_nota_fiscal_numero ?? "—",
  },
  {
    id: "emissao",
    header: "Emissão NF",
    priority: "secondary",
    cell: (row) => <EmissaoNfBadge status={row.nf_emissao_status} error={row.nf_emissao_error} />,
  },
  {
    id: "situacao",
    header: "Situação",
    priority: "secondary",
    cell: (row) => (
      <SituacaoBadge situacaoId={row.situacao_id} mlShipmentStatus={row.ml_shipment_status} />
    ),
  },
  {
    id: "itens",
    header: "Itens",
    priority: "secondary",
    align: "right",
    className: "text-muted-foreground",
    cell: (row) => row.items_count,
  },
];
```

Duas `primary` (número e cliente), o resto `secondary` — exatamente o teto que o contrato do componente estabelece.

- [ ] **Step 4: Trocar a `<table>` pela `<ResponsiveTable>`**

Todo o bloco de `<div className="border rounded-lg overflow-hidden"> <table> ... </table> </div>` vira:

```tsx
<div className="md:border md:rounded-lg md:overflow-hidden">
  <ResponsiveTable
    columns={columns}
    rows={rows}
    rowKey={(row) => row.id}
    loading={q.isLoading}
    rowClassName={(row) => (row.situacao_id === 12 ? "opacity-50" : "")}
    empty={
      <>
        <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p>Nenhum pedido encontrado</p>
      </>
    }
    rowActions={(row) => {
      const isCanceled = row.situacao_id === 12;
      const isLoading = reimprimindo === row.id;
      const isVisualizando = visualizando === row.id;
      const jaImpresso = Boolean(row.etiqueta_zpl);
      return (
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={isVisualizando || isCanceled}
            onClick={() =>
              handleVisualizar({
                id: row.id,
                bling_pedido_id: row.bling_pedido_id,
                etiqueta_zpl: row.etiqueta_zpl,
                bling_nota_fiscal_id: row.bling_nota_fiscal_id,
                bling_nota_fiscal_numero: row.bling_nota_fiscal_numero,
              })
            }
            title="Visualizar etiqueta como PDF"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            {isVisualizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            Visualizar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLoading}
            onClick={() =>
              handleReimprimir({
                id: row.id,
                bling_pedido_id: row.bling_pedido_id,
                bling_nota_fiscal_id: row.bling_nota_fiscal_id,
                bling_nota_fiscal_numero: row.bling_nota_fiscal_numero,
              })
            }
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : jaImpresso ? (
              <RefreshCw className="h-4 w-4" />
            ) : (
              <Printer className="h-4 w-4" />
            )}
            {jaImpresso ? "Reimprimir" : "Imprimir"}
          </Button>
        </>
      );
    }}
  />
</div>
```

O wrapper virou `md:border md:rounded-lg md:overflow-hidden`: no desktop é a mesma moldura de hoje; no celular some, porque cada card já tem a sua borda.

`rowActions` **não** precisa de `<MobileHidden>` aqui — o `ResponsiveTable` já envolve.

- [ ] **Step 5: Paginação com alvo de toque**

```tsx
<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm text-muted-foreground">
  <span>
    Página {page} de {totalPages} — {total} pedido{total !== 1 ? "s" : ""}
  </span>
  <div className="flex gap-2">
    <Button variant="outline" size="sm" className="flex-1 md:flex-none h-11 md:h-8"
      disabled={page <= 1 || q.isLoading} onClick={() => setPage((p) => p - 1)}>
      Anterior
    </Button>
    <Button variant="outline" size="sm" className="flex-1 md:flex-none h-11 md:h-8"
      disabled={page >= totalPages || q.isLoading} onClick={() => setPage((p) => p + 1)}>
      Próxima
    </Button>
  </div>
</div>
```

Paginação é navegação de leitura — permitida no celular (tabela da seção 4 do spec).

- [ ] **Step 6: `PrinterConfig` fora do celular**

O modal no fim do componente:

```tsx
<MobileHidden>
  <PrinterConfig open={showPrinterConfig} onClose={() => setShowPrinterConfig(false)} qzTray={qzTray} />
</MobileHidden>
```

- [ ] **Step 7: Verificar**

390x844 em `/pedidos`:

```js
({
  overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  overflowMain: (() => { const m = document.querySelector('main'); return m ? m.scrollWidth - m.clientWidth : null; })(),
  tabelasVisiveis: [...document.querySelectorAll('table')].filter(t => t.offsetParent !== null).length,
  cards: document.querySelectorAll('main .md\\:hidden > div, main .md\\:hidden > button').length,
  acoesProibidas: [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim())
    .filter(t => /Imprimir|Reimprimir|Visualizar/i.test(t)),
  alvosPequenos: [...document.querySelectorAll('button, a, input, [role="button"]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({ t: (el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,30), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
    .filter(x => x.h < 44 || x.w < 44),
})
```

Expected: `overflowDoc <= 0`, `overflowMain <= 0`, `tabelasVisiveis: 0`, `acoesProibidas: []`, `alvosPequenos: []`.

1440x900: screenshot contra `baseline/pedidos-1440.png`. **Esta é a comparação mais importante do plano inteiro** — é a primeira tela a trocar `<table>` manuscrita por `<ResponsiveTable>`, e é onde um desvio de padding/alinhamento apareceria. Conferir célula a célula: alinhamento à direita de Total e Itens, largura da coluna Cliente, espaçamento dos dois botões de ação.

- [ ] **Step 8: Commit**

```bash
git add src/routes/_app/pedidos.tsx
git commit -m "feat(mobile): pedidos migrado para ResponsiveTable"
```

---

## Tarefa 6: `historico.tsx`, `a-expedir.tsx`, `expedidos-hoje.tsx`

**Files:**
- Modify: `src/routes/_app/historico.tsx`
- Modify: `src/routes/_app/a-expedir.tsx`
- Modify: `src/routes/_app/expedidos-hoje.tsx`

- [ ] **Step 1: `historico.tsx` — container, cabeçalho e o filtro de marketplace**

O filtro de marketplace desta tela é o objetivo nº 2 do spec ("filtrar pedidos por marketplace"). Ele já existe e já tem `aria-label`; o que falta é largura e alvo de toque.

```tsx
<div className="p-4 md:p-6 space-y-4">
  <div className="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 className="text-2xl font-semibold">Histórico de Expedição</h1>
      <p className="text-sm text-muted-foreground mt-0.5">Pedidos expedidos nos últimos 30 dias</p>
    </div>
    <span className="text-sm text-muted-foreground">
      {total} pedido{total !== 1 ? "s" : ""}
    </span>
  </div>

  {/* Filtros */}
  <div className="flex flex-col gap-3 md:flex-row md:items-center">
    <div className="relative w-full md:max-w-sm">
      <label htmlFor="busca-historico" className="sr-only">Buscar por número, nº da loja ou cliente</label>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        id="busca-historico"
        placeholder="Buscar por número, nº da loja ou cliente..."
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        className="pl-9 pr-9 h-11 md:h-9"
      />
      {busca && (
        <button
          onClick={() => setBusca("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-11 w-11 md:h-8 md:w-8 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label="Limpar busca"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>

    <Select value={marketplace} onValueChange={(value) => { setMarketplace(value); setPage(1); }}>
      <SelectTrigger className="w-full md:w-[220px] h-11 md:h-9" aria-label="Filtrar por marketplace">
        <SelectValue placeholder="Marketplace" />
      </SelectTrigger>
      <SelectContent>
        {MARKETPLACE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value} className="min-h-11 md:min-h-0">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
```

Os `sm:` viraram `md:` (convenção 2). Em `>= 768px` o resultado é idêntico ao de hoje.

- [ ] **Step 2: `historico.tsx` — colunas**

```tsx
type Row = HistoricoRow;

const columns: ResponsiveColumn<Row>[] = [
  {
    id: "numero",
    header: "Nº Pedido",
    priority: "primary",
    cell: (p) => (
      <>
        <span className="font-mono text-xs md:text-xs">{p.numero_loja ?? p.numero}</span>
        {p.numero_loja && (
          <span className="block text-xs md:text-[11px] text-muted-foreground">Bling #{p.numero}</span>
        )}
      </>
    ),
  },
  {
    id: "marketplace",
    header: "Marketplace",
    priority: "secondary",
    cell: (p) => {
      const badge = marketplaceBadge(p.marketplace);
      return (
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${badge.cor}`}>
            {badge.nome}
          </span>
          {isPedidoFlex(p) && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-yellow-100 text-yellow-800 border-yellow-300">
              FLEX
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: "cliente",
    header: "Cliente",
    priority: "primary",
    className: "max-w-[200px] truncate",
    cell: (p) => p.cliente_nome,
  },
  {
    id: "valor",
    header: "Valor",
    priority: "secondary",
    align: "right",
    className: "tabular-nums",
    cell: (p) => formatBRL(p.valor_total),
  },
  {
    id: "expedido",
    header: "Expedido em",
    priority: "secondary",
    className: "text-muted-foreground",
    cell: (p) => formatDateTime(p.printed_at),
  },
];
```

- [ ] **Step 3: `historico.tsx` — tabela e paginação**

```tsx
<div className="md:border md:rounded-lg md:overflow-hidden">
  <ResponsiveTable
    columns={columns}
    rows={rows}
    rowKey={(p) => p.id}
    loading={isLoading}
    empty={
      <>
        <PackageCheck className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p>
          {buscaDebounced || marketplace !== "todos"
            ? "Nenhum pedido encontrado com esses filtros"
            : "Nenhum pedido expedido nos últimos 30 dias"}
        </p>
      </>
    }
    rowActions={(p) => (
      <Button variant="outline" size="sm" onClick={() => handleReimprimir(p)} className="gap-1.5">
        <Printer className="h-3.5 w-3.5" />
        Reimprimir
      </Button>
    )}
  />
</div>
```

Paginação: `<div className="flex items-center justify-between pt-1">` → `<div className="flex items-center justify-between gap-2 pt-1">`, e nos dois botões `className="gap-1.5"` → `className="gap-1.5 h-11 md:h-8"`.

- [ ] **Step 4: `a-expedir.tsx`**

Container `p-6` → `p-4 md:p-6`; cabeçalho `flex items-center justify-between` → `flex flex-wrap items-center justify-between gap-3`; busca `<div className="relative w-64">` → `<div className="relative w-full md:w-64">` com `<label htmlFor="busca-a-expedir" className="sr-only">Buscar por número ou cliente</label>`, `id` no `Input` e `className="pl-9 h-11 md:h-9"`.

Colunas (a tela não tem ações — `rowActions` fica de fora):

```tsx
const columns: ResponsiveColumn<PedidoAExpedir>[] = [
  {
    id: "numero", header: "Número", priority: "primary", className: "font-mono",
    cell: (p) => (
      <>
        {p.numero_loja ?? p.numero}
        {p.numero_loja && p.numero_loja !== p.numero && (
          <div className="text-xs text-muted-foreground">{p.numero}</div>
        )}
      </>
    ),
  },
  {
    id: "cliente", header: "Cliente", priority: "primary", className: "max-w-[180px] truncate",
    cell: (p) => p.cliente?.nome ?? p.cliente?.razaoSocial ?? "—",
  },
  {
    id: "marketplace", header: "Marketplace", priority: "secondary",
    cell: (p) => {
      const marketplace = detectarMarketplace(p.numero_loja);
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          {marketplace && (
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${marketplace.cor}`}>
              {marketplace.nome}
            </span>
          )}
          {isPedidoFlex(p) && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-yellow-100 text-yellow-800 border-yellow-300">
              FLEX
            </span>
          )}
        </div>
      );
    },
  },
  { id: "situacao", header: "Situação", priority: "secondary", cell: (p) => <SituacaoBadge situacaoId={p.situacao_id} /> },
  {
    id: "logistica", header: "Logística", priority: "secondary", className: "text-muted-foreground",
    cell: (p) => (p.raw_json as any)?.transporte?.volumes?.[0]?.servico ?? "—",
  },
  { id: "data", header: "Data", priority: "secondary", className: "text-muted-foreground", cell: (p) => formatDateTime(p.data_pedido) },
  { id: "total", header: "Total", priority: "secondary", align: "right", className: "tabular-nums", cell: (p) => formatBRL(p.total) },
];
```

E a tabela:

```tsx
<div className="md:border md:rounded-lg md:overflow-hidden">
  <ResponsiveTable
    columns={columns}
    rows={filtered}
    rowKey={(p) => p.id}
    loading={q.isLoading}
    empty={
      <>
        <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p>Nenhum pedido encontrado</p>
      </>
    }
  />
</div>
```

- [ ] **Step 5: `expedidos-hoje.tsx`**

Container `p-6` → `p-4 md:p-6`; cabeçalho `flex items-center justify-between` → `flex flex-wrap items-center justify-between gap-3`; botão "Voltar" ganha `className="gap-2 h-11 md:h-8"` (navegação é leitura — **fica** no celular).

```tsx
const columns: ResponsiveColumn<(typeof rows)[number]>[] = [
  { id: "numero", header: "Nº Pedido", priority: "primary", className: "font-mono", cell: (p) => p.numero_loja },
  {
    id: "marketplace", header: "Marketplace", priority: "secondary",
    cell: (p) => {
      const m = marketplaceBadge(p.marketplace);
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${m.cor}`}>
          {m.nome}
        </span>
      );
    },
  },
  { id: "cliente", header: "Cliente", priority: "primary", className: "max-w-[220px] truncate", cell: (p) => p.cliente_nome },
  { id: "valor", header: "Valor", priority: "secondary", align: "right", className: "tabular-nums", cell: (p) => formatBRL(p.valor_total) },
  { id: "horario", header: "Horário", priority: "secondary", className: "text-muted-foreground", cell: (p) => formatTime(p.printed_at) },
];
```

```tsx
<div className="md:border md:rounded-lg md:overflow-hidden">
  <ResponsiveTable
    columns={columns}
    rows={rows}
    rowKey={(p) => p.id}
    loading={q.isLoading}
    empty={
      <>
        <PackageCheck className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p>Nenhum pedido expedido hoje</p>
      </>
    }
  />
</div>
```

- [ ] **Step 6: Verificar as três rotas**

Para `/historico`, `/a-expedir`, `/expedidos-hoje`, em 390x844, o mesmo bloco de medição da Tarefa 5 Step 7 (trocando o regex de `acoesProibidas` por `/Reimprimir/i` em `/historico`; as outras duas não têm ação nenhuma).

Em `/historico`, verificar **o objetivo nº 2 na mão**: abrir o `Select` de marketplace, escolher "Shopee", confirmar que a lista filtra e que o gatilho tem >= 44px de altura.

1440x900: screenshot das três contra `baseline/`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/_app/historico.tsx src/routes/_app/a-expedir.tsx src/routes/_app/expedidos-hoje.tsx
git commit -m "feat(mobile): historico, a-expedir e expedidos-hoje migrados para ResponsiveTable"
```

---

## Tarefa 7: `produtos.tsx`

**Files:** Modify `src/routes/_app/produtos.tsx`

- [ ] **Step 1: Container, cabeçalho e botão de sync de produtos**

`<div className="p-8 max-w-7xl">` → `<div className="p-4 md:p-8 max-w-7xl">`.

```tsx
<div className="flex flex-col md:flex-row md:items-start md:justify-between mb-6 gap-4">
  <div>
    <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Produtos</h1>
    <p className="text-sm text-muted-foreground mt-1">
      {ov.data?.totalProdutos ?? 0} produtos · última sincronização {fmtRel(ov.data?.lastSyncedAt)}
    </p>
  </div>
  {isAdmin && (
    <MobileHidden>
      <Button onClick={handleSync} disabled={syncMut.isPending || !!activeJob}>
        {syncMut.isPending || activeJob
          ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          : <RefreshCw className="h-4 w-4 mr-2" />}
        Sincronizar agora
      </Button>
    </MobileHidden>
  )}
</div>
```

**Este botão vai para `<MobileHidden>`, o do dashboard não.** A ação liberada no celular é `triggerReconciliar` (sincronizar *pedidos*, no dashboard). Sincronizar *produtos* é "importar produto manualmente" na tabela da seção 4 do spec — bloqueada.

- [ ] **Step 2: Filtros**

`<div className="flex flex-wrap gap-3 mb-4">` → `<div className="flex flex-col md:flex-row md:flex-wrap gap-3 mb-4">`, e:

- `Input`: `className="max-w-sm"` → `className="w-full md:max-w-sm h-11 md:h-9"`, com `<label htmlFor="busca-produtos" className="sr-only">Buscar por nome, SKU ou EAN</label>` e o `id` correspondente.
- `SelectTrigger` da conta: `className="w-52"` → `className="w-full md:w-52 h-11 md:h-9"`, com `aria-label="Filtrar por conta Bling"`.
- `SelectTrigger` de status: `className="w-36"` → `className="w-full md:w-36 h-11 md:h-9"`, com `aria-label="Filtrar por status"`.
- `SelectTrigger` de tipo: `className="w-36"` → `className="w-full md:w-36 h-11 md:h-9"`, com `aria-label="Filtrar por tipo"`.

Os três `Select` estavam sem rótulo acessível (prioridade 1 e 8 do checklist): o valor selecionado é a única pista, e no celular não há hover.

- [ ] **Step 3: Colunas**

```tsx
const columns: ResponsiveColumn<any>[] = [
  {
    id: "imagem", header: "", priority: "desktop-only", className: "w-14",
    cell: (p) => p.imagem_url
      ? <img src={p.imagem_url} alt="" width={40} height={40} className="h-10 w-10 rounded object-cover" />
      : <div className="h-10 w-10 rounded bg-muted flex items-center justify-center"><Package className="h-4 w-4 text-muted-foreground" /></div>,
  },
  {
    id: "nome", header: "Nome", priority: "primary",
    cell: (p) => (
      <div className="font-medium flex items-center gap-2">
        <span className="line-clamp-1">{p.nome}</span>
        {!p.ativo && (
          <span className="text-xs md:text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Inativo</span>
        )}
      </div>
    ),
  },
  { id: "sku", header: "SKU", priority: "primary", className: "font-mono text-xs", cell: (p) => p.sku },
  { id: "ean", header: "EAN", priority: "secondary", className: "font-mono text-xs", cell: (p) => p.gtin ?? "—" },
  { id: "estoque", header: "Estoque", priority: "secondary", align: "right", cell: (p) => p.estoque ?? "—" },
  {
    id: "tipo", header: "Tipo", priority: "secondary",
    cell: (p) => (
      <span className="text-xs md:text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary capitalize">{p.tipo}</span>
    ),
  },
  ...(connectionId === "__all"
    ? [{
        id: "conta", header: "Conta", priority: "secondary" as const,
        className: "text-xs text-muted-foreground",
        cell: (p: any) => connName(p.bling_connection_id),
      }]
    : []),
  { id: "sincronizado", header: "Sincronizado", priority: "secondary", className: "text-xs text-muted-foreground", cell: (p) => fmtRel(p.synced_at) },
];
```

A coluna "Conta" é condicional hoje (`{connectionId === "__all" && <th>}`) — o spread condicional preserva esse comportamento sem `<th>`/`<td>` desalinhados.

A imagem vira `desktop-only`: no card do celular ela ocuparia a linha de destaque sem informar nada; nome e SKU são o que identifica o produto. E ganha `width`/`height` explícitos (prioridade 3, CLS).

- [ ] **Step 4: Tabela e paginação**

```tsx
<div className="md:bg-card md:border md:rounded-xl md:shadow-sm md:overflow-hidden">
  <ResponsiveTable
    columns={columns}
    rows={listQ.data?.rows ?? []}
    rowKey={(p) => p.id}
    loading={listQ.isLoading}
    empty={
      <>
        <Package className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
        <p className="text-muted-foreground">
          {debounced || status !== "ativos" || tipo !== "todos" || connectionId !== "__all"
            ? "Nenhum produto encontrado com esses filtros."
            : "Nenhum produto importado ainda."}
        </p>
        {isAdmin && !debounced && (
          <p className="hidden md:block text-xs text-muted-foreground mt-1">
            Clique em <strong>Sincronizar agora</strong> para começar.
          </p>
        )}
      </>
    }
    rowActions={(p) => (
      <>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          disabled={!p.bling_product_id || sincronizando.has(p.bling_product_id)}
          onClick={() => handleSyncProduto(p)}
          aria-label="Sincronizar produto" title="Sincronizar produto"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${sincronizando.has(p.bling_product_id) ? "animate-spin" : ""}`} />
        </Button>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => setEditingProduto(p)}
          aria-label="Editar produto" title="Editar produto"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </>
    )}
  />

  {total > pageSize && (
    <div className="px-4 py-3 md:border-t flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm">
      <span className="text-muted-foreground">Página {page} de {totalPages} · {total} produtos</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1 md:flex-none h-11 md:h-8"
          disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
        <Button variant="outline" size="sm" className="flex-1 md:flex-none h-11 md:h-8"
          disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
      </div>
    </div>
  )}
</div>
```

A dica "Clique em Sincronizar agora" ganhou `hidden md:block`: no celular o botão que ela manda clicar não existe.

Os botões de ação de 28px (`h-7 w-7`) ficam como estão — só existem no desktop, onde 44px não é requisito. E ganharam o `aria-label` que faltava.

- [ ] **Step 5: Modal de edição fora do celular**

```tsx
{editingProduto && (
  <MobileHidden>
    <EditProdutoModal
      produto={editingProduto}
      onClose={() => setEditingProduto(null)}
      onSaved={() => { setEditingProduto(null); qc.invalidateQueries({ queryKey: ["produtos"] }); }}
    />
  </MobileHidden>
)}
```

- [ ] **Step 6: Verificar**

390x844 em `/produtos`, o bloco de medição da Tarefa 5 Step 7 com `acoesProibidas` casando `/Sincronizar|Editar/i`. Expected: vazio, sem overflow, sem tabela visível.

Conferir também que o banner de job (`bannerJob`) não estoura — ele tem `px-4 py-3` e texto longo; se `overflowDoc > 0` com um job ativo, adicionar `break-words` ao `<span>` da mensagem.

1440x900: screenshot contra `baseline/produtos-1440.png`, com atenção à coluna condicional "Conta" (testar com o filtro em "Todas as contas" **e** numa conta específica).

- [ ] **Step 7: Commit**

```bash
git add src/routes/_app/produtos.tsx
git commit -m "feat(mobile): produtos migrado para ResponsiveTable"
```

---

## Tarefa 8: `ExpedicaoPage.tsx`

**Files:** Modify `src/features/expedicao/ExpedicaoPage.tsx`

Arquivo de 1.117 linhas, coração operacional, usado em produção todo dia. Por isso é o penúltimo item e por isso as mudanças aqui são **só de classe de layout e de envolver ações** — nenhuma linha de lógica de negócio muda. Se um step aqui pedir para mexer em `handleImpressaoAutomatica`, `marcarImpresso` ou no fluxo de bipagem, o step está errado.

- [ ] **Step 1: Imports e gate de mobile**

```tsx
import { MobileHidden } from "@/components/MobileHidden";
import { useIsMobile } from "@/hooks/use-mobile";
```

E dentro de `ExpedicaoPage`, junto dos outros hooks: `const isMobile = useIsMobile();`

- [ ] **Step 2: Container e cabeçalho**

```tsx
<div className="p-4 md:p-8 max-w-[1400px] mx-auto">
  {/* Header */}
  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-6 mb-6">
    <div>
      <h1 className="text-2xl md:text-4xl font-bold tracking-tight text-foreground">
        Checkout por Produto
      </h1>
      <p className="text-sm text-muted-foreground mt-2">
        Selecione um pedido e bipe os itens para liberar a expedição
      </p>
    </div>
    <div className="flex items-center gap-3">
      <div className="rounded-xl bg-primary text-primary-foreground px-6 py-4 text-center shadow-md min-w-[160px] flex-1 md:flex-none">
        <div className="text-4xl font-bold leading-none">{filtrados.length}</div>
        <div className="text-xs uppercase tracking-wider opacity-80 mt-1">pedidos pendentes</div>
      </div>
      <MobileHidden>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setShowPrinterConfig(true)}
          aria-label="Configurar impressora"
          title="Configurar impressora"
          className="h-12 w-12"
        >
          <Settings className="h-5 w-5" />
        </Button>
      </MobileHidden>
    </div>
  </div>
```

O contador "pedidos pendentes" é o objetivo nº 1 (quantos pedidos há para processar) — ele **fica** e ganha `flex-1` no celular para ocupar a largura toda quando o botão da impressora desaparece.

`text-4xl` → `text-2xl md:text-4xl`: 36px de título em 390px consome a tela inteira.

- [ ] **Step 3: Filtros — a busca e as pílulas**

```tsx
<div className="bg-card rounded-xl border p-4 mb-6 shadow-sm space-y-3">
  <div className="relative w-full md:max-w-sm">
    <label htmlFor="busca-expedicao" className="sr-only">Buscar por número, loja ou cliente</label>
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
    <Input
      id="busca-expedicao"
      placeholder="Buscar por número, loja ou cliente..."
      value={busca}
      onChange={(e) => setBusca(e.target.value)}
      className="pl-9 h-11"
    />
  </div>
```

(`h-11` já estava — mantém.)

Nas **duas** fileiras de pílulas (marketplace e data), cada `Button` `size="sm"` ganha `className="rounded-full h-11 md:h-8"`. São filtros: leitura, permitidos no celular, e por isso precisam do alvo de 44px.

- [ ] **Step 4: `PedidoCard` — empilhar e bloquear as ações**

Assinatura e lógica não mudam. Só o layout e as ações:

```tsx
<div
  className={`bg-card border rounded-xl shadow-sm p-4 flex flex-col md:flex-row md:items-center gap-4 transition-shadow hover:shadow-md ${
    done ? "opacity-60" : ""
  }`}
>
  {/* Imagem do produto */}
  <div className="shrink-0 w-full h-40 md:w-[150px] md:h-[150px] rounded-lg bg-muted flex flex-col items-center justify-center overflow-hidden border">
```

(o conteúdo interno da imagem fica igual)

O bloco de dados `<div className="flex-1 min-w-0">` fica igual. A grade `grid grid-cols-3 gap-x-6 gap-y-1 text-xs` fica igual — três colunas curtas cabem em 390px menos os paddings (≈110px cada); confirmar no Step 6 e, se estourar, `gap-x-6` → `gap-x-3 md:gap-x-6`.

O bloco de ações inteiro entra em `<MobileHidden>`:

```tsx
{/* Ações */}
<MobileHidden className="hidden md:flex gap-2 shrink-0">
  {done && (
    <Button variant="outline" size="sm" onClick={onReimprimir} className="gap-1.5">
      <Printer className="h-4 w-4" />
      Reimprimir
    </Button>
  )}
  {!done && !isFlex && semNf ? (
    <div className="text-center text-xs text-muted-foreground leading-tight px-3">
      <span className="block font-medium">Aguardando</span>
      <span className="block">NF do Bling</span>
    </div>
  ) : !done ? (
    <Button
      onClick={onBipar}
      className="bg-success hover:bg-success/90 text-success-foreground font-bold px-8 h-auto py-3"
    >
      BIPAR
    </Button>
  ) : null}
</MobileHidden>
```

Aqui o `className` é passado de propósito: o wrapper original era `<div className="flex gap-2 shrink-0">`, então `md:contents` (o padrão) perderia o `gap-2`. `hidden md:flex gap-2 shrink-0` reproduz o desktop exatamente.

**Efeito colateral aceito e deliberado:** o aviso "Aguardando NF do Bling" também some no celular, porque está dentro do mesmo bloco. O estado continua legível pelo badge "⚠ Sem NF" / "Aguardando NF do Bling" que já existe na fileira de badges acima — informação preservada, ação removida.

- [ ] **Step 5: `BipagemModal` não abre no celular**

O botão BIPAR já está fora do DOM no celular, mas o spec pede a garantia explícita. No `handleBiparPedido` (ou onde o `setPedidoAtivo` é chamado a partir do card), primeira linha:

```tsx
if (isMobile) return; // spec seção 4: bipagem é bloqueada no celular
```

E envolver o modal:

```tsx
<MobileHidden>
  <BipagemModal
    pedido={pedidoAtivo}
    onClose={() => setPedidoAtivo(null)}
    onConcluido={(pedido) => {
      queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] });
      setPedidoAtivo(null);
      handleImpressaoAutomatica(pedido);
    }}
    onRegistered={() => queryClient.invalidateQueries({ queryKey: ["expedicao-pedidos"] })}
  />
</MobileHidden>
```

O mesmo para `<PrinterConfig>` e para `<NfNaoAutorizadaDialog>` (este último é aviso de uma ação bloqueada; sem a ação, não tem por que existir).

- [ ] **Step 6: Verificar**

390x844 em `/expedicao`:

```js
({
  overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  overflowMain: (() => { const m = document.querySelector('main'); return m ? m.scrollWidth - m.clientWidth : null; })(),
  bipar: [...document.querySelectorAll('button')].filter(b => /BIPAR|Reimprimir|Configurar impressora/i.test(b.textContent || b.getAttribute('aria-label') || '')).length,
  dialogos: document.querySelectorAll('[role="dialog"]').length,
  contadorPendentes: !!document.body.textContent.match(/pedidos pendentes/i),
  alvosPequenos: [...document.querySelectorAll('button, a, input, [role="button"]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({ t: (el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,30), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
    .filter(x => x.h < 44 || x.w < 44),
})
```

Expected: `overflowDoc <= 0`, `overflowMain <= 0`, `bipar: 0`, `dialogos: 0`, `contadorPendentes: true`, `alvosPequenos: []`.

1440x900: screenshot contra `baseline/expedicao-1440.png`. **Comparação crítica** — esta é a tela que a operação usa o dia inteiro. Verificar: alinhamento vertical do card (imagem, dados e botão BIPAR na mesma linha), tamanho do título (`text-4xl` no desktop), a caixa azul de contagem com `min-w-[160px]`, e clicar em BIPAR no desktop para confirmar que o modal ainda abre e o fluxo de bipagem funciona.

- [ ] **Step 7: Commit**

```bash
git add src/features/expedicao/ExpedicaoPage.tsx
git commit -m "feat(mobile): ExpedicaoPage responsiva com acoes operacionais bloqueadas"
```

---

## Tarefa 9: `login.tsx`

**Files:** Modify `src/routes/login.tsx`

A porta de entrada. Já está quase certa (`max-w-md`, `px-4`, `h-11` nos campos e no botão) — o que falta é acessibilidade e CLS.

- [ ] **Step 1: Logo com dimensões explícitas (prioridade 3 — CLS)**

```tsx
<img
  src="/expede-logo-light.png"
  alt="EXPEDE"
  width={240}
  height={96}
  className="mx-auto h-16 w-auto"
/>
```

Antes de escrever os números, ler as dimensões reais do arquivo:

```bash
node -e "const b=require('fs').readFileSync('public/expede-logo-light.png');console.log(b.readUInt32BE(16),b.readUInt32BE(20))"
```

Usar os valores que saírem (a proporção é o que importa; `h-16 w-auto` continua mandando no tamanho renderizado). Aplicar os mesmos valores no `SidebarNav` da Tarefa 1, substituindo o `width={240} height={96}` provisório.

- [ ] **Step 2: Erro anunciado por leitor de tela (prioridade 1 e 8)**

```tsx
{error && (
  <div role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
    {error}
  </div>
)}
```

- [ ] **Step 3: Conferir o zoom automático do iOS (prioridade 6)**

`Input` já é `text-base md:text-sm` — 16px no celular, que é exatamente o limiar abaixo do qual o iOS dá zoom no foco. **Nada a mudar**; confirmar por medição no Step 4 e registrar no relatório.

- [ ] **Step 4: Verificar**

390x844 em `/login`:

```js
({
  overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  fontes: [...document.querySelectorAll('input')].map(i => getComputedStyle(i).fontSize),
  alvos: [...document.querySelectorAll('input, button')].map(el => Math.round(el.getBoundingClientRect().height)),
  viewport: document.querySelector('meta[name="viewport"]')?.content,
})
```

Expected: `overflowDoc <= 0`; `fontes` todas `"16px"`; `alvos` todos >= 44; `viewport` = `"width=device-width, initial-scale=1"` **sem `user-scalable=no`** (prioridade 5).

Fazer um login de verdade em 390px (o Vinicius digita a senha) e confirmar que cai em `/expedicao` com o shell mobile.

1440x900: screenshot contra `baseline/login-1440.png`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/login.tsx src/components/layout/AppShell.tsx
git commit -m "feat(mobile): login acessivel e logo com dimensoes explicitas"
```

(`AppShell.tsx` entra junto porque as dimensões reais do logo do Step 1 são aplicadas nos dois arquivos.)

---

## Tarefa 10: Verificação completa (Critérios A a E) e relatório

**Files:** nenhum arquivo de produção. Saída: relatório em texto para o Vinicius.

- [ ] **Step 1: Build limpo**

Run: `npm run build`
Expected: sucesso, sem erro de tipo. Comparar com o resultado anotado na Tarefa 0 Step 4.

Run: `npm run lint`
Expected: sem erro novo em relação ao estado da Tarefa 0.

- [ ] **Step 2: Critério A + overflow do `<main>`, nas 12 rotas, em 390x844**

Para cada rota da lista da Tarefa 0 Step 3, navegar e rodar:

```js
({
  rota: location.pathname,
  A_doc: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  A_main: (() => { const m = document.querySelector('main'); return m ? m.scrollWidth <= m.clientWidth : true; })(),
  estouro: [...document.querySelectorAll('main *')]
    .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
    .slice(0, 5)
    .map(el => el.tagName + '.' + (el.className || '').toString().slice(0, 60)),
})
```

Registrar rota a rota. `estouro` nomeia o culpado quando A falha — sem ele o relatório vira "falhou em algum lugar".

- [ ] **Step 3: Critério C — alvos de toque, nas 12 rotas, em 390x844**

```js
[...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="switch"], [role="tab"]')]
  .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
  .map(el => ({
    tag: el.tagName,
    txt: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
    h: Math.round(el.getBoundingClientRect().height),
    w: Math.round(el.getBoundingClientRect().width),
  }))
  .filter(x => x.h < 44 || x.w < 44)
```

Expected: `[]` em todas as rotas. Qualquer sobra entra no relatório com rota, elemento e medida — **não arredondar para "praticamente 44"**.

- [ ] **Step 4: Critério D — ações bloqueadas ausentes do DOM, em 390x844**

Uma passada por rota, com o vocabulário completo da tabela da seção 4:

```js
({
  rota: location.pathname,
  proibidas: [...document.querySelectorAll('button, a, [role="button"], [role="switch"]')]
    .map(el => (el.textContent || el.getAttribute('aria-label') || '').trim())
    .filter(t => /BIPAR|Imprimir|Reimprimir|Visualizar|Etiqueta|DANFE|Emitir|Reconectar|^Conectar|Desconectar|Atualizar token|Adicionar conta|Novo usuário|Sincronizar agora|Editar|Configurar impressora/i.test(t)),
  switches: document.querySelectorAll('[role="switch"]').length,
  permitidoSync: [...document.querySelectorAll('button')].filter(b => /Sincronizar pedidos/i.test(b.textContent||'')).length,
})
```

Expected: `proibidas: []` e `switches: 0` em **todas** as rotas; `permitidoSync: 1` em `/dashboard` e `0` nas demais.

E a metade do Critério D que o browser não cobre — o HTML do servidor:

```bash
for r in / /login /dashboard /pedidos /produtos /expedicao /configuracoes/marketplaces; do
  echo "== $r"; curl -s "http://localhost:<porta>$r" | grep -oE "BIPAR|Reimprimir|Reconectar|Desconectar|Sincronizar agora" | sort -u;
done
```

Expected: nenhuma saída por rota. Se aparecer alguma, a ação está no HTML entregue pelo servidor: o `<MobileHidden>` não foi aplicado ali (ou foi aplicado só como gate de JS).

- [ ] **Step 5: Critério B — não-regressão do desktop, nas 12 rotas, em 1440x900**

Screenshot de cada rota, comparação com `baseline/<rota>-1440.png`. Toda diferença entra no relatório, mesmo que pareça melhoria — o spec é explícito: no desktop, diferença é falha.

- [ ] **Step 6: Critério E — os quatro objetivos, na mão, em 390x844**

| # | Objetivo | Como verificar |
|---|---|---|
| 1 | Quantos pedidos há para processar | `/dashboard`: card "A expedir" e o funil legíveis sem zoom; `/expedicao`: contador "pedidos pendentes" visível |
| 2 | Filtrar pedidos por marketplace | `/historico`: abrir o `Select`, escolher "Shopee", confirmar que a lista filtra. Também as pílulas de marketplace em `/expedicao` |
| 3 | Marketplaces e Bling conectados, e expiração do token | `/dashboard`: cartões ML/Bling no topo, com texto "Conectado"/"Desconectado" e "expira em Xh"; `/configuracoes/marketplaces`: os três cards legíveis |
| 4 | Disparar a sincronização | `/dashboard`: tocar "Sincronizar pedidos", ver o spinner + "Sincronizando...", esperar o toast e o modal de relatório, e confirmar que o modal não estoura em 390px |

- [ ] **Step 7: Escrever o relatório**

Estrutura obrigatória:

1. **Critérios A–E, rota a rota**, com o valor medido. Falha nomeia rota, elemento e medida.
2. **Checklist da seção 6, prioridade a prioridade.** As 1 e 2 são bloqueantes: ou passaram, ou o trabalho não está pronto. Da 3 à 10, dizer **o que ficou de fora e por quê** — em especial:
   - Pri 3: `<Skeleton>` entrou nas listas via `ResponsiveTable`, mas o dashboard mantém os `animate-pulse` manuscritos que já existiam (trocá-los mexeria no desktop sem necessidade).
   - Pri 7: nenhuma animação nova foi escrita; o `<Sheet>` do shadcn já respeita `prefers-reduced-motion`.
   - Pri 10: o eixo Y da direita some no celular — decisão registrada, não omissão.
3. **Desvios do spec**, com a razão. Os conhecidos até aqui:
   - O spec (seção 5, item 5) diz que "o filtro por marketplace precisa estar alcançável sem zoom" em `pedidos.tsx`. **`pedidos.tsx` não tem filtro por marketplace** — nunca teve. O filtro existe em `historico.tsx` (`MARKETPLACE_OPTIONS`, `getHistorico`) e nas pílulas de `ExpedicaoPage.tsx`. Criar um em `pedidos.tsx` exigiria mudar `listarPedidos`, o que a restrição "nenhum server function novo" proíbe. O objetivo nº 2 é atendido por `/historico` e `/expedicao`, e ambos foram verificados em 390px.
   - O spec (seção 5, item 3) diz que `StatCard` vira `grid-cols-2 md:grid-cols-4`. São **3** cards, não 4, e ficou `grid-cols-1 md:grid-cols-3` — dois cards de 3 numa linha de 390px deixariam "Faturado hoje" (`R$ 12.345,67` em `text-3xl`) ilegível.
   - O `grid-cols-3` interno do `QueryReportSection`: dizer qual das duas saídas do Step 7 da Tarefa 3 foi usada.
4. **O que não foi feito e continua valendo**: PWA, push, modo escuro, ação operacional pelo celular, framework de teste (todos não-objetivos declarados).

- [ ] **Step 8: Atualizar a documentação de sessão (obrigatório por `CLAUDE.md`)**

Atualizar `AGENT-CONTEXT/SESSION-HANDOFF.md` no vault do Obsidian (`C:\Users\Vinicius\Documents\Obsidian Vault\Vinicius Morandi Alexandre\Baby World\Babyworld-Dev\EXPEDE\`) com: o que foi entregue, os dois componentes novos e a regra do `<MobileHidden>`, e os desvios do item 3 do Step 7. Avaliar se `CURRENT-STATE.md` e `KNOWN-ISSUES.md` também precisam de linha, conforme `DOCUMENTATION-RULES.md`.

- [ ] **Step 9: Commit da documentação (se algo mudou no repositório)**

O relatório vai para o chat e o handoff vai para o vault (fora do repositório). Se nada mudou em `EXPEDE/`, não há commit nesta tarefa.

---

## Auto-revisão do plano

**Cobertura do spec:**

| Seção do spec | Onde é implementada |
|---|---|
| 1 — Breakpoint único amarrado | Tarefa 2 Step 3 |
| 2 — `AppShell` responsivo (SidebarNav, Sheet, título, avatar, fechar ao navegar) | Tarefa 1 |
| 3 — `<ResponsiveTable>` (contrato completo, skeleton, card clicável 44px) | Tarefa 2 Step 2 |
| 4 — `<MobileHidden>` duas camadas + tabela de ações | Tarefa 2 Step 1; aplicação nas Tarefas 4–8 |
| 5.1 a 5.9 — as nove telas | Tarefas 1, 2, 3, 4, 5, 6, 7, 8, 9 |
| 6 — checklist de qualidade pri 1–10 | Distribuído (aria-label, 44px, skeleton, sem emoji novo, sem largura fixa, >= 12px, sem animação nova, rótulo nos filtros, voltar do Android, Recharts) + prestação de contas na Tarefa 10 Step 7 |
| 7 — Critérios A–E | Tarefas 0 (baseline) e 10 (verificação) |
| 8 — Riscos | ExpedicaoPage por último; Critério B em toda tarefa; classes `md:` em par |
| "Alterações previstas" | Todos os arquivos listados aparecem em alguma tarefa |

**Consistência de tipos:** `ResponsiveColumn<T>` / `ColumnPriority` / `ResponsiveTableProps<T>` definidos na Tarefa 2 e usados com os mesmos nomes de campo (`id`, `header`, `cell`, `priority`, `align`, `className`) nas Tarefas 4–7. `MobileHidden` tem sempre a assinatura `{ children, className? }`. `rowActions` nunca é envolvido em `<MobileHidden>` pela tela — o componente já faz isso — exceto em `ExpedicaoPage`, que não usa `ResponsiveTable` e por isso envolve explicitamente.

**Sem placeholders:** todo step que muda código traz o código. Os únicos pontos com decisão em aberto são medições declaradas (o `grid-cols-3` do `QueryReportSection`, o `gap-x-6` do `PedidoCard`, o `-mb-px` das abas), cada um com a condição e a saída alternativa escritas.
