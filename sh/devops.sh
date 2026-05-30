#!/bin/bash
# devops.sh — WClock DevOps
# Использование:
#   ./devops.sh              — интерактивное меню
#   ./devops.sh <команда>    — прямой запуск

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()  { echo -e " ${GREEN}✓${NC} $1"; }
info(){ echo -e " ${CYAN}ℹ${NC} $1"; }
warn(){ echo -e " ${YELLOW}⚠${NC} $1"; }
err() { echo -e " ${RED}✗${NC} $1" >&2; }

# === SSH / CONFIG ===
source "$SCRIPT_DIR/deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"
ssh_cmd() { ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SSH_TARGET" "$@"; }

# ============================================================
# 1. LOCAL — build & run
# ============================================================
local_run() {
    cd "$PROJECT_ROOT"
    if [ ! -d venv ]; then
        info "Создание venv..."
        python -m venv venv
    fi
    source venv/bin/activate 2>/dev/null || source venv/Scripts/activate
    pip install -r requirements.txt -q

    # Бьём старые процессы
    kill "$(lsof -ti:"${PORT:-5001}" 2>/dev/null)" 2>/dev/null || true
    pkill -f "mail_ru_weather_24hours" 2>/dev/null || true
    pkill -f "tinkoff_invest_daemon" 2>/dev/null || true

    export PYTHONIOENCODING=utf-8
    python app.py &
    APP_PID=$!
    python parsers/mail.ru/mail_ru_weather_24hours.py &
    WEATHER_PID=$!

    sleep 3
    echo ""
    echo "  http://localhost:${PORT:-5001}/"
    echo "  PIDs: app=$APP_PID  weather=$WEATHER_PID"
    echo "  Стоп: pkill -f app.py"
    echo ""
}

# ============================================================
# 2. REMOTE — build, deploy & run (docker)
# ============================================================
remote_deploy() {
    info "Заливка на сервер ${SSH_TARGET} ..."
    rsync -az --delete --exclude='.git' --exclude='venv' --exclude='__pycache__' \
        --exclude='*.db' --exclude='.env' \
        -e ssh "$PROJECT_ROOT/" "${SSH_TARGET}:${REMOTE_PATH}/"

    info "Сборка и запуск Docker на сервере..."
    ssh_cmd "cd ${REMOTE_PATH} && docker compose up -d --build"

    echo ""
    ok "Готово: https://${DOMAIN}/"
    echo ""
}

# ============================================================
# 3. STATIC — быстрый деплой статики (templates, css, js)
# ============================================================
deploy_static() {
    info "Деплой статики на ${SSH_TARGET} ..."
    rsync -az --delete -e ssh \
        "$PROJECT_ROOT/templates/" "${SSH_TARGET}:${REMOTE_PATH}/templates/"
    rsync -az --delete -e ssh \
        "$PROJECT_ROOT/static/" "${SSH_TARGET}:${REMOTE_PATH}/static/"

    # Рестарт только web-контейнера (без пересборки)
    ssh_cmd "cd ${REMOTE_PATH} && docker compose restart wclock"
    ok "Статика обновлена"
}

# ============================================================
# HELP / SHORT STATUS
# ============================================================
short_status() {
    echo "Локально:"
    curl -so /dev/null -w "  http://localhost:${PORT:-5001}/  →  %{http_code}\n" http://localhost:"${PORT:-5001}"/ 2>/dev/null || echo "  не запущен"

    echo "Сервер ${DOMAIN}:"
    curl -so /dev/null -w "  https://${DOMAIN}/  →  %{http_code}\n" https://"${DOMAIN}"/ 2>/dev/null || echo "  недоступен"
}

# ============================================================
# MENU
# ============================================================
show_menu() {
    echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║         WClock DevOps                ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Сервер: ${SSH_TARGET}${NC}"
    echo ""
    echo " 1) 🚀  Build & Run  LOCAL"
    echo " 2) 📦  Build & Deploy & Run  REMOTE"
    echo " 3) ⚡  Deploy STATIC (css/js/html только)"
    echo "─────────────────────────────"
    echo " s) 📊  Status — проверить local + remote"
    echo " 0) ❌  Выход"
    echo ""
}

while true; do
    # В неинтерактивном режиме — сразу exit
    if [ $# -gt 0 ]; then
        case "${1:-}" in
            1|local)       local_run; exit 0 ;;
            2|remote)      remote_deploy; exit 0 ;;
            3|static)      deploy_static; exit 0 ;;
            s|status)      short_status; exit 0 ;;
            help|--help)   echo "Команды: local / remote / static / status"; exit 0 ;;
            *)             err "Неизвестно: $1"; exit 1 ;;
        esac
    fi

    clear
    show_menu
    read -rp "Выберите: " choice

    case "$choice" in
        1|l|local)  local_run ;;
        2|r|remote) remote_deploy ;;
        3|s|static) deploy_static ;;
        s|status)   short_status ;;
        0|q|exit)   echo -e "${GREEN}Пока${NC}"; exit 0 ;;
        *)          err "Неверный выбор"; sleep 1 ;;
    esac

    echo ""
    read -rp "Enter для продолжения..."
done
