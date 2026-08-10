# Design: Shopee em produção + canal de marketplace unificado

**Data:** 2026-08-10 (revisado)
**Status:** Aprovado (decisões de design confirmadas via AskUserQuestion com o Vinicius; revisão técnica de arquitetura do gateway incorporada)

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

## Decisões de design (brainstorming + revisão técnica, confirmadas pelo Vinicius)

1. **Sandbox vs produção**: parar de insistir no ambiente sandbox da Shopee (já
   duplamente confirmado quebrado do lado deles) e migrar para o Partner App de
   **produção** via o botão **Go-Live** do próprio app "EXPEDE" no Shopee Open
   Platform Console — não é um app novo, é o mesmo app promovido, confirmado
   visualmente (botão presente na página de detalhe do app).
2. **Ordem de execução**: a infraestrutura de IP fixo (item 3 abaixo) precisa existir
   **antes** de enviar o formulário Go-Live, porque o próprio formulário exige o IP
   estático no campo "IP Address Whitelist". Não dá pra submeter primeiro e provisionar
   depois.
3. **Gateway de egress para IP fixo**: nem Cloudflare Workers nem Supabase Edge
   Functions oferecem IP de saída fixo fora do plano Enterprise da Cloudflare (recurso
   "Dedicated Egress IP", sem preço público, desproporcional pra essa necessidade).
   Decisão: **AWS Lightsail, região São Paulo, plano $5/mês**, com IP estático
   associado — rodando um **gateway HTTP reverso**, não um forward de TCP cru:
   `Worker → Cloudflare Tunnel/Access → nginx (HTTP) na Lightsail → partner.shopeemobile.com`.
   Detalhes de segurança do gateway na seção Arquitetura.
4. **Autenticação Worker↔gateway**: não usar IP de origem do Worker como controle de
   acesso — o IP do Cloudflare Worker é dinâmico/compartilhado, não é uma credencial
   válida. Usar **Cloudflare Access Service Token** (preferencial) ou, se inviável,
   assinatura HMAC com timestamp no payload da chamada ao gateway.
5. **Canal unificado no código**: criar um contrato comum (`buscarEtiqueta`,
   `getConnectionStatus`, `disconnect`) que `ml.functions.ts` e `shopee.ts` passam a
   implementar, sem reescrever a lógica interna de cada um. `etiqueta.functions.ts`
   passa a fazer lookup por um registro de canais em vez do `if (marketplace ===
   "shopee")` inline, removendo a classe de duplicação que causou o bug do
   `pdf_base64` faltando em 2 de 3 lugares — **preservando o fallback atual pra
   Mercado Livre** quando `marketplace` é `null`/legado (comportamento de hoje,
   não pode regredir).
6. **Fora de escopo (YAGNI)**: painel de status de canais, suporte a múltiplas lojas
   Shopee simultâneas, Amazon (filtro existe na UI mas não tem implementação real),
   refazer a lógica interna de assinatura/token da Shopee (já validada correta).

## Arquitetura

### Frente 1 — Shopee em produção + gateway de egress

**Pré-requisitos, fora do código, nesta ordem:**

1. **Hostname corporativo para o gateway**: precisa de um domínio da empresa gerenciado
   na Cloudflare (ex: `shopee-egress.<domínio-da-empresa>`) pra servir de hostname
   público do túnel/Access — é o que recebe TLS válido e fica na frente do nginx da
   Lightsail. Confirmar com o Vinicius qual domínio usar antes de configurar (não
   necessariamente `lojababyworld.com.br` — a zona precisa estar na Cloudflare pra
   Tunnel/Access funcionarem).
2. **Provisionar a instância Lightsail** (São Paulo) e **associar o IP estático** —
   isso acontece **antes** do formulário Go-Live, já que o IP precisa estar disponível
   pra preencher o campo "IP Address Whitelist".
3. **Configurar Cloudflare Tunnel (`cloudflared`)** rodando na Lightsail, publicando
   o hostname `shopee-egress.<domínio>` protegido por **Cloudflare Access** com
   **Service Token** (não expõe a Lightsail direto na internet pra além do túnel).
4. **nginx HTTP** na Lightsail, atrás do túnel, como reverse proxy que:
   - só faz `proxy_pass` para `partner.shopeemobile.com` (e `partner.test-stable.
     shopeemobile.com` se ainda quisermos suporte a teste via o mesmo gateway) —
     qualquer outro host de destino é rejeitado;
   - preserva exatamente o path (`/api/v2/...`) e a querystring recebidos, sem
     reescrever parâmetros;
   - **não loga nem armazena** query string, body ou headers de autorização —
     `access_log off` ou log format que mascara esses campos (a query/body carrega
     `access_token`, `partner_key`-derived `sign`, etc., que são segredos).
5. **Preencher e enviar o formulário Go-Live** no Shopee Open Platform Console:
   - **IP Address Whitelist** = IP estático da Lightsail (não o IP do Worker — nunca
     fazia sentido, é dinâmico);
   - **Live Redirect URL Domain** = só o domínio (`https://babyworld.expede.workers.dev`),
     **distinto** da URL completa de callback usada no código
     (`https://babyworld.expede.workers.dev/api/shopee/callback`) — mesma pegadinha
     já documentada na Lição #21 pro campo equivalente do sandbox ("esse campo espera
     só o domínio, não a URL completa com path");
   - Product Brief, screenshot da UI, credencial de teste do EXPEDE pra revisão da
     Shopee (dados que só o Vinicius preenche).
6. **Aguardar aprovação da Shopee** — sem prazo garantido, decisão deles. **Não
   assumir que o Live Partner ID será `1235356`** — esse é o Test Partner ID do
   sandbox; o processo de Go-Live emite um Partner ID e Partner Key **novos e
   diferentes** pro ambiente Live, específicos desse app.

**Passo a passo técnico, só depois da aprovação:**

7. `wrangler secret put SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY` com os valores Live
   reais recebidos da Shopee (nunca colados em chat/log — digitados direto no prompt
   interativo do wrangler, mesmo padrão da Lição #21).
8. `wrangler.jsonc`: `SHOPEE_SANDBOX` passa a `"false"`.
9. `src/lib/shopee.ts`: as chamadas **server-to-server** (token exchange, refresh
   token, create/poll/download shipping document) passam a ir através do gateway
   (`https://shopee-egress.<domínio>/...`, autenticado com o Service Token/HMAC do
   item 4 da decisão de design) em vez de direto pro host da Shopee.
   **Exceção explícita**: `getShopeeAuthUrl()` (o `auth_partner`) **não** passa pelo
   gateway — essa etapa é uma navegação de **browser** (o operador clica "Conectar",
   o servidor monta a URL e devolve um redirect 302, e é o navegador do operador que
   visita a Shopee diretamente, não uma chamada server-to-server nossa). O IP
   whitelist da Shopee não se aplica a esse passo.
10. **Corrigir `buscarEtiquetaShopee()`** para parar de usar `SHOPEE_TEST_SHOP_ID` e
    em vez disso consultar `shopee_connections` filtrando **`is_sandbox = false`**
    e pegando a conexão de produção ativa mais recente (mesmo padrão de
    `getMLAccessToken()` em `ml.functions.ts:113-128`). Não itera por `shop_id`
    arbitrário — múltiplas lojas Shopee estão fora de escopo.
11. `getShopeeConnection()` (status exibido na UI de Configurações) também passa a
    filtrar `is_sandbox = false` em produção, pra não misturar uma conexão sandbox
    residual com o status real de produção mostrado pro operador.
12. Testar ponta a ponta: Conectar → autorizar na Shopee → confirmar linha nova em
    `shopee_connections` (`is_sandbox: false`) → bipar um pedido Shopee real →
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
  (numeroLoja) [ML]` (linhas 53-82 hoje) por
  `(CANAIS[marketplace ?? ""] ?? CANAIS["mercadolivre"]).buscarEtiqueta(numeroLoja)`
  — **preserva exatamente** o fallback atual pra ML quando `marketplace` é
  `null`/vazio/desconhecido (comportamento documentado hoje como "inclui pedidos
  legados sem marketplace definido", linha 69).
- **Nenhuma mudança de comportamento esperada** além da correção do fallback já
  descrita — é refactor puro no resto. Validação: os 3 fluxos de reimpressão
  (Expedição/Pedidos/Histórico) continuam chamando só `buscarEtiquetaBling`, que já
  é o único ponto de entrada — a unificação acontece inteiramente dentro dele.

## Ordem de entrega (dois blocos separados)

1. **Bloco 1 — Infraestrutura + Shopee produção**: provisionamento Lightsail/Tunnel/
   Access/nginx (fora do repo, documentado em `docs/`), + mudanças de código da
   Frente 1 (`shopee.ts`, `wrangler.jsonc`, secrets). Commitado e deployado
   separadamente, só depois de testado ponta a ponta com um pedido real.
2. **Bloco 2 — Canal unificado**: refactor da Frente 2, commitado depois do Bloco 1
   estar validado em produção — evita misturar uma mudança de infraestrutura externa
   (com aprovação de terceiro no meio) com um refactor interno que não depende dela.

## Critérios de aceite

1. Pedido Shopee real, bipado e com NF autorizada, imprime a etiqueta de transporte
   junto com a DANFE — sem erro `shopee_no_connection`.
2. `shopee_connections` tem uma linha com `is_sandbox: false` após a autorização de
   produção.
3. `buscarEtiquetaShopee()` usa a conexão de produção ativa (`is_sandbox = false`) —
   não itera por `shop_id` arbitrário (multi-loja fora de escopo).
4. Todas as chamadas **server-to-server** de produção à API da Shopee (token
   exchange, refresh, shipping document) passam pelo gateway — IP de origem visto
   pela Shopee é o IP estático da Lightsail. A navegação `auth_partner` (browser) é
   a exceção documentada e não passa pelo gateway.
5. O gateway nginx rejeita qualquer destino que não seja `partner.shopeemobile.com`
   (e o host sandbox, se mantido pra teste) e não grava query/body/tokens em log.
6. `getShopeeConnection()` (status na UI) reflete só a conexão de produção
   (`is_sandbox = false`).
7. `etiqueta.functions.ts` não tem mais `if (marketplace === "shopee")` inline —
   lookup único via `CANAIS`, com fallback pra ML preservado quando `marketplace`
   é nulo/legado.
8. `npm run build` passa limpo; os 3 fluxos de reimpressão continuam funcionando
   para ML sem regressão (validação manual, já que não há suite de testes
   automatizados no projeto).

## Arquivos afetados

| Arquivo | Tipo de mudança |
|---|---|
| `src/lib/shopee.ts` | Corrige `buscarEtiquetaShopee`/`getShopeeConnection` (filtro `is_sandbox=false`), adiciona `shopeeFetch()` via gateway (exceto `getShopeeAuthUrl`), exporta objeto `CanalMarketplace` |
| `src/lib/ml.functions.ts` | Exporta objeto `CanalMarketplace` |
| `src/lib/canais/types.ts` | Novo — contrato `CanalMarketplace` |
| `src/lib/etiqueta.functions.ts` | Troca if/else por lookup em `CANAIS`, preservando fallback ML |
| `wrangler.jsonc` | `SHOPEE_SANDBOX=false` (só após aprovação Go-Live) |
| Secrets Cloudflare | `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY` (Live, valores reais emitidos pela Shopee) |
| Infraestrutura nova (fora do repo de código) | Lightsail (São Paulo, IP estático) + Cloudflare Tunnel/Access (Service Token) + nginx reverse proxy restrito a `partner.shopeemobile.com` |

## Pendências / bloqueios externos

- **Vinicius**: definir o domínio corporativo pra hospedar `shopee-egress.<domínio>`
  na Cloudflare (pré-requisito do Tunnel/Access).
- **Vinicius**: provisionar Lightsail + IP estático, configurar Tunnel/Access/nginx
  (posso ajudar a escrever a config do nginx e o script do `cloudflared` quando a
  instância e o domínio existirem).
- **Vinicius**: preencher e enviar o formulário Go-Live (Product Brief, screenshot,
  credencial de teste do EXPEDE, Live Redirect URL Domain, IP estático da Lightsail).
- Aprovação da Shopee — sem prazo, decisão deles. Live Partner ID/Key só existem
  depois da aprovação, não assumir `1235356`.
