#!/bin/bash
# Daemon logs

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Daemon Logs ==="
echo "Select daemon:"
echo "1) Invest daemon"
echo "2) Tickers daemon"
echo "3) Weather parser"
read -p "Select: " DAEMON_CHOICE

case $DAEMON_CHOICE in
    1) 
        ssh "$SSH_TARGET" "docker logs \$(docker ps -q -f name=${DOCKER_PREFIX}-inv) --tail 30 2>&1 | tail -20"
        ;;
    2) 
        ssh "$SSH_TARGET" "docker logs \$(docker ps -q -f name=${DOCKER_PREFIX}-tickers) --tail 30 2>&1 | tail -20"
        ;;
    3) 
        ssh "$SSH_TARGET" "docker logs \$(docker ps -q -f name=${DOCKER_PREFIX}-parser) --tail 30 2>&1 | tail -20"
        ;;
esac
