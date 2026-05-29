# Design: Confirmação de Desconexão Bling com Contagem de Produtos

**Data:** 2026-05-29  
**Status:** Aprovado

---

## Contexto

A tabela `produtos` tem FK `produtos_bling_connection_id_fkey` com `ON DELETE CASCADE` apontando para `bling_connections`. Clicar "Desconectar" apaga todos os produtos vinculados silenciosamente. Um acidente já ocorreu: 2681 produtos perdidos.

O `AlertDialog` já existe na página (`configuracoes.bling.tsx:217-237`) mas a descrição é genérica e não informa quantos produtos serão apagados.

---

## Objetivo

Exibir a contagem real de produtos no diálogo de confirmação antes de desconectar, com o botão de confirmação desabilitado enquanto o número carrega.

---

## Restrições

- Não alterar a FK `ON DELETE CASCADE`
- Não alterar `blingDisconnect` (server function existente)
- Não tocar nos botões "Forçar renovação" e edição de nome
- Usar `AlertDialog` do shadcn/ui (já importado)

---

## Arquitetura

### Nova server function: `getProdutoCountByConnection`

Localização: `src/lib/bling.functions.ts`

```ts
export const getProdutoCountByConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { connectionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // Valida ownership antes de contar
    const { data: conn } = await supabaseAdmin
      .from("bling_connections")
      .select("user_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (!conn || conn.user_id !== userId) throw new Error("Sem permissão");

    const { count } = await supabaseAdmin
      .from("produtos")
      .select("id", { count: "exact", head: true })
      .eq("bling_connection_id", data.connectionId);
    return { count: count ?? 0 };
  });
```

### Alteração no componente `BlingPage`

`src/routes/_app/configuracoes.bling.tsx`

1. Importar `getProdutoCountByConnection` de `bling.functions`.
2. Adicionar `useServerFn(getProdutoCountByConnection)` e um `useQuery` com `queryKey: ["bling-produto-count", conn?.id]`, habilitado apenas quando `conn?.id` existe. Carrega eager no background.
3. Atualizar a `AlertDialogDescription` para mostrar a contagem dinâmica.
4. Adicionar `disabled={isLoadingCount}` no `AlertDialogAction`.

---

## Comportamento do diálogo

| Estado | Descrição exibida | Botão confirmar |
|---|---|---|
| Contagem carregando | "Verificando quantos produtos serão apagados..." | Desabilitado |
| 0 produtos | "Os tokens serão removidos. Nenhum produto cadastrado será afetado." | Habilitado |
| N > 0 produtos | "**N produtos** serão apagados permanentemente. Esta ação não pode ser desfeita." | Habilitado |

---

## Fluxo completo

1. Página carrega → `useQuery("bling-connection")` resolve → `conn.id` disponível
2. `useQuery("bling-produto-count", conn.id)` inicia automaticamente em background
3. Usuário clica "Desconectar" → `AlertDialog` abre
4. Se contagem ainda não resolveu: descrição mostra "Verificando..." e botão fica desabilitado
5. Quando contagem chega: descrição atualiza, botão habilita
6. Cancelar: fecha sem efeito
7. Confirmar: chama `disconnectMut.mutate(conn.id)` (sem alteração)

---

## Critérios de aceite

1. Clicar "Desconectar" abre diálogo com contagem correta de produtos
2. Enquanto contagem carrega, botão "Desconectar mesmo assim" permanece desabilitado
3. Cancelar fecha o diálogo sem nenhuma ação
4. Confirmar executa `disconnectMut.mutate` normalmente
5. `npm run build` passa limpo

---

## Arquivos afetados

| Arquivo | Tipo de mudança |
|---|---|
| `src/lib/bling.functions.ts` | Adiciona `getProdutoCountByConnection` |
| `src/routes/_app/configuracoes.bling.tsx` | Adiciona query + atualiza AlertDialog |

Nenhuma migração de banco necessária.
