#!/bin/bash

# run_docker.sh - Управление WClock в Docker
# Usage: ./run_docker.sh [start|stop|restart|status|clean|logs|build]

cd "$(dirname "$0")/.."

ACTION=${1:-start}

# Проверка Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker не найден"
    exit 1
fi

# Проверка работы Docker
docker_ready() { docker info >/dev/null 2>&1; }

# На Windows Docker Desktop можно поднять прямо из скрипта и подождать
start_docker_desktop() {
    case "$(uname -s 2>/dev/null || echo unknown)" in
        MINGW*|MSYS*|CYGWIN*) ;;
        *) return 1 ;;
    esac
    local exe="/c/Program Files/Docker/Docker/Docker Desktop.exe"
    [ -f "$exe" ] || return 1
    echo "🚀 Docker Desktop не отвечает — запускаю (до 3 минут)..."
    cmd //c start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" >/dev/null 2>&1 || return 1
    local i
    for i in $(seq 1 36); do
        sleep 5
        if docker_ready; then
            echo "✅ Docker Desktop готов (за $((i * 5)) с)"
            return 0
        fi
    done
    return 1
}

if ! docker_ready; then
    case "$ACTION" in
        start|restart|build) ;;
        *)
            echo "⚠️  Docker не запущен — команда '$ACTION' требует Docker"
            echo "   Запустите Docker Desktop или работайте без него:"
            echo "     bash sh/devops.sh upall / lstatus / stop"
            exit 1
            ;;
    esac
    if start_docker_desktop; then
        :
    else
        echo "❌ Docker не запущен или недоступен"
        echo ""
        echo "Варианты:"
        echo "  1) Запустить Docker Desktop вручную и повторить: ./run_docker.sh $ACTION"
        echo "  2) Работать без Docker (легче по памяти):"
        echo "       bash sh/devops.sh upall    # веб + все демоны"
        echo "       bash sh/devops.sh lstatus  # статус"
        exit 1
    fi
fi

# Проверка docker-compose
if ! command -v docker compose &> /dev/null; then
    echo "❌ docker compose не найден"
    exit 1
fi

SERVICES="wclock weather-parser invest-parser finam-invest-parser funit-invest-parser funit2-invest-parser tdiv-invest-parser trnd-invest-parser tickers-parser fx-sources-parser"

check_status() {
    echo "=== Статус контейнеров ==="
    docker compose ps
    echo ""

    local service cid state
    for service in $SERVICES; do
        cid=$(docker compose ps -q "$service" 2>/dev/null | head -1)
        if [ -z "$cid" ]; then
            echo "⚪ $service - не запущен"
            continue
        fi
        state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)
        if [ "$state" = "running" ]; then
            echo "✅ $service - работает"
        else
            echo "❌ $service - $state"
        fi
    done
}

clean_docker() {
    echo "=== Очистка Docker ==="
    echo "🛑 Остановка контейнеров..."
    docker compose down --rmi local 2>/dev/null || docker compose down 2>/dev/null

    echo "🧹 Очистка неиспользуемых ресурсов..."
    docker system prune -f

    echo "✅ Очистка завершена"
}

build() {
    echo "=== Сборка образов ==="
    docker compose build --no-cache
    echo "✅ Сборка завершена"
}

start_services() {
    echo "=== Запуск WClock ==="
    
    # Проверка .env
    if [ ! -f ".env" ]; then
        echo "❌ Файл .env не найден!"
        exit 1
    fi
    
    # Остановка старых контейнеров
    echo "🛑 Остановка старых контейнеров..."
    docker compose down 2>/dev/null || true
    
    # Сборка и запуск
    echo "🔨 Сборка и запуск..."
    if ! docker compose up -d --build 2>&1; then
        echo "❌ Ошибка сборки/запуска. Проверьте:"
        echo "   - Docker Desktop запущен?"
        echo "   - .env файл заполнен правильно?"
        docker compose logs --tail=20
        exit 1
    fi
    
    # Ожидание запуска
    echo "⏳ Ожидание запуска сервисов..."
    sleep 5
    
    # Проверка статуса
    echo ""
    check_status
    
    echo ""
    echo "=== WClock запущен ==="
    echo "🌐 Откройте в браузере:"
    echo "   http://localhost:10405/         - погода"
    echo "   http://localhost:10405/?KEY=... - инвестиции"
    echo ""
    echo "Логи: ./run_docker.sh logs"
    echo "Статус: ./run_docker.sh status"
}

stop_services() {
    echo "=== Остановка WClock ==="
    docker compose down
    echo "✅ Остановка завершена"
}

reload_web() {
    echo "=== Перезагрузка web-сервиса ==="
    docker compose restart wclock
    echo "✅ Web-сервис перезагружен"
    echo "   (изменения в static/templates применены без пересборки)"
}

show_logs() {
    echo "=== Логи (Ctrl+C для выхода) ==="
    docker compose logs -f
}

case $ACTION in
    start)
        start_services
        ;;
    stop)
        stop_services
        ;;
    restart)
        stop_services
        start_services
        ;;
    status)
        check_status
        ;;
    clean)
        clean_docker
        ;;
    build)
        build
        ;;
    logs)
        show_logs
        ;;
    reload)
        reload_web
        ;;
    *)
        echo "Использование: $0 {start|stop|restart|reload|status|clean|build|logs}"
        echo ""
        echo "  start   - Собрать и запустить все сервисы"
        echo "  stop    - Остановить все сервисы"
        echo "  restart - Перезапустить все сервисы"
        echo "  reload  - Перезапустить только web (без пересборки)"
        echo "  status  - Показать статус контейнеров"
        echo "  clean   - Остановить и удалить контейнеры и образы"
        echo "  build   - Пересобрать образы"
        echo "  logs    - Показать логи"
        exit 1
        ;;
esac
