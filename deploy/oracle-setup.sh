#!/usr/bin/env bash
# =============================================================================
# SiteClone Pro — one-time server setup for Oracle Cloud (Ubuntu 24.04, arm64/amd64)
#
# Run ON THE SERVER, from the app folder (/opt/siteclone):
#   sudo bash deploy/oracle-setup.sh                 # uses <public-ip>.sslip.io
#   sudo bash deploy/oracle-setup.sh clone.mydomain.com   # use your own domain
#
# Safe to re-run: every step checks whether it is already done.
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SITE_HOST="${1:-}"

log() { echo -e "\n\033[1;34m==> $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/oracle-setup.sh" >&2
  exit 1
fi

# --- 1. System updates -------------------------------------------------------
log "Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent iptables-persistent

# --- 2. Swap (safety net so a memory spike slows down instead of crashing) ---
if ! swapon --show | grep -q '/swapfile'; then
  log "Creating 4 GB swap file"
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-siteclone.conf
else
  log "Swap already present — skipping"
fi

# --- 3. Open ports 80/443 in the OS firewall ---------------------------------
# Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH,
# so opening the ports in the OCI Security List alone is NOT enough.
open_port() {
  local port="$1"
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    local pos
    pos="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')"
    if [[ -n "$pos" ]]; then
      iptables -I INPUT "$pos" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
    echo "Opened TCP $port"
  fi
}
log "Opening ports 80 and 443 in iptables"
open_port 80
open_port 443
netfilter-persistent save

# --- 4. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "${SUDO_USER:-ubuntu}" || true
else
  log "Docker already installed — skipping"
fi
systemctl enable --now docker

# --- 5. Caddy (automatic HTTPS) ----------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  log "Caddy already installed — skipping"
fi

if [[ -z "$SITE_HOST" ]]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
  SITE_HOST="${PUBLIC_IP//./-}.sslip.io"
fi
log "Configuring HTTPS for: $SITE_HOST"
sed "s|{\$SITE_HOST}|${SITE_HOST}|" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

# --- 6. Build and start the app ----------------------------------------------
log "Building and starting SiteClone (first build takes a few minutes)"
mkdir -p "$APP_DIR/storage/sites" "$APP_DIR/storage/zips"
cd "$APP_DIR"
docker compose up -d --build

log "Waiting for the app to become healthy"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "App is up."
    break
  fi
  sleep 3
done

echo
echo "============================================================"
echo " SiteClone is live at:  https://${SITE_HOST}"
echo " (HTTPS certificate may take ~1 minute on first visit)"
echo "============================================================"
