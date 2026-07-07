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
# 1b. LOCAL RESTART — убить старый Flask и запустить заново
# ============================================================
local_restart() {
    cd "$PROJECT_ROOT"
    info "Остановка старых процессов..."
    kill "$(lsof -ti:"${PORT:-5001}" 2>/dev/null)" 2>/dev/null || true
    pkill -f "mail_ru_weather_24hours" 2>/dev/null || true
    sleep 1

    source venv/bin/activate 2>/dev/null || source venv/Scripts/activate
    export PYTHONIOENCODING=utf-8
    python app.py &
    APP_PID=$!
    python parsers/mail.ru/mail_ru_weather_24hours.py &
    WEATHER_PID=$!

    sleep 2
    echo ""
    ok "Flask на http://localhost:${PORT:-5001}/ (PID=$APP_PID)"
    echo ""
}

# ============================================================
# 2. REMOTE — сборка, деплой и запуск (docker)
# ============================================================
remote_deploy() {
    info "Заливка на сервер ${SSH_TARGET} ..."
    scp -r "$PROJECT_ROOT/templates/" "${SSH_TARGET}:${REMOTE_PATH}/templates/"
    scp -r "$PROJECT_ROOT/static/" "${SSH_TARGET}:${REMOTE_PATH}/static/"
    scp "$PROJECT_ROOT/requirements.txt" "$PROJECT_ROOT/app.py" "$PROJECT_ROOT/db_init.py" "$PROJECT_ROOT/invest_db.py" "${SSH_TARGET}:${REMOTE_PATH}/"
    scp -r "$PROJECT_ROOT/parsers/" "${SSH_TARGET}:${REMOTE_PATH}/parsers/"
    scp "$PROJECT_ROOT/.env" "${SSH_TARGET}:${REMOTE_PATH}/.env" 2>/dev/null || true

    info "Остановка старых контейнеров..."
    ssh_cmd "cd ${REMOTE_PATH} && docker compose down"

    info "Сборка и запуск Docker на сервере..."
    ssh_cmd "cd ${REMOTE_PATH} && docker compose up -d --build"

    info "Очистка Docker-мусора..."
    ssh_cmd "docker image prune -f && docker builder prune -f"

    info "Удаление битых ссылок и дубликатов..."
    ssh_cmd "find ${REMOTE_PATH} -type d -name 'parsers' -path '*/parsers/parsers' -exec rm -rf {} + 2>/dev/null; true"

    echo ""
    ok "Готово: https://${DOMAIN}/"
    echo ""
}

# ============================================================
# 3. STATIC — быстрый деплой статики (templates, css, js)
# ============================================================
deploy_static() {
    info "Деплой статики на ${SSH_TARGET} ..."
    scp -r "$PROJECT_ROOT/templates/" "${SSH_TARGET}:${REMOTE_PATH}/templates/"
    scp -r "$PROJECT_ROOT/static/" "${SSH_TARGET}:${REMOTE_PATH}/static/"

    # Рестарт только web-контейнера (без пересборки)
    ssh_cmd "cd ${REMOTE_PATH} && docker compose restart wclock"
    ok "Статика обновлена"
}

# ============================================================
# 3b. NGINX CACHE CLEAR — сброс кэша nginx на сервере
# ============================================================
clear_nginx_cache() {
    info "Сброс кэша Nginx на ${SSH_TARGET} ..."
    ssh_cmd "rm -rf /var/cache/nginx/* && nginx -s reload" && \
        ok "Кэш Nginx очищен, сервер перезагружен" || \
        err "Ошибка при сбросе кэша Nginx"
    echo ""
}

# ============================================================
# 4. PARSERS — рестарт парсеров на сервере
# ============================================================
restart_parsers() {
    info "Рестарт парсеров на ${SSH_TARGET} ..."
    ssh_cmd "docker restart wclock5-parser wclock5-inv wclock5-tickers"
    ok "Парсеры перезапущены"
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
# DIAGNOSTIC — диагностика всех демонов, погоды, инвестиций
# ============================================================
diagnostic() {
    echo ""
    echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}         Диагностика WClock                       ${NC}"
    echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
    echo ""

    # ─── 1. Локальные процессы ───────────────────────────────
    echo -e "${CYAN}── Локальные процессы ──${NC}"
    local all_ok=true

    _check_proc() {
        local name="$1" pattern="$2"
        if pgrep -f "$pattern" >/dev/null 2>&1; then
            local pid; pid=$(pgrep -f "$pattern" | head -1)
            local rss; rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")
            local cpu; cpu=$(ps -o pcpu= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")
            ok "${name}  PID=${pid}  RAM=${rss}KB  CPU=${cpu}%"
        else
            err "${name}  НЕ ЗАПУЩЕН"
            all_ok=false
        fi
    }

    _check_proc "Flask app"       "app.py"
    _check_proc "Weather parser"  "mail_ru_weather_24hours"
    _check_proc "Invest daemon"   "tinkoff_invest_daemon"
    _check_proc "Tickers daemon"  "tracked_tickers_daemon"
    echo ""

    # ─── 2. Локальный HTTP ───────────────────────────────────
    echo -e "${CYAN}── Локальный HTTP ──${NC}"
    local local_code
    local_code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 http://localhost:"${PORT:-5001}"/ 2>/dev/null || true)
    if [ -z "$local_code" ] || [ "$local_code" = "000" ]; then
        err "http://localhost:${PORT:-5001}/  — не отвечает"
        all_ok=false
    else
        ok "http://localhost:${PORT:-5001}/  →  ${local_code}"
    fi
    echo ""

    # ─── 3. Удалённые Docker-контейнеры ──────────────────────
    echo -e "${CYAN}── Docker контейнеры (${SSH_TARGET}) ──${NC}"
    local containers
    containers=$(ssh_cmd "docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null" 2>/dev/null) || true
    if [ -z "$containers" ]; then
        warn "Не удалось подключиться к Docker на ${SSH_TARGET}"
    else
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            local name="${line%% *}"
            local rest="${line#* }"
            if echo "$rest" | grep -qiE "Up|healthy"; then
                ok "$name  →  $rest"
            else
                err "$name  →  $rest"
                all_ok=false
            fi
        done <<< "$containers"
    fi
    echo ""

    # ─── 4. Удалённый HTTP ───────────────────────────────────
    echo -e "${CYAN}── HTTP ${DOMAIN} ──${NC}"
    remote_code=""
    for url in "https://${DOMAIN}/" "http://${DOMAIN}/" "http://${SSH_HOST}:${PORT:-80}/"; do
        local code
        code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || true)
        if [ -n "$code" ] && [ "$code" != "000" ]; then
            remote_code="$code"
            ok "${url}  →  ${code}"
            break
        fi
    done
    if [ -z "$remote_code" ]; then
        err "https://${DOMAIN}/  — не отвечает (проверено HTTPS, HTTP, ${SSH_HOST}:${PORT})"
        all_ok=false
    fi
    echo ""

    # ─── 5. Погода (данные из БД) ────────────────────────────
    echo -e "${CYAN}── Погода ──${NC}"
    local weather_data
    weather_data=$(ssh_cmd "sqlite3 ${REMOTE_PATH}/parsers/mail.ru/odintsovo_weather.db \"SELECT collected_at, datetime, temperature, feels_like, humidity, description FROM current ORDER BY collected_at DESC LIMIT 1;\" 2>/dev/null" 2>/dev/null) || true
    if [ -z "$weather_data" ]; then
        err "Погода: нет данных или БД недоступна"
        all_ok=false
    else
        ok "Погода: последнее измерение — ${weather_data}"
    fi
    echo ""

    # ─── 6. Инвестиции (данные из БД) ────────────────────────
    echo -e "${CYAN}── Инвестиции ──${NC}"
    local inv_data
    inv_data=$(ssh_cmd "sqlite3 ${REMOTE_PATH}/parsers/invest/invest_portfolio.db \"SELECT timestamp, ticker, quantity, price, value FROM portfolio_positions ORDER BY timestamp DESC LIMIT 5;\" 2>/dev/null" 2>/dev/null) || true
    if [ -z "$inv_data" ]; then
        # fallback: other table names
        inv_data=$(ssh_cmd "sqlite3 ${REMOTE_PATH}/parsers/invest/invest_portfolio.db \"SELECT * FROM portfolio_history ORDER BY rowid DESC LIMIT 3;\" 2>/dev/null" 2>/dev/null) || true
    fi
    if [ -z "$inv_data" ]; then
        err "Инвестиции: нет данных или БД недоступна"
        all_ok=false
    else
        ok "Инвестиции (последние):"
        echo "$inv_data" | while IFS='|' read -r ts ticker qty price val; do
            echo "    ${ts}  ${ticker}  qty=${qty}  price=${price}  val=${val}"
        done
    fi
    echo ""

    # ─── 7. Итог ─────────────────────────────────────────────
    echo -e "${BLUE}──────────────────────────────────────────────────${NC}"
    if $all_ok; then
        echo -e " ${GREEN}✓ Все системы в норме${NC}"
    else
        echo -e " ${RED}✗ Есть проблемы (см. выше)${NC}"
    fi
    echo ""
}

# ============================================================
# 7. DIAGNOSE + RELOAD — проверка + перезагрузка
# ============================================================
diagnose_and_reload() {
    echo ""
    echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}      Диагностика + Перезагрузка                  ${NC}"
    echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
    echo ""

    diagnostic

    echo -e "${CYAN}── SQLite блокировки (локально) ──${NC}"
    local db_files
    db_files=$(find "$PROJECT_ROOT" -name "*.db" -o -name "*.sqlite" 2>/dev/null | head -20)
    if [ -z "$db_files" ]; then
        info "Локальные .db / .sqlite не найдены"
    else
        for db in $db_files; do
            local lockfile="${db}-shm"
            local wal="${db}-wal"
            if [ -f "$lockfile" ]; then
                warn "Обнаружен ${db}-shm (возможно блокировка)"
            fi
            if [ -f "$wal" ]; then
                info "WAL-файл: ${wal}"
            fi
            if command -v sqlite3 &>/dev/null; then
                if sqlite3 "$db" "PRAGMA quick_check;" 2>/dev/null | grep -qi "ok\|row"; then
                    ok "$(basename "$db") — OK"
                else
                    err "$(basename "$db") — ОШИБКА/заблокирована"
                fi
            fi
        done
    fi
    echo ""

    echo -e "${CYAN}── Docker логи (последние ошибки) ──${NC}"
    local logs
    logs=$(ssh_cmd "docker logs wclock5 2>&1 | tail -10" 2>/dev/null) || true
    if [ -n "$logs" ]; then
        echo "$logs" | while IFS= read -r line; do
            if echo "$line" | grep -qiE "error|exception|traceback|locked|timeout"; then
                err "$line"
            else
                echo "  $line"
            fi
        done
    else
        warn "Нет логов или контейнер не запущен"
    fi
    echo ""

    echo -e "${YELLOW}Перезагрузить все сервисы?${NC}"
    read -rp "  y/n: " reload_choice
    if [ "$reload_choice" = "y" ] || [ "$reload_choice" = "Y" ] || [ "$reload_choice" = "д" ] || [ "$reload_choice" = "Д" ]; then
        echo ""
        echo -e "${CYAN}── Перезагрузка Docker-контейнеров ──${NC}"
        ssh_cmd "cd ${REMOTE_PATH} && docker compose down && docker compose up -d" && \
            ok "Все контейнеры перезапущены" || \
            err "Ошибка перезапуска"

        echo ""
        echo -e "${CYAN}── Проверка после перезагрузки ──${NC}"
        sleep 3
        local code
        code=$(curl -so /dev/null -w "%{http_code}" --max-time 10 https://"${DOMAIN}"/ 2>/dev/null || true)
        if [ -n "$code" ] && [ "$code" != "000" ]; then
            ok "https://${DOMAIN}/  →  ${code}"
        else
            err "https://${DOMAIN}/  — не отвечает"
        fi
    else
        info "Перезагрузка отменена"
    fi
    echo ""
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
     echo " 4) 🔄  Restart PARSERS (wclock5-parser, inv, tickers)"
     echo " 5) 🔄  Restart LOCAL (убить/запустить Flask)"
     echo " 6) 🔍  Diagnostic — демоны, погода, инвестиции"
     echo " 7) 🩺  Diagnose + Reload — диагностика + перезагрузка"
     echo " 8) 🗑️  Clear NGINX Cache на сервере"
     echo " s) 📊  Status — проверить local + remote"
     echo " 0) ❌  Выход"
    echo ""
}

while true; do
    # В неинтерактивном режиме — сразу exit
    if [ $# -gt 0 ]; then
    case "${1:-}" in
        1|local)       local_run; exit 0 ;;
        5|r|restart)   local_restart; exit 0 ;;
        2|remote)      remote_deploy; exit 0 ;;
        3|static)      deploy_static; exit 0 ;;
        4|p|parsers)   restart_parsers; exit 0 ;;
        6|diag|diagnostic) diagnostic; exit 0 ;;
        7|reload|diag-reload) diagnose_and_reload; exit 0 ;;
        8|nginx|cache) clear_nginx_cache; exit 0 ;;
        s|status)      short_status; exit 0 ;;
        help|--help)   echo "Команды: local / restart / remote / static / parsers / diagnostic / diag-reload / nginx-cache / status"; exit 0 ;;
        *)             err "Неизвестно: $1"; exit 1 ;;
    esac
    fi

    clear
    show_menu
    read -rp "Выберите: " choice

    case "$choice" in
        1|l|local)  local_run ;;
        5|r|restart) local_restart ;;
        2|d|remote) remote_deploy ;;
        3|s|static) deploy_static ;;
        4|p)        restart_parsers ;;
        6|diag)     diagnostic ;;
        7|reload)   diagnose_and_reload ;;
        8|n|cache)  clear_nginx_cache ;;
        s|status)   short_status ;;
        0|q|exit)   echo -e "${GREEN}Пока${NC}"; exit 0 ;;
        *)          err "Неверный выбор"; sleep 1 ;;
    esac

    echo ""
    read -rp "Enter для продолжения..."
done
