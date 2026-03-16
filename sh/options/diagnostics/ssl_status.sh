#!/bin/bash
# SSL certificates

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== SSL Certificates ==="
ssh "$SSH_TARGET" "
    echo '--- All Certificates ---'
    certbot certificates
    echo ''
    echo '--- Renewal Dry Run ---'
    certbot renew --dry-run 2>&1 | head -10
"
