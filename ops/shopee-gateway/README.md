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

**Validar que nada de sensível vaza pro log — com um segredo fictício na
query, antes de qualquer chamada real:**
```bash
curl -s -o /dev/null "http://127.0.0.1:8080/api/v2/shop/auth_partner?partner_id=1&timestamp=1&sign=SEGREDO_FICTICIO_TESTE_LOG"
sudo grep -c "SEGREDO_FICTICIO_TESTE_LOG" /var/log/nginx/shopee-egress.access.log /var/log/nginx/shopee-egress.error.log 2>/dev/null
```
Esperado: `0` ocorrências nos dois arquivos (o segundo nem deve existir,
já que `error_log` está redirecionado pra `/dev/null`). Se
`SEGREDO_FICTICIO_TESTE_LOG` aparecer em qualquer um dos dois, **parar e
corrigir a config antes de seguir** — não prosseguir pro Tunnel/Access com
esse vazamento confirmado.

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

Na instalação validada em produção, o `cloudflared` já usava
`Restart=on-failure`, mas o nginx usava `Restart=no`. O drop-in aplicado ao
nginx foi:

```ini
[Unit]
Wants=network-online.target
After=network-online.target nss-lookup.target

[Service]
Restart=on-failure
RestartSec=5s
```

Salvar em `/etc/systemd/system/nginx.service.d/restart.conf` e aplicar:

```bash
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl restart nginx
```

## 8. Validação final e reboot

A cadeia TLS atual de `partner.shopeemobile.com` exige
`proxy_ssl_verify_depth 3`; sem essa diretiva o nginx pode responder 502 com
`unable to get local issuer certificate`, embora `curl` e `openssl` validem a
mesma cadeia. A configuração versionada nesta pasta já inclui o ajuste.

Antes e depois de um reboot controlado, confirmar:

```bash
systemctl is-active nginx cloudflared
systemctl is-enabled nginx cloudflared
systemctl show nginx.service cloudflared.service -p Id -p Restart
sudo ss -tlnp | grep 8080
curl -sS -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:8080/healthz
curl -sS --max-time 30 -w '\nshopee=%{http_code} %{content_type}\n' \
  http://127.0.0.1:8080/api/v2/shop/auth_partner
```

Esperado: ambos os serviços ativos/habilitados, ambos com
`Restart=on-failure`, porta 8080 apenas em `127.0.0.1`, health 200 e a rota da
Shopee devolvendo JSON (inclusive um erro de parâmetro da própria API é uma
resposta válida para esse teste sem credenciais).

No hostname externo, confirmar também que a chamada sem Service Token recebe
403 e que a chamada autenticada recebe o mesmo JSON da Shopee. Digitar o
Client ID e o Client Secret somente via entrada silenciosa (`read -s`) e
remover as variáveis da sessão imediatamente após o teste.
