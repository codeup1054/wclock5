#!/bin/bash
# Restart services

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Restart Services ==="
echo "1) Restart Docker containers"
echo "2) Restart Nginx"
echo "3) Full restart (Docker + Nginx)"
read -p "Select: " RESTART_CHOICE

case $RESTART_CHOICE in
    1)
        ssh "$SSH_TARGET" "
            cd $REMOTE_PATH
            PORT=$PORT docker-compose restart
        "
        echo "Docker restarted."
        ;;
    2)
        ssh "$SSH_TARGET" "systemctl restart nginx && echo 'Nginx restarted.'"
        ;;
    3)
        ssh "$SSH_TARGET" "
            cd $REMOTE_PATH
            PORT=$PORT docker-compose restart
            systemctl restart nginx
        "
        echo "Full restart complete."
        ;;
esac
