# parsers/invest/tinkoff_invest_daemon.py

import os
import sys
import time
import json
import sqlite3
import http.client
import traceback
from datetime import datetime, timedelta, timezone
import signal
from pathlib import Path
from dotenv import load_dotenv
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from invest_db import init_invest_db
from invest_repo import Snapshot, Position, write_snapshot, apply_retention, current_interval, init_trades_tables, upsert_trades

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

# --- Инициализация БД — через mediation-слой (invest_repo) ---
def init_db():
    init_trades_tables()
    init_invest_db()
    print(f"✅ База данных инициализирована: {DB_PATH}", flush=True)

# --- Вспомогательная функция: преобразование денежного объекта ---
def money_to_float(m):
    if not m:
        return 0.0
    if isinstance(m, (int, float)):
        return float(m)
    if isinstance(m, str):
        try:
            return float(m)
        except ValueError:
            return 0.0
    return int(m.get("units", 0)) + int(m.get("nano", 0)) / 1e9

# --- Чтение интервала из БД ---
def get_invest_interval():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000")
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

MIN_POSITIONS = 2  # минимум позиций для сохранения (чтобы не писать неполные снепшоты)

# --- Сохранение через mediation-слой ---
def save_to_sqlite(positions):
    if len(positions) < MIN_POSITIONS:
        print(f"⚠️ Пропущен снепшот: только {len(positions)} позиций (нужно {MIN_POSITIONS})", flush=True)
        return None

    snap_positions = []
    for p in positions:
        qty = money_to_float(p.get("quantity"))
        price = money_to_float(p.get("currentPrice"))
        value = qty * price
        if value > 0:
            snap_positions.append(Position(
                instrument_type=p.get("instrumentType") or "",
                name=p.get("name") or "",
                ticker=p.get("ticker") or "",
                quantity=qty,
                price=price,
                value=value,
                source="tinkoff",
            ))

    snap = Snapshot(source="tinkoff", positions=snap_positions)
    return write_snapshot(snap)

# --- Основной цикл ---
# --- История операций (сделки) для оборотов ---
_ops_since_ts = None      # инкрементальный курсор синхронизации


def _fetch_ops_chunk(context, account_id, token, start, end):
    """Одно окно [start, end] → список операций."""
    conn = http.client.HTTPSConnection("invest-public-api.tbank.ru", timeout=20, context=context)
    payload = json.dumps({
        "accountId": account_id,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "state": "Executed",
    })
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }
    try:
        conn.request(
            "POST",
            "/rest/tinkoff.public.invest.api.contract.v1.OperationsService/GetOperations",
            payload, headers)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        if resp.status != 200:
            print(f"⚠️ GetOperations HTTP {resp.status}: {body[:200]}", flush=True)
            return []
        return json.loads(body).get("operations", [])
    finally:
        conn.close()


def fetch_operations(days=3):
    """История операций с пагинацией: идём назад от 'now' часовыми окнами,
    при лимите 1000 отступаем к самой ранней операции. Первый запуск — N дней."""
    global _ops_since_ts
    now = datetime.now(timezone.utc)
    if _ops_since_ts:
        frm = datetime.fromtimestamp(_ops_since_ts, tz=timezone.utc) - timedelta(minutes=5)
    else:
        frm = now - timedelta(days=days)

    import ssl
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    account_id = ACCOUNT_ID
    token = API_TOKEN

    end, out = now, []
    while end > frm:
        start = max(frm, end - timedelta(hours=1))
        ops = _fetch_ops_chunk(context, account_id, token, start, end)
        out.extend(ops)
        if len(ops) >= 1000:
            earliest = None
            for op in ops:
                ds = op.get("date") or op.get("date_time")
                if not ds:
                    continue
                try:
                    ts = datetime.fromisoformat(ds.replace("Z", "+00:00")).timestamp()
                except ValueError:
                    continue
                if earliest is None or ts < earliest:
                    earliest = ts
            if earliest is None:
                break
            end = datetime.fromtimestamp(earliest, tz=timezone.utc)
        else:
            end = start
    _ops_since_ts = now.timestamp()
    return out


def map_trades(operations):
    """Операции T-Invest → сделки для invest_repo.upsert_trades.
    BUY/SELL → сделки; BROKER_FEE → строка side='fee' с реальной комиссией."""
    trades = []
    for op in operations or []:
        if op.get("status") not in (None, "OPERATION_STATE_EXECUTED", "Executed"):
            continue
        op_type = (op.get("operationType") or "").upper().replace("OPERATION_TYPE_", "")
        payment = money_to_float(op.get("payment"))
        date_str = op.get("date") or op.get("date_time")
        if not date_str:
            continue
        try:
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue

        # Комиссия брокера: отдельная операция с отрицательным payment
        if op_type == "BROKER_FEE":
            if payment >= 0:
                continue
            fee = abs(payment)
            trades.append({
                "trade_id": op.get("id") or f"fee_{int(dt.timestamp())}_{fee}",
                "source": "tinkoff",
                "symbol": op.get("figi") or "?",
                "side": "fee",
                "quantity": 0,
                "price": 0,
                "sum": fee,
                "commission": fee,
                "ts_epoch": int(dt.timestamp()),
            })
            continue

        if op_type not in ("BUY", "SELL"):
            continue
        if payment <= 0:
            continue
        trades.append({
            "trade_id": op.get("id") or f"{op.get('figi')}_{int(dt.timestamp())}_{op_type}_{payment}",
            "source": "tinkoff",
            "symbol": op.get("figi") or op.get("instrument_uid") or "?",
            "side": "buy" if op_type == "BUY" else "sell",
            "quantity": money_to_float(op.get("quantity")),
            "price": money_to_float(op.get("price")),
            "sum": abs(payment),
            "commission": money_to_float(op.get("commission")),
            "ts_epoch": int(dt.timestamp()),
        })
    return trades


def sync_trades():
    """Раз в ~2 минуты: подтянуть сделки за 3 дня в БД."""
    try:
        ops = fetch_operations(days=3)
        added = upsert_trades(map_trades(ops))
        if added:
            print(f"💰 Новых сделок Tinkoff: {added}", flush=True)
    except Exception as e:
        print(f"⚠️ sync_trades: {e}", flush=True)


def main():
    print("🔄 Запуск демона Tinkoff Invest", flush=True)
    print(f"🗃️  База данных: {DB_PATH}", flush=True)
    print(f"🆔 Account ID: {ACCOUNT_ID[:4]}... (токен длиной {len(API_TOKEN)} символов)", flush=True)
    print("-" * 60, flush=True)

    # Инициализация БД
    init_db()

    iteration = 0
    while not shutdown:
        iteration += 1
        try:
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{now_str}] 🔄 Начало цикла обновления портфеля...", flush=True)

            data = fetch_portfolio()
            positions = data.get("positions", [])
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

        # Адаптивный интервал: 10с днём (08:00–24:00 МСК), ночью — базовый из настроек
        interval = current_interval(base=get_invest_interval())
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ⏳ Ожидание {interval} секунд до следующего запроса...", flush=True)
        
        # Постепенный sleep с проверкой shutdown каждую секунду
        for _ in range(interval):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Демон Tinkoff Invest корректно завершил работу.", flush=True)

if __name__ == "__main__":
    main()