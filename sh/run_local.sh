#!/bin/bash

# run_local.sh - Локальный запуск (Windows Git Bash / Linux / macOS / WSL)
# Запускает Flask приложение и демоны парсинга

cd "$(dirname "$0")"

echo "=== Запуск WClock локально ==="

# Проверка Python
if ! command -v python &> /dev/null; then
    echo "❌ Python не найден"
    exit 1
fi

# Создание виртуального окружения (если нет)
if [ ! -d "venv" ]; then
    echo "📦 Создание виртуального окружения..."
    python -m venv venv
fi

# Активация venv
source venv/bin/activate 2>/dev/null || source venv/Scripts/activate 2>/dev/null

# Установка зависимостей
echo "📥 Установка зависимостей..."
pip install -r requirements.txt -q

# Запуск Flask приложения в фоне
echo "🚀 Запуск Flask (порт 5001)..."
python app.py &
APP_PID=$!

# Запуск демона погоды в фоне
echo "🌤️ Запуск демона погоды..."
python parsers/mail.ru/mail_ru_weather_24hours.py &
WEATHER_PID=$!

# Запуск демона инвестиций в фоне (если есть токен)
if [ -f "parsers/invest/tinkoff_invest_daemon.py" ]; then
    echo "📈 Запуск демона инвестиций..."
    python parsers/invest/tinkoff_invest_daemon.py &
    INVEST_PID=$!
fi

echo ""
echo "=== WClock запущен ==="
echo "🌐 Откройте в браузере:"
echo "   http://localhost:5001/         - погода"
echo "   http://localhost:5001/?KEY=6HKJ809-YUI67-HKJJL-5677-HJKK - инвестиции"
echo ""
echo "PIDs: Flask=$APP_PID Погода=$WEATHER_PID Инвестиции=${INVEST_PID:-N/A}"
echo ""
echo "Для остановки: kill $APP_PID $WEATHER_PID ${INVEST_PID:-}"
echo "================================"

# Ожидание ( чтобы скрипт не завершался )
wait
