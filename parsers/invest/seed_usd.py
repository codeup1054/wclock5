#!/usr/bin/env python3
"""Seed USD/RUB истории (часовые свечи T-Invest) в tracked_tickers.db для investChart.

Скачивает часовые свечи USD000UTSTOM (MOEX, class CETS) за ~5 месяцев и наполняет
last_prices как figi='USD_RUB', ticker='USD/RUB'. Идемпотентно: перед вставкой
удаляет прежние строки USD_RUB.

Запуск:  API_TOKEN=<token> python parsers/invest/seed_usd.py
Требуется только T-Invest MarketDataService/GetCandles.
"""
import http.client
import json
import os
import sqlite3
import ssl
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "tracked_tickers.db"

FIGI = "BBG0013HGFT4"          # USD000UTSTOM
TICKER = "USD/RUB"
STORE_FIGI = "USD_RUB"
CLASS_CODE = "tinkoff"
INTERVAL = "CANDLE_INTERVAL_HOUR"
MONTHS = float(os.environ.get("USD_MONTHS", "5"))
CHUNK_DAYS = 80                 # лимит T-Invest для HOUR — 90 дней

HOST = "invest-public-api.tbank.ru"
CANDLES_EP = "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles"
API_TOKEN = os.environ.get("API_TOKEN", "").strip()


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _quotation(q):
    return float(q.get("units", 0)) + float(q.get("nano", 0)) / 1e9


def fetch_chunk(frm, to):
    """Часовые свечи за окно (<= 90 дней). Возвращает список (epoch, iso, close)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(HOST, timeout=25, context=ctx)
    payload = json.dumps({
        "instrumentId": FIGI, "from": _iso(frm), "to": _iso(to), "interval": INTERVAL,
    })
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {API_TOKEN}"}
    try:
        conn.request("POST", CANDLES_EP, payload, headers)
        res = conn.getresponse()
        body = res.read().decode()
        if res.status != 200:
            raise RuntimeError(f"HTTP {res.status}: {body[:200]}")
        data = json.loads(body)
    finally:
        conn.close()
    out = []
    for c in data.get("candles") or []:
        dt = datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
        out.append((int(dt.timestamp()), dt.isoformat(), round(_quotation(c["close"]), 4)))
    return out


def main():
    if not API_TOKEN:
        raise SystemExit("API_TOKEN не задан (export API_TOKEN=<token>)")

    now = datetime.now(timezone.utc)
    start = now - timedelta(days=MONTHS * 30)

    points = {}
    cur = start
    while cur < now:
        end = min(cur + timedelta(days=CHUNK_DAYS), now)
        rows = fetch_chunk(cur, end)
        for epoch, iso, price in rows:
            points[epoch] = (iso, price)
        print(f"  {_iso(cur)[:10]} → {_iso(end)[:10]}: {len(rows)} строк (итого {len(points)})", flush=True)
        cur = end

    series = [(iso, epoch, price) for epoch, (iso, price) in sorted(points.items())]
    if not series:
        raise SystemExit("Не получено ни одной свечи")

    con = sqlite3.connect(DB_PATH, timeout=15)
    cols = [r[1] for r in con.execute("PRAGMA table_info(last_prices)")]
    if "ts_epoch" not in cols:
        con.execute("ALTER TABLE last_prices ADD COLUMN ts_epoch INTEGER")
    con.execute("DELETE FROM last_prices WHERE figi = ?", (STORE_FIGI,))
    con.executemany(
        "INSERT INTO last_prices (timestamp, ts_epoch, figi, ticker, class_code, price) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(iso, epoch, STORE_FIGI, TICKER, CLASS_CODE, price) for iso, epoch, price in series],
    )
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM last_prices WHERE figi = ?", (STORE_FIGI,)).fetchone()[0]
    lo, hi = con.execute("SELECT MIN(timestamp), MAX(timestamp) FROM last_prices WHERE figi = ?",
                         (STORE_FIGI,)).fetchone()
    con.close()
    print(f"[OK] USD/RUB: {n} строк  {lo} → {hi}  ({DB_PATH})", flush=True)


if __name__ == "__main__":
    main()
