#!/bin/bash
# Full system check

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Full System Check ==="
echo ""

echo "--- Server Info ---"
ssh "$SSH_TARGET" "uptime"

echo ""
echo "--- Docker ---"
ssh "$SSH_TARGET" "docker ps --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo "--- Nginx ---"
ssh "$SSH_TARGET" "systemctl is-active nginx | grep -q 'active' && echo 'OK' || echo 'FAIL'"

echo ""
echo "--- SSL ---"
ssh "$SSH_TARGET" "certbot certificates 2>/dev/null | grep -q '$DOMAIN' && echo 'OK' || echo 'FAIL'"

echo ""
echo "--- Port $PORT ---"
ssh "$SSH_TARGET" "ss -tlnp | grep -q ':$PORT' && echo 'OK' || echo 'FAIL'"
