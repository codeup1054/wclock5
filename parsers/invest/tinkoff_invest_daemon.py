# parsers/invest/tinkoff_invest_daemon.py

import os
import sys
import time
import json
import sqlite3
import http.client
import traceback
from datetime import datetime, timezone
import signal
from pathlib import Path
from dotenv import load_dotenv

# Загружаем .env из корневой директории проекта
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
dotenv_path = PROJECT_ROOT / ".env"

if dotenv_path.exists():
    load_dotenv(dotenv_path, override=True)
    print(f"✅ Переменные окружения загружены из: {dotenv_path}", flush=True)
else:
    print(f"⚠️  Файл .env не найден: {dotenv_path}", flush=True)



# === Конфигурация ===
ACCOUNT_ID = os.environ.get("ACCOUNT_ID", "").strip()
API_TOKEN = os.environ.get("API_TOKEN", "").strip()
UPDATE_INTERVAL_SEC = int(os.environ.get("UPDATE_INTERVAL_SEC", 60))

print("✅ Демон запущен. Python версия:", sys.version, flush=True)
print("📁 Текущая директория:", __file__, flush=True)
print(f"⏱️ Период обновления данных: {UPDATE_INTERVAL_SEC} секунд", flush=True)

if not ACCOUNT_ID or not API_TOKEN:
    print("❌ Ошибка: ACCOUNT_ID и API_TOKEN должны быть заданы в переменных окружения!", flush=True)
    sys.exit(1)

# === Путь к БД — рядом с этим файлом ===
DB_PATH = os.path.join(os.path.dirname(__file__), "invest_portfolio.db")

# === Флаг завершения ===
shutdown = False

def signal_handler(sig, frame):
    global shutdown
    print("\n🛑 Получен сигнал завершения. Завершаем работу...", flush=True)
    shutdown = True

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# --- Инициализация БД (локальная) ---
def init_db():
    """Создаёт таблицы, если их нет."""
    db_dir = os.path.dirname(DB_PATH)
    os.makedirs(db_dir, exist_ok=True)  
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            total_value REAL NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            instrument_type TEXT,
            name TEXT,
            ticker TEXT,
            quantity REAL,
            price REAL,
            value REAL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')

    # Настройки по умолчанию
    default_interval = UPDATE_INTERVAL_SEC
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", 
                   ("INVEST_UPDATE_INTERVAL", str(default_interval)))

    conn.commit()
    conn.close()
    print(f"✅ База данных инициализирована: {DB_PATH}", flush=True)

# --- Вспомогательная функция: преобразование денежного объекта ---
def money_to_float(m):
    if not m:
        return 0.0
    return int(m.get("units", 0)) + int(m.get("nano", 0)) / 1e9

# --- Чтение интервала из БД ---
def get_invest_interval():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'INVEST_UPDATE_INTERVAL'")
    row = cursor.fetchone()
    conn.close()
    if row:
        try:
            interval = max(60, int(row[0]))  # минимум 60 сек (1 минута)
            return interval
        except (ValueError, TypeError):
            pass
    return 60  # 5 минут по умолчанию

# --- Получение портфеля с Tinkoff Invest API ---
def fetch_portfolio():
    import ssl
    context = ssl.create_default_context()
    # ⚠️ Отключение проверки SSL — только для отладки! В продакшене лучше использовать корректный сертификат.
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    conn = http.client.HTTPSConnection("invest-public-api.tbank.ru", timeout=15, context=context)

    payload = json.dumps({
        "accountId": ACCOUNT_ID,
        "currency": "RUB"
    })
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {API_TOKEN}"
    }

    try:
        conn.request(
            "POST",
            "/rest/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio",
            payload,
            headers
        )
        res = conn.getresponse()
        if res.status != 200:
            error_body = res.read().decode('utf-8')
            raise Exception(f"HTTP {res.status}: {error_body}")
        data = json.loads(res.read().decode("utf-8"))
        return data
    finally:
        conn.close()

# --- Сохранение в SQLite ---
def save_to_sqlite(positions):
    total_value = 0.0
    timestamp = datetime.now(timezone.utc).isoformat()

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Удаляем данные старше 30 дней
    cursor.execute("DELETE FROM portfolio_history WHERE timestamp < datetime('now', '-30 days')")
    cursor.execute("DELETE FROM portfolio_positions WHERE timestamp < datetime('now', '-30 days')")

    for p in positions:
        qty = money_to_float(p.get("quantity"))
        price = money_to_float(p.get("currentPrice"))
        value = qty * price
        total_value += value

        if value > 0:
            cursor.execute('''
                INSERT INTO portfolio_positions (
                    timestamp, instrument_type, name, ticker, quantity, price, value
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (
                timestamp,
                p.get("instrumentType"),
                p.get("name") or "",
                p.get("ticker") or "",
                qty,
                price,
                value
            ))

    cursor.execute('''
        INSERT INTO portfolio_history (timestamp, total_value)
        VALUES (?, ?)
    ''', (timestamp, total_value))

    conn.commit()
    conn.close()
    return total_value

# --- Генерация данных для графика ---
def generate_chart_data():
    """Генерирует готовые данные для графика и сохраняет в JS файл"""
    static_dir = PROJECT_ROOT / "static" / "js"
    output_file = static_dir / "invest_chart_data.js"
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Получаем данные для разных интервалов
    periods = {
        'minute': '-2 day',
        'hour': '-14 day', 
        'day': '-56 day'
    }
    
    chart_data = {}
    
    for interval, period in periods.items():
        # История портфеля
        cur.execute(f"""
            SELECT timestamp, total_value 
            FROM portfolio_history 
            WHERE timestamp >= datetime('now', '{period}')
            ORDER BY timestamp ASC
        """)
        history_rows = cur.fetchall()
        
        # Агрегация по интервалу
        aggregated = []
        for row in history_rows:
            ts = row['timestamp']
            val = row['total_value']
            aggregated.append({
                'timestamp': ts,
                'value': round(val, 2)
            })
        
        chart_data[interval] = aggregated
    
    conn.close()
    
    # Формируем JS файл
    js_content = f"""// Auto-generated chart data - {datetime.now().isoformat()}
// Do not edit manually

window.investChartData = {json.dumps(chart_data, indent=2, ensure_ascii=False)};
"""
    
    # Записываем в файл
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(js_content)
    
    print(f"📊 Данные для графика сохранены в: {output_file}", flush=True)

# --- Основной цикл ---
def main():
    print("🔄 Запуск демона Tinkoff Invest", flush=True)
    print(f"🗃️  База данных: {DB_PATH}", flush=True)
    print(f"🆔 Account ID: {ACCOUNT_ID[:4]}... (токен длиной {len(API_TOKEN)} символов)", flush=True)
    print("-" * 60, flush=True)

    # Инициализация БД
    init_db()

    while not shutdown:
        try:
            interval = get_invest_interval()
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] 🔄 Начало цикла обновления портфеля...", flush=True)

            data = fetch_portfolio()
            positions = data.get("positions", [])
            total = save_to_sqlite(positions)

            # Генерируем данные для графика
            generate_chart_data()

            print(f"[{now_str}] ✅ Успешно сохранено {len(positions)} позиций. Общая стоимость: {total:,.2f} RUB", flush=True)

        except Exception as e:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] ❌ КРИТИЧЕСКАЯ ОШИБКА: {e}", flush=True)
            print("Подробности:", flush=True)
            traceback.print_exc()
            print("-" * 60, flush=True)

        if shutdown:
            break

        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ⏳ Ожидание {interval} секунд до следующего запроса...", flush=True)
        
        # Постепенный sleep с проверкой shutdown каждую секунду
        for _ in range(interval):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Демон Tinkoff Invest корректно завершил работу.", flush=True)

if __name__ == "__main__":
    main()