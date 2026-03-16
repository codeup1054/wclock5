#!/bin/bash
# Docker logs

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Docker Logs ==="
echo "Select service:"
echo "1) ${DOCKER_PREFIX}-app"
echo "2) ${DOCKER_PREFIX}-parser"
echo "3) ${DOCKER_PREFIX}-inv"
echo "4) ${DOCKER_PREFIX}-tickers"
read -p "Select: " SERVICE_CHOICE

case $SERVICE_CHOICE in
    1) CONTAINER="${DOCKER_PREFIX}-app" ;;
    2) CONTAINER="${DOCKER_PREFIX}-parser" ;;
    3) CONTAINER="${DOCKER_PREFIX}-inv" ;;
    4) CONTAINER="${DOCKER_PREFIX}-tickers" ;;
    *) exit 0 ;;
esac

ssh "$SSH_TARGET" "docker logs --tail 50 -f \$CONTAINER"
