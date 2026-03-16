#!/bin/bash
# check_and_run.sh — проверка и интерактивный запуск tinkoff_invest_daemon.py

set -euo pipefail

DAEMON_SCRIPT="parsers/invest/tinkoff_invest_daemon.py"
PID_FILE="./tinkoff_daemon.pid"
LOG_DIR="./logs"
PORTFOLIO_DB="parsers/invest/invest_portfolio.db"
TICKERS_DB="parsers/invest/tracked_tickers.db"

# Создаём директорию для логов
mkdir -p "$LOG_DIR"

# === ПРОВЕРКА ЗАПУЩЕННОСТИ ДЕМОНА ===
is_daemon_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
        if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
            CMDLINE=$(ps -p "$PID" -o command= 2>/dev/null | head -1 || "")
            if echo "$CMDLINE" | grep -q "$DAEMON_SCRIPT"; then
                return 0
            fi
        fi
    fi
    
    if pgrep -f "$DAEMON_SCRIPT" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

# === ВЫВОД ПОСЛЕДНИХ ЗАПИСЕЙ ИЗ БД ===
show_db_data() {
    echo -e "\n=== 📊 Последние записи из БД ==="
    
    if [ -f "$PORTFOLIO_DB" ]; then
        echo "Портфель:"
        sqlite3 "$PORTFOLIO_DB" "
            SELECT 
                timestamp,
                total_value AS 'Стоимость, ₽'
            FROM portfolio_history 
            ORDER BY timestamp DESC 
            LIMIT 5;"
    fi
    
    if [ -f "$TICKERS_DB" ]; then
        echo -e "\nТикеры:"
        sqlite3 "$TICKERS_DB" "
            SELECT 
                datetime(timestamp, 'unixepoch', 'localtime') AS 'Дата',
                ticker AS 'Тикер',
                price AS 'Цена'
            FROM last_prices 
            ORDER BY timestamp DESC 
            LIMIT 5;"
    fi
}

# === ЗАПУСК ДЕМОНА ===
start_daemon() {
    echo "🚀 Запускаю tinkoff_invest_daemon.py в фоне..."
    
    # Генерируем имя лог-файла с текущей датой
    LOG_FILE="$LOG_DIR/tinkoff_daemon_$(date +%Y%m%d_%H%M%S).log"
    
    # Запуск через nohup
    nohup python3 "$DAEMON_SCRIPT" > "$LOG_FILE" 2>&1 &
    DAEMON_PID=$!
    
    # Сохраняем PID
    echo $DAEMON_PID > "$PID_FILE"
    
    # Небольшая пауза для старта
    sleep 1
    
    # Проверка успешного запуска
    if ps -p "$DAEMON_PID" > /dev/null 2>&1; then
        echo "✅ Демон запущен (PID: $DAEMON_PID)"
        echo "   Лог: $LOG_FILE"
        echo "   Остановить: kill \$PID или удалить $PID_FILE"
        return 0
    else
        echo "❌ Демон завершился сразу после запуска"
        rm -f "$PID_FILE"
        echo "   Последние строки лога:"
        tail -n 10 "$LOG_FILE" 2>/dev/null || echo "   (лог пустой)"
        return 1
    fi
}

# === ОСНОВНАЯ ЛОГИКА ===
if is_daemon_running; then
    echo "✅ tinkoff_invest_daemon.py работает"
    
    # Показываем последние логи
    LOG_FILE=$(ls -t "$LOG_DIR"/tinkoff_daemon*.log 2>/dev/null | head -1)
    if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ]; then
        echo -e "\n=== 📝 Последние 5 строк лога ==="
        tail -n 5 "$LOG_FILE"
    else
        echo "⚠️  Лог-файлы не найдены"
    fi
    
    show_db_data
    
else
    echo "❌ tinkoff_invest_daemon.py НЕ запущен"
    read -p "❓ Запустить демон в фоне? (y/n): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        start_daemon
    else
        echo "⏹️  Запуск отменён"
    fi
fi