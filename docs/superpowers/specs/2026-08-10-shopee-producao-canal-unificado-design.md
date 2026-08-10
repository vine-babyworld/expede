# Design: Shopee em produção + canal de marketplace unificado

**Data:** 2026-08-10 (revisão 2)
**Status:** Aprovado (decisões de design + revisão técnica de segurança/operação do gateway confirmadas pelo Vinicius)

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

## Decisões de design

1. **Sandbox vs produção**: parar de insistir no ambiente sandbox da Shopee (já
   duplamente confirmado quebrado do lado deles) e migrar para o Partner App de
   **produção** via o botão **Go-Live** do próprio app "EXPEDE" — não é um app novo.
2. **Ordem de execução**: a infraestrutura de IP fixo precisa existir **antes** de
   enviar o formulário Go-Live, porque o formulário exige o IP estático no campo
   "IP Address Whitelist".
3. **Gateway de egress para IP fixo**: nem Cloudflare Workers nem Supabase Edge
   Functions oferecem IP de saída fixo fora do plano Enterprise da Cloudflare
   (sem preço público, desproporcional). Decisão: **AWS Lightsail, São Paulo,
   plano $5/mês**, com IP estático associado — rodando um **gateway HTTP reverso**:
   `Worker → Cloudflare Tunnel/Access → nginx (HTTP, loopback) na Lightsail →
   HTTPS → partner.shopeemobile.com`. Especificação completa na seção Arquitetura.
4. **Autenticação Worker↔gateway — decisão fixada**: **Cloudflare Access Service
   Token**. Não é "preferencial", é a solução escolhida. HMAC com timestamp existe
   só como contingência de reserva — se o Service Token se mostrar inviável durante
   a implementação, isso **exige nova decisão explícita** (não é uma troca
   automática/silenciosa).
5. **Canal unificado no código**: contrato comum (`buscarEtiqueta`,
   `getConnectionStatus`, `disconnect`) que `ml.functions.ts` e `shopee.ts` passam a
   implementar. `etiqueta.functions.ts` troca o `if (marketplace === "shopee")`
   inline por lookup num registro de canais, **preservando o fallback atual pra
   Mercado Livre** quando `marketplace` é `null`/legado.
6. **Fora de escopo (YAGNI)**: painel de status de canais, múltiplas lojas Shopee
   simultâneas, Amazon (sem implementação real hoje), refazer a lógica interna de
   assinatura/token da Shopee (já validada correta).

## Registro de infraestrutura (fatos, não segredos — IP público de infra é ok registrar aqui)

A instância já foi provisionada pelo Vinicius:

| Campo | Valor |
|---|---|
| Nome | `expede-shopee-proxy-prod` |
| Região / zona | São Paulo — `sa-east-1` / `sa-east-1a` |
| SO | Ubuntu 24.04 LTS |
| Plano | General Purpose, US$ 5/mês — 512 MB RAM, 2 vCPUs, 20 GB SSD |
| IPv4 estático | `54.20.20.253` (recurso `expede-shopee-static-ip-prod`, já associado) |
| IPv6 | Desabilitado |
| Firewall HTTP público | Sendo removido (80/443 não devem ficar públicos — ver Especificação do gateway) |
| Cloudflare Tunnel / Access / nginx | Ainda não configurados |

**Nunca registrar aqui**: token do Tunnel, Access Client Secret, chaves SSH privadas,
Partner Key da Shopee. Só fatos de infraestrutura pública (IP, nome, região).

## Arquitetura

### Frente 1 — Shopee em produção + gateway de egress

**Pré-requisitos, nesta ordem:**

1. **Hostname corporativo para o gateway**: precisa de um domínio da empresa
   gerenciado na Cloudflare (ex: `shopee-egress.<domínio-da-empresa>`) — confirmar
   com o Vinicius qual domínio antes de configurar Tunnel/Access.
2. ~~Provisionar Lightsail + IP estático~~ — **feito** (ver Registro de infraestrutura
   acima).
3. Configurar Cloudflare Tunnel + Access + nginx (especificação abaixo) — **ainda
   não feito**.
4. Preencher e enviar o formulário Go-Live com o IP `54.20.20.253`.
5. Aguardar aprovação da Shopee — sem prazo garantido. **Não assumir que o Live
   Partner ID será `1235356`** — esse é o Test Partner ID do sandbox; produção emite
   credenciais novas.

### Especificação do gateway (Lightsail: Tunnel + nginx)

**Exposição de rede:**
- nginx escuta **somente em `127.0.0.1`** (ex: `127.0.0.1:8080`) — nunca em
  `0.0.0.0`.
- Portas 80/443 **fechadas publicamente** no firewall da instância (Lightsail
  firewall + `ufw`) — já em andamento pelo Vinicius.
- SSH restrito (allowlist de IP de origem, não `0.0.0.0/0`).
- `cloudflared` roda como serviço systemd na própria instância e aponta pro nginx
  via `127.0.0.1:8080` — é o único caminho de entrada de tráfego externo pro nginx,
  via o túnel outbound do `cloudflared` (não precisa de porta pública aberta pra
  isso, é conexão de saída da VM pra Cloudflare).

**Autenticação de entrada (Worker → gateway):**
- Cloudflare Access na frente do hostname do túnel, exigindo **Service Token**
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) em toda requisição do Worker.

**Proxy de saída (nginx → Shopee):**
- `proxy_pass` via **HTTPS** pra `partner.shopeemobile.com` (produção **apenas** —
  o host sandbox `partner.test-stable.shopeemobile.com` **não** é mantido, já que
  decidimos abandonar o sandbox de vez).
- `proxy_ssl_verify on`, com bundle de CA confiável (`proxy_ssl_trusted_certificate`
  apontando pro CA bundle padrão do sistema, ex: `/etc/ssl/certs/ca-certificates.crt`
  no Ubuntu).
- `proxy_ssl_server_name on` (SNI correto) + `proxy_set_header Host
  partner.shopeemobile.com` (Host header correto).
- Preserva **exatamente** o path e a querystring recebidos — sem reescrever, sem
  normalizar parâmetros.
- **Só permite** path com prefixo `/api/v2/` — qualquer outro path é rejeitado
  (`444`/`403`).
- **Só permite métodos `GET` e `POST`** — qualquer outro método (`DELETE`, `PUT`,
  `PATCH`, etc.) é rejeitado.

**Headers — remover antes de repassar upstream pra Shopee:**
- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`
- `Cf-Access-Jwt-Assertion`
- `Cookie`
- Qualquer `Authorization` recebido (a autenticação da Shopee vai via `sign`/
  `access_token` na querystring do próprio payload da API deles, não via header
  `Authorization` — um header desses vazando upstream não faz sentido e é risco
  de vazamento de credencial do lado errado).

**Logging — regra ampliada (Worker, nginx e qualquer observabilidade):**
- **Nunca** logar/gravar/armazenar: URL assinada completa, querystring, body,
  `access_token`, `sign`, ou qualquer outra credencial — em nenhuma camada (Worker,
  nginx, serviço de monitoramento externo se algum for adicionado depois).
- Formato de log permitido: **path sem querystring**, status HTTP, `request_id`
  sanitizado (ex: só os primeiros N caracteres, ou um hash, nunca o valor completo
  se ele puder conter algo sensível — na prática o `request_id` da Shopee já é
  opaco, mas tratar como se pudesse não ser).
- nginx: `log_format` customizado que descarta `$request_uri` completo, loga só
  o path base; ou `access_log off` no `location` do proxy Shopee especificamente.

**systemd + resiliência (instância de 512 MB é enxuta):**
- `nginx.service` e `cloudflared.service` habilitados no boot, `Restart=on-failure`
  (systemd já cobre isso por padrão pro nginx no Ubuntu; confirmar/adicionar
  explicitamente pro `cloudflared`).
- **Health check**: endpoint leve no nginx (`location /healthz { return 200; }`,
  não exposto via o túnel Access, só local) monitorado por um script cron simples
  ou pelo próprio `cloudflared`/Lightsail health check, pra detectar o proxy
  travado.
- **Swap**: 512 MB de RAM é pouco — adicionar um swapfile (ex: 1 GB) pra evitar
  OOM kill do nginx/`cloudflared` sob pico, já que não há orçamento de memória
  sobrando nessa instância.

**Segredos:**
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`: `wrangler secret put` (o
  Worker precisa deles pra autenticar no Access) — **documentar rotação**: Service
  Tokens da Cloudflare Access têm data de expiração configurável no painel; anotar
  a data de expiração escolhida e criar lembrete pra rotacionar antes de vencer
  (um Service Token vencido derruba a etiqueta Shopee silenciosamente se não
  monitorado).
- Token/credencial do Tunnel (`cloudflared` credentials file): fica **só na VM**
  (`/etc/cloudflared/`, permissão restrita a root), nunca vira secret do Worker —
  o Worker não fala com o Tunnel diretamente, fala com o hostname público
  protegido por Access.

### Passo a passo de deploy (ordem corrigida)

1. Provisionar e **validar o gateway isoladamente** (testar com `curl` direto da
   Lightsail e depois via o hostname do Tunnel, autenticado com Service Token,
   contra um endpoint de teste da Shopee — antes de qualquer mudança no Worker).
2. Implementar as mudanças de código (`shopee.ts`, `wrangler.jsonc`) numa **branch/
   worktree própria** (ver seção Estratégia de branch abaixo) e buildar localmente.
3. **Gate de deploy existente, obrigatório antes de qualquer novo deploy de
   produção** (bloqueio ativo documentado em `CURRENT-STATE.md`/`SESSION-HANDOFF.md`
   desde 08/08/2026, Lições #24-26): validar que `VITE_SUPABASE_URL` e
   `VITE_SUPABASE_PUBLISHABLE_KEY` estão corretamente resolvidas no build do
   cliente, e validar a SPA renderizando em navegador real (não só HTTP 200) —
   antes de publicar. Esse gate é geral pro projeto, não específico do Shopee.
4. **Obter autorização explícita do Vinicius** antes do deploy em si (mesmo padrão
   já em uso no projeto pra mudanças de produção).
5. Deploy controlado (`npm run build` → `wrangler deploy`, mesma ordem da Lição #14).
6. Testar ponta a ponta em produção: Conectar → autorizar → confirmar linha em
   `shopee_connections` (`is_sandbox: false`) → bipar pedido Shopee real → etiqueta
   sai na impressora.
7. **Plano de rollback**: se algo falhar, reverter pro Worker version anterior
   (`wrangler rollback` ou publicar a versão anterior conhecida boa), sem precisar
   desfazer a infraestrutura do gateway (ela é aditiva, não substitui nada
   existente).

### Estratégia de branch

Trabalho da Frente 1 acontece numa **branch/worktree própria pro Shopee** (ex:
`shopee-producao`, mesmo padrão já usado pro `codex/nf-ml-controlada`), **não**
direto em `main` — evita misturar uma mudança que depende de aprovação externa
(prazo incerto) com o estado de `main`, e preserva as mudanças já existentes em
`main` (incluindo o fix de hoje, commit `89427d0`, e o trabalho do controlador de
NF ML já integrado mas não ativo em produção). Merge pra `main` só depois de
validado ponta a ponta.

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
  (wrapper fino em cima das funções já existentes).
- `etiqueta.functions.ts`: novo registro `const CANAIS: Record<string, CanalMarketplace>`.
  `buscarEtiquetaBling` troca o bloco `if (marketplace === "shopee") ... else if
  (numeroLoja) [ML]` por
  `(CANAIS[marketplace ?? ""] ?? CANAIS["mercadolivre"]).buscarEtiqueta(numeroLoja)`
  — **preserva exatamente** o fallback atual pra ML quando `marketplace` é
  `null`/vazio/desconhecido.
- **Nenhuma mudança de comportamento esperada** além da correção do fallback já
  descrita — refactor puro no resto.

## Ordem de entrega (dois blocos separados)

1. **Bloco 1 — Infraestrutura + Shopee produção**: gateway (Tunnel/Access/nginx) +
   mudanças de código da Frente 1, em branch própria, seguindo o passo a passo de
   deploy corrigido acima. Merge/deploy só depois de validado ponta a ponta com
   pedido real.
2. **Bloco 2 — Canal unificado**: refactor da Frente 2, commitado em `main` depois
   do Bloco 1 estar validado em produção.

## Critérios de aceite

1. Pedido Shopee real, bipado e com NF autorizada, imprime a etiqueta de transporte
   junto com a DANFE — sem erro `shopee_no_connection`.
2. `shopee_connections` tem uma linha com `is_sandbox: false` após a autorização de
   produção.
3. `buscarEtiquetaShopee()` usa a conexão de produção ativa (`is_sandbox = false`) —
   não itera por `shop_id` arbitrário (multi-loja fora de escopo).
4. Todas as chamadas **server-to-server** de produção à API da Shopee passam pelo
   gateway (IP de origem visto pela Shopee = `54.20.20.253`). A navegação
   `auth_partner` (browser) é a exceção documentada.
5. nginx só aceita `/api/v2/` + métodos GET/POST, só encaminha pra
   `partner.shopeemobile.com`, remove os headers de Access/Cookie/Authorization
   antes do upstream, e não grava query/body/tokens em log (Worker, nginx e
   qualquer observabilidade).
6. `getShopeeConnection()` (status na UI) reflete só a conexão de produção
   (`is_sandbox = false`).
7. `etiqueta.functions.ts` não tem mais `if (marketplace === "shopee")` inline —
   lookup único via `CANAIS`, com fallback pra ML preservado.
8. Gate de deploy (`VITE_SUPABASE_*` + validação em navegador real) passou antes
   do deploy de produção da Frente 1.
9. `npm run build` passa limpo; os 3 fluxos de reimpressão continuam funcionando
   para ML sem regressão.

## Arquivos afetados

| Arquivo | Tipo de mudança |
|---|---|
| `src/lib/shopee.ts` | Corrige `buscarEtiquetaShopee`/`getShopeeConnection` (`is_sandbox=false`), adiciona `shopeeFetch()` via gateway com Service Token (exceto `getShopeeAuthUrl`), exporta objeto `CanalMarketplace` |
| `src/lib/ml.functions.ts` | Exporta objeto `CanalMarketplace` |
| `src/lib/canais/types.ts` | Novo — contrato `CanalMarketplace` |
| `src/lib/etiqueta.functions.ts` | Troca if/else por lookup em `CANAIS`, preservando fallback ML |
| `wrangler.jsonc` | `SHOPEE_SANDBOX=false` (só após aprovação Go-Live) |
| Secrets Cloudflare | `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY` (Live), `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` |
| Infraestrutura (fora do repo) | Lightsail `expede-shopee-proxy-prod` (já criada) + Cloudflare Tunnel/Access (Service Token) + nginx restrito, systemd + swap |

## Pendências / bloqueios externos

- **Vinicius**: definir o domínio corporativo pra `shopee-egress.<domínio>`.
- **Vinicius**: terminar de fechar o firewall público (80/443) — já em andamento.
- **Vinicius + eu**: configurar Tunnel/Access/nginx na instância já provisionada.
- **Vinicius**: preencher e enviar o formulário Go-Live com IP `54.20.20.253`.
- Aprovação da Shopee — sem prazo, decisão deles.
- **Gate de deploy geral do projeto** (não específico do Shopee): `VITE_SUPABASE_*`
  precisa continuar resolvendo corretamente em qualquer build novo — validar de
  novo antes do deploy desta feature, mesmo já tendo funcionado no deploy de hoje
  (commit `89427d0`, verificado em navegador real via Playwright).
