# Shopee Produção + Canal Unificado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans ou
> superpowers:subagent-driven-development pra executar este plano tarefa por
> tarefa. Steps usam checkbox (`- [ ]`) pra tracking.
>
> **BLOQUEIO ATIVO, NÃO IGNORAR:** nenhuma tarefa deste plano pode ser executada
> além da criação da worktree (Task 3) e dos arquivos de configuração (Task 4)
> até o Vinicius confirmar que a zona `bwbaby.com.br` está **Active** no painel
> Cloudflare (Task 1). **Não rodar `npx wrangler deploy`, não enviar o
> formulário Go-Live da Shopee, não configurar Tunnel/Access/nginx na Lightsail,
> e não alterar `wrangler.jsonc`/secrets de produção sem confirmação explícita
> do Vinicius** — regra permanente do projeto (`CLAUDE.md`, "Deploy é sempre
> manual") mais o bloqueio específico desta feature. **Todos os artefatos de
> código e configuração deste plano são criados numa worktree própria — nunca
> commitados direto em `main`.**

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
não tem equivalente de "teste automatizado" — verificação é `curl`/`cloudflared
tunnel ingress rule` direto e inspeção de logs/status do systemd.

## Global Constraints

- Hostname do gateway fixado: `shopee-egress.bwbaby.com.br`.
- Autenticação Worker↔gateway: **Cloudflare Access Service Token**, não IP do Worker, não HMAC (HMAC só entra com nova decisão explícita se o Service Token se mostrar inviável).
- nginx escuta **só em `127.0.0.1`** — nunca `0.0.0.0`. Portas 80/443 fechadas publicamente (já feito na instância).
- Proxy de saída: só `partner.shopeemobile.com`, só `/api/v2/`, só métodos `GET`/`POST`, `proxy_ssl_verify on`.
- Ingress do Tunnel restrito por `path: ^/api/v2/.*` — sem isso, todo path (incluindo `/healthz`) seria roteado pro nginx via o hostname público.
- Headers removidos antes do upstream: `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `Cf-Access-Jwt-Assertion`, `Cookie`, qualquer `Authorization` recebido.
- Log: nunca gravar querystring, body ou credenciais — em nenhuma camada (Worker, nginx, observabilidade).
- `/healthz` responde só por loopback — nunca publicado pelo hostname do Tunnel (reforçado pelo `path` do ingress).
- Segredos de teste (Service Token) nunca literais em comando/histórico de shell nem em argumentos de processo — `read -s` pra captura, `curl -K -` (headers via stdin) pra uso, `unset` depois.
- Ordem de publicação do gateway: Service Token → Access Application (Service Auth) → só então DNS route + serviço do túnel — nunca publicar o hostname antes do Access estar configurado.
- Credencial do túnel (`~/.cloudflared/<TUNNEL_ID>.json`) copiada pra `/etc/cloudflared/` com permissão `600`; `cert.pem` da conta protegido/removido depois da rota DNS criada (não é necessário pra rodar o túnel).
- Multi-loja Shopee fora de escopo — sempre usa a conexão `is_sandbox=false` mais recente, sem iterar por `shop_id` arbitrário.
- Fallback ML pro registro `CANAIS` precisa ser preservado exatamente (`marketplace` nulo/legado → ML), comportamento de hoje.
- **Todo trabalho roda numa worktree/branch própria (`shopee-producao`), nunca commitado direto em `main`** — worktree criada antes de qualquer artefato.
- Bloco 2 (canal unificado) só começa depois do Bloco 1 validado em produção (ordem de entrega do spec).
- SSH na Lightsail: usar o firewall da própria Lightsail primeiro (não `ufw`) até a origem real de SSH estar identificada e validada, com caminho de recuperação confirmado.
- DNSSEC de `bwbaby.com.br` só é reativado depois da zona estar **Active** (nunca com zona `Pending`).
- IP de saída da Lightsail confirmado como `54.20.20.253` **antes** de enviar o Go-Live.

---

## File Map

| Arquivo | Operação | Responsabilidade |
|---|---|---|
| `ops/shopee-gateway/nginx-shopee-egress.conf` | Create (na worktree) | Config nginx do gateway |
| `ops/shopee-gateway/cloudflared-config.yml` | Create (na worktree) | Config do túnel Cloudflare, com `path` restrito |
| `ops/shopee-gateway/setup-swap.sh` | Create (na worktree) | Script de setup de swap 1GB pra instância de 512MB |
| `ops/shopee-gateway/README.md` | Create (na worktree) | Runbook passo a passo pra configurar a VM |
| `src/lib/shopee.ts` | Modify (na worktree) | `shopeeFetch()` via gateway, `buscarEtiquetaShopee`/`getShopeeConnection` filtram `is_sandbox=false`, exporta `CanalMarketplace` |
| `wrangler.jsonc` | Modify (na worktree) | `SHOPEE_SANDBOX=false` (só após aprovação) |
| `src/lib/canais/types.ts` | Create (Bloco 2) | Contrato `CanalMarketplace` |
| `src/lib/ml.functions.ts` | Modify (Bloco 2) | Exporta objeto `CanalMarketplace` |
| `src/lib/etiqueta.functions.ts` | Modify (Bloco 2) | Lookup via `CANAIS` com fallback ML preservado |

---

## Bloco 1 — Gateway + Shopee produção

### Task 1: Gate — confirmar ativação da zona `bwbaby.com.br`

**Files:** nenhum (checkpoint manual)

- [ ] **Step 1: Perguntar ao Vinicius se a zona `bwbaby.com.br` já está `Active`**

  No painel Cloudflare → domínio `bwbaby.com.br` → status deve mostrar
  "Active", não "Pending Nameservers". Nameservers esperados: `dane.ns.
  cloudflare.com` e `rita.ns.cloudflare.com`.

- [ ] **Step 2: Se ainda não estiver ativa — PARAR aqui**

  Não prosseguir pra Task 2 em diante. Nem a worktree nem os artefatos
  dependem tecnicamente da zona, mas o plano trata a confirmação como gate
  de entrada de qualquer trabalho desta feature, pra não haver ambiguidade
  sobre o que já pode rodar.

---

### Task 2: Reativar DNSSEC de `bwbaby.com.br` (pós-ativação)

**BLOQUEADO até Task 1 confirmar zona `Active`. Nunca fazer isso com a zona `Pending`.**

**Files:** nenhum (ação no painel Cloudflare + Registro.br)

- [ ] **Step 1: Aguardar a zona estabilizar**

  Depois do status virar `Active`, aguardar propagação completa (checar
  resolução DNS de `bwbaby.com.br` de fora, ex: `dig bwbaby.com.br NS
  +short` batendo com os nameservers da Cloudflare) antes de mexer em
  DNSSEC — mudança de DNSSEC numa zona ainda instável pode causar falha de
  resolução do domínio inteiro.

- [ ] **Step 2: Habilitar DNSSEC no painel Cloudflare**

  Zona `bwbaby.com.br` → DNS → Settings → DNSSEC → Enable. A Cloudflare
  gera e mostra um registro **DS** (Delegation Signer — algoritmo, key tag,
  digest).

- [ ] **Step 3: Cadastrar o DS no Registro.br**

  Painel do Registro.br → domínio `bwbaby.com.br` → DNSSEC → cadastrar o DS
  fornecido pela Cloudflare no Step 2 (copiar os valores exatos, não
  digitar de memória).

- [ ] **Step 4: Confirmar propagação e validação da cadeia**

  Voltar no painel Cloudflare depois de algumas horas — o status de DNSSEC
  deve mudar pra "Active" (chain of trust validada). Se continuar
  "Pending"/erro por mais de ~24h, revisar se o DS cadastrado no Registro.br
  bate exatamente com o gerado pela Cloudflare.

---

### Task 3: Criar worktree da branch `shopee-producao`

**Files:** nenhum no repo `main` — cria um diretório de worktree separado

- [ ] **Step 1: Criar a worktree**

  Comandos em Git Bash (`C:\Users\Vinicius\EXPEDE` = `/c/Users/Vinicius/EXPEDE`
  — `cd C:\Users\...` não funciona corretamente no Git Bash, usar sempre o
  caminho estilo Unix):

  ```bash
  cd /c/Users/Vinicius/EXPEDE
  git worktree add ../shopee-producao -b shopee-producao
  ```

  Segue o mesmo padrão já em uso no projeto pra trabalho isolado (ver
  `CURRENT-STATE.md`, worktree `nf-ml-controlada`). Resultado: diretório
  `/c/Users/Vinicius/shopee-producao` (= `C:\Users\Vinicius\shopee-producao`
  no Explorer/PowerShell), checkout da branch nova `shopee-producao`, `main`
  no diretório original **intocado**.

- [ ] **Step 2: Confirmar isolamento**

  ```bash
  cd /c/Users/Vinicius/shopee-producao
  git status
  git branch --show-current
  ```

  Esperado: branch `shopee-producao`, working tree limpo (idêntico ao
  `main` no momento da criação).

- [ ] **Step 3: Todo o resto deste plano (Tasks 4-12) roda dentro desta worktree**

  `/c/Users/Vinicius/shopee-producao`, não em `/c/Users/Vinicius/EXPEDE`.

---

### Task 4: Artefatos de configuração do gateway (na worktree)

**Files (dentro de `C:\Users\Vinicius\shopee-producao`):**
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

      # Health check — SÓ loopback. Redundante com o `path` restrito no
      # ingress do cloudflared (Task 4, Step 2), mas mantido como segunda
      # camada de defesa: mesmo que o ingress mude, esta location não some.
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

- [ ] **Step 2: Criar `ops/shopee-gateway/cloudflared-config.yml`, COM o `path` restrito**

  ```yaml
  # Template — substituir <TUNNEL_ID> pelo ID real gerado por
  # `cloudflared tunnel create expede-shopee-egress` (Task 5).
  tunnel: <TUNNEL_ID>
  credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

  ingress:
    # path restrito é OBRIGATÓRIO: sem ele, qualquer path (incluindo
    # /healthz) seria roteado pro nginx via o hostname público do túnel.
    - hostname: shopee-egress.bwbaby.com.br
      path: ^/api/v2/.*
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

  Pré-requisitos: zona `bwbaby.com.br` **Active** (Task 1) e worktree
  `shopee-producao` criada (Task 3). Não seguir os passos abaixo antes disso.

  Instância alvo: `expede-shopee-proxy-prod` (São Paulo, IP `54.20.20.253`).

  ## 1. Swap

  ```bash
  scp ops/shopee-gateway/setup-swap.sh ubuntu@54.20.20.253:/tmp/
  ssh ubuntu@54.20.20.253 'sudo bash /tmp/setup-swap.sh'
  ```

  ## 2. nginx

  ```bash
  sudo apt update && sudo apt install -y nginx
  ```
  Copiar `nginx-shopee-egress.conf` pra
  `/etc/nginx/sites-available/shopee-egress.conf`, linkar em
  `sites-enabled`, remover o `default` do nginx se existir, `nginx -t` pra
  validar sintaxe, `systemctl reload nginx`.

  Confirmar que nginx só escuta em `127.0.0.1`:
  ```bash
  sudo ss -tlnp | grep nginx
  ```
  Esperado: `127.0.0.1:8080`, nada em `0.0.0.0:80` ou `:443`.

  ## 3. Cloudflare Tunnel — criar e validar (NÃO publicar ainda)

  **Ordem importa**: criar e validar o túnel aqui, mas só rodar `route dns` +
  iniciar o serviço depois que o Access (seção 4) já estiver configurado —
  senão existe uma janela em que o hostname resolve e o túnel responde
  publicamente sem nenhuma política de autenticação na frente.

  ```bash
  curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared.deb
  cloudflared tunnel login   # abre URL — autenticar na conta Cloudflare da empresa
  cloudflared tunnel create expede-shopee-egress
  ```
  Anotar o `TUNNEL_ID` gerado, preencher em `cloudflared-config.yml` (2
  ocorrências).

  **O arquivo de credencial do túnel nasce em `~/.cloudflared/<TUNNEL_ID>.json`
  — a config aponta pra `/etc/cloudflared/<TUNNEL_ID>.json`, que não existe
  ainda.** Criar o diretório protegido e copiar com permissão restrita:
  ```bash
  sudo mkdir -p /etc/cloudflared
  sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/<TUNNEL_ID>.json
  sudo chown root:root /etc/cloudflared/<TUNNEL_ID>.json
  sudo chmod 600 /etc/cloudflared/<TUNNEL_ID>.json
  ```
  Só então copiar `cloudflared-config.yml` (já preenchido) pra
  `/etc/cloudflared/config.yml`.

  **Verificar a sintaxe exata da versão instalada antes de validar** (a flag
  `--config` pode mudar de posição entre versões do `cloudflared`):
  ```bash
  cloudflared tunnel ingress --help
  ```
  Confirmar ali como passar o arquivo de config pro `validate`/`rule` (a
  forma mais comum é a flag global antes do subcomando). Validar:
  ```bash
  cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
  ```
  Esperado: `OK` / sem erro de sintaxe. Se o `--help` mostrar uma posição
  diferente pra flag, usar a forma que ele indicar — não a forma acima às
  cegas.

  **Testar quais regras casam com quais paths (sem precisar do serviço
  rodando nem do DNS publicado ainda):**
  ```bash
  cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner
  cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://shopee-egress.bwbaby.com.br/healthz
  ```
  Esperado: o primeiro casa com a regra `service: http://127.0.0.1:8080`; o
  segundo casa com a regra de fallback `http_status:404` (não com a regra
  do nginx) — confirma que `/healthz` não é alcançável pelo hostname público
  **antes mesmo de publicar o túnel de verdade**.

  ## 4. Cloudflare Access (Service Token) — ANTES de publicar o túnel

  Criar nesta ordem, pra nunca existir uma janela pública sem proteção:

  1. Zero Trust → Access → Service Auth → **Create Service Token primeiro**:
     - Nome: `expede-worker-shopee-gateway`
     - **Definir expiração** (ex: 1 ano) — anotar a data em
       `PENDING-DECISIONS.md` ou equivalente, criar lembrete de rotação antes
       de vencer.
     - Copiar `Client ID` e `Client Secret` — **não colar em chat/log**, só
       digitar direto no `wrangler secret put` (Task 10) ou capturar via
       `read -s` em teste manual (Task 6).
  2. **Só depois**, Zero Trust → Access → Applications → Add an application
     → Self-hosted:
     - Domain: `shopee-egress.bwbaby.com.br`
     - Policy: Service Auth, exigindo o Service Token criado no passo 1.

  ## 5. Publicar o túnel (DNS + serviço) — só depois do Access configurado

  ```bash
  cloudflared tunnel route dns expede-shopee-egress shopee-egress.bwbaby.com.br
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared
  sudo systemctl status cloudflared   # confirmar "active (running)"
  ```

  A partir daqui o hostname resolve e responde — mas já protegido pelo
  Access configurado na seção 4, sem janela pública desprotegida.

  **`cert.pem` não é necessário pra rodar o túnel** (só foi usado pra criar
  o túnel e a rota DNS, nas etapas 3-5 acima) — proteger ou remover depois de
  confirmado que o serviço está rodando:
  ```bash
  sudo chmod 600 ~/.cloudflared/cert.pem
  # ou, se preferir não deixar nem isso na instância:
  # shred -u ~/.cloudflared/cert.pem
  ```

  ## 6. SSH — Lightsail firewall primeiro, `ufw` só depois de validar

  **Não configurar `ufw` ainda.** O Lightsail Browser SSH (acesso via
  console AWS, no navegador) pode ser bloqueado por uma regra `ufw` mal
  configurada, e isso tranca o acesso à instância sem caminho de volta fácil.

  Passo inicial: usar o **firewall da própria Lightsail** (aba "Networking"
  da instância no console AWS) pra restringir a porta 22 — esse firewall é
  gerenciado fora da instância, então um erro de config não derruba o acesso
  via Browser SSH (que passa por outro caminho da AWS, não pela regra de
  rede da instância da mesma forma que uma conexão SSH direta de terceiros).

  Antes de qualquer restrição adicional via `ufw`:
  1. Identificar o(s) IP(s) real(is) de origem que o Vinicius usa pra SSH.
  2. Validar que a conexão funciona a partir desse(s) IP(s) com a regra do
     firewall Lightsail já restrita.
  3. Confirmar que existe caminho de recuperação (Browser SSH continua
     acessível) caso alguma regra saia errada.

  Só depois desses 3 pontos confirmados, `ufw` pode ser adicionado como
  camada extra — decisão e execução ficam pra quando isso estiver validado,
  não faz parte da execução inicial deste plano.

  ## 7. systemd — auto-restart

  nginx e `cloudflared` já vêm com unit systemd padrão no Ubuntu 24.04.
  Confirmar `Restart=on-failure` em ambos:
  ```bash
  systemctl show nginx.service -p Restart
  systemctl show cloudflared.service -p Restart
  ```
  Se algum não tiver, adicionar via `systemctl edit <service>` (drop-in), não
  editar o unit file gerado diretamente.
  ```

- [ ] **Step 5: Commit — só na worktree, nunca em `main`**

  ```bash
  cd /c/Users/Vinicius/shopee-producao
  git add ops/shopee-gateway/
  git commit -m "docs(ops): runbook e configs do gateway de egress Shopee (Lightsail)"
  ```

---

### Task 5: Configurar Tunnel + Access + nginx na Lightsail

**BLOQUEADO até Task 2 (DNSSEC, se aplicável ao momento) e Task 4 completas.**

**Files:** nenhum no repo (execução remota via SSH, seguindo `ops/shopee-gateway/README.md`)

- [ ] **Step 1: Seguir `ops/shopee-gateway/README.md` seções 1-5, na ordem (Access antes de publicar o túnel — seção 4 vem antes da 5 de propósito)**

  Executado pelo Vinicius (ou por mim com acesso SSH, se ele conceder e
  confirmar explicitamente) — mexe numa VM de produção fora do
  repositório de código, não roda sem confirmação.

- [ ] **Step 2: Validar nginx isoladamente, direto na instância**

  ```bash
  curl -s http://127.0.0.1:8080/healthz
  ```
  Esperado: `ok`.

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    "http://127.0.0.1:8080/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=x"
  ```
  Esperado: algum status HTTP vindo da Shopee de verdade (ex: `400`/`403`
  por parâmetros inválidos) — confirma que o proxy alcança
  `partner.shopeemobile.com`.

- [ ] **Step 3: Validar `/healthz` NÃO está acessível de fora, via o hostname real**

  De uma máquina fora da Lightsail:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://shopee-egress.bwbaby.com.br/healthz
  ```
  Esperado: **não** `200` (o `path: ^/api/v2/.*` do ingress já garante isso —
  ver validação prévia com `cloudflared tunnel ingress rule` no README).

---

### Task 6: Validar o gateway ponta a ponta com Service Token

**BLOQUEADO até Task 5 completa.**

**Files:** nenhum

- [x] **Step 1: Capturar o Service Token com entrada silenciosa — nunca literal no comando**

  ```bash
  read -r -p "CF Access Client ID: " CF_TEST_CLIENT_ID
  read -r -s -p "CF Access Client Secret: " CF_TEST_CLIENT_SECRET
  echo
  ```

  Isso evita que o secret fique no histórico do shell (`~/.bash_history`).
  **Mas `read -s` sozinho não é suficiente**: passar o valor direto num
  `-H "CF-Access-Client-Secret: ${VAR}"` ainda coloca o secret nos
  **argumentos do processo** (visível via `ps aux`/`/proc/<pid>/cmdline`
  enquanto o `curl` roda, mesmo vindo de uma variável de shell). Usar
  `curl -K -` (config lido da entrada padrão) evita isso — os headers vão
  no stdin, não no `argv`.

- [x] **Step 2: Testar autenticado, de fora da Lightsail — secret via stdin, não via argv**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -K - \
    "https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=x" <<EOF
  header = "CF-Access-Client-Id: ${CF_TEST_CLIENT_ID}"
  header = "CF-Access-Client-Secret: ${CF_TEST_CLIENT_SECRET}"
  EOF
  ```
  `-K -` faz o `curl` ler diretivas de config (formato `chave = "valor"`) do
  stdin — o heredoc sem aspas no delimitador (`<<EOF`, não `<<'EOF'`) permite
  a expansão das variáveis de shell, mas o valor nunca aparece na lista de
  argumentos do processo `curl`. Esperado: resposta da Shopee (não HTML de
  login do Access — se vier isso, o Service Token não está sendo aceito,
  revisar a Policy).

- [x] **Step 3: Testar sem o Service Token — deve ser rejeitado**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=x"
  ```
  Esperado: bloqueado pelo Access.

- [ ] **Step 4: Testar método/path fora do permitido — deve ser rejeitado pelo nginx (secret ainda via stdin)**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -X DELETE -K - \
    "https://shopee-egress.bwbaby.com.br/api/v2/shop/auth_partner" <<EOF
  header = "CF-Access-Client-Id: ${CF_TEST_CLIENT_ID}"
  header = "CF-Access-Client-Secret: ${CF_TEST_CLIENT_SECRET}"
  EOF

  curl -s -o /dev/null -w "%{http_code}\n" -K - \
    "https://shopee-egress.bwbaby.com.br/api/v1/outro-path" <<EOF
  header = "CF-Access-Client-Id: ${CF_TEST_CLIENT_ID}"
  header = "CF-Access-Client-Secret: ${CF_TEST_CLIENT_SECRET}"
  EOF
  ```
  Esperado: ambos rejeitados (o segundo já nem chega no nginx — `path` do
  ingress barra qualquer coisa fora de `/api/v2/`).

- [x] **Step 5: Limpar as variáveis com o secret assim que terminar os testes**

  ```bash
  unset CF_TEST_CLIENT_ID CF_TEST_CLIENT_SECRET
  ```

---

### Task 7: Confirmar o IP de saída público da Lightsail

**BLOQUEADO até Task 6. Deve passar antes de enviar o formulário Go-Live (Task 8).**

**Files:** nenhum

- [x] **Step 1: De dentro da própria instância Lightsail, checar o IPv4 de saída**

  ```bash
  ssh ubuntu@54.20.20.253
  curl -s https://api.ipify.org
  echo
  ```
  Esperado: **exatamente** `54.20.20.253`.

- [ ] **Step 2: Se o IP retornado for diferente — parar e investigar antes de prosseguir**

  Possíveis causas: IP estático não associado corretamente à instância,
  rota de saída alternativa (ex: IPv6 habilitado de novo, NAT diferente).
  Não faz sentido preencher o whitelist da Shopee com `54.20.20.253` se o
  tráfego real sai por outro IP — o Go-Live falharia silenciosamente depois.

---

### Task 8: Preencher e enviar o formulário Go-Live

**BLOQUEADO até Task 7 confirmar o IP de saída correto.**

**Files:** nenhum (ação do Vinicius no console da Shopee)

- [x] **Step 1: Vinicius preenche o formulário** com IP `54.20.20.253`, Live
  Redirect URL Domain = `https://babyworld.expede.workers.dev` (só o domínio,
  não o path completo — Lição #21), Product Brief, screenshot, credencial de
  teste do EXPEDE pra revisão.

- [x] **Step 2: Aguardar aprovação** — aprovada em 2026-08-12. App `Online`,
  Live Partner ID `2036352` e Live API Partner Key emitidos (chave nunca
  registrada no repositório ou em chat).

  Antes da ativação em produção, confirmar no console por que `IP Address
  Whitelist` ainda aparece como `Disabled`, apesar do IP `54.20.20.253` estar
  cadastrado. Confirmar também se `Access to Sensitive Data: No access` atende
  os endpoints de documento logístico usados pelo EXPEDE.

---

### Task 9: `shopeeFetch()` via gateway + correção de `is_sandbox` (código, na worktree)

**DESBLOQUEADO em 2026-08-12 pela aprovação da Task 8.**

**Files (dentro de `C:\Users\Vinicius\shopee-producao`):**
- Modify: `src/lib/shopee.ts`

**Interfaces:**
- Consumes: nenhuma (self-contained neste arquivo)
- Produces: `shopeeFetch(url: string, init?: RequestInit): Promise<Response>` — usado internamente por `buildShopeeUrl`-consumers em vez de `fetch()` cru, para chamadas server-to-server. `getShopeeAuthUrl()` continua sem usar `shopeeFetch` (exceção documentada — navegação de browser).

- [x] **Step 1: Confirmar que está na worktree, branch correta**

  ```bash
  cd /c/Users/Vinicius/shopee-producao
  git branch --show-current
  ```
  Esperado: `shopee-producao`.

- [x] **Step 2: Adicionar `shopeeFetch()` em `src/lib/shopee.ts`, logo após os imports (linha 3)**

  ```ts
  const SHOPEE_GATEWAY_URL = "https://shopee-egress.bwbaby.com.br";

  /**
   * Chamadas server-to-server pra Shopee em produção passam pelo gateway
   * (IP fixo exigido pelo whitelist da Shopee) autenticado com Cloudflare
   * Access Service Token. EXCEÇÃO: getShopeeAuthUrl() não usa isso — é uma
   * navegação de browser (auth_partner), não uma chamada nossa.
   *
   * Headers são construídos via `new Headers()` em vez de spread de objeto —
   * `init?.headers` pode chegar como Headers, array de tuplas ou objeto
   * simples, e um spread ingênuo (`{...init?.headers}`) só funciona certo
   * pro último caso, perdendo headers nos outros dois.
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

    const headers = new Headers(init?.headers);
    headers.set("CF-Access-Client-Id", clientId);
    headers.set("CF-Access-Client-Secret", clientSecret);

    return fetch(gatewayUrl, { ...init, headers });
  }
  ```

- [x] **Step 3: Trocar os `fetch()` diretos por `shopeeFetch()` nas funções server-to-server**

  Em `refreshShopeeTokenIfNeeded` (linha ~141), `exchangeShopeeCode` (linha
  ~205), e dentro de `buscarEtiquetaShopee` (linhas ~293, ~318 —
  `createRes`/`downloadRes`) e `pollShopeeShippingDocumentReady` (linha ~258):
  trocar `await fetch(url, {...})` por `await shopeeFetch(url, {...})`. **Não
  tocar em `getShopeeAuthUrl()`** — continua montando a URL e devolvendo pro
  caller sem chamar `fetch`/`shopeeFetch` nenhum.

- [x] **Step 4: Corrigir `buscarEtiquetaShopee()` pra usar a conexão real em vez de `SHOPEE_TEST_SHOP_ID`**

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

- [x] **Step 5: Corrigir `getShopeeConnection()` pra filtrar pela mesma regra**

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

- [x] **Step 6: Verificar build**

  ```bash
  npm run build
  ```
  Esperado: zero erros novos.

- [x] **Step 7: Commit (na worktree, sem merge em `main`)**

  ```bash
  git add src/lib/shopee.ts
  git commit -m "feat(shopee): chamadas server-to-server via gateway de egress + filtro is_sandbox real"
  ```

---

### Task 10: Secrets + flag de produção

**DESBLOQUEADO e autorizado pelo Vinicius em 2026-08-12.**

**Files (na worktree):**
- Modify: `wrangler.jsonc`

- [x] **Step 1: Configurar os secrets (Vinicius digita direto no prompt interativo, nunca colar em chat)**

  ```bash
  npx wrangler secret put SHOPEE_PARTNER_ID
  npx wrangler secret put SHOPEE_PARTNER_KEY
  npx wrangler secret put CF_ACCESS_CLIENT_ID
  npx wrangler secret put CF_ACCESS_CLIENT_SECRET
  ```

- [x] **Step 2: Atualizar `wrangler.jsonc`**

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

- [x] **Step 3: Commit**

  ```bash
  git add wrangler.jsonc
  git commit -m "feat(shopee): ativa modo produção (SHOPEE_SANDBOX=false)"
  ```

---

### Task 11: Gate de deploy + deploy controlado

**BLOQUEADO até Task 10. Requer autorização explícita do Vinicius antes do Step 3.**

**Files:** nenhum (build + deploy, a partir da worktree)

- [ ] **Step 1: Rodar o gate de deploy geral do projeto (bloqueio documentado desde 08/08/2026)**

  ```bash
  npm run build
  ```
  Confirmar que o build local tem `.env` presente (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`):
  ```bash
  grep -c "VITE_SUPABASE_URL" .env
  ```
  Esperado: `1` ou mais. Se não tiver, **parar** (Lições #24-26).

- [ ] **Step 2: Validar a SPA em navegador real, servindo o build local**

  ```bash
  npx vite preview
  ```
  Confirmar tela de login renderiza sem erro de configuração ausente.

- [ ] **Step 3: Merge da branch `shopee-producao` em `main` — só com autorização explícita do Vinicius**

  ```bash
  cd /c/Users/Vinicius/EXPEDE
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

### Task 12: Teste ponta a ponta em produção + rollback se necessário

**BLOQUEADO até Task 11.**

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
  A infraestrutura do gateway é aditiva (não precisa ser desfeita) — só
  reverter o código do Worker.

---

## Bloco 2 — Canal unificado no código

**Só começa depois do Bloco 1 validado em produção (Task 12 completa). Pode continuar na mesma worktree ou numa nova — decisão de conveniência, não crítica, já que não depende de aprovação externa.**

### Task 13: Contrato `CanalMarketplace`

**Files:**
- Create: `src/lib/canais/types.ts`

**Interfaces:**
- Produces: `EtiquetaResult`, `ConnectionStatus`, `CanalMarketplace` — usados pelas Tasks 14-16.

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

### Task 14: `ml.functions.ts` exporta `CanalMarketplace`

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

### Task 15: `shopee.ts` exporta `CanalMarketplace`

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

### Task 16: `etiqueta.functions.ts` usa o registro `CANAIS`

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
  Esperado: zero erros novos.

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/etiqueta.functions.ts
  git commit -m "refactor(canais): unifica fallback de etiqueta via registro CANAIS"
  ```

---

### Task 17: Validação manual dos 3 fluxos de reimpressão

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
     teste da Task 12, agora passando pelo registro `CANAIS`.

- [ ] **Step 3: Commit final (se algum ajuste foi necessário) e push**

  ```bash
  git push origin main
  ```

---

## Checklist de aceite final

- [ ] Zona `bwbaby.com.br` ativa na Cloudflare antes de qualquer config de Tunnel/Access
- [ ] DNSSEC reativado (DS cadastrado no Registro.br) só depois da zona estável — nunca com zona `Pending`
- [x] Worktree `shopee-producao` criada antes de qualquer artefato de código/config — nada commitado direto em `main` até o merge da Task 11
- [ ] `cloudflared-config.yml` com `path: ^/api/v2/.*`, validado com `cloudflared tunnel --config ... ingress validate` e `ingress rule` pros dois paths de teste (sintaxe exata confirmada via `--help` antes de assumir)
- [ ] Credencial do túnel copiada pra `/etc/cloudflared/<TUNNEL_ID>.json` com permissão `600`; `cert.pem` protegido/removido depois da rota DNS criada
- [x] Service Token e Access Application criados **antes** da rota DNS/serviço do túnel — sem janela pública desprotegida
- [x] Gateway (nginx + Tunnel + Access) validado isoladamente com `curl` antes do Go-Live
- [x] `/healthz` confirmado inacessível de fora (só loopback, reforçado pelo `path` do ingress)
- [ ] SSH: firewall Lightsail usado primeiro; `ufw` só depois de validar origem real + caminho de recuperação
- [x] Segredos de teste do Service Token nunca literais em comando/argv — `read -s` pra captura, `curl -K -` (stdin) pro uso, `unset` depois
- [x] IP de saída da Lightsail confirmado como `54.20.20.253` antes do envio do Go-Live
- [x] Formulário Go-Live enviado com o IP correto e Live Redirect URL Domain correto (só domínio)
- [x] `IP Address Whitelist` habilitado no console Shopee para `54.20.20.253` em 2026-08-12
- [x] `Access to Sensitive Data` consta `Can access` após salvar o whitelist
- [x] Live Partner ID/Key reais (não `1235356`) configurados como secrets
- [x] `shopeeFetch()` usa `new Headers()` + `.set()`, não spread de objeto
- [ ] Gate `VITE_SUPABASE_*` + validação em navegador real passou antes do deploy de produção
- [ ] Deploy só depois de autorização explícita do Vinicius
- [ ] Pedido Shopee real imprime etiqueta + DANFE em produção
- [ ] `shopee_connections` mostra `is_sandbox: false` após autorização de produção
- [ ] `etiqueta.functions.ts` sem `if (marketplace === "shopee")` inline — só `CANAIS`
- [ ] Fallback ML preservado pra `marketplace` nulo/legado
- [ ] Os 3 fluxos de reimpressão (Expedição/Pedidos/Histórico) validados sem regressão pra ML
- [ ] `npm run build` limpo em todo o processo
- [ ] `CURRENT-STATE.md` e `SESSION-HANDOFF.md` atualizados ao final
