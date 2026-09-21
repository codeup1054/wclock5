# parsers/invest/finam_invest_daemon.py
# Демон портфеля Finam Trade API → общая БД invest_portfolio.db (источник 'finam').

import os
import sys
import time
import json
import re
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
QUOTE_DB_PATH = os.path.join(os.path.dirname(__file__), "tracked_tickers.db")

# === Spike-фильтр цен позиций Finam ===
# Защита от разовых аномалий цены из API брокера (напр. TGLD 15.26 при отсутствии
# торгов). Если цена одного тикера за один тик ушла больше SPIKE_PCT% и при этом
# противоречит котировочному источнику (tracked_tickers.last_prices) — считаем цену
# спайком, заменяем на предыдущую и регистрируем событие в bot_events (API Finam).
SPIKE_PCT = 2.0
_prev_price = {}          # ticker -> last approved price
_spike_logged = {}        # ticker -> epoch (мин) последнего лога, для дедупликации


def _quote_price(ticker):
    """Последняя котировка тикера из tracked_tickers.db (last_prices). Возвращает
    цену или None. Тикер Finam (TGLD@@RUSX) нормализуется до котировочного (TGLD@)."""
    q = _normalize_symbol(ticker)
    conn = sqlite3.connect(QUOTE_DB_PATH, timeout=10)
    try:
        row = conn.execute(
            "SELECT price FROM last_prices WHERE ticker=? ORDER BY ts_epoch DESC LIMIT 1",
            (q,)).fetchone()
        if row and row[0]:
            return float(row[0])
        # фолбэк по figi, если тикер в котировках пустой ('')
        row = conn.execute(
            "SELECT price FROM last_prices WHERE figi=? AND ticker!='' ORDER BY ts_epoch DESC LIMIT 1",
            (q,)).fetchone()
        return float(row[0]) if row and row[0] else None
    except Exception:
        return None
    finally:
        conn.close()


def _normalize_symbol(s):
    """Финансовый символ Finam (напр. 'TGLD@@RUSX', 'LQDT@RUSX') → котировочный
    тикер (напр. 'TGLD@'): убираем суффикс рынка и сжимаем серию '@'."""
    if not s:
        return s
    t = re.sub(r"RUSX$", "", s)
    t = re.sub(r"@+", "@", t)
    return t


def _log_spike(ticker, old_price, new_price, quote_price):
    """Записать событие-аномалию в bot_events (источник API Finam)."""
    now = time.time()
    conn = sqlite3.connect(DB_PATH, timeout=30)
    try:
        text = (f"[spike] {ticker}: цена позиции скачком {old_price} → {new_price} "
                f"({abs(new_price - old_price) / old_price * 100 if old_price else 0:.2f}%), "
                f"котировка {quote_price}. Торгов нет — цена заменена на предыдущую. Источник: API Finam")
        conn.execute(
            "INSERT INTO bot_events (msg_id, chat, ts_epoch, update_type, text, raw)"
            " VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(chat, msg_id) DO UPDATE SET"
            " ts_epoch=excluded.ts_epoch, text=excluded.text, raw=excluded.raw",
            (-int(now // 60), "API Finam", int(now), "spike", text[:4000], text[:4000]))
        conn.commit()
    finally:
        conn.close()


def filter_position_price_spikes(positions):
    """Заменить аномальную цену позиции на предыдущую, если скачок > SPIKE_PCT%
    И противоречит котировочному источнику. Возвращает исправленный список."""
    out = []
    for p in positions:
        ticker = p.get("ticker") or p.get("name")
        is_currency = (p.get("instrument_type") == "Currency")
        new_p = float(p["price"] or 0)
        if is_currency or new_p <= 0 or not ticker:
            # Валюту/кэш и невалидные цены не фильтруем
            _prev_price[ticker] = new_p if new_p > 0 else _prev_price.get(ticker)
            out.append(p)
            continue

        prev_p = _prev_price.get(ticker)
        quote_p = _quote_price(ticker)

        ref_p = prev_p if (prev_p and prev_p > 0) else quote_p
        if ref_p and ref_p > 0 and new_p != ref_p:
            pct = abs(new_p - ref_p) / ref_p * 100
            contradicts = (quote_p and quote_p > 0
                           and abs(new_p - quote_p) / quote_p * 100 > SPIKE_PCT)
            if pct > SPIKE_PCT and contradicts:
                if _spike_logged.get(ticker) != int(time.time() // 60):
                    _spike_logged[ticker] = int(time.time() // 60)
                    _log_spike(ticker, ref_p, new_p, quote_p)
                print(f"⚠️ [spike] {ticker}: цена {new_p} заменена на {ref_p} "
                      f"(котировка {quote_p}, отклонение {pct:.2f}%)", flush=True)
                # Заменяем только цену и value, остальное без изменений
                p["price"] = ref_p
                p["value"] = float(p["quantity"]) * ref_p
                out.append(p)
                _prev_price[ticker] = ref_p
                continue

        _prev_price[ticker] = new_p
        out.append(p)
    return out

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

    # Кэш: денежные средства по валютам — СУММИРУЕМ все записи (свободные +
    # «Ожидания по сделкам»). Итог может быть отрицательным (списанная комиссия,
    # долг) — такой кэш тоже сохраняем, иначе total завышается относительно equity.
    cash_by_currency = {}
    for c in data.get("cash") or []:
        currency = c.get("currency_code") or "RUB"
        amount = _money(c)
        if amount != 0:
            cash_by_currency[currency] = cash_by_currency.get(currency, 0) + amount

    for currency, amount in cash_by_currency.items():
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

MIN_POSITIONS = 0  # барьер отключён: пишем снепшоты при любом количестве позиций

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
    """Раз в ~2 минуты: подтянуть новые сделки в БД. При 5xx/таймауте API — ретрай
    с короткими паузами, затем тихий выход до следующего цикла."""
    try:
        trades = fetch_trades(days=3)
    except Exception as e:
        # Транзиентные 5xx/таймауты API Finam: ретрай через 5 и 30 сек
        time.sleep(5)
        try:
            trades = fetch_trades(days=3)
        except Exception as e2:
            print(f"⚠️ finam sync_trades (retry): {e2}", flush=True)
            time.sleep(30)
            try:
                trades = fetch_trades(days=3)
            except Exception as e3:
                print(f"⚠️ finam sync_trades: {e3}", flush=True)
                return
    try:
        added = upsert_trades(map_trades(trades))
        if added:
            print(f"💰 Новых сделок Finam: {added}", flush=True)
    except Exception as e:
        print(f"⚠️ finam sync_trades (upsert): {e}", flush=True)


def finam_collection_enabled():
    """Сбор данных через Finam API включён? (настройка хранится в инвест-БД)."""
    try:
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.execute("PRAGMA busy_timeout = 5000")
        try:
            row = conn.execute("SELECT value FROM settings WHERE key = 'invest_collection_finam_enabled'").fetchone()
            return row[0] != "0" if row else True
        finally:
            conn.close()
    except Exception:
        return True


def main():
    print("🔄 Запуск демона Finam Invest", flush=True)
    print(f"🗃️  База данных: {DB_PATH}", flush=True)
    print(f"🆔 Account ID: {FINAM_ACCOUNT_ID} (секрет длиной {len(FINAM_SECRET)} символов)", flush=True)
    print("-" * 60, flush=True)

    init_db()

    last_trades_sync = 0
    verbose = True
    while not shutdown:
        now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        # Сбор данных можно отключить из UI (настройка живёт в инвест-БД).
        if not finam_collection_enabled():
            if verbose:
                print(f"[{now_str}] ⏸️ Сбор данных через Finam API отключён — цикл пропущен", flush=True)
        else:
            try:
                if verbose:
                    print(f"[{now_str}] 🔄 Начало цикла обновления портфеля Finam...", flush=True)

                data = fetch_portfolio()
                positions = map_positions(data)
                positions = filter_position_price_spikes(positions)
                total = save_to_sqlite(positions)

                if total is None:
                    print(f"[{now_str}] ⏭️ Снепшот пропущен (неполные данные)", flush=True)
                elif verbose:
                    print(f"[{now_str}] ✅ Успешно сохранено {len(positions)} позиций. Общая стоимость: {total:,.2f} RUB", flush=True)

                # Агрегация старых данных выполняется только в tinkoff-демоне,
                # чтобы избежать гонки двух write-транзакций за одну SQLite-БД.
                # (В этой БД retention делает tinkoff_invest_daemon.py)

                # Сделки/оборот: не чаще раза в 2 мин (time-based, чтобы при
                # 1с-цикле пика не дёргать API брокера каждые ~12 итераций)
                if time.time() - last_trades_sync >= 120:
                    last_trades_sync = time.time()
                    sync_trades()

            except Exception as e:
                now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                print(f"[{now_str}] ❌ КРИТИЧЕСКАЯ ОШИБКА: {e}", flush=True)
                print("Подробности:", flush=True)
                traceback.print_exc()
                print("-" * 60, flush=True)

        if shutdown:
            break

        # Адаптивный интервал: пик 10:00–19:00 МСК — 1с, вне пика — 60с.
        # Рутинные принты при 1с-кадденции душили бы логи — печатаем их вне пика.
        interval = current_interval(base=UPDATE_INTERVAL_SEC)
        verbose = interval >= 10
        if verbose:
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ⏳ Ожидание {interval} секунд до следующего запроса...", flush=True)

        for _ in range(interval):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Демон Finam Invest корректно завершил работу.", flush=True)

if __name__ == "__main__":
    main()
