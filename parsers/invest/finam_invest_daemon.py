# parsers/invest/finam_invest_daemon.py
# Демон портфеля Finam Trade API → общая БД invest_portfolio.db (источник 'finam').

import os
import sys
import time
import json
import sqlite3
import traceback
from datetime import datetime, timezone
import signal
from pathlib import Path
import requests
from dotenv import load_dotenv
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from invest_db import aggregate_old_data

# UTF-8 для вывода в консоль (Windows cp1251 не кодирует эмодзи)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# === Загрузка .env ===
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
dotenv_path = PROJECT_ROOT / ".env"

if dotenv_path.exists():
    load_dotenv(dotenv_path, override=True)
    print(f"✅ Переменные окружения загружены из: {dotenv_path}", flush=True)
else:
    print(f"⚠️  Файл .env не найден: {dotenv_path}", flush=True)

# === Конфигурация ===
FINAM_SECRET = os.environ.get("FINAM_SECRET", "").strip()
FINAM_ACCOUNT_ID = os.environ.get("FINAM_ACCOUNT_ID", "").strip()
UPDATE_INTERVAL_SEC = int(os.environ.get("FINAM_UPDATE_INTERVAL_SEC", "60"))

FINAM_API_BASE = "https://api.finam.ru"
SOURCE = "finam"
JWT_TTL_SEC = 10 * 60  # JWT живёт 15 мин, обновляем раньше

print("✅ Демон Finam запущен. Python версия:", sys.version, flush=True)
print(f"📁 Текущая директория: {__file__}", flush=True)
print(f"⏱️ Период обновления данных: {UPDATE_INTERVAL_SEC} секунд", flush=True)

if not FINAM_SECRET or not FINAM_ACCOUNT_ID:
    print("❌ Ошибка: FINAM_SECRET и FINAM_ACCOUNT_ID должны быть заданы в переменных окружения!", flush=True)
    sys.exit(1)

# === Путь к БД — рядом с этим файлом ===
DB_PATH = os.path.join(os.path.dirname(__file__), "invest_portfolio.db")

# === Кэш JWT ===
_jwt = None
_jwt_obtained_at = 0.0

def _get_jwt(force=False):
    """Получить JWT: POST /v1/sessions {'secret': ...}. Кэшируем до истечения."""
    global _jwt, _jwt_obtained_at
    now = time.time()
    if not force and _jwt and (now - _jwt_obtained_at) < JWT_TTL_SEC:
        return _jwt
    resp = requests.post(
        f"{FINAM_API_BASE}/v1/sessions",
        json={"secret": FINAM_SECRET},
        timeout=15,
    )
    resp.raise_for_status()
    _jwt = resp.json().get("token", "")
    _jwt_obtained_at = time.time()
    if not _jwt:
        raise RuntimeError("Finam Auth: пустой token в ответе /v1/sessions")
    return _jwt

# === Флаг завершения ===
shutdown = False

def signal_handler(sig, frame):
    global shutdown
    print("\n🛑 Получен сигнал завершения. Завершаем работу...", flush=True)
    shutdown = True

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# --- Инициализация БД ---
def init_db():
    """Создаёт таблицы, если их нет (общая схема с tinkoff_invest_daemon.py)."""
    db_dir = os.path.dirname(DB_PATH)
    os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000")
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            total_value REAL NOT NULL,
            source TEXT DEFAULT 'tinkoff'
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
            value REAL,
            source TEXT DEFAULT 'tinkoff'
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_hourly (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL UNIQUE,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER DEFAULT 0
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                   ("FINAM_UPDATE_INTERVAL", str(UPDATE_INTERVAL_SEC)))

    # Индексы
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_positions_timestamp ON portfolio_positions(timestamp)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_history_timestamp ON portfolio_history(timestamp)")

    # Миграция source на существующих БД (созданы старым демоном)
    for table in ("portfolio_positions", "portfolio_history"):
        cols = [r[1] for r in cursor.execute(f"PRAGMA table_info({table})").fetchall()]
        if "source" not in cols:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN source TEXT DEFAULT 'tinkoff'")

    conn.commit()
    conn.close()
    print(f"✅ База данных инициализирована: {DB_PATH}", flush=True)

# --- Вспомогательные функции ---
def _dec(s):
    """Decimal (строковый 'value') → float."""
    if s is None:
        return 0.0
    try:
        return float(str(s))
    except (TypeError, ValueError):
        return 0.0

def _money(m):
    """Money {currency_code, units, nanos} → float."""
    if not m:
        return 0.0
    return _dec(m.get("units", 0)) + _dec(m.get("nanos", 0)) / 1e9

# --- Получение портфеля с Finam Trade API ---
def fetch_portfolio():
    """GET /v1/accounts/{account_id} с Bearer JWT. При 401 — обновляем токен один раз."""
    headers = {"Authorization": f"Bearer {_get_jwt()}"}
    url = f"{FINAM_API_BASE}/v1/accounts/{FINAM_ACCOUNT_ID}"

    resp = requests.get(url, headers=headers, timeout=15)
    if resp.status_code == 401:
        # Токен протух → обновляем и повторяем
        headers = {"Authorization": f"Bearer {_get_jwt(force=True)}"}
        resp = requests.get(url, headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()

# --- Преобразование в позиции ---
def map_positions(data):
    """Позиции Finam + кэш (cash) → список словарей для portfolio_positions."""
    positions = []

    for p in data.get("positions") or []:
        symbol = p.get("symbol") or ""
        if not symbol:
            continue
        qty = _dec(p.get("quantity", {}).get("value"))
        price = _dec(p.get("current_price", {}).get("value"))
        value = qty * price
        if value <= 0:
            continue
        positions.append({
            "instrument_type": "Finam",
            "name": symbol,
            "ticker": symbol,
            "quantity": qty,
            "price": price,
            "value": value,
        })

    # Кэш: денежные средства по валютам — СУММИРУЕМ все записи (свободные + «Ожидания по сделкам»).
    # Без этого портфель задваивается: покупка по о/р уже учтена в positions, а отрицательный кэш её снимает.
    cash_by_currency = {}
    for c in data.get("cash") or []:
        currency = c.get("currency_code") or "RUB"
        amount = _money(c)
        if amount != 0:
            cash_by_currency[currency] = cash_by_currency.get(currency, 0) + amount

    for currency, amount in cash_by_currency.items():
        if amount <= 0:
            continue
        if currency.upper() == "RUB":
            positions.append({
                "instrument_type": "Currency",
                "name": "Рубль",
                "ticker": "RUB",
                "quantity": amount,
                "price": 1.0,
                "value": amount,
            })

    return positions

MIN_POSITIONS = 1  # для Finam всегда есть кэш (RUB) + позиции

# --- Сохранение в SQLite ---
def save_to_sqlite(positions):
    if len(positions) < MIN_POSITIONS:
        print(f"⚠️ Пропущен снепшот: только {len(positions)} позиций (нужно {MIN_POSITIONS})", flush=True)
        return None

    total_value = sum(p["value"] for p in positions)
    timestamp = datetime.now(timezone.utc).isoformat()

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000")
    cursor = conn.cursor()

    cursor.execute("DELETE FROM portfolio_history WHERE timestamp < datetime('now', '-120 days')")
    cursor.execute("DELETE FROM portfolio_positions WHERE timestamp < datetime('now', '-120 days')")

    for p in positions:
        cursor.execute('''
            INSERT INTO portfolio_positions (
                timestamp, instrument_type, name, ticker, quantity, price, value, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            timestamp,
            p["instrument_type"],
            p["name"],
            p["ticker"],
            p["quantity"],
            p["price"],
            p["value"],
            SOURCE,
        ))

    cursor.execute('''
        INSERT INTO portfolio_history (timestamp, total_value, source)
        VALUES (?, ?, ?)
    ''', (timestamp, round(total_value, 2), SOURCE))

    conn.commit()
    conn.close()
    return total_value

# --- Основной цикл ---
def main():
    print("🔄 Запуск демона Finam Invest", flush=True)
    print(f"🗃️  База данных: {DB_PATH}", flush=True)
    print(f"🆔 Account ID: {FINAM_ACCOUNT_ID} (секрет длиной {len(FINAM_SECRET)} символов)", flush=True)
    print("-" * 60, flush=True)

    init_db()

    iteration = 0
    while not shutdown:
        iteration += 1
        try:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] 🔄 Начало цикла обновления портфеля Finam...", flush=True)

            data = fetch_portfolio()
            positions = map_positions(data)
            total = save_to_sqlite(positions)

            if total is None:
                print(f"[{now_str}] ⏭️ Снепшот пропущен (неполные данные)", flush=True)
            else:
                print(f"[{now_str}] ✅ Успешно сохранено {len(positions)} позиций. Общая стоимость: {total:,.2f} RUB", flush=True)

            # Агрегация старых данных: каждый 10-й цикл (~каждые 10 мин)
            if iteration % 10 == 0:
                aggregate_old_data()

        except Exception as e:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] ❌ КРИТИЧЕСКАЯ ОШИБКА: {e}", flush=True)
            print("Подробности:", flush=True)
            traceback.print_exc()
            print("-" * 60, flush=True)

        if shutdown:
            break

        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ⏳ Ожидание {UPDATE_INTERVAL_SEC} секунд до следующего запроса...", flush=True)

        for _ in range(UPDATE_INTERVAL_SEC):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Демон Finam Invest корректно завершил работу.", flush=True)

if __name__ == "__main__":
    main()
