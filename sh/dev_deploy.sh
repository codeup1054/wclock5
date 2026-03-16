#!/bin/bash
# dev_deploy.sh - Server Admin Script
# Delegates to scripts in sh/options/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/deploy.conf"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE"
    exit 1
fi

source "$CONFIG_FILE"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPTIONS_DIR="${SCRIPT_DIR}/options"

CHOICE="${1:-}"

if [ -z "$CHOICE" ]; then
    echo "========================================"
    echo "  WClock Server Admin"
    echo "========================================"
    echo ""
    echo "=== Diagnostics ==="
    echo "1) Server resources (CPU, RAM, Disk)"
    echo "2) Docker status & containers"
    echo "3) Docker logs (all services)"
    echo "4) Daemon logs (parsers)"
    echo "5) Nginx status & logs"
    echo "6) SSL certificates info"
    echo "7) Full system check"
    echo "8) Checklist (common issues)"
    echo ""
    echo "=== Maintenance ==="
    echo "9) Cleanup Docker (prune)"
    echo "10) Restart services"
    echo ""
    echo "=== Deploy ==="
    echo "11) Copy static files only"
    echo "12) Full rebuild (clean + upload + docker build)"
    echo ""
    echo "=== Setup ==="
    echo "13) Setup Nginx config"
    echo "14) Setup SSL (certbot)"
    echo "15) Full setup (Nginx + SSL + deploy)"
    echo ""
    echo "0) Exit"
    echo ""
    
    read -p "Select option: " CHOICE
fi

case $CHOICE in
    1)  bash "$OPTIONS_DIR/diagnostics/resources.sh" ;;
    2)  bash "$OPTIONS_DIR/diagnostics/docker_status.sh" ;;
    3)  bash "$OPTIONS_DIR/diagnostics/docker_logs.sh" ;;
    4)  bash "$OPTIONS_DIR/diagnostics/daemon_logs.sh" ;;
    5)  bash "$OPTIONS_DIR/diagnostics/nginx_status.sh" ;;
    6)  bash "$OPTIONS_DIR/diagnostics/ssl_status.sh" ;;
    7)  bash "$OPTIONS_DIR/diagnostics/full_check.sh" ;;
    8)  bash "$OPTIONS_DIR/diagnostics/checklist.sh" ;;
    9)  bash "$OPTIONS_DIR/maintenance/cleanup.sh" ;;
    10) bash "$OPTIONS_DIR/maintenance/restart.sh" ;;
    11) bash "$OPTIONS_DIR/deploy/copy_static.sh" ;;
    12) bash "$OPTIONS_DIR/deploy/full_rebuild.sh" ;;
    13) bash "$OPTIONS_DIR/setup/nginx.sh" ;;
    14) bash "$OPTIONS_DIR/setup/ssl.sh" ;;
    15) bash "$OPTIONS_DIR/setup/full_setup.sh" ;;
    0)  echo "Exit."; exit 0 ;;
    *)  echo "Invalid option."; exit 1 ;;
esac
