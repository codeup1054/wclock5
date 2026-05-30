#!/bin/bash

# ============================================
# WClock5 Server Diagnostics & Management
# Works locally on server or via SSH from local machine
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default values
REMOTE_PATH="/var/www/wclock5.startupassist.ru"
DOCKER_PREFIX="wclock5"
PORT=10405
DOMAIN="wclock5.startupassist.ru"
SSH_TARGET=""

# Check if docker works locally (then we're on the server)
if docker ps &>/dev/null; then
    echo "[LOCAL] Docker available - running directly on server"
    # Optionally load config for custom values, but don't use SSH
    for cfg in "$SCRIPT_DIR/deploy.conf" "$SCRIPT_DIR/run_server.conf"; do
        if [ -f "$cfg" ]; then
            source "$cfg"
            echo "[LOCAL] Loaded config: $cfg (values: PORT=$PORT, DOCKER_PREFIX=$DOCKER_PREFIX)"
            break
        fi
    done
else
    echo "[SSH] No local docker - checking for SSH config..."
    for cfg in "$SCRIPT_DIR/deploy.conf" "$SCRIPT_DIR/run_server.conf"; do
        if [ -f "$cfg" ]; then
            source "$cfg"
            SSH_TARGET="${SSH_USER}@${SSH_HOST}"
            echo "[SSH] Using SSH: $SSH_TARGET"
            break
        fi
    done
    if [ -z "$SSH_TARGET" ]; then
        echo "ERROR: No docker, no config, cannot continue"
        exit 1
    fi
fi

DOCKER_APP="${DOCKER_PREFIX}-app"
DOCKER_PARSER="${DOCKER_PREFIX}-parser"
DOCKER_INV="${DOCKER_PREFIX}-inv"
DOCKER_TICKERS="${DOCKER_PREFIX}-tickers"

# Run command locally or via SSH
run() {
    if [ -n "$SSH_TARGET" ]; then
        ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "$1"
    else
        eval "$1"
    fi
}

echo "========================================"
echo "  WClock5 Server Diagnostics"
echo "========================================"
echo ""
echo "1) Server resources"
echo "2) Docker status"
echo "3) Docker logs (app)"
echo "4) Docker logs (parsers)"
echo "5) Nginx"
echo "6) Full check"
echo "7) Checklist"
echo "8) Cleanup Docker"
echo "9) Restart services"
echo "10) Pull & restart"
echo "0) Exit"
echo ""

read -p "Select: " CHOICE

case $CHOICE in
    1) run "uptime; top -bn1 | head -5; free -h; df -h | grep /dev/" ;;
    2) run "docker ps -a; echo '---'; docker images" ;;
    3) run "docker logs \$(docker ps -q -f name=$DOCKER_APP) --tail 30 2>&1" ;;
    4)
        echo "1) weather 2) invest 3) tickers 4) all"
        read -p "Select: " c
        case $c in
            1) run "docker logs \$(docker ps -q -f name=$DOCKER_PARSER) --tail 20" ;;
            2) run "docker logs \$(docker ps -q -f name=$DOCKER_INV) --tail 20" ;;
            3) run "docker logs \$(docker ps -q -f name=$DOCKER_TICKERS) --tail 20" ;;
            4) for x in $DOCKER_PARSER $DOCKER_INV $DOCKER_TICKERS; do echo "=== $x ==="; run "docker logs \$(docker ps -q -f name=$x) --tail 10 2>&1"; done ;;
        esac
        ;;
    5) run "systemctl status nginx --no-pager | head -8; tail -10 /var/log/nginx/error.log 2>/dev/null" ;;
    6) 
        echo "HTTP: $(curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/)"
        run "docker ps; free -h; df -h / | tail -1"
        ;;
    7)
        HTTP=$(curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/)
        echo "HTTP: $HTTP"
        run "systemctl is-active nginx" | grep -q active && echo "Nginx: OK" || echo "Nginx: FAIL"
        run "docker ps -q | wc -l" | grep -q [0-9] && echo "Docker: OK" || echo "Docker: FAIL"
        echo "1) Restart Docker  2) Rebuild"
        read -p "Fix? " f
        [ "$f" = "1" ] && run "cd $REMOTE_PATH && PORT=$PORT docker-compose restart"
        [ "$f" = "2" ] && run "cd $REMOTE_PATH && PORT=$PORT docker-compose up -d --build"
        ;;
    8) 
        echo "Cleanup? "
        read -p "yes/no: " c
        [ "$c" = "yes" ] && run "docker system prune -f; docker images"
        ;;
    9)
        echo "1) Docker  2) Nginx  3) All"
        read -p "Select: " r
        [ "$r" = "1" ] && run "cd $REMOTE_PATH && PORT=$PORT docker-compose restart"
        [ "$r" = "2" ] && run "systemctl restart nginx"
        [ "$r" = "3" ] && run "cd $REMOTE_PATH && PORT=$PORT docker-compose restart; systemctl restart nginx"
        echo "Done"
        ;;
    10) run "cd $REMOTE_PATH && git pull && PORT=$PORT docker-compose up -d --build" ;;
    0) exit ;;
esac