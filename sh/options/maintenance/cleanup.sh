#!/bin/bash
# Cleanup Docker

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Cleanup Docker ==="
echo "WARNING: This will remove unused containers, networks, and images!"
echo ""
echo "1) Remove stopped containers"
echo "2) Remove unused networks"
echo "3) Remove dangling images"
echo "4) All unused"
read -p "Select: " CLEANUP_CHOICE

if [ "$CLEANUP_CHOICE" = "4" ]; then
    read -p "Continue? (yes/no): " CONFIRM
    [ "$CONFIRM" != "yes" ] && echo "Cancelled." && exit 0
    
    ssh "$SSH_TARGET" "
        echo '--- Stopped containers ---'
        docker container prune -f
        echo ''
        echo '--- Unused networks ---'
        docker network prune -f
        echo ''
        echo '--- Dangling images ---'
        docker image prune -f
        echo ''
        echo '--- All unused ---'
        docker system prune -f
    "
    echo "=== Cleanup complete ==="
fi
