#!/bin/bash
# Copy static files

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$SCRIPT_DIR/sh/deploy.conf"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PROJECT_ROOT="$SCRIPT_DIR"

echo "=== Copy Static Files ==="
echo "Copying static files to server..."
IGNORE_FILE="${SCRIPT_DIR}/sh/deploy_ignore.txt"
ssh "$SSH_TARGET" "mkdir -p $REMOTE_PATH/static $REMOTE_PATH/templates"
tar -X "$IGNORE_FILE" -czf - -C "$PROJECT_ROOT" static templates | \
    ssh "$SSH_TARGET" "tar -xzf - -C $REMOTE_PATH"
echo "Static files copied."
echo ""
echo "Restarting containers to apply changes..."
ssh "$SSH_TARGET" "cd $REMOTE_PATH && docker-compose restart"
echo "Done."
