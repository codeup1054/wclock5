# parsers/invest/finam_invest_daemon.py
# Демон портфеля Finam Trade API → общая БД invest_portfolio.db (источник 'finam').

import os
import sys
import time
import json
import sqlite3
import traceback
from datetime import datetime, timedelta, timezone
import signal
from pathlib import Path
import requests
from dotenv import load_dotenv
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from invest_db import init_invest_db
from invest_repo import Snapshot, Position, write_snapshot, apply_retention, current_interval, init_trades_tables, upsert_trades, guess_exchange

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

# --- Инициализация БД — через mediation-слой (invest_repo) ---
def init_db():
    init_invest_db()
    init_trades_tables()
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

# --- Сохранение через mediation-слой ---
def save_to_sqlite(positions):
    if len(positions) < MIN_POSITIONS:
        print(f"⚠️ Пропущен снепшот: только {len(positions)} позиций (нужно {MIN_POSITIONS})", flush=True)
        return None

    snap_positions = [
        Position(
            instrument_type=p["instrument_type"],
            name=p["name"],
            ticker=p["ticker"],
            quantity=float(p["quantity"]),
            price=float(p["price"]),
            value=float(p["value"]),
            source=SOURCE,
        )
        for p in positions
    ]
    snap = Snapshot(source=SOURCE, positions=snap_positions)
    return write_snapshot(snap)

# --- Основной цикл ---
# --- История сделок для оборотов ---
_trades_since_ts = None   # инкрементальный курсор синхронизации


def _trade_ts(t):
    """timestamp сделки: ISO-строка или proto {seconds, nanos} → epoch."""
    ts = t.get("timestamp")
    if isinstance(ts, dict):
        return int(ts.get("seconds") or 0)
    if isinstance(ts, str) and ts:
        try:
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
        except ValueError:
            return 0
    return 0


def _fetch_trades_chunk(headers, start, end):
    """Одно окно [start, end] → список сделок."""
    base = f"{FINAM_API_BASE}/v1/accounts/{FINAM_ACCOUNT_ID}/trades"
    params = {"limit": 500,
              "interval.start_time": start.strftime('%Y-%m-%dT%H:%M:%SZ'),
              "interval.end_time": end.strftime('%Y-%m-%dT%H:%M:%SZ')}
    resp = requests.get(base, headers=headers, params=params, timeout=15)
    if resp.status_code == 401:
        headers = {"Authorization": f"Bearer {_get_jwt(force=True)}"}
        resp = requests.get(base, headers=headers, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json().get("trades", [])


def fetch_trades(days=3):
    """История сделок с пагинацией: идём назад от 'now', при переполнении окна (500)
    отступаем к самой ранней сделке. Первый запуск — N дней, далее инкремент."""
    global _trades_since_ts
    now = datetime.now(timezone.utc)
    if _trades_since_ts:
        target = datetime.fromtimestamp(_trades_since_ts, tz=timezone.utc) - timedelta(minutes=5)
    else:
        target = now - timedelta(days=days)
    headers = {"Authorization": f"Bearer {_get_jwt()}"}
    end, out = now, []
    while end > target:
        start = max(target, end - timedelta(minutes=30))
        batch = _fetch_trades_chunk(headers, start, end)
        out.extend(batch)
        if len(batch) == 500:
            end = datetime.fromtimestamp(min(_trade_ts(t) for t in batch), tz=timezone.utc)
        else:
            end = start
    _trades_since_ts = now.timestamp()
    return out


def map_trades(trades):
    """Сделки Finam → формат invest_repo.upsert_trades. Комиссия считается оценкой на агрегате."""
    out = []
    for t in trades or []:
        ts = _trade_ts(t)
        if not ts:
            continue
        price = _dec((t.get("price") or {}).get("value"))
        size = _dec((t.get("size") or {}).get("value"))
        if price <= 0 or size <= 0:
            continue
        raw_side = t.get("side")
        if isinstance(raw_side, int):
            side = {1: "buy", 2: "sell"}.get(raw_side)
        else:
            side = {"SIDE_BUY": "buy", "SIDE_SELL": "sell",
                    "BUY": "buy", "SELL": "sell"}.get(str(raw_side).upper())
        if not side:
            continue
        symbol = t.get("symbol") or "?"
        out.append({
            "trade_id": t.get("trade_id") or f"{symbol}_{ts}_{side}_{price}_{size}",
            "source": "finam",
            "symbol": symbol,
            "side": side,
            "quantity": size,
            "price": price,
            "sum": price * size,
            "commission": 0.0,
            "exchange": guess_exchange(symbol),
            "ts_epoch": int(ts),
        })
    return out


def sync_trades():
    """Раз в ~2 минуты: подтянуть новые сделки в БД."""
    try:
        added = upsert_trades(map_trades(fetch_trades(days=3)))
        if added:
            print(f"💰 Новых сделок Finam: {added}", flush=True)
    except Exception as e:
        print(f"⚠️ finam sync_trades: {e}", flush=True)


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

            # Агрегация старых данных: каждый 10-й цикл
            if iteration % 10 == 0:
                apply_retention()

            # Сделки/оборот: каждый 12-й цикл (~2 мин)
            if iteration % 12 == 1:
                sync_trades()

        except Exception as e:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] ❌ КРИТИЧЕСКАЯ ОШИБКА: {e}", flush=True)
            print("Подробности:", flush=True)
            traceback.print_exc()
            print("-" * 60, flush=True)

        if shutdown:
            break

        # Адаптивный интервал: 10с днём (08:00–24:00 МСК), ночью — базовый из env
        interval = current_interval(base=UPDATE_INTERVAL_SEC)
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ⏳ Ожидание {interval} секунд до следующего запроса...", flush=True)

        for _ in range(interval):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Демон Finam Invest корректно завершил работу.", flush=True)

if __name__ == "__main__":
    main()
