#!/bin/bash
# Nginx status

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Nginx Status ==="
ssh "$SSH_TARGET" "
    echo '--- Service Status ---'
    systemctl status nginx --no-pager | head -10
    echo ''
    echo '--- Error Log ---'
    tail -20 /var/log/nginx/error.log
    echo ''
    echo '--- Access Log (last 20) ---'
    tail -20 /var/log/nginx/access.log
"
