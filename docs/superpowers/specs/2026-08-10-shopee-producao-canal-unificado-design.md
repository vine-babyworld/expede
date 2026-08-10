# Design: Shopee em produção + canal de marketplace unificado

**Data:** 2026-08-10
**Status:** Aprovado (decisões de design confirmadas via AskUserQuestion com o Vinicius)

---

## Contexto

Investigando por que a etiqueta de transporte do pedido Shopee #8819 (`2608100G3GRRNK`)
não saiu na impressão (só a DANFE), duas causas raiz foram confirmadas ao vivo (ver
sessão de 2026-08-10):

1. **Falha silenciosa na UI**: quando a busca/impressão de etiqueta falhava, o código
   só logava `console.warn`, nunca avisava o operador — corrigido nesta mesma sessão
   (commit `89427d0`, deploy `d94b8792`) em `ExpedicaoPage.tsx`, `pedidos.tsx` e
   `historico.tsx`.
2. **Causa raiz de fundo**: a etiqueta Shopee falha com `shopee_no_connection` porque
   o app Shopee do EXPEDE nunca completou a autorização OAuth. Investigação (Lição #21,
   15-17/07/2026) já tinha determinado que o app está preso no ambiente **sandbox**
   (status "Developing" no Shopee Open Platform Console), retornando `{"error":"error_sign",
   "message":"Wrong sign."}` no `auth_partner` — bug do lado da Shopee, não do nosso
   código/config (verificado linha a linha: assinatura HMAC, host, partner_id, timestamp,
   comprimento da chave). **Reconfirmado ao vivo nesta sessão** (2026-08-10, mesmo erro,
   mesmo `request_id` novo) mesmo depois de uma Test Account sandbox ter sido criada
   com sucesso (`Shop ID 227816515`) — descarta a hipótese de que a Test Account
   ausente era a causa.

Achado colateral durante a investigação: `buscarEtiquetaShopee()` (`src/lib/shopee.ts`)
usa `process.env.SHOPEE_TEST_SHOP_ID` fixo em vez de consultar a conexão real em
`shopee_connections` — não escala além de uma única loja de teste hardcoded, e é
inconsistente com o padrão já usado por `getMLAccessToken()` (consulta a conexão mais
recente na tabela). Achado adicional: o fluxo de reimpressão em `pedidos.tsx` e
`historico.tsx` só tratava etiqueta do tipo `zpl`, ignorando silenciosamente o tipo
`pdf_base64` (usado pelo fallback Shopee/ML) — também corrigido no commit `89427d0`.

## Decisões de design (brainstorming, confirmadas pelo Vinicius)

1. **Sandbox vs produção**: parar de insistir no ambiente sandbox da Shopee (já
   duplamente confirmado quebrado do lado deles) e migrar para o Partner App de
   **produção** via o botão **Go-Live** do próprio app "EXPEDE" no Shopee Open
   Platform Console — não é um app novo, é o mesmo app (`partner_id 1235356`)
   promovido, confirmado visualmente (botão presente na página de detalhe do app)
   e por um guia de integração de terceiro (Smartship) que documenta o mesmo padrão
   de fluxo do Shopee Open Platform.
2. **IP fixo para produção**: o formulário Go-Live exige uma **IP Address Whitelist**.
   Nem Cloudflare Workers nem Supabase Edge Functions (as duas camadas que o EXPEDE já
   usa) oferecem IP de saída fixo fora do plano Enterprise da Cloudflare (recurso
   "Dedicated Egress IP", sem preço público, claramente desproporcional pra essa
   necessidade). Decisão: **AWS Lightsail, região São Paulo, plano $5/mês** — inclui
   1 IP estático grátis enquanto atrelado à instância rodando. A instância roda só um
   forwarder mínimo (nginx `stream` ou `socat`) que aceita conexão **apenas** do
   Worker do EXPEDE (segredo compartilhado, não é proxy aberto) e repassa só para os
   hosts da Shopee (`partner.shopeemobile.com` / `partner.test-stable.shopeemobile.com`).
   Nenhum dado de pedido/token é armazenado na VPS — é só um salto de rede.
3. **Canal unificado no código**: criar um contrato comum (`buscarEtiqueta`,
   `getConnectionStatus`, `disconnect`) que `ml.functions.ts` e `shopee.ts` passam a
   implementar, sem reescrever a lógica interna de cada um — só expondo o mesmo
   formato. Objetivo: `etiqueta.functions.ts` deixa de ter um `if (marketplace ===
   "shopee")` inline e passa a fazer lookup por um registro de canais, removendo a
   classe de duplicação que causou o bug do `pdf_base64` faltando em 2 de 3 lugares.
4. **Fora de escopo (YAGNI)**: painel de status de canais, suporte a múltiplas lojas
   Shopee simultâneas, Amazon (filtro existe na UI mas não tem implementação real,
   sem pedido usando), refazer a lógica interna de assinatura/token da Shopee (já
   validada correta).

## Arquitetura

### Frente 1 — Shopee em produção (bloqueada em ação externa do Vinicius)

**Pré-requisito, fora do código**: Vinicius preenche e envia o formulário Go-Live no
Shopee Open Platform Console (Product Brief, screenshot da UI, Live Redirect URL
Domain = `https://babyworld.expede.workers.dev`, IP Address Whitelist = IP estático
da Lightsail). Aprovação é decisão da Shopee, sem prazo garantido — mesma classe de
dependência externa que já bloqueou o sandbox por semanas (Lição #21). **Não há
garantia de que a aprovação resolve o problema** — só que o código do nosso lado já
foi verificado correto e não há razão técnica conhecida pra falhar depois de
aprovado.

**Passo a passo técnico, só depois da aprovação:**

1. Provisionar a instância Lightsail (São Paulo), configurar firewall (só porta do
   forwarder, só IP do Cloudflare Worker de origem se possível, senão segredo
   compartilhado no payload), instalar `unattended-upgrades`.
2. `wrangler secret put SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY` (credenciais Live,
   nunca coladas em chat/log — digitadas direto no prompt interativo do wrangler,
   mesmo padrão da Lição #21).
3. `wrangler.jsonc`: `SHOPEE_SANDBOX` passa a `"false"`.
4. `src/lib/shopee.ts`: todas as chamadas `fetch()` para hosts Shopee passam a ir
   através do proxy Lightsail em vez de direto (novo helper, ex: `shopeeFetch()` que
   substitui o `fetch()` cru usado em `buildShopeeUrl`-consumers).
5. **Corrigir `buscarEtiquetaShopee()`** para parar de usar `SHOPEE_TEST_SHOP_ID` e
   em vez disso consultar `shopee_connections` pela conexão ativa mais recente
   (mesmo padrão de `getMLAccessToken()` em `ml.functions.ts:113-128`) — necessário
   de qualquer forma pra funcionar com uma loja real de produção.
6. Testar: Conectar → autorizar na Shopee → confirmar linha nova em
   `shopee_connections` (`is_sandbox: false`) → bipar um pedido Shopee real e
   confirmar que a etiqueta sai na impressora térmica.

### Frente 2 — Canal unificado (não depende da Frente 1, pode começar já)

**Novo tipo compartilhado**, local sugerido `src/lib/canais/types.ts`:

```ts
export type EtiquetaResult =
  | { ok: true; tipo: "zpl" | "pdf_base64"; conteudo: string }
  | { ok: false; error: string };

export type ConnectionStatus =
  | { connected: true; label: string; expires_at: string }
  | { connected: false };

export interface CanalMarketplace {
  id: string; // "mercadolivre" | "shopee"
  buscarEtiqueta(orderId: string): Promise<EtiquetaResult>;
  getConnectionStatus(): Promise<ConnectionStatus>;
  disconnect(): Promise<{ ok: boolean }>;
}
```

- `ml.functions.ts` e `shopee.ts` cada um exporta um objeto `CanalMarketplace`
  (wrapper fino em cima das funções já existentes — `buscarEtiquetaML`/
  `buscarEtiquetaShopee`, `getMLConnection`/`getShopeeConnection`,
  `disconnectML`/`disconnectShopee` continuam existindo, só ganham um objeto que os
  agrupa sob o contrato comum).
- `etiqueta.functions.ts`: novo registro `const CANAIS: Record<string, CanalMarketplace>`.
  `buscarEtiquetaBling` troca o bloco `if (marketplace === "shopee") ... else if
  (numeroLoja) [ML]` (linhas 53-82 hoje) por `CANAIS[marketplace]?.buscarEtiqueta(numeroLoja)`.
- **Nenhuma mudança de comportamento esperada** — é refactor puro. Validação: os 3
  fluxos de reimpressão (Expedição/Pedidos/Histórico) continuam chamando só
  `buscarEtiquetaBling`, que já é o único ponto de entrada — a unificação acontece
  inteiramente dentro dele, sem tocar nos 3 arquivos de novo.

## Critérios de aceite

1. Pedido Shopee real, bipado e com NF autorizada, imprime a etiqueta de transporte
   junto com a DANFE — sem erro `shopee_no_connection`.
2. `shopee_connections` tem uma linha com `is_sandbox: false` após a autorização de
   produção.
3. `buscarEtiquetaShopee()` funciona para qualquer `shop_id` presente em
   `shopee_connections`, não só o hardcoded.
4. Todas as chamadas de produção à API da Shopee passam pelo proxy Lightsail — IP de
   origem visto pela Shopee é o IP estático da instância.
5. `etiqueta.functions.ts` não tem mais `if (marketplace === "shopee")` inline —
   lookup único via `CANAIS`.
6. `npm run build` passa limpo; os 3 fluxos de reimpressão continuam funcionando
   para ML sem regressão (validação manual, já que não há suite de testes automatizados
   no projeto).

## Arquivos afetados

| Arquivo | Tipo de mudança |
|---|---|
| `src/lib/shopee.ts` | Corrige `buscarEtiquetaShopee` (lookup real de `shop_id`), adiciona `shopeeFetch()` via proxy, exporta objeto `CanalMarketplace` |
| `src/lib/ml.functions.ts` | Exporta objeto `CanalMarketplace` |
| `src/lib/canais/types.ts` | Novo — contrato `CanalMarketplace` |
| `src/lib/etiqueta.functions.ts` | Troca if/else por lookup em `CANAIS` |
| `wrangler.jsonc` | `SHOPEE_SANDBOX=false` (só após aprovação Go-Live) |
| Secrets Cloudflare | `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY` (Live), substituindo os `TEST_*` |
| Infraestrutura nova | Instância AWS Lightsail (São Paulo, $5/mês) rodando proxy de encaminhamento |

## Pendências / bloqueios externos

- **Vinicius**: preencher e enviar o formulário Go-Live no Shopee Open Platform
  Console (Product Brief, screenshot, credencial de teste do EXPEDE pra revisão da
  Shopee, Live Redirect URL Domain, IP da Lightsail depois de provisionada).
- Aprovação da Shopee — sem prazo, decisão deles.
- Provisionamento da instância Lightsail — ação do Vinicius (ou eu posso ajudar a
  configurar o forwarder depois que a instância existir, mas a criação da conta/
  cobrança é dele).
