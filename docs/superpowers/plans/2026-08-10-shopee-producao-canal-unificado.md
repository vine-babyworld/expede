# Shopee Produção + Canal Unificado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans ou
> superpowers:subagent-driven-development pra executar este plano tarefa por
> tarefa. Steps usam checkbox (`- [ ]`) pra tracking.
>
> **BLOQUEIO ATIVO, NÃO IGNORAR:** nenhuma tarefa deste plano pode ser executada
> além da criação dos arquivos de configuração (Task 2) até o Vinicius confirmar
> que a zona `bwbaby.com.br` está **Active** no painel Cloudflare (ver Task 1).
> **Não rodar `npx wrangler deploy`, não enviar o formulário Go-Live da Shopee, e
> não alterar `wrangler.jsonc`/secrets de produção sem confirmação explícita do
> Vinicius** — regra permanente do projeto (`CLAUDE.md`, "Deploy é sempre
> manual") mais o bloqueio específico desta feature.

**Goal:** Migrar a integração Shopee do sandbox quebrado (Lição #21) pro
ambiente de produção via Go-Live, com um gateway de IP fixo (Lightsail) na
frente das chamadas server-to-server, e unificar o contrato de canal de
marketplace no código pra eliminar a duplicação que já causou um bug real
(`pdf_base64` faltando em 2 de 3 fluxos de reimpressão).

**Architecture:** ver
`docs/superpowers/specs/2026-08-10-shopee-producao-canal-unificado-design.md`
(revisão 3). Resumo: `Worker → Cloudflare Tunnel/Access (Service Token) →
nginx (loopback) na Lightsail → HTTPS → partner.shopeemobile.com`, mais um
contrato `CanalMarketplace` compartilhado entre `ml.functions.ts` e
`shopee.ts`.

**Tech Stack:** TanStack Start (server functions), Cloudflare Workers,
Cloudflare Tunnel + Access, nginx, AWS Lightsail (Ubuntu 24.04), systemd.

Não há test suite no projeto — verificação é via `npm run build` (TypeScript)
e teste manual (dev server / produção). Infraestrutura (Tunnel/nginx/systemd)
não tem equivalente de "teste automatizado" — verificação é `curl` direto e
inspeção de logs/status do systemd.

## Global Constraints

- Hostname do gateway fixado: `shopee-egress.bwbaby.com.br` (spec, decisão 1 do domínio corporativo).
- Autenticação Worker↔gateway: **Cloudflare Access Service Token**, não IP do Worker, não HMAC (HMAC só entra com nova decisão explícita se o Service Token se mostrar inviável).
- nginx escuta **só em `127.0.0.1`** — nunca `0.0.0.0`. Portas 80/443 fechadas publicamente (já feito na instância).
- Proxy de saída: só `partner.shopeemobile.com`, só `/api/v2/`, só métodos `GET`/`POST`, `proxy_ssl_verify on`.
- Headers removidos antes do upstream: `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `Cf-Access-Jwt-Assertion`, `Cookie`, qualquer `Authorization` recebido.
- Log: nunca gravar querystring, body ou credenciais — em nenhuma camada (Worker, nginx, observabilidade).
- `/healthz` responde só por loopback — nunca publicado pelo hostname do Tunnel.
- Multi-loja Shopee fora de escopo — sempre usa a conexão `is_sandbox=false` mais recente, sem iterar por `shop_id` arbitrário.
- Fallback ML pro registro `CANAIS` precisa ser preservado exatamente (`marketplace` nulo/legado → ML), comportamento de hoje.
- Trabalho da Frente 1 roda em branch/worktree própria (`shopee-producao`), não direto em `main`.
- Bloco 2 (canal unificado) só começa depois do Bloco 1 validado em produção (ordem de entrega do spec).

---

## File Map

| Arquivo | Operação | Responsabilidade |
|---|---|---|
| `ops/shopee-gateway/nginx-shopee-egress.conf` | Create | Config nginx do gateway (versionada no repo, copiada pra Lightsail) |
| `ops/shopee-gateway/cloudflared-config.yml` | Create | Config do túnel Cloudflare (template, `TUNNEL_ID` preenchido na hora) |
| `ops/shopee-gateway/setup-swap.sh` | Create | Script de setup de swap 1GB pra instância de 512MB |
| `ops/shopee-gateway/README.md` | Create | Runbook passo a passo pra configurar a VM (comandos SSH) |
| `src/lib/shopee.ts` | Modify | `shopeeFetch()` via gateway, `buscarEtiquetaShopee`/`getShopeeConnection` filtram `is_sandbox=false`, exporta `CanalMarketplace` |
| `wrangler.jsonc` | Modify | `SHOPEE_SANDBOX=false` (só após aprovação) |
| `src/lib/canais/types.ts` | Create | Contrato `CanalMarketplace` (Bloco 2) |
| `src/lib/ml.functions.ts` | Modify | Exporta objeto `CanalMarketplace` (Bloco 2) |
| `src/lib/etiqueta.functions.ts` | Modify | Lookup via `CANAIS` com fallback ML preservado (Bloco 2) |

---

## Bloco 1 — Gateway + Shopee produção

### Task 1: Gate — confirmar ativação da zona `bwbaby.com.br`

**Files:** nenhum (checkpoint manual)

- [ ] **Step 1: Perguntar ao Vinicius se a zona `bwbaby.com.br` já está `Active`**

  No painel Cloudflare → domínio `bwbaby.com.br` → status deve mostrar
  "Active", não "Pending Nameservers". Nameservers esperados: `dane.ns.
  cloudflare.com` e `rita.ns.cloudflare.com` (já configurados no Registro.br,
  faltando propagar/ativar).

- [ ] **Step 2: Se ainda não estiver ativa — PARAR aqui**

  Não prosseguir pra Task 3 em diante (tudo que envolve Tunnel/DNS/Access).
  Task 2 (criar os arquivos de config no repo) pode ser feita antes, já que
  não depende da zona estar ativa — só do hostname já estar decidido
  (`shopee-egress.bwbaby.com.br`, que já está).

---

### Task 2: Artefatos de configuração do gateway (versionados no repo)

**Files:**
- Create: `ops/shopee-gateway/nginx-shopee-egress.conf`
- Create: `ops/shopee-gateway/cloudflared-config.yml`
- Create: `ops/shopee-gateway/setup-swap.sh`
- Create: `ops/shopee-gateway/README.md`

- [ ] **Step 1: Criar `ops/shopee-gateway/nginx-shopee-egress.conf`**

  ```nginx
  # Gateway restrito de egress pra Shopee — só GET/POST em /api/v2/*, só
  # encaminha pra partner.shopeemobile.com. NUNCA loga querystring/body:
  # a query carrega access_token/sign, que são credenciais.

  log_format shopee_gateway '$remote_addr - [$time_local] "$request_method $uri" $status $body_bytes_sent';

  server {
      listen 127.0.0.1:8080;
      server_name shopee-egress-internal;

      access_log /var/log/nginx/shopee-egress.access.log shopee_gateway;
      error_log /var/log/nginx/shopee-egress.error.log;

      # Health check — SÓ loopback. Nunca deixar isso acessível pelo hostname
      # do Tunnel (não referenciar essa location em nenhuma config exposta
      # via cloudflared).
      location = /healthz {
          default_type text/plain;
          return 200 "ok";
      }

      location /api/v2/ {
          limit_except GET POST { deny all; }

          proxy_http_version 1.1;
          proxy_ssl_verify on;
          proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
          proxy_ssl_server_name on;

          # Remove headers de entrada antes de repassar upstream — Access/Cookie/
          # Authorization não fazem sentido pra Shopee e não podem vazar.
          proxy_set_header Host partner.shopeemobile.com;
          proxy_set_header CF-Access-Client-Id "";
          proxy_set_header CF-Access-Client-Secret "";
          proxy_set_header Cf-Access-Jwt-Assertion "";
          proxy_set_header Cookie "";
          proxy_set_header Authorization "";

          proxy_pass https://partner.shopeemobile.com;
      }

      location / {
          return 404;
      }
  }
  ```

- [ ] **Step 2: Criar `ops/shopee-gateway/cloudflared-config.yml`**

  ```yaml
  # Template — substituir <TUNNEL_ID> pelo ID real gerado por
  # `cloudflared tunnel create expede-shopee-egress` (Task 3).
  tunnel: <TUNNEL_ID>
  credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

  ingress:
    # Só expõe /api/v2/* — /healthz do nginx NUNCA é roteado aqui de propósito.
    - hostname: shopee-egress.bwbaby.com.br
      service: http://127.0.0.1:8080
    - service: http_status:404
  ```

- [ ] **Step 3: Criar `ops/shopee-gateway/setup-swap.sh`**

  ```bash
  #!/usr/bin/env bash
  # Swap de 1GB pra instância de 512MB RAM — evita OOM kill do nginx/cloudflared
  # sob pico. Rodar uma vez na Lightsail expede-shopee-proxy-prod.
  set -euo pipefail

  if swapon --show | grep -q '/swapfile'; then
    echo "swap já configurado, nada a fazer"
    exit 0
  fi

  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap de 1GB ativo:"
  swapon --show
  ```

- [ ] **Step 4: Criar `ops/shopee-gateway/README.md`**

  ```markdown
  # Gateway de egress Shopee — runbook

  Pré-requisito: zona `bwbaby.com.br` **Active** na Cloudflare (Task 1 do
  plano de implementação). Não seguir os passos abaixo antes disso.

  Instância alvo: `expede-shopee-proxy-prod` (São Paulo, IP `54.20.20.253`).

  ## 1. Swap

  Copiar `setup-swap.sh` pra instância e rodar como root:
  ```bash
  scp ops/shopee-gateway/setup-swap.sh ubuntu@54.20.20.253:/tmp/
  ssh ubuntu@54.20.20.253 'sudo bash /tmp/setup-swap.sh'
  ```

  ## 2. nginx

  ```bash
  sudo apt update && sudo apt install -y nginx
  ```
  Copiar `nginx-shopee-egress.conf` pra
  `/etc/nginx/sites-available/shopee-egress.conf` na instância, linkar em
  `sites-enabled`, remover o `default` do nginx se existir, `nginx -t` pra
  validar sintaxe, `systemctl reload nginx`.

  Confirmar que nginx só escuta em `127.0.0.1`:
  ```bash
  sudo ss -tlnp | grep nginx
  ```
  Esperado: `127.0.0.1:8080`, nada em `0.0.0.0:80` ou `:443`.

  ## 3. Cloudflare Tunnel

  ```bash
  curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared.deb
  cloudflared tunnel login   # abre URL — autenticar na conta Cloudflare da empresa
  cloudflared tunnel create expede-shopee-egress
  ```
  Anotar o `TUNNEL_ID` gerado, preencher em `cloudflared-config.yml` (2
  ocorrências), copiar pra `/etc/cloudflared/config.yml` na instância.

  ```bash
  cloudflared tunnel route dns expede-shopee-egress shopee-egress.bwbaby.com.br
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared
  sudo systemctl status cloudflared   # confirmar "active (running)"
  ```

  ## 4. Cloudflare Access (Service Token)

  No painel Cloudflare Zero Trust → Access → Applications → Add an
  application → Self-hosted:
  - Domain: `shopee-egress.bwbaby.com.br`
  - Policy: Service Auth, exigindo o Service Token que será criado a seguir.

  Zero Trust → Access → Service Auth → Create Service Token:
  - Nome: `expede-worker-shopee-gateway`
  - **Definir expiração** (ex: 1 ano) — anotar a data em `PENDING-DECISIONS.md`
    ou equivalente, criar lembrete de rotação antes de vencer.
  - Copiar `Client ID` e `Client Secret` — **não colar em chat/log**, só
    digitar direto no `wrangler secret put` (Task 7).

  ## 5. SSH — restrição final (pendente de confirmação, ver spec)

  ```bash
  sudo ufw allow from <IP_DE_ORIGEM_DO_VINICIUS>/32 to any port 22 proto tcp
  sudo ufw default deny incoming
  sudo ufw allow 22/tcp from <IP_DE_ORIGEM_DO_VINICIUS>/32
  sudo ufw enable
  ```
  Substituir `<IP_DE_ORIGEM_DO_VINICIUS>` pelo IP real de onde ele acessa via
  SSH — decisão ainda pendente, não aplicar com um IP genérico/errado (risco
  de se trancar pra fora da instância).

  ## 6. systemd — auto-restart

  nginx e `cloudflared` já vêm com unit systemd padrão no Ubuntu 24.04
  (`nginx.service`, `cloudflared.service` criado pelo `service install`
  acima). Confirmar `Restart=on-failure` em ambos:
  ```bash
  systemctl show nginx.service -p Restart
  systemctl show cloudflared.service -p Restart
  ```
  Se algum não tiver `Restart=on-failure`, adicionar via
  `systemctl edit <service>` (drop-in), não editar o unit file gerado
  diretamente.
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add ops/shopee-gateway/
  git commit -m "docs(ops): runbook e configs do gateway de egress Shopee (Lightsail)"
  ```

---

### Task 3: Configurar Tunnel + Access + nginx na Lightsail

**BLOQUEADO até Task 1 confirmar zona `bwbaby.com.br` ativa.**

**Files:** nenhum no repo (execução remota via SSH, seguindo `ops/shopee-gateway/README.md`)

- [ ] **Step 1: Seguir `ops/shopee-gateway/README.md` seções 1-4, na ordem**

  Executado pelo Vinicius (ou por mim com acesso SSH, se ele conceder e
  confirmar explicitamente) — não é algo que rodo sem confirmação, já que
  mexe numa VM de produção fora do repositório de código.

- [ ] **Step 2: Validar nginx isoladamente, direto na instância**

  ```bash
  curl -s http://127.0.0.1:8080/healthz
  ```
  Esperado: `ok`.

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    "http://127.0.0.1:8080/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=x"
  ```
  Esperado: algum status HTTP vindo da Shopee de verdade (ex: `400`/`403` por
  parâmetros inválidos) — confirma que o proxy está alcançando
  `partner.shopeemobile.com`, não que a chamada é válida.

- [ ] **Step 3: Validar `/healthz` NÃO está acessível de fora**

  De uma máquina fora da Lightsail:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://shopee-egress.bwbaby.com.br/healthz
  ```
  Esperado: **não** `200` — ou 404 (rota não mapeada no `ingress` do
  cloudflared) ou bloqueio do Access. Se retornar `200` com `ok`, a config do
  `cloudflared-config.yml` está expondo o `/healthz` sem querer — corrigir
  antes de prosseguir.

---

### Task 4: Validar o gateway ponta a ponta com Service Token

**BLOQUEADO até Task 3 completa.**

**Files:** nenhum

- [ ] **Step 1: Testar autenticado, de fora da Lightsail**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "CF-Access-Client-Id: <CLIENT_ID>" \
    -H "CF-Access-Client-Secret: <CLIENT_SECRET>" \
    "https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=x"
  ```
  Esperado: resposta da Shopee (não do Access — se vier HTML de login do
  Access, o Service Token não está sendo aceito, revisar a Policy).

- [ ] **Step 2: Testar sem o Service Token — deve ser rejeitado**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=x"
  ```
  Esperado: bloqueado pelo Access (não chega no nginx/Shopee).

- [ ] **Step 3: Testar método/path fora do permitido — deve ser rejeitado pelo nginx**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -X DELETE \
    -H "CF-Access-Client-Id: <CLIENT_ID>" -H "CF-Access-Client-Secret: <CLIENT_SECRET>" \
    "https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner"
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "CF-Access-Client-Id: <CLIENT_ID>" -H "CF-Access-Client-Secret: <CLIENT_SECRET>" \
    "https://shopee-egress.bwbaby.com.br/api/v1/outro-path"
  ```
  Esperado: ambos rejeitados (nginx `403`/`444`, não alcançam a Shopee).

---

### Task 5: Preencher e enviar o formulário Go-Live

**BLOQUEADO até Task 4 confirmar o gateway funcionando ponta a ponta.**

**Files:** nenhum (ação do Vinicius no console da Shopee)

- [ ] **Step 1: Vinicius preenche o formulário** com IP `54.20.20.253`, Live
  Redirect URL Domain = `https://babyworld.expede.workers.dev` (só o domínio,
  não o path completo — Lição #21), Product Brief, screenshot, credencial de
  teste do EXPEDE pra revisão.

- [ ] **Step 2: Aguardar aprovação** — sem prazo garantido. Não prosseguir
  pra Task 6 antes da aprovação chegar (Live Partner ID/Key emitidos).

---

### Task 6: `shopeeFetch()` via gateway + correção de `is_sandbox` (código)

**BLOQUEADO até Task 5 (aprovação da Shopee com credenciais Live em mãos).**

**Files:**
- Modify: `src/lib/shopee.ts`

**Interfaces:**
- Consumes: nenhuma (self-contained neste arquivo)
- Produces: `shopeeFetch(url: string, init?: RequestInit): Promise<Response>` — usado internamente por `buildShopeeUrl`-consumers em vez de `fetch()` cru, para chamadas server-to-server. `getShopeeAuthUrl()` continua sem usar `shopeeFetch` (exceção documentada — navegação de browser).

- [ ] **Step 1: Trabalhar numa branch própria**

  ```bash
  git checkout -b shopee-producao
  ```

- [ ] **Step 2: Adicionar `shopeeFetch()` em `src/lib/shopee.ts`, logo após os imports (linha 3)**

  ```ts
  const SHOPEE_GATEWAY_URL = "https://shopee-egress.bwbaby.com.br";

  /**
   * Chamadas server-to-server pra Shopee em produção passam pelo gateway
   * (IP fixo exigido pelo whitelist da Shopee) autenticado com Cloudflare
   * Access Service Token. EXCEÇÃO: getShopeeAuthUrl() não usa isso — é uma
   * navegação de browser (auth_partner), não uma chamada nossa.
   */
  async function shopeeFetch(shopeeUrl: string, init?: RequestInit): Promise<Response> {
    if (isShopeeSandbox()) {
      // Sandbox segue direto — não tem exigência de IP whitelist.
      return fetch(shopeeUrl, init);
    }

    const clientId = process.env.CF_ACCESS_CLIENT_ID;
    const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("[SHOPEE] CF_ACCESS_CLIENT_ID/SECRET não configurados — obrigatório em produção");
    }

    const url = new URL(shopeeUrl);
    const gatewayUrl = `${SHOPEE_GATEWAY_URL}${url.pathname}${url.search}`;

    return fetch(gatewayUrl, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    });
  }
  ```

- [ ] **Step 3: Trocar os `fetch()` diretos por `shopeeFetch()` nas funções server-to-server**

  Em `refreshShopeeTokenIfNeeded` (linha ~141), `exchangeShopeeCode` (linha
  ~205), e dentro de `buscarEtiquetaShopee` (linhas ~293, ~318 —
  `createRes`/`downloadRes`) e `pollShopeeShippingDocumentReady` (linha ~258):
  trocar `await fetch(url, {...})` por `await shopeeFetch(url, {...})`. **Não
  tocar em `getShopeeAuthUrl()`** — continua montando a URL e devolvendo pro
  caller sem chamar `fetch`/`shopeeFetch` nenhum (é só string building, quem
  navega é o browser via redirect 302 na rota `/api/shopee/auth`).

- [ ] **Step 4: Corrigir `buscarEtiquetaShopee()` pra usar a conexão real em vez de `SHOPEE_TEST_SHOP_ID`**

  Código atual (linha 275-284):
  ```ts
  export async function buscarEtiquetaShopee(orderSn: string): Promise<ShopeeEtiquetaResult> {
    const shopId = process.env.SHOPEE_TEST_SHOP_ID;
    if (!shopId) return { ok: false, error: "shopee_shop_id_not_configured" };

    let accessToken: string;
    try {
      accessToken = await refreshShopeeTokenIfNeeded(shopId);
    } catch {
      return { ok: false, error: "shopee_no_connection" };
    }
  ```

  Substituir por:
  ```ts
  export async function buscarEtiquetaShopee(orderSn: string): Promise<ShopeeEtiquetaResult> {
    const { data: conn, error } = await supabaseAdmin
      .from("shopee_connections")
      .select("shop_id")
      .eq("is_sandbox", isShopeeSandbox())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) console.error("[SHOPEE] erro ao buscar conexão ativa:", error.message);
    if (!conn) return { ok: false, error: "shopee_no_connection" };

    const shopId = conn.shop_id;

    let accessToken: string;
    try {
      accessToken = await refreshShopeeTokenIfNeeded(shopId);
    } catch {
      return { ok: false, error: "shopee_no_connection" };
    }
  ```

  > Nota: `.eq("is_sandbox", isShopeeSandbox())` usa conexão sandbox quando
  > `SHOPEE_SANDBOX=true`, conexão de produção quando `false` — mantém o
  > comportamento testável em sandbox (`SHOPEE_TEST_SHOP_ID` deixa de existir
  > como dependência) e já entrega o filtro `is_sandbox=false` pedido pro
  > cenário de produção.

- [ ] **Step 5: Corrigir `getShopeeConnection()` pra filtrar pela mesma regra**

  Código atual (linha 350-362):
  ```ts
  export const getShopeeConnection = createServerFn({ method: "GET" })
    .middleware([requireSupabaseAuth])
    .handler(async (): Promise<ShopeeConnectionStatus> => {
      const { data } = await supabaseAdmin
        .from("shopee_connections")
        .select("shop_id, access_token_expires_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
  ```

  Substituir a query por:
  ```ts
      const { data } = await supabaseAdmin
        .from("shopee_connections")
        .select("shop_id, access_token_expires_at")
        .eq("is_sandbox", isShopeeSandbox())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
  ```

- [ ] **Step 6: Verificar build**

  ```bash
  npm run build
  ```
  Esperado: zero erros novos.

- [ ] **Step 7: Commit (ainda na branch `shopee-producao`, sem merge em `main`)**

  ```bash
  git add src/lib/shopee.ts
  git commit -m "feat(shopee): chamadas server-to-server via gateway de egress + filtro is_sandbox real"
  ```

---

### Task 7: Secrets + flag de produção

**BLOQUEADO — só depois da Task 6 e com autorização explícita do Vinicius pra mexer em secrets/config de produção.**

**Files:**
- Modify: `wrangler.jsonc`

- [ ] **Step 1: Configurar os secrets (Vinicius digita direto no prompt interativo, nunca colar em chat)**

  ```bash
  npx wrangler secret put SHOPEE_PARTNER_ID
  npx wrangler secret put SHOPEE_PARTNER_KEY
  npx wrangler secret put CF_ACCESS_CLIENT_ID
  npx wrangler secret put CF_ACCESS_CLIENT_SECRET
  ```

- [ ] **Step 2: Atualizar `wrangler.jsonc`**

  Trocar:
  ```jsonc
  "vars": {
    "SHOPEE_SANDBOX": "true",
    "SHOPEE_TEST_PARTNER_ID": "1235356",
    "SHOPEE_TEST_SHOP_ID": "227816515"
  }
  ```
  Por:
  ```jsonc
  "vars": {
    "SHOPEE_SANDBOX": "false"
  }
  ```
  (Os `SHOPEE_TEST_*` deixam de ser necessários já que `buscarEtiquetaShopee`
  não depende mais de `SHOPEE_TEST_SHOP_ID` — Task 6, Step 4. Se quiser manter
  a capacidade de testar em sandbox depois, deixar os `TEST_*` e só trocar
  `SHOPEE_SANDBOX` via variável de ambiente na hora do deploy, não hardcoded —
  decisão do Vinicius, não assumir.)

- [ ] **Step 3: Commit**

  ```bash
  git add wrangler.jsonc
  git commit -m "feat(shopee): ativa modo produção (SHOPEE_SANDBOX=false)"
  ```

---

### Task 8: Gate de deploy + deploy controlado

**BLOQUEADO até Task 7. Requer autorização explícita do Vinicius antes do Step 3.**

**Files:** nenhum (build + deploy)

- [ ] **Step 1: Rodar o gate de deploy geral do projeto (bloqueio documentado desde 08/08/2026)**

  ```bash
  npm run build
  ```
  Confirmar que o build local tem `.env` presente (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`) — verificar:
  ```bash
  grep -c "VITE_SUPABASE_URL" .env
  ```
  Esperado: `1` (ou mais). Se `.env` não tiver essas chaves, **parar** — não
  builda/deploya sem isso (Lições #24-26).

- [ ] **Step 2: Validar a SPA em navegador real, servindo o build local**

  ```bash
  npx vite preview
  ```
  Abrir no navegador, confirmar tela de login renderiza sem erro de
  configuração ausente (mesmo critério documentado no `SESSION-HANDOFF.md` de
  08/08 — HTTP 200 sozinho não é suficiente, tem que executar o JS).

- [ ] **Step 3: Merge da branch `shopee-producao` em `main` — só com autorização explícita do Vinicius**

  ```bash
  git checkout main
  git pull origin main
  git merge shopee-producao
  ```

- [ ] **Step 4: Deploy — só com autorização explícita do Vinicius**

  ```bash
  npm run build
  npx wrangler deploy --config .output/server/wrangler.json
  ```

- [ ] **Step 5: Validar em navegador real, contra produção**

  Repetir a validação do Step 2, agora contra
  `https://babyworld.expede.workers.dev`.

---

### Task 9: Teste ponta a ponta em produção + rollback se necessário

**BLOQUEADO até Task 8.**

**Files:** nenhum

- [ ] **Step 1: Conectar Shopee em Configurações → Marketplaces**

  Autorizar, confirmar redirect de volta sem erro.

- [ ] **Step 2: Confirmar linha nova em `shopee_connections`**

  ```sql
  select shop_id, is_sandbox, access_token_expires_at, created_at
  from shopee_connections order by created_at desc limit 1;
  ```
  Esperado: `is_sandbox = false`.

- [ ] **Step 3: Bipar um pedido Shopee real e confirmar impressão da etiqueta**

  Etiqueta de transporte sai junto com a DANFE, sem erro `shopee_no_connection`.

- [ ] **Step 4: Se algo falhar — rollback**

  ```bash
  npx wrangler rollback
  ```
  Ou publicar a versão anterior conhecida boa. A infraestrutura do gateway é
  aditiva (não precisa ser desfeita) — só reverter o código do Worker.

---

## Bloco 2 — Canal unificado no código

**Só começa depois do Bloco 1 validado em produção (Task 9 completa).**

### Task 10: Contrato `CanalMarketplace`

**Files:**
- Create: `src/lib/canais/types.ts`

**Interfaces:**
- Produces: `EtiquetaResult`, `ConnectionStatus`, `CanalMarketplace` — usados pelas Tasks 11-13.

- [ ] **Step 1: Criar o arquivo**

  ```ts
  export type EtiquetaResult =
    | { ok: true; tipo: "zpl" | "pdf_base64"; conteudo: string }
    | { ok: false; error: string };

  export type ConnectionStatus =
    | { connected: true; label: string; expires_at: string }
    | { connected: false };

  export interface CanalMarketplace {
    id: string;
    buscarEtiqueta(orderId: string): Promise<EtiquetaResult>;
    getConnectionStatus(): Promise<ConnectionStatus>;
    disconnect(): Promise<{ ok: boolean }>;
  }
  ```

- [ ] **Step 2: Verificar build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/lib/canais/types.ts
  git commit -m "feat(canais): adiciona contrato CanalMarketplace compartilhado"
  ```

---

### Task 11: `ml.functions.ts` exporta `CanalMarketplace`

**Files:**
- Modify: `src/lib/ml.functions.ts`

**Interfaces:**
- Consumes: `CanalMarketplace`, `EtiquetaResult`, `ConnectionStatus` de `src/lib/canais/types.ts`.
- Produces: `export const canalML: CanalMarketplace`.

- [ ] **Step 1: Adicionar import no topo**

  ```ts
  import type { CanalMarketplace } from "@/lib/canais/types";
  ```

- [ ] **Step 2: Adicionar no final do arquivo**

  ```ts
  export const canalML: CanalMarketplace = {
    id: "mercadolivre",
    buscarEtiqueta: buscarEtiquetaML,
    getConnectionStatus: async () => {
      const status = await getMLConnection();
      if (!status.connected) return { connected: false };
      return {
        connected: true,
        label: `user ${status.ml_user_id}`,
        expires_at: status.expires_at,
      };
    },
    disconnect: disconnectML,
  };
  ```

- [ ] **Step 3: Verificar build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/ml.functions.ts
  git commit -m "feat(canais): ml.functions exporta canalML"
  ```

---

### Task 12: `shopee.ts` exporta `CanalMarketplace`

**Files:**
- Modify: `src/lib/shopee.ts`

**Interfaces:**
- Consumes: `CanalMarketplace`, `EtiquetaResult`, `ConnectionStatus` de `src/lib/canais/types.ts`.
- Produces: `export const canalShopee: CanalMarketplace`.

- [ ] **Step 1: Adicionar import no topo**

  ```ts
  import type { CanalMarketplace } from "@/lib/canais/types";
  ```

- [ ] **Step 2: Adicionar no final do arquivo**

  ```ts
  export const canalShopee: CanalMarketplace = {
    id: "shopee",
    buscarEtiqueta: buscarEtiquetaShopee,
    getConnectionStatus: async () => {
      const status = await getShopeeConnection();
      if (!status.connected) return { connected: false };
      return {
        connected: true,
        label: `shop ${status.shop_id}`,
        expires_at: status.expires_at,
      };
    },
    disconnect: disconnectShopee,
  };
  ```

- [ ] **Step 3: Verificar build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/shopee.ts
  git commit -m "feat(canais): shopee.ts exporta canalShopee"
  ```

---

### Task 13: `etiqueta.functions.ts` usa o registro `CANAIS`

**Files:**
- Modify: `src/lib/etiqueta.functions.ts`

**Interfaces:**
- Consumes: `canalML` de `ml.functions.ts`, `canalShopee` de `shopee.ts`, `CanalMarketplace` de `canais/types.ts`.

- [ ] **Step 1: Atualizar imports (linha 3-4)**

  Código atual:
  ```ts
  import { buscarEtiquetaML } from "@/lib/ml.functions";
  import { buscarEtiquetaShopee } from "@/lib/shopee";
  ```
  Substituir por:
  ```ts
  import { canalML } from "@/lib/ml.functions";
  import { canalShopee } from "@/lib/shopee";
  import type { CanalMarketplace } from "@/lib/canais/types";

  const CANAIS: Record<string, CanalMarketplace> = {
    mercadolivre: canalML,
    shopee: canalShopee,
  };
  ```

- [ ] **Step 2: Substituir o bloco de fallback por marketplace (linhas 53-82)**

  Código atual:
  ```ts
    // 3. Fallback por marketplace
    if (marketplace === "shopee" && numeroLoja) {
      try {
        const shopeeResult = await buscarEtiquetaShopee(numeroLoja);
        if (shopeeResult.ok) {
          if (pedido?.id) await salvarEtiqueta(pedido.id, shopeeResult.conteudo, "pdf_base64");
          return { ok: true, tipo: "pdf_base64", conteudo: shopeeResult.conteudo };
        }
        console.warn("[etiqueta] Shopee também falhou:", shopeeResult.error);
        return { ok: false, error: shopeeResult.error };
      } catch (err) {
        console.warn("[etiqueta] Shopee exception:", err);
      }
      return blingResult;
    }

    // Fallback ML (default — inclui pedidos legados sem marketplace definido)
    if (numeroLoja) {
      try {
        const mlResult = await buscarEtiquetaML(numeroLoja);
        if (mlResult.ok) {
          if (pedido?.id) await salvarEtiqueta(pedido.id, mlResult.conteudo, "zpl");
          return { ok: true, tipo: "zpl", conteudo: mlResult.conteudo };
        }
        console.warn("[etiqueta] ML também falhou:", mlResult.error);
        return { ok: false, error: mlResult.error };
      } catch (err) {
        console.warn("[etiqueta] ML exception:", err);
      }
    }

    return blingResult; // retorna o erro original do Bling
  ```

  Substituir por:
  ```ts
    // 3. Fallback por canal — preserva exatamente o comportamento de hoje:
    // marketplace conhecido usa o canal correspondente, null/vazio/desconhecido
    // cai no ML (inclui pedidos legados sem marketplace definido).
    if (!numeroLoja) return blingResult;

    const canal = CANAIS[marketplace ?? ""] ?? CANAIS.mercadolivre;

    try {
      const canalResult = await canal.buscarEtiqueta(numeroLoja);
      if (canalResult.ok) {
        const tipoSalvo = canalResult.tipo;
        if (pedido?.id) await salvarEtiqueta(pedido.id, canalResult.conteudo, tipoSalvo);
        return { ok: true, tipo: tipoSalvo, conteudo: canalResult.conteudo };
      }
      console.warn(`[etiqueta] ${canal.id} também falhou:`, canalResult.error);
      return { ok: false, error: canalResult.error };
    } catch (err) {
      console.warn(`[etiqueta] ${canal.id} exception:`, err);
      return blingResult;
    }
  ```

  > Nota: no código antigo, exceção no ramo ML caía em `return blingResult`
  > implícito (fim da função), enquanto exceção no ramo Shopee tinha um
  > `return blingResult` explícito dentro do próprio `if`. O código novo
  > unifica os dois — qualquer exceção (ML ou Shopee) devolve `blingResult`,
  > igual já acontecia nos dois casos, só que agora de forma consistente.

- [ ] **Step 3: Verificar build**

  ```bash
  npm run build
  ```
  Esperado: zero erros novos. `EtiquetaTipo` já inclui `"zpl" | "pdf_base64" |
  "pdf_url" | "desconhecido"` (linha 9) — `canalResult.tipo` (`"zpl" |
  "pdf_base64"`) é subtipo compatível, sem cast necessário.

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/etiqueta.functions.ts
  git commit -m "refactor(canais): unifica fallback de etiqueta via registro CANAIS"
  ```

---

### Task 14: Validação manual dos 3 fluxos de reimpressão

**Files:** nenhum

- [ ] **Step 1: `npm run build` limpo (checagem final)**

  ```bash
  npm run build
  ```

- [ ] **Step 2: Testar em produção (ou dev server com dados reais) os 3 fluxos**

  1. Tela de Expedição (`/expedicao`), impressão automática pós-bipagem de um
     pedido ML — etiqueta ZPL sai normalmente, sem regressão.
  2. Tela de Pedidos (`/pedidos`), botão "Reimprimir" num pedido ML — etiqueta
     sai normalmente.
  3. Tela de Histórico (`/historico`), botão de reimpressão — etiqueta sai
     normalmente.
  4. Pedido Shopee real (já em produção pelo Bloco 1): os 3 fluxos acima
     buscam a etiqueta via `canalShopee` e imprimem — mesmo resultado do
     teste da Task 9, agora passando pelo registro `CANAIS` em vez do
     `if/else` antigo.

- [ ] **Step 3: Commit final (se algum ajuste foi necessário) e push**

  ```bash
  git push origin main
  ```

---

## Checklist de aceite final

- [ ] Zona `bwbaby.com.br` ativa na Cloudflare antes de qualquer config de Tunnel/Access
- [ ] Gateway (nginx + Tunnel + Access) validado isoladamente com `curl` antes do Go-Live
- [ ] `/healthz` confirmado inacessível de fora (só loopback)
- [ ] Formulário Go-Live enviado com o IP correto (`54.20.20.253`) e Live Redirect URL Domain correto (só domínio)
- [ ] Live Partner ID/Key reais (não `1235356`) configurados como secrets
- [ ] Gate `VITE_SUPABASE_*` + validação em navegador real passou antes do deploy de produção
- [ ] Deploy só depois de autorização explícita do Vinicius
- [ ] Pedido Shopee real imprime etiqueta + DANFE em produção
- [ ] `shopee_connections` mostra `is_sandbox: false` após autorização de produção
- [ ] `etiqueta.functions.ts` sem `if (marketplace === "shopee")` inline — só `CANAIS`
- [ ] Fallback ML preservado pra `marketplace` nulo/legado
- [ ] Os 3 fluxos de reimpressão (Expedição/Pedidos/Histórico) validados sem regressão pra ML
- [ ] `npm run build` limpo em todo o processo
- [ ] `CURRENT-STATE.md` e `SESSION-HANDOFF.md` atualizados ao final
