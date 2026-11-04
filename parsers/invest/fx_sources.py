#!/usr/bin/env python3
"""fx_sources.py — курсы USD/RUB из разных источников в fx_rates.

Источники:
  cbr    — ЦБ РФ (официальный, 1 точка в день, cbr-xml-daily.ru)
  yahoo  — FOREX-котировка RUB=X (часовые свечи, 24/5)
  tinkoff— биржевой USD000UTSTOM (пишет fx_candles.py; здесь только читается)

Пишет в invest_portfolio.db :: fx_rates (ts_epoch, pair, source, close).
Идемпотентно: повторная запись того же (ts_epoch, pair, source) обновляет close.

Запуск:
  python parsers/invest/fx_sources.py --days 3           # бэкфилл
  python parsers/invest/fx_sources.py                    # разовое обновление
"""
import argparse
import json
import sqlite3
import ssl
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "invest_portfolio.db"
PAIR = "USD/RUB"
CTX = ssl.create_default_context()


def _get_json(url, timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read().decode(errors="replace"))


def _ensure(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fx_rates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            ts_epoch INTEGER NOT NULL,
            pair TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'tinkoff',
            close REAL NOT NULL,
            bid REAL,
            ask REAL,
            fetched_ts INTEGER,
            UNIQUE(ts_epoch, pair, source)
        )
    """)
    # Время фактического скачивания (ts_epoch — время самих данных; у ЦБ оно
    # может быть в будущем: курс публикуется на 11:30 МСК).
    try:
        conn.execute("ALTER TABLE fx_rates ADD COLUMN fetched_ts INTEGER")
    except sqlite3.OperationalError:
        pass
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fx_rates_ts_pair ON fx_rates(ts_epoch, pair, source)")


def _upsert(conn, rows, source):
    _ensure(conn)
    cur = conn.cursor()
    n = 0
    for ts, close in rows:
        if not close or close <= 0:
            continue
        cur.execute("""
            INSERT INTO fx_rates (timestamp, ts_epoch, pair, source, close, fetched_ts)
            VALUES (datetime(?, 'unixepoch'), ?, ?, ?, ?, strftime('%s','now'))
            ON CONFLICT(ts_epoch, pair, source) DO UPDATE SET close = excluded.close
        """, (ts, ts, PAIR, source, round(float(close), 4)))
        n += 1
    conn.commit()
    return n


# --- ЦБ РФ: официальный курс, одна точка на день (11:30 MSK) --------------
def fetch_cbr(days=3):
    rows = []
    today = datetime.now(timezone.utc).date()
    for d in range(days + 1):
        day = today - timedelta(days=d)
        url = (f"https://www.cbr-xml-daily.ru/archive/"
               f"{day.year:04d}/{day.month:02d}/{day.day:02d}/daily_json.js")
        if d == 0:
            url = "https://www.cbr-xml-daily.ru/daily_json.js"
        try:
            data = _get_json(url)
            usd = (data.get("Valute") or {}).get("USD") or {}
            value = usd.get("Value")
            if not value:
                continue
            # Время публикации берём из самого ответа ЦБ (поле Date): до 11:30 МСК
            # daily_json ещё отдаёт ВЧЕРАШНИЙ курс, и «сегодня 11:30» давало
            # точку в будущем. Фолбэк — расчётные 11:30 МСК.
            pub = None
            raw_date = data.get("Date")
            if raw_date:
                try:
                    pub = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00"))
                except ValueError:
                    pub = None
            if pub is None:
                pub = datetime(day.year, day.month, day.day, 11, 30,
                               tzinfo=timezone(timedelta(hours=3)))
            rows.append((int(pub.timestamp()), float(value)))
        except Exception as e:
            print(f"  cbr {day}: {type(e).__name__} {str(e)[:60]}", flush=True)
        time.sleep(0.2)
    return rows


# --- Yahoo: RUB=X (USD/RUB), часовые свечи --------------------------------
def fetch_yahoo(days=3, interval="60m"):
    rng = f"{max(days, 2)}d"
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/RUB=X?interval={interval}&range={rng}"
    data = _get_json(url)
    res = (data.get("chart") or {}).get("result") or []
    if not res:
        return []
    r = res[0]
    stamps = r.get("timestamp") or []
    closes = ((r.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    rows = []
    for ts, c in zip(stamps, closes):
        if c and c > 0:
            rows.append((int(ts), float(c)))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    args = ap.parse_args()

    conn = sqlite3.connect(DB, timeout=30)
    try:
        cbr = fetch_cbr(args.days)
        n_cbr = _upsert(conn, cbr, "cbr")
        print(f"cbr:    {len(cbr)} точек, записано {n_cbr}", flush=True)

        yh = fetch_yahoo(args.days)
        n_yh = _upsert(conn, yh, "yahoo")
        print(f"yahoo:  {len(yh)} точек, записано {n_yh}", flush=True)

        for src in ("cbr", "yahoo", "tinkoff"):
            row = conn.execute(
                "SELECT COUNT(*), MIN(ts_epoch), MAX(ts_epoch) FROM fx_rates WHERE pair=? AND source=?",
                (PAIR, src)).fetchone()
            if row and row[0]:
                mn = datetime.fromtimestamp(int(row[1]), tz=timezone.utc).strftime("%d.%m %H:%M")
                mx = datetime.fromtimestamp(int(row[2]), tz=timezone.utc).strftime("%d.%m %H:%M")
                print(f"  {src:8s} n={row[0]:<5} {mn} → {mx}", flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
