#!/bin/bash

# ============================================
# Undeploy script - Clean up server before deployment
# WARNING: This will remove all data!
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/deploy.conf"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE"
    exit 1
fi

source "$CONFIG_FILE"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "========================================"
echo "  WClock Undeploy / Clean Server"
echo "========================================"
echo ""
echo "WARNING: This will remove:"
echo "  1. Docker containers & images"
echo "  2. Nginx config: $NGINX_CONFIG_PATH/${DOMAIN}.conf"
echo "  3. SSL certificates: /etc/letsencrypt/live/${DOMAIN}"
echo "  4. Project files: $REMOTE_PATH"
echo "  5. Systemd service: wclock4"
echo ""

read -p "Are you sure? Type 'yes' to continue: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "=== 1. Stopping Docker containers ==="
ssh "$SSH_TARGET" "
    cd $REMOTE_PATH
    docker-compose down 2>/dev/null || true
    docker ps -a --filter name=wclock4 --format '{{.ID}}' | xargs -r docker rm -f 2>/dev/null || true
    docker images --filter reference='wclock*' --format '{{.ID}}' | xargs -r docker rmi -f 2>/dev/null || true
"

echo "=== 2. Stopping uvicorn service ==="
ssh "$SSH_TARGET" "
    systemctl stop wclock4 2>/dev/null || true
    systemctl disable wclock4 2>/dev/null || true
    rm -f /etc/systemd/system/wclock4.service
    systemctl daemon-reload
"

echo "=== 3. Removing Nginx config ==="
ssh "$SSH_TARGET" "
    rm -f $NGINX_CONFIG_PATH/${DOMAIN}.conf
    rm -f /etc/nginx/sites-enabled/${DOMAIN}.conf
    nginx -t && systemctl reload nginx
"

echo "=== 4. Removing SSL certificates ==="
ssh "$SSH_TARGET" "
    rm -rf /etc/letsencrypt/live/${DOMAIN}
    rm -rf /etc/letsencrypt/archive/${DOMAIN}
    rm -rf /etc/letsencrypt/renewal/${DOMAIN}.conf
"

echo "=== 5. Removing project files ==="
ssh "$SSH_TARGET" "rm -rf $REMOTE_PATH"

echo "=== Cleanup complete ==="
echo ""
echo "Server is clean. Ready for fresh deployment."
echo "Run: ./deploy.sh"
