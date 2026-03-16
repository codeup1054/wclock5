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
if ! docker info &> /dev/null; then
    echo "❌ Docker не запущен или недоступен"
    echo "Пожалуйста, запустите Docker Desktop и дождитесь полной загрузки"
    exit 1
fi

# Проверка docker-compose
if ! command -v docker compose &> /dev/null; then
    echo "❌ docker compose не найден"
    exit 1
fi

check_status() {
    echo "=== Статус контейнеров ==="
    docker compose ps
    echo ""
    
    # Проверка каждого сервиса
    for service in wclock weather-parser invest-parser tickers-parser; do
        if docker compose ps $service 2>/dev/null | grep -q "Up"; then
            echo "✅ $service - работает"
        elif docker compose ps $service 2>/dev/null | grep -q "Exited"; then
            echo "❌ $service - остановлен"
        else
            echo "⚪ $service - не запущен"
        fi
    done
}

clean_docker() {
    echo "=== Очистка Docker ==="
    echo "🛑 Остановка контейнеров..."
    docker compose down 2>/dev/null
    
    echo "🗑️ Удаление образов..."
    docker rmi wclock3-wclock wclock3-weather-parser wclock3-invest-parser wclock3-tickers-parser 2>/dev/null || true
    
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
    echo "   http://localhost:8004/         - погода"
    echo "   http://localhost:8004/?KEY=... - инвестиции"
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
