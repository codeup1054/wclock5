#!/bin/bash
# devops.sh — WClock DevOps
# Использование:
#   ./devops.sh              — интерактивное меню
#   ./devops.sh <команда>    — прямой запуск
#
# Локально, без Docker (venv + Flask):
#   ./devops.sh local        — только веб (порт 5001, LOCAL_PORT)
#   ./devops.sh upall        — веб + демоны (pogoda, tickers, invest, finam, fx)
#   ./devops.sh stop         — остановить всё локальное
#   ./devops.sh lstatus      — статус локального запуска
#   ./devops.sh llogs web    — хвост лога (logs/local/<имя>.log)
#   ./devops.sh deps         — venv + полный pip install

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()  { echo -e " ${GREEN}✓${NC} $1"; }
info(){ echo -e " ${CYAN}ℹ${NC} $1"; }
warn(){ echo -e " ${YELLOW}⚠${NC} $1"; }
err() { echo -e " ${RED}✗${NC} $1" >&2; }

# Кириллица в логах локальных процессов и python-вставках
export PYTHONIOENCODING=utf-8

# === SSH / CONFIG ===
source "$SCRIPT_DIR/deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"
ssh_cmd() { ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SSH_TARGET" "$@"; }

# ============================================================
# 1. LOCAL (без Docker) — веб + демоны через venv
# ============================================================
# Порт локального веба. Не путать с PORT (10405) — это внешний порт
# Docker-контейнера; локальный запуск использует свой порт, чтобы не
# трогать работающий Docker.
LOCAL_PORT="${LOCAL_PORT:-5001}"
LOCAL_DIR="$PROJECT_ROOT/logs/local"
# Демоны, которые поднимает `upall` (переопределяется: LOCAL_DAEMONS="tickers tinkoff")
LOCAL_DAEMONS_DEFAULT="${LOCAL_DAEMONS:-weather tickers tinkoff finam funit funit2 tdiv trnd fx}"

case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
    *) IS_WINDOWS=0 ;;
esac

mkdir -p "$LOCAL_DIR" 2>/dev/null || true

# --- вспомогательное ----------------------------------------
venv_python() {
    if [ -x "$PROJECT_ROOT/venv/Scripts/python.exe" ]; then
        echo "$PROJECT_ROOT/venv/Scripts/python.exe"
    elif [ -x "$PROJECT_ROOT/venv/bin/python" ]; then
        echo "$PROJECT_ROOT/venv/bin/python"
    else
        echo ""
    fi
}

host_python() {
    if [ -n "${PYTHON:-}" ]; then echo "$PYTHON"
    elif command -v python3 >/dev/null 2>&1; then echo python3
    else echo python
    fi
}

local_pidfile() { echo "$LOCAL_DIR/$1.pid"; }

pid_alive() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 1
    if [ "$IS_WINDOWS" = "1" ]; then
        tasklist //FI "PID eq $pid" 2>/dev/null | grep -q " $pid "
    else
        kill -0 "$pid" 2>/dev/null
    fi
}

kill_pid() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0
    if [ "$IS_WINDOWS" = "1" ]; then
        taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true
    else
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
    fi
}

# PID, слушающие порт (Windows: netstat, Unix: lsof/ss)
port_pids() {
    local port="$1"
    if [ "$IS_WINDOWS" = "1" ]; then
        netstat -ano 2>/dev/null | awk -v p=":$port" '$2 ~ p"$" {print $NF}' | sort -u | grep -v '^0$' || true
    elif command -v lsof >/dev/null 2>&1; then
        lsof -ti:"$port" 2>/dev/null || true
    else
        ss -tlnp 2>/dev/null | grep ":$port " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u || true
    fi
}

# Запуск фонового процесса: start_local_bg <имя> <workdir> <команда...>
# PID пишем в logs/local/<имя>.pid. На Windows MSYS-PID не совпадает с
# Windows-PID, поэтому сохраняем WINPID (taskkill/tasklist работают с ним).
start_local_bg() {
    local name="$1" workdir="$2"; shift 2
    local log="$LOCAL_DIR/$name.log"
    ( cd "$workdir" && exec "$@" >>"$log" 2>&1 ) &
    local pid=$!
    if [ "$IS_WINDOWS" = "1" ]; then
        local w="" i
        for i in 1 2 3 4 5 6 7 8 9 10; do
            w="$(ps -W 2>/dev/null | awk -v p="$pid" '$1==p {print $4; exit}')"
            [ -n "$w" ] && break
            sleep 0.2
        done
        [ -n "$w" ] && pid="$w"
    fi
    echo "$pid" > "$(local_pidfile "$name")"
}

read_pid() { cat "$(local_pidfile "$1")" 2>/dev/null || true; }

# --- venv ---------------------------------------------------
local_ensure_venv() {
    local vpy
    vpy="$(venv_python)"
    if [ -z "$vpy" ]; then
        info "Создание venv..."
        "$(host_python)" -m venv "$PROJECT_ROOT/venv" || { err "Не удалось создать venv"; return 1; }
        vpy="$(venv_python)"
    fi
    if ! "$vpy" -c "import flask" >/dev/null 2>&1; then
        info "Установка зависимостей в venv (Flask и др.)..."
        "$vpy" -m pip install -q --upgrade pip >/dev/null 2>&1 || true
        "$vpy" -m pip install -q -r "$PROJECT_ROOT/requirements.txt" \
            || { err "pip install не удался — см. requirements.txt"; return 1; }
    fi
    ok "venv: $vpy"
}

# Полная установка зависимостей (включая yfinance/playwright для демонов)
local_deps() {
    local_ensure_venv || return 1
    local vpy; vpy="$(venv_python)"
    info "Полная установка requirements.txt..."
    "$vpy" -m pip install -q -r "$PROJECT_ROOT/requirements.txt" || { err "pip install не удался"; return 1; }
    echo ""
    for mod in flask requests dotenv apscheduler bs4 PIL yfinance playwright; do
        if "$vpy" -c "import $mod" >/dev/null 2>&1; then ok "$mod"; else warn "$mod — нет"; fi
    done
}

# --- веб ----------------------------------------------------
local_web_start() {
    local_ensure_venv || return 1
    local vpy; vpy="$(venv_python)"
    local pid; pid="$(read_pid web)"
    if pid_alive "$pid"; then
        info "WEB уже запущен (PID=$pid) → http://127.0.0.1:${LOCAL_PORT}/"
        return 0
    fi

    # Порт занят (например, старый процесс без pid-файла) — освобождаем
    local busy; busy="$(port_pids "$LOCAL_PORT" | head -1)"
    if [ -n "$busy" ]; then
        warn "Порт ${LOCAL_PORT} занят (PID=$busy) — останавливаю"
        kill_pid "$busy"
        sleep 1
    fi

    info "Запуск Flask локально (без Docker), порт ${LOCAL_PORT}..."
    start_local_bg web "$PROJECT_ROOT" env \
        PORT="$LOCAL_PORT" PYTHONIOENCODING=utf-8 "$vpy" -u app.py
    pid="$(read_pid web)"
    sleep 4

    local code; code=$(curl -so /dev/null -w "%{http_code}" --max-time 8 \
        "http://127.0.0.1:${LOCAL_PORT}/" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
        ok "WEB: http://127.0.0.1:${LOCAL_PORT}/  (PID=$pid)"
        echo "    вход: http://127.0.0.1:${LOCAL_PORT}/?KEY=6HKJ809-YUI67-HKJJL-5677-HJKK"
    else
        err "WEB не отвечает (HTTP ${code:-000}), лог: $LOCAL_DIR/web.log"
        return 1
    fi
}

# --- демоны -------------------------------------------------
local_daemon_start_one() {
    local name="$1" vpy="$2"
    case "$name" in
        weather)   start_local_bg weather  "$PROJECT_ROOT" "$vpy" -u parsers/mail.ru/mail_ru_weather_24hours.py ;;
        tickers)   start_local_bg tickers  "$PROJECT_ROOT" "$vpy" -u parsers/invest/tracked_tickers_daemon.py ;;
        tinkoff)   start_local_bg tinkoff  "$PROJECT_ROOT" "$vpy" -u parsers/invest/tinkoff_invest_daemon.py ;;
        finam)     start_local_bg finam    "$PROJECT_ROOT" env INVEST_SOURCE=finam   "$vpy" -u parsers/invest/finam_invest_daemon.py ;;
        funit)     start_local_bg funit    "$PROJECT_ROOT" env INVEST_SOURCE=funit   "$vpy" -u parsers/invest/finam_invest_daemon.py ;;
        funit2)    start_local_bg funit2   "$PROJECT_ROOT" env INVEST_SOURCE=funit2  "$vpy" -u parsers/invest/finam_invest_daemon.py ;;
        tdiv)      start_local_bg tdiv     "$PROJECT_ROOT" env INVEST_SOURCE=tdiv    "$vpy" -u parsers/invest/account_invest_daemon.py ;;
        trnd)      start_local_bg trnd     "$PROJECT_ROOT" env INVEST_SOURCE=trnd    "$vpy" -u parsers/invest/account_invest_daemon.py ;;
        fx)        start_local_bg fx       "$PROJECT_ROOT" sh -c "while true; do \"$vpy\" -u parsers/invest/fx_sources.py --days 3; sleep 900; done" ;;
        *)         warn "Неизвестный демон: $name"; return 1 ;;
    esac
}

local_daemons_start() {
    local_ensure_venv || return 1
    local vpy; vpy="$(venv_python)"
    local list="${LOCAL_DAEMONS:-$LOCAL_DAEMONS_DEFAULT}"

    if [ -z "$(curl -so /dev/null -w '%{http_code}' --max-time 5 https://www.cbr-xml-daily.ru/ 2>/dev/null | grep -v 000 || true)" ]; then
        warn "Нет сети/DNS с хоста — демоны не смогут скачивать данные (веб будет работать)"
    fi

    for name in $list; do
        local pid; pid="$(read_pid "$name")"
        if pid_alive "$pid"; then
            info "$name уже запущен (PID=$pid)"
            continue
        fi
        if local_daemon_start_one "$name" "$vpy"; then
            sleep 1
            pid="$(read_pid "$name")"
            if pid_alive "$pid"; then
                ok "$name запущен (PID=$pid)"
            else
                err "$name упал сразу — см. $LOCAL_DIR/$name.log"
            fi
        fi
    done
}

local_start_all() {
    local_web_start
    echo ""
    local_daemons_start
    echo ""
    local_status
}

# --- остановка ----------------------------------------------
local_all_names() {
    echo "web ${LOCAL_DAEMONS:-$LOCAL_DAEMONS_DEFAULT}"
}

local_stop_one() {
    local name="$1"
    local f; f="$(local_pidfile "$name")"
    if [ ! -f "$f" ]; then
        return 0
    fi
    local pid; pid="$(cat "$f" 2>/dev/null || true)"
    if pid_alive "$pid"; then
        kill_pid "$pid"
        ok "остановлен $name (PID=$pid)"
    fi
    rm -f "$f"
}

local_stop() {
    info "Остановка локальных процессов (Docker не трогаем)..."
    local stopped=0
    for name in $(local_all_names); do
        local pid; pid="$(read_pid "$name")"
        if pid_alive "$pid"; then stopped=$((stopped + 1)); fi
        local_stop_one "$name"
    done

    # Подчищаем процесс на порту, если pid-файла не было
    local busy; busy="$(port_pids "$LOCAL_PORT" | head -1)"
    if [ -n "$busy" ]; then
        kill_pid "$busy"
        ok "освобождён порт ${LOCAL_PORT} (PID=$busy)"
        stopped=$((stopped + 1))
    fi

    if [ "$stopped" -eq 0 ]; then
        info "Локально ничего не запущено"
    fi
}

# --- статус / логи ------------------------------------------
local_status() {
    echo ""
    echo -e "${BLUE}── Локальный запуск (без Docker) ──${NC}"

    local vpy; vpy="$(venv_python)"
    if [ -n "$vpy" ]; then ok "venv: $vpy"; else warn "venv не найден (./sh/devops.sh deps)"; fi

    local pid; pid="$(read_pid web)"
    local code; code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 \
        "http://127.0.0.1:${LOCAL_PORT}/" 2>/dev/null || true)
    if pid_alive "$pid"; then
        if [ "$code" = "200" ]; then
            ok "web: PID=$pid  http://127.0.0.1:${LOCAL_PORT}/ → 200"
        else
            err "web: PID=$pid, но HTTP ${code:-000} — см. $LOCAL_DIR/web.log"
        fi
    elif [ "$code" = "200" ]; then
        warn "web: отвечает на ${LOCAL_PORT}, но PID-файла нет (запущен вручную?)"
    else
        info "web: не запущен"
    fi

    echo ""
    echo -e "${CYAN}  демоны:${NC}"
    local any=0
    for name in $(local_all_names); do
        [ "$name" = "web" ] && continue
        pid="$(read_pid "$name")"
        if pid_alive "$pid"; then
            ok "  $name  PID=$pid"
            any=1
        else
            echo -e "  ${YELLOW}—${NC}  $name  не запущен"
        fi
    done
    [ "$any" -eq 0 ] && info "  (ни один демон не запущен — это нормально для режима только-веб)"

    # Свежесть данных в БД
    if [ -n "$vpy" ]; then
        echo ""
        echo -e "${CYAN}  данные (БД):${NC}"
        "$vpy" - "$PROJECT_ROOT" <<'PY' 2>/dev/null || true
import os, sqlite3, sys, datetime
root = sys.argv[1]
checks = [
    ("invest", os.path.join(root, "parsers/invest/invest_portfolio.db"),
     "SELECT COUNT(*), MAX(ts_epoch) FROM portfolio_history"),
    ("tickers", os.path.join(root, "parsers/invest/tracked_tickers.db"),
     "SELECT COUNT(*), MAX(ts_epoch) FROM last_prices"),
    ("weather", os.path.join(root, "parsers/mail.ru/odintsovo_weather.db"),
     "SELECT COUNT(*), MAX(collected_at) FROM current"),
]
for name, path, q in checks:
    if not os.path.exists(path):
        print(f"    {name:8s} — нет файла {path}")
        continue
    try:
        c = sqlite3.connect(path)
        n, ts = c.execute(q).fetchone()
        if isinstance(ts, str):
            print(f"    {name:8s} записей={n}  последняя={ts}")
        elif ts:
            print(f"    {name:8s} записей={n}  последняя=" +
                  datetime.datetime.fromtimestamp(int(ts)).strftime("%d.%m %H:%M"))
        else:
            print(f"    {name:8s} записей={n}")
    except Exception as e:
        print(f"    {name:8s} — ошибка: {e}")
PY
    fi
    echo ""
}

local_logs() {
    local name="${1:-web}"
    local f="$LOCAL_DIR/$name.log"
    if [ ! -f "$f" ]; then
        err "Нет лога: $f"
        info "Доступные логи: $(ls "$LOCAL_DIR"/*.log 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
        return 1
    fi
    info "Лог «$name» — $f (Ctrl+C для выхода)"
    tail -n 60 -f "$f"
}

# ============================================================
# 1a. LOCAL — старт только веба (совместимость с меню 1)
# ============================================================
local_run() {
    cd "$PROJECT_ROOT"
    local_web_start
}

# ============================================================
# 1b. LOCAL RESTART — перезапуск веба
# ============================================================
local_restart() {
    cd "$PROJECT_ROOT"
    info "Перезапуск локального веба..."
    local_stop_one web
    local_web_start
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
    ssh_cmd "docker restart wclock5-parser wclock5-inv wclock5-finam-inv wclock5-funit-inv wclock5-funit2-inv wclock5-tdiv-inv wclock5-trnd-inv wclock5-tickers wclock5-fx-sources"
    ok "Парсеры перезапущены"
}

# ============================================================
# HELP / SHORT STATUS
# ============================================================
short_status() {
    echo "Локальный веб (без Docker, порт ${LOCAL_PORT}):"
    local lcode
    lcode=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${LOCAL_PORT}/" 2>/dev/null || true)
    if [ "$lcode" = "200" ]; then
        echo "  http://127.0.0.1:${LOCAL_PORT}/  →  ${lcode}"
    else
        echo "  http://127.0.0.1:${LOCAL_PORT}/  →  не запущен"
    fi

    echo "Docker (порт ${PORT}):"
    local dcode
    dcode=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${PORT}/" 2>/dev/null || true)
    if [ "$dcode" = "200" ]; then
        echo "  http://127.0.0.1:${PORT}/  →  ${dcode}"
    else
        echo "  http://127.0.0.1:${PORT}/  →  не запущен"
    fi

    echo "Сервер ${DOMAIN}:"
    curl -so /dev/null -w "  https://${DOMAIN}/  →  %{http_code}\n" --max-time 8 https://"${DOMAIN}"/ 2>/dev/null || echo "  недоступен"
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

    # Локальный запуск без Docker: процессы ищем по pid-файлам
    _check_pid() {
        local label="$1" key="$2" pid
        pid="$(read_pid "$key")"
        if pid_alive "$pid"; then
            ok "${label}  PID=${pid}"
        else
            err "${label}  НЕ ЗАПУЩЕН"
            all_ok=false
        fi
    }

    if [ "$IS_WINDOWS" = "1" ] || ! command -v pgrep >/dev/null 2>&1; then
        _check_pid "Flask app (local)"     web
        _check_pid "Weather parser (local)" weather
        _check_pid "Invest daemon (local)"  tinkoff
        _check_pid "Tickers daemon (local)" tickers
    else
        _check_proc "Flask app"       "app.py"
        _check_proc "Weather parser"  "mail_ru_weather_24hours"
        _check_proc "Invest daemon"   "tinkoff_invest_daemon"
        _check_proc "Tickers daemon"  "tracked_tickers_daemon"
    fi
    echo ""

    # ─── 2. Локальный HTTP ───────────────────────────────────
    echo -e "${CYAN}── Локальный HTTP ──${NC}"
    local local_code
    local_code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${LOCAL_PORT}/" 2>/dev/null || true)
    if [ -z "$local_code" ] || [ "$local_code" = "000" ]; then
        info "http://127.0.0.1:${LOCAL_PORT}/ (без Docker) — не запущен"
    else
        ok "http://127.0.0.1:${LOCAL_PORT}/ (без Docker) → ${local_code}"
    fi

    local docker_code
    docker_code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${PORT}/" 2>/dev/null || true)
    if [ -z "$docker_code" ] || [ "$docker_code" = "000" ]; then
        info "http://127.0.0.1:${PORT}/ (Docker) — не запущен"
    else
        ok "http://127.0.0.1:${PORT}/ (Docker) → ${docker_code}"
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
     echo " 1) 🚀  Build & Run  LOCAL (веб, без Docker)"
     echo " 2) 📦  Build & Deploy & Run  REMOTE"
     echo " 3) ⚡  Deploy STATIC (css/js/html только)"
     echo " 4) 🔄  Restart PARSERS (wclock5-parser, inv, tickers)"
     echo " 5) 🔄  Restart LOCAL web (убить/запустить Flask)"
     echo " 6) 🔍  Diagnostic — демоны, погода, инвестиции"
     echo " 7) 🩺  Diagnose + Reload — диагностика + перезагрузка"
     echo " 8) 🗑️  Clear NGINX Cache на сервере"
     echo " 9) 🐍  LOCAL WEB + ДЕМОНЫ (без Docker)"
     echo "10) ⏹️  LOCAL STOP (веб + демоны)"
     echo "11) 📊  LOCAL STATUS (без Docker)"
     echo "12) 📜  LOCAL LOGS (<имя>)"
     echo "13) 📥  LOCAL DEPS (venv + pip install)"
     echo " s) 📊  Status — local + docker + remote"
     echo " 0) ❌  Выход"
    echo ""
}

while true; do
    # В неинтерактивном режиме — сразу exit
    if [ $# -gt 0 ]; then
    case "${1:-}" in
        1|local)       local_run; exit 0 ;;
        9|upall|local-all) local_start_all; exit 0 ;;
        10|stop|down)  local_stop; exit 0 ;;
        11|lstatus|local-status) local_status; exit 0 ;;
        12|llogs|local-logs) local_logs "${2:-web}"; exit 0 ;;
        13|deps|local-deps) local_deps; exit 0 ;;
        5|r|restart)   local_restart; exit 0 ;;
        2|remote)      remote_deploy; exit 0 ;;
        3|static)      deploy_static; exit 0 ;;
        4|p|parsers)   restart_parsers; exit 0 ;;
        6|diag|diagnostic) diagnostic; exit 0 ;;
        7|reload|diag-reload) diagnose_and_reload; exit 0 ;;
        8|nginx|cache) clear_nginx_cache; exit 0 ;;
        s|status)      short_status; exit 0 ;;
        help|--help)   echo "Команды: local | upall | stop | lstatus | llogs [имя] | deps | restart | remote | static | parsers | diagnostic | diag-reload | nginx-cache | status"; exit 0 ;;
        *)             err "Неизвестно: $1"; exit 1 ;;
    esac
    fi

    clear
    show_menu
    read -rp "Выберите: " choice

    case "$choice" in
        1|l|local)  local_run ;;
        9|upall)    local_start_all ;;
        10|stop)    local_stop ;;
        11|lstatus) local_status ;;
        12|llogs)   read -rp "  имя лога (web/weather/tickers/tinkoff/finam/...): " log_name
                    local_logs "${log_name:-web}" ;;
        13|deps)    local_deps ;;
        5|r|restart) local_restart ;;
        2|d|remote) remote_deploy ;;
        3|static)   deploy_static ;;
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
