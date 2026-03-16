#!/bin/bash
# Server resources (CPU, RAM, Disk)

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Server Resources ==="
ssh "$SSH_TARGET" "
    echo '--- Uptime ---'
    uptime
    echo ''
    echo '--- CPU ---'
    top -bn1 | head -5
    echo ''
    echo '--- RAM ---'
    free -h
    echo ''
    echo '--- Disk ---'
    df -h | grep -E '/dev/|Filesystem'
    echo ''
    echo '--- Top Processes ---'
    ps aux --sort=-%mem | head -6
"
