# Bling Disconnect Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exibir contagem de produtos no diálogo de confirmação antes de desconectar uma conta Bling, com botão de confirmação desabilitado durante o carregamento.

**Architecture:** Uma nova server function `getProdutoCountByConnection` retorna discriminated union com a contagem. O componente `BlingPage` carrega esse número em background via `useQuery` assim que `conn.id` fica disponível, de modo que na maioria dos casos o número já está pronto quando o dialog abre. O `AlertDialog` existente é atualizado para mostrar 4 estados possíveis e o foco inicial é movido para o botão Cancelar.

**Tech Stack:** TanStack Start 1.167 (server functions), TanStack Query (useQuery), React, shadcn/ui AlertDialog, Supabase Admin client.

---

## File Map

| Arquivo | Operação | Responsabilidade |
|---|---|---|
| `src/lib/bling.functions.ts` | Modify (append) | Nova server function que conta produtos por conexão |
| `src/routes/_app/configuracoes.bling.tsx` | Modify | Adiciona query de contagem + atualiza AlertDialog |

---

## Task 1: Adicionar `getProdutoCountByConnection` em `bling.functions.ts`

**Files:**
- Modify: `src/lib/bling.functions.ts` (append ao final do arquivo)

Não há test suite no projeto — a verificação é via `npm run build` (TypeScript) e `npm run lint`.

- [ ] **Step 1: Abrir o arquivo e localizar o ponto de inserção**

  Abra `src/lib/bling.functions.ts`. A última função exportada é `findLatestConnectionByState` (linha ~343). A nova função vai ao final do arquivo, após ela.

- [ ] **Step 2: Adicionar a server function**

  Appende ao final de `src/lib/bling.functions.ts`:

  ```ts
  /** Conta produtos vinculados a uma conexão. Retorna discriminated union. */
  export const getProdutoCountByConnection = createServerFn({ method: "GET" })
    .middleware([requireSupabaseAuth])
    .inputValidator((d: { connectionId: string }) => d)
    .handler(async ({ data, context }) => {
      const { userId } = context;
      const { data: conn } = await supabaseAdmin
        .from("bling_connections")
        .select("user_id")
        .eq("id", data.connectionId)
        .maybeSingle();
      if (!conn || conn.user_id !== userId) return { ok: false as const, reason: "forbidden" };

      const { count, error } = await supabaseAdmin
        .from("produtos")
        .select("id", { count: "exact", head: true })
        .eq("bling_connection_id", data.connectionId);
      if (error) return { ok: false as const, reason: "db_error" };
      return { ok: true as const, count: count ?? 0 };
    });
  ```

- [ ] **Step 3: Verificar build**

  ```bash
  npm run build
  ```

  Esperado: sem erros de TypeScript relacionados à nova função. Se aparecer erro de tipo no `inputValidator`, confirme que o padrão `(d: { connectionId: string }) => d` bate com o de `blingDisconnect` na linha ~195.

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/bling.functions.ts
  git commit -m "feat: adiciona getProdutoCountByConnection server function"
  ```

---

## Task 2: Atualizar `BlingPage` com query de contagem e AlertDialog dinâmico

**Files:**
- Modify: `src/routes/_app/configuracoes.bling.tsx`

- [ ] **Step 1: Adicionar `getProdutoCountByConnection` ao import de `bling.functions`**

  Localize a linha de import (linha ~15):

  ```ts
  import {
    blingOAuthStart, getBlingConnection, blingRefreshToken, blingDisconnect, setBlingConnectionName,
  } from "@/lib/bling.functions";
  ```

  Substitua por:

  ```ts
  import {
    blingOAuthStart, getBlingConnection, blingRefreshToken, blingDisconnect,
    setBlingConnectionName, getProdutoCountByConnection,
  } from "@/lib/bling.functions";
  ```

- [ ] **Step 2: Registrar `useServerFn` para a nova função**

  Localize dentro de `BlingPage` (linha ~37):

  ```ts
  const disconnectFn = useServerFn(blingDisconnect);
  ```

  Adicione a linha logo abaixo:

  ```ts
  const disconnectFn = useServerFn(blingDisconnect);
  const getCountFn = useServerFn(getProdutoCountByConnection);
  ```

- [ ] **Step 3: Adicionar `useQuery` para a contagem**

  Localize o bloco do `disconnectMut` (linha ~93):

  ```ts
  const disconnectMut = useMutation({
  ```

  Adicione o `useQuery` **antes** desse bloco (mas após os outros hooks, para manter a ordem de declaração):

  ```ts
  const { data: countData, isLoading: isLoadingCount } = useQuery({
    queryKey: ["bling-produto-count", conn?.id],
    queryFn: () => getCountFn({ data: { connectionId: conn!.id! } }),
    enabled: !!conn?.id,
  });

  const disconnectMut = useMutation({
  ```

  > **Nota:** `conn!.id!` é seguro aqui porque `enabled: !!conn?.id` garante que a queryFn só executa quando ambos existem. O `conn` neste ponto é o resultado do `useQuery("bling-connection")` acima, que pode ser `null | undefined` quando ainda não carregou.

- [ ] **Step 4: Adicionar a função helper `getDisconnectBody` ao final do arquivo**

  Após a função `Field` (linha ~262), adicione:

  ```tsx
  type CountResult =
    | { ok: true; count: number }
    | { ok: false; reason: string }
    | undefined;

  function getDisconnectBody(isLoading: boolean, data: CountResult): ReactNode {
    if (isLoading) return "Verificando quantos produtos serão apagados...";
    if (!data || !data.ok)
      return "Não foi possível verificar a quantidade de produtos. Verifique se realmente deseja continuar.";
    if (data.count === 0)
      return "A conexão será removida. Nenhum produto cadastrado será afetado.";
    const n = data.count;
    return (
      <>
        <strong>{n} produto{n !== 1 ? "s" : ""}</strong>{" "}
        {n !== 1 ? "serão apagados" : "será apagado"} permanentemente. Esta ação não pode ser desfeita.
      </>
    );
  }
  ```

  Adicione também o import de `React` no topo do arquivo, logo após os imports existentes do React:

  ```ts
  import { useEffect, useState } from "react";
  import type { ReactNode } from "react";
  ```

- [ ] **Step 5: Atualizar o bloco `AlertDialog` com os 4 estados**

  Localize o bloco `AlertDialog` existente (linhas ~217–237):

  ```tsx
  <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button variant="outline" size="sm" className="text-rose-600 hover:text-rose-700">
        <Trash2 className="h-4 w-4 mr-2" /> Desconectar
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Desconectar conta Bling?</AlertDialogTitle>
        <AlertDialogDescription>
          Os tokens serão removidos. Você precisará autorizar novamente para sincronizar pedidos.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancelar</AlertDialogCancel>
        <AlertDialogAction onClick={() => conn.id && disconnectMut.mutate(conn.id)}>
          Desconectar
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  ```

  Substitua por:

  ```tsx
  <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button variant="outline" size="sm" className="text-rose-600 hover:text-rose-700">
        <Trash2 className="h-4 w-4 mr-2" /> Desconectar
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Desconectar conta Bling?</AlertDialogTitle>
        <AlertDialogDescription>
          {getDisconnectBody(isLoadingCount, countData)}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel autoFocus>Cancelar</AlertDialogCancel>
        <AlertDialogAction
          disabled={isLoadingCount}
          onClick={() => conn.id && disconnectMut.mutate(conn.id)}
        >
          Desconectar mesmo assim
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  ```

- [ ] **Step 6: Verificar build e lint**

  ```bash
  npm run build
  ```

  Esperado: saída sem erros. Se aparecer erro `Property 'ReactNode' does not exist`, ajuste o import para `import React from "react"` (default) em vez de `import type React from "react"` e mude a assinatura para usar `React.ReactNode` ou substitua por `JSX.Element | string`.

  ```bash
  npm run lint
  ```

  Esperado: sem novos warnings ou erros.

- [ ] **Step 7: Teste manual**

  Suba o dev server (`npm run dev`) e acesse `/configuracoes/bling` com uma conta conectada.

  Cenários a verificar:
  1. Clique "Desconectar" — dialog abre. Se a contagem já estava em cache, mostra "X produtos..." ou "Nenhum produto...". Se não estava, botão "Desconectar mesmo assim" aparece desabilitado por um instante até a query resolver.
  2. Pressione **Enter** com o dialog aberto — não deve desconectar (foco está em Cancelar).
  3. Clique Cancelar — dialog fecha, nada acontece.
  4. Clique "Desconectar mesmo assim" — desconecta normalmente, toast "Conta desconectada".

- [ ] **Step 8: Commit**

  ```bash
  git add src/routes/_app/configuracoes.bling.tsx
  git commit -m "feat: confirmação de desconexão Bling com contagem de produtos"
  ```

---

## Checklist de aceite final

- [ ] Dialog mostra contagem correta ao abrir
- [ ] Botão "Desconectar mesmo assim" desabilitado durante loading
- [ ] Cancelar fecha sem efeito
- [ ] Confirmar executa `disconnectMut.mutate` normalmente
- [ ] Enter com dialog aberto não dispara ação destrutiva
- [ ] `npm run build` passa limpo
