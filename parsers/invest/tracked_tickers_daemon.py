#!/usr/bin/env python3
# parsers/invest/tracked_tickers_daemon.py
# Демон для получения последних цен по FIGI через GetLastPrices

import os
import sys
import time
import json
import sqlite3
import http.client
import traceback
from datetime import datetime, timezone
import signal
import ssl

# === Загрузка .env ===
PROJECT_ROOT = os.getcwd()
ENV_PATH = os.path.join(PROJECT_ROOT, ".env")

if os.path.exists(ENV_PATH):
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                os.environ.setdefault(key, value)
    print(f"✅ .env загружен: {ENV_PATH}", flush=True)
else:
    print(f"⚠️ .env не найден: {ENV_PATH}", flush=True)

API_TOKEN = os.environ.get("API_TOKEN", "").strip()
if not API_TOKEN:
    print("❌ API_TOKEN не задан!", flush=True)
    sys.exit(1)

# === Конфигурация ===
# Используем FIGI из вашего JSON
TRACKED_FIGI = [
    "TCS80A101X50",   # TGLD@
    "FUTGOLD03260"    # GDH6
]

UPDATE_INTERVAL_SEC = int(os.environ.get("TRACKED_UPDATE_INTERVAL_SEC", "60"))
DB_PATH = os.path.join(os.path.dirname(__file__), "tracked_tickers.db")
shutdown = False

def signal_handler(sig, frame):
    global shutdown
    print("\n🛑 Завершение работы...", flush=True)
    shutdown = True

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# --- Инициализация БД ---
def init_db():
    db_dir = os.path.dirname(DB_PATH)
    os.makedirs(db_dir, exist_ok=True)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS last_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            figi TEXT NOT NULL,
            ticker TEXT,
            class_code TEXT,
            price REAL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                   ("TRACKED_UPDATE_INTERVAL", str(UPDATE_INTERVAL_SEC)))
    conn.commit()
    conn.close()
    print(f"✅ БД инициализирована: {DB_PATH}", flush=True)

def get_db_stats():
    """Получить статистику по БД"""
    if not os.path.exists(DB_PATH):
        return {}
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    stats = {}
    for figi in TRACKED_FIGI:
        cursor.execute(
            "SELECT MIN(timestamp), MAX(timestamp), COUNT(*) FROM last_prices WHERE figi = ?",
            (figi,)
        )
        row = cursor.fetchone()
        stats[figi] = {
            'min_date': row[0][:10] if row[0] else None,
            'max_date': row[1][:10] if row[1] else None,
            'count': row[2]
        }
    
    conn.close()
    return stats

# --- Получение последних цен ---
def fetch_last_prices(figi_list):
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    conn = http.client.HTTPSConnection("invest-public-api.tbank.ru", timeout=15, context=context)

    payload = json.dumps({"figi": figi_list})
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_TOKEN}"
    }

    try:
        conn.request("POST", "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices", payload, headers)
        res = conn.getresponse()
        if res.status != 200:
            raise Exception(f"HTTP {res.status}: {res.read().decode()}")
        data = json.loads(res.read().decode())
        return data.get("lastPrices", [])
    finally:
        conn.close()

# --- Преобразование цены ---
def price_to_float(price_obj):
    if not price_obj:
        return 0.0
    return int(price_obj.get("units", 0)) + int(price_obj.get("nano", 0)) / 1e9

# --- Сохранение в БД ---
def save_prices(last_prices):
    timestamp = datetime.now(timezone.utc).isoformat()
    saved = 0

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("DELETE FROM last_prices WHERE timestamp < datetime('now', '-90 days')")

    for item in last_prices:
        figi = item["figi"]
        ticker = item.get("ticker", "")
        class_code = item.get("classCode", "")
        price = price_to_float(item.get("price"))

        cursor.execute('''
            INSERT INTO last_prices (timestamp, figi, ticker, class_code, price)
            VALUES (?, ?, ?, ?, ?)
        ''', (timestamp, figi, ticker, class_code, price))
        saved += 1

    conn.commit()
    conn.close()
    return saved

# --- Основной цикл ---
def main():
    print("✅ Демон последних цен запущен", flush=True)
    print(f"🔍 FIGI: {TRACKED_FIGI}", flush=True)
    print(f"⏱️ Интервал: {UPDATE_INTERVAL_SEC} сек", flush=True)
    print("-" * 50, flush=True)

    init_db()

    # Показать статистику БД
    if os.path.exists(DB_PATH):
        stats = get_db_stats()
        print("📊 База данных:", flush=True)
        for ticker, s in stats.items():
            print(f"  {ticker}: {s['count']} записей ({s['min_date']} - {s['max_date']})", flush=True)
        print("-" * 50, flush=True)

    while not shutdown:
        try:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] 🔄 Запрос последних цен...", flush=True)

            prices = fetch_last_prices(TRACKED_FIGI)
            saved = save_prices(prices)

            print(f"[{now_str}] ✅ Сохранено {saved} записей", flush=True)

        except Exception as e:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] ❌ ОШИБКА: {e}", flush=True)
            traceback.print_exc()

        if shutdown:
            break

        interval = UPDATE_INTERVAL_SEC
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ⏳ Ожидание {interval} сек...", flush=True)
        for _ in range(interval):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Демон завершил работу.", flush=True)

if __name__ == "__main__":
    main()
    