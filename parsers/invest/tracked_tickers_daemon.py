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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import invest_repo as repo
try:
    import fx_candles
except Exception:
    fx_candles = None

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
    "FUTGOLD03260",   # GDH6
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
    
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
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
    conn = sqlite3.connect(DB_PATH, timeout=10)
    cursor = conn.cursor()
    
    stats = {}
    for figi in TRACKED_FIGI + ["XAU_USD", "USD_RUB", "BRENT"]:
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

# --- Получение XAU/USD: candles.db (история) + yfinance (обновления) ---
CANDLES_DB_PATH = os.path.join(os.path.dirname(__file__), "candles.db")

def _read_xau_from_candles_db():
    """Прочитать последнюю XAU цену из candles.db."""
    if not os.path.exists(CANDLES_DB_PATH):
        return None, None
    try:
        conn = sqlite3.connect(CANDLES_DB_PATH)
        cur = conn.cursor()
        cur.execute("""
            SELECT time_utc, close FROM candles
            WHERE instrument='XAU' AND interval='1h'
            ORDER BY time_utc DESC LIMIT 1
        """)
        row = cur.fetchone()
        conn.close()
        if row:
            return row[0], float(row[1])
    except Exception:
        pass
    return None, None

def _save_xau_to_candles_db(time_utc, close):
    """Добавить XAU свечу в candles.db (INSERT OR IGNORE)."""
    if not os.path.exists(CANDLES_DB_PATH):
        return
    try:
        conn = sqlite3.connect(CANDLES_DB_PATH)
        conn.execute("""
            INSERT OR IGNORE INTO candles (instrument, time_utc, open, high, low, close, volume, interval, source)
            VALUES ('XAU', ?, ?, ?, ?, ?, 0, '1h', 'yfinance')
        """, (time_utc, close, close, close, close))
        conn.commit()
        conn.close()
    except Exception:
        pass

def _fetch_xau_from_yfinance():
    """Получить свежую цену XAU/USD через yfinance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("GC=F")
        data = ticker.history(period="1d", interval="1m")
        if data.empty:
            return None, None
        price = float(data["Close"].iloc[-1])
        from datetime import datetime, timezone
        now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
        return now_utc, price
    except Exception as e:
        print(f"  ⚠️ yfinance: {e}", flush=True)
        return None, None

def _fetch_xau_from_yahoo_api():
    """Свежая цена XAU/USD (GC=F) через Yahoo Chart API — без yfinance.

    yfinance в образе может отсутствовать, а сам эндпоинт доступен обычным
    HTTP-запросом. Возвращает (iso_utc, price) либо (None, None).
    """
    import urllib.parse
    import urllib.request
    try:
        url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
               + urllib.parse.quote("GC=F") + "?interval=5m&range=1d")
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
        result = (data.get("chart") or {}).get("result") or []
        if not result:
            return None, None
        res = result[0]
        stamps = res.get("timestamp") or []
        closes = ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
        for ts, close in reversed(list(zip(stamps, closes))):
            if close and close > 0:
                dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
                return dt.strftime("%Y-%m-%dT%H:%M:%SZ"), float(close)
        return None, None
    except Exception as e:
        print(f"  ⚠️ yahoo api: {e}", flush=True)
        return None, None


def fetch_xau_price():
    """Получить XAU/USD: yfinance → Yahoo API → candles.db (история)."""
    now_utc = None
    yf_price = None

    # 1) Попробовать yfinance (свежая цена)
    now_utc, yf_price = _fetch_xau_from_yfinance()

    # 1b) Фолбэк без зависимости: тот же источник через HTTP
    if yf_price is None:
        now_utc, yf_price = _fetch_xau_from_yahoo_api()
        if yf_price is not None:
            print(f"  📈 XAU yahoo: ${yf_price:.2f}", flush=True)
            _save_xau_to_candles_db(now_utc, yf_price)
    if yf_price is not None:
        print(f"  📈 XAU: ${yf_price:.2f}", flush=True)
        _save_xau_to_candles_db(now_utc, yf_price)

    # 2) Если yfinance не сработал — взять из candles.db
    if yf_price is None:
        db_time, db_price = _read_xau_from_candles_db()
        if db_price is not None:
            print(f"  📊 XAU candles.db: ${db_price:.2f} ({db_time})", flush=True)
            return {
                "figi": "XAU_USD",
                "ticker": "XAU/USD",
                "class_code": "candles_db",
                "price": round(db_price, 2),
            }
        return None

    return {
        "figi": "XAU_USD",
        "ticker": "XAU/USD",
        "class_code": "yfinance",
        "price": round(yf_price, 2),
    }

# --- Получение внешних котировок (USD/RUB, Brent) через T-Invest GetLastPrices ---
USD_FIGI = "BBG0013HGFT4"     # USD000UTSTOM (MOEX, CETS)
BRENT_FIGI = "FBR112600000"   # BR-11.26 Нефть Brent (MOEX, SPBFUT)

def fetch_last_price_value(figi):
    """Последняя цена по FIGI через MarketDataService/GetLastPrices (float или None)."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection("invest-public-api.tbank.ru", timeout=15, context=context)
    try:
        payload = json.dumps({"figi": [figi]})
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_TOKEN}",
        }
        conn.request("POST", "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices", payload, headers)
        res = conn.getresponse()
        if res.status != 200:
            raise Exception(f"HTTP {res.status}: {res.read().decode()[:150]}")
        data = json.loads(res.read().decode())
        lp = data.get("lastPrices") or []
        if not lp:
            return None
        price = price_to_float(lp[0].get("price"))
        return price if price > 0 else None
    finally:
        conn.close()

def fetch_usd_price():
    """Текущий курс USD/RUB."""
    price = fetch_last_price_value(USD_FIGI)
    if price is None:
        return None
    return {"figi": "USD_RUB", "ticker": "USD/RUB", "class_code": "tinkoff", "price": round(price, 4)}

def fetch_brent_price():
    """Текущая цена нефти Brent (BR-11.26)."""
    price = fetch_last_price_value(BRENT_FIGI)
    if price is None:
        return None
    return {"figi": "BRENT", "ticker": "Brent", "class_code": "tinkoff", "price": round(price, 2)}

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
    saved = 0
    for item in last_prices:
        figi = item["figi"]
        ticker = item.get("ticker", "")
        class_code = item.get("classCode", "")
        price = price_to_float(item.get("price"))
        repo.write_price(figi, ticker, class_code, price, db_path=DB_PATH)
        saved += 1
        # Дублируем USD/RUB в fx_rates для детализации как портфель
        if ticker == "USD/RUB" or figi == "USD_RUB":
            try:
                ts = int(time.time())
                repo.upsert_fx_rate(ts, pair="USD/RUB", close=round(price, 4), source="tinkoff", db_path=os.path.join(os.path.dirname(__file__), "invest_portfolio.db"))
            except Exception:
                pass
    repo.apply_ticker_retention(days=200, db_path=DB_PATH)
    return saved

# --- Сохранение XAU в БД ---
def save_xau_price(item):
    """Сохранить одну запись XAU (уже float цена)."""
    if not item:
        return 0
    repo.write_price(item["figi"], item["ticker"], item["class_code"], round(item["price"], 2), db_path=DB_PATH)
    repo.apply_ticker_retention(days=200, db_path=DB_PATH)
    return 1

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

            # XAU/USD через yfinance
            xau = fetch_xau_price()
            if xau:
                saved += save_xau_price(xau)

            # USD/RUB через T-Invest (GetLastPrices + свечи)
            try:
                usd = fetch_usd_price()
                if usd:
                    saved += save_xau_price(usd)
                    print(f"  💵 USD/RUB: {usd['price']:.2f}", flush=True)
                    try:
                        ts = int(time.time())
                        repo.upsert_fx_rate(ts, pair="USD/RUB", close=round(usd['price'], 4), source="tinkoff", db_path=os.path.join(os.path.dirname(__file__), "invest_portfolio.db"))
                    except Exception:
                        pass
                try:
                    if fx_candles:
                        fx_candles.update_once(minutes=120, interval_key="1min")
                except Exception:
                    pass
            except Exception as e:
                print(f"  ⚠️ USD/RUB: {e}", flush=True)

            # Brent через T-Invest (GetLastPrices)
            try:
                brent = fetch_brent_price()
                if brent:
                    saved += save_xau_price(brent)
                    print(f"  🛢️ Brent: {brent['price']:.2f}", flush=True)
            except Exception as e:
                print(f"  ⚠️ Brent: {e}", flush=True)

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
    