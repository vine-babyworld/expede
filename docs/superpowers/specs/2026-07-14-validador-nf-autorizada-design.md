# Design: Validador de NF Autorizada no Bipar

**Data:** 2026-07-14
**Status:** Aprovado (decisões de design confirmadas via AskUserQuestion com o Vinicius)

---

## Contexto

O Checkout por Produto (`ExpedicaoPage.tsx`) já filtra pedidos sem NF nenhuma no
Bling (`bling_nota_fiscal_id IS NULL`, exceto Flex) desde 01/07/2026 (commit
`41f69ef`). Esse filtro só verifica **existência** do id da NF — não verifica se
a NF foi de fato **autorizada** pela SEFAZ.

Caso real: pedido `2000014001394589` (Bling #8467) tem NF criada no Bling
(id existe, número 016395 visível), mas rejeitada por erro local antes de ir pra
SEFAZ ("É necessário informar o NCM em todos os itens da nota"). Como
`bling_nota_fiscal_id` já está preenchido, esse pedido passa pelo filtro de
01/07 e aparece bipável no Checkout — o operador pode bipar, e como a etiqueta
ML normalmente imprime independente da NF, `imprimiuAlgo` fica `true` e o
pedido é marcado `printed_at`, saindo da fila com uma DANFE inválida (placeholder
"chave não disponível", `danfe.functions.ts:219`).

Confirmado por leitura de código: não existe hoje, em lugar nenhum do projeto,
o conceito de "situação da NF" — só id/número são lidos das respostas do Bling.

## Decisões de design (brainstorming, confirmadas pelo Vinicius)

1. **Fonte do status:** campo cacheado (`pedidos.nf_situacao`), populado por um
   cron leve novo (`cronNfStatus`), no mesmo padrão do `cronMLStatus` já
   existente (`server.ts:83-222`). Não é consulta ao vivo no clique — evita
   latência e risco de rate limit do Bling (3 req/s). Trade-off aceito: janela
   de defasagem de poucos minutos entre o Bling mostrar erro e o EXPEDE refletir.
2. **Mensagem do popup:** tenta mostrar o motivo real do Bling quando disponível
   (`nf_situacao_motivo`), com fallback para rótulo genérico da situação
   (`nfSituacaoLabel`). A API do Bling não documenta publicamente um campo de
   "motivo/erro" no `GET /nfe/{id}` — o campo é best-effort (extraído se a
   resposta trouxer algo reconhecível) e o fallback SEMPRE funciona.
3. **Regra Flex:** todas as novas verificações usam o helper já existente
   `isPedidoFlex()` (`pedidos.functions.ts:92-98`) e são puladas por completo
   para pedidos Flex, que continuam sem exigir NF.

## Códigos de situação da NF (Bling API v3, `GET /Api/v3/nfe/{id}`)

Confirmado via documentação pública do conector Bling v3 (Floui):

| Código | Significado |
|---|---|
| 1 | Pendente |
| 2 | Cancelada |
| 3 | Aguardando recibo |
| 4 | Rejeitada |
| 5 | Autorizada |
| 6 | Emitida DANFE |
| 7 | Registrada |
| 8 | Aguardando protocolo |
| 9 | Denegada |
| 10 | Consulta situação |
| 11 | Bloqueada |

**Autorizada para efeito de bipagem = `{5, 6}`** (6 pressupõe autorização prévia,
já que a DANFE só é emitida depois da NF autorizada). Qualquer outro código
(inclusive `null` = nunca verificado) é tratado como "não confirmado" — só
bloqueia quando o código é conhecido e não está no conjunto autorizado (ver
"Janela de defasagem" abaixo).

⚠️ **Verificação empírica pendente (Task 1 do plano):** o significado exato do
campo de motivo/erro (se existir) só será confirmado na primeira chamada real
`GET /nfe/{id}` contra o pedido #8467. Se a API não expuser nenhum campo de
motivo utilizável, o sistema usa só o rótulo da situação — cumprindo a decisão
2 mesmo no caso pessimista.

## Janela de defasagem (null ≠ bloqueado)

`nf_situacao IS NULL` (cron ainda não processou esse pedido) **não bloqueia** —
mantém o comportamento atual (que já deixa passar hoje) até o cron alcançar o
pedido, normalmente em poucos minutos. Só bloqueia quando `nf_situacao` tem um
valor conhecido fora de `{5, 6}`. Esse é o trade-off explícito da decisão 1.

## Arquitetura

### Nova migration: `nf_situacao`, `nf_situacao_motivo`, `nf_situacao_checked_at`

Colunas em `public.pedidos`, mesmo padrão de `ml_shipment_status` /
`ml_status_checked_at` (migration `20260701000000_ml-shipment-status.sql`).

### Nova função server-side: `fetchNfSituacaoBling`

Localização: `src/lib/pedidos.functions.ts`, ao lado de `fetchNfNumeroBling`
(linha ~757). Chama `GET {BLING_NFE_URL}/{nfId}`, extrai `situacao` e tenta
extrair um motivo de campos plausíveis (`motivo`, `mensagem`, `erro`,
`observacoes` — o que a API realmente devolver, confirmado na Task 1).

### Novo cron: `cronNfStatus`

Localização: `src/server.ts`, ao lado de `cronMLStatus` (linha 83). Mesmo
padrão de gate (`cron_state`, job_name `"nf_status"`), mesma priorização
"nunca verificados vs retry" (Lição #16 do projeto — nunca ordenar retry por
chave estática). `MAX_CANDIDATOS_NF_STATUS = 4`, intervalo próprio
(`NF_STATUS_INTERVAL_MS`), candidatos = pedidos com `bling_nota_fiscal_id`
preenchido, `printed_at IS NULL`, não arquivados, não cancelados, e
`nf_situacao` ainda não confirmado como autorizado. Registrado em
`plugins/cloudflare-scheduled.ts` junto aos outros crons.

### Helper compartilhado: `nfNaoAutorizada` / `nfSituacaoLabel`

Localização: `src/lib/pedidos.functions.ts` (mesmo arquivo de `isPedidoFlex`,
já importado tanto por `ExpedicaoPage.tsx` quanto por rotas de dashboard) —
fonte única de verdade para não duplicar a regra "autorizada = {5,6}" em cada
tela, ao contrário do que já acontece hoje com `isFlex` (3 implementações
inline diferentes, achado pela investigação de código — não será corrigido
nesta mudança, fora de escopo).

### UI — Checkout por Produto (`ExpedicaoPage.tsx`)

1. `PedidoExpedicao` ganha `nf_situacao` / `nf_situacao_motivo`.
2. `handleBiparPedido` (linha 262): antes de abrir o `BipagemModal`, se
   `!isPedidoFlex(pedido) && nfNaoAutorizada(pedido)`, abre um `AlertDialog`
   bloqueante em vez do modal de bipagem. **Pedido não some da lista** — o
   clique só abre o aviso, nada muda no estado do pedido.
3. Novo componente `NfNaoAutorizadaDialog` (`AlertDialog` do shadcn/ui — mesmo
   padrão já usado em `configuracoes.bling.tsx`), com botão único "Entendi".
4. `handleImpressaoAutomatica` (linha 275): defesa em profundidade — mesmo
   check logo após o `semNf` existente, bloqueia `marcarImpresso` se a NF não
   estiver autorizada (cobre `historico.tsx` reimprimir e qualquer race entre
   a lista carregar e o print disparar).
5. `PedidoCard`: novo badge vermelho "⚠ NF não autorizada (Rejeitada)" quando
   `!isFlex && nfNaoAutorizada(pedido)` — repõe a visibilidade que o Vinicius
   relatou ter sumido (não é literalmente o badge antigo, mas cobre o caso
   real que ele está vendo hoje).

### UI — Histórico (`historico.tsx`)

Mesmo guard em `handleReimprimir` (linha 77), usando os mesmos helpers
importados de `pedidos.functions.ts`. Exige adicionar `nf_situacao` /
`nf_situacao_motivo` ao `HISTORICO_SELECT` e ao tipo `HistoricoRow`
(`dashboard.functions.ts`).

## Fora de escopo (deliberado, não tocar nesta mudança)

- Badge de "NF não autorizada" no Dashboard / `/a-expedir` — o pedido continua
  contando normalmente nesses lugares, só o Checkout e o Histórico ganham a
  trava. Pode ser um follow-up depois de validar o essencial.
- Unificar as 3 implementações inline de detecção de Flex — achado da
  investigação, não é bug introduzido por esta mudança.
- Qualquer ajuste em `danfe.functions.ts` (o placeholder "chave não
  disponível" continua existindo como fallback de exibição — só deixa de ser
  alcançável na prática, porque o pedido não deveria mais chegar lá pelo fluxo
  normal).

## Critérios de aceite

1. Pedido com `bling_nota_fiscal_id` preenchido mas NF não autorizada
   (situação fora de `{5,6}`, já verificada pelo cron) mostra popup bloqueante
   ao clicar "BIPAR" — modal de bipagem não abre.
2. Pedido permanece visível no Checkout por Produto depois do popup (não some
   da lista, não é marcado como impresso).
3. Pedido Flex com as mesmas condições **não** é bloqueado — comportamento
   idêntico ao de hoje.
4. Pedido com `nf_situacao` ainda `null` (cron não chegou nele) continua
   bipável normalmente (sem regressão no fluxo atual).
5. Badge "⚠ NF não autorizada" aparece no card do pedido bloqueado.
6. `handleImpressaoAutomatica` e `historico.tsx` reimprimir também recusam
   completar quando a NF não está autorizada (defesa em profundidade).
7. `npm run build` passa limpo.
8. Validado com o pedido real #8467 assim que o cron o processar (ou via
   chamada manual da nova função, se o cron ainda não tiver rodado no momento
   do teste).

## Arquivos afetados

| Arquivo | Tipo de mudança |
|---|---|
| `supabase/migrations/20260714100000_nf-situacao.sql` | Nova migration |
| `src/lib/pedidos.functions.ts` | Adiciona `fetchNfSituacaoBling`, `NF_SITUACOES_AUTORIZADAS`, `nfSituacaoLabel`, `nfNaoAutorizada` |
| `src/server.ts` | Adiciona `cronNfStatus` |
| `plugins/cloudflare-scheduled.ts` | Registra `cronNfStatus` no hook |
| `src/features/expedicao/ExpedicaoPage.tsx` | Gate no bipar, dialog novo, badge, defesa no print |
| `src/routes/_app/historico.tsx` | Mesmo gate no reimprimir |
| `src/lib/dashboard.functions.ts` | Adiciona campos ao `HISTORICO_SELECT`/`HistoricoRow` |
