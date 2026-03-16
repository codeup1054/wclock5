#!/bin/bash
# Full rebuild

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$SCRIPT_DIR/sh/deploy.conf"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PROJECT_ROOT="$SCRIPT_DIR"

echo "=== Full Rebuild ==="
echo "WARNING: This will remove all containers, rebuild and restart!"
read -p "Continue? (yes/no): " CONFIRM
[ "$CONFIRM" != "yes" ] && echo "Cancelled." && exit 0

echo "1. Cleaning Docker on server..."
ssh "$SSH_TARGET" "
    cd $REMOTE_PATH
    docker-compose down 2>/dev/null || true
    docker container prune -f
    docker image prune -f
    docker builder prune -f
"

echo "2. Copying project files..."
IGNORE_FILE="${SCRIPT_DIR}/sh/deploy_ignore.txt"
ssh "$SSH_TARGET" "mkdir -p $REMOTE_PATH"
tar -X "$IGNORE_FILE" -czf - -C "$PROJECT_ROOT" . | \
    ssh "$SSH_TARGET" "tar -xzf - -C $REMOTE_PATH"

echo "3. Building and starting Docker containers..."
ssh "$SSH_TARGET" "
    cd $REMOTE_PATH
    PORT=$PORT docker-compose up -d --build
"

echo "4. Checking status..."
ssh "$SSH_TARGET" "docker ps --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo "=== Full rebuild complete ==="
