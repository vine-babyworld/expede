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
