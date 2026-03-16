#!/bin/bash
# Docker status

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Docker Status ==="
ssh "$SSH_TARGET" "
    echo '--- Containers ---'
    docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo ''
    echo '--- Images ---'
    docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
    echo ''
    echo '--- Networks ---'
    docker network ls
    echo ''
    echo '--- Volumes ---'
    docker volume ls
"
