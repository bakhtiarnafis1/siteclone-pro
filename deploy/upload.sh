#!/usr/bin/env bash
# =============================================================================
# Upload the app from this PC to the Oracle server and (re)start it.
# Run from Git Bash in the project folder:
#
#   bash deploy/upload.sh <SERVER_IP> <PATH_TO_PRIVATE_KEY> [--setup]
#
#   --setup   first time only: also runs deploy/oracle-setup.sh on the server
#
# Example:
#   bash deploy/upload.sh 140.238.12.34 "D:/keys/siteclone.key" --setup
# Secrets (credentials.md, .deploy-env.json), node_modules and storage are NOT uploaded.
# =============================================================================
set -euo pipefail

SERVER_IP="${1:?Usage: bash deploy/upload.sh <SERVER_IP> <KEY_PATH> [--setup]}"
KEY_PATH="${2:?Usage: bash deploy/upload.sh <SERVER_IP> <KEY_PATH> [--setup]}"
FIRST_SETUP="${3:-}"
REMOTE_USER="ubuntu"
REMOTE_DIR="/opt/siteclone"

cd "$(dirname "$0")/.."
SSH=(ssh -i "$KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE_USER@$SERVER_IP")

echo "==> Packing project (excluding secrets, node_modules, storage)"
tar -czf - \
  --exclude=node_modules \
  --exclude=storage \
  --exclude=.backup-render-version \
  --exclude=.vercel \
  --exclude=public/.vercel \
  --exclude=.git \
  --exclude=.env \
  --exclude=.deploy-env.json \
  --exclude=credentials.md \
  --exclude=deploy-sync.js \
  --exclude='*.log' \
  --exclude='*.key' \
  --exclude='*.pem' \
  . | "${SSH[@]}" "sudo mkdir -p $REMOTE_DIR && sudo chown $REMOTE_USER:$REMOTE_USER $REMOTE_DIR && tar -xzf - -C $REMOTE_DIR"

if [[ "$FIRST_SETUP" == "--setup" ]]; then
  echo "==> Running first-time server setup"
  "${SSH[@]}" "cd $REMOTE_DIR && sudo bash deploy/oracle-setup.sh"
else
  echo "==> Rebuilding and restarting the app"
  "${SSH[@]}" "cd $REMOTE_DIR && sudo docker compose up -d --build && sudo docker image prune -f >/dev/null"
fi

echo "==> Done."
