#!/usr/bin/env python3
"""Бэкфилл свечей TGLD@, XAU/USD, USD/RUB, Brent за N недель в tracked_tickers.db.

Источники:
  - T-Invest MarketDataService/GetCandles: TGLD@ (TCS80A101X50),
    USD/RUB (BBG0013HGFT4 = USD000UTSTOM), Brent (FBR112600000 = BR-11.26)
  - Yahoo Chart API (GC=F): XAU/USD — у T-Invest пары XAU/USD нет

Смешанные интервалы (лимиты T-Invest на глубину запроса):
  0–2 дня      → 1 мин,  чанк 1 день
  2–14 дней    → 5 мин,  чанк 1 день
  14–56 дней   → 1 час,  чанк 7 дней

Пишет в last_prices (его читает investChart) и дублирует USD/RUB в fx_rates.
Идемпотентно: дубли по (figi, ts_epoch) не создаются.

Запуск:
  API_TOKEN=... python parsers/invest/backfill_8w.py [--weeks 8] [--dry-run]
"""
import argparse
import http.client
import json
import os
import socket
import sqlite3
import ssl
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TICKERS_DB = HERE / "tracked_tickers.db"
INVEST_DB = HERE / "invest_portfolio.db"

HOST = "invest-public-api.tbank.ru"
CANDLES_EP = "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles"
API_TOKEN = (os.environ.get("API_TOKEN") or os.environ.get("TINKOFF_TOKEN") or "").strip()

INTERVAL = {
    "1min": "CANDLE_INTERVAL_1_MIN",
    "5min": "CANDLE_INTERVAL_5_MIN",
    "15min": "CANDLE_INTERVAL_15_MIN",
    "hour": "CANDLE_INTERVAL_HOUR",
    "day": "CANDLE_INTERVAL_DAY",
}

# store_figi → (figi T-Invest, ticker, class_code, имя)
TINKOFF_INSTRUMENTS = {
    "TCS80A101X50": ("TCS80A101X50", "TGLD@", "tinkoff", "TGLD@"),
    "USD_RUB": ("BBG0013HGFT4", "USD/RUB", "tinkoff", "USD/RUB"),
    "BRENT": ("FBR112600000", "Brent", "tinkoff", "Brent"),
}

# store_figi → (тикер Yahoo, ticker, имя)
YAHOO_INSTRUMENTS = {
    "XAU_USD": ("GC=F", "XAU/USD", "XAU/USD"),
}


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _quotation(q):
    if not q:
        return 0.0
    return float(q.get("units", 0)) + float(q.get("nano", 0)) / 1e9


def _post(payload):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(HOST, timeout=40, context=ctx)
    try:
        conn.request("POST", CANDLES_EP, json.dumps(payload),
                     {"Content-Type": "application/json",
                      "Authorization": f"Bearer {API_TOKEN}"})
        res = conn.getresponse()
        body = res.read().decode()
        if res.status != 200:
            raise RuntimeError(f"HTTP {res.status}: {body[:200]}")
        return json.loads(body).get("candles") or []
    finally:
        conn.close()


def fetch_tinkoff(figi, frm, to, interval_key):
    candles = _post({
        "instrumentId": figi,
        "from": _iso(frm),
        "to": _iso(to),
        "interval": INTERVAL[interval_key],
    })
    out = []
    for c in candles:
        try:
            dt = datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
            close = round(_quotation(c.get("close")), 4)
            if close > 0:
                out.append((int(dt.timestamp()), dt, close))
        except Exception:
            continue
    return out


def fetch_yahoo(symbol, interval="60m", rng="60d"):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?interval={interval}&range={rng}")
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=40) as r:
        data = json.loads(r.read().decode())
    result = (data.get("chart") or {}).get("result") or []
    if not result:
        return []
    res = result[0]
    stamps = res.get("timestamp") or []
    closes = ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    out = []
    for ts, close in zip(stamps, closes):
        if close is None or close <= 0:
            continue
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        out.append((int(ts), dt, round(float(close), 4)))
    return out


def _ensure_fx(conn):
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
            UNIQUE(ts_epoch, pair, source)
        )
    """)


def save_rows(rows, store_figi, ticker, class_code, source="tinkoff"):
    """UPSERT в last_prices по (figi, ts_epoch); FX — ещё и в fx_rates."""
    if not rows:
        return 0
    added = 0
    conn = sqlite3.connect(TICKERS_DB, timeout=30)
    try:
        cur = conn.cursor()
        for ts, dt, close in rows:
            cur.execute("""
                INSERT INTO last_prices (timestamp, ts_epoch, figi, ticker, class_code, price)
                SELECT ?, ?, ?, ?, ?, ?
                WHERE NOT EXISTS (
                    SELECT 1 FROM last_prices WHERE figi=? AND ts_epoch=?
                )
            """, (dt.strftime("%Y-%m-%dT%H:%M:%SZ"), ts, store_figi, ticker,
                  class_code, close, store_figi, ts))
            if cur.rowcount:
                added += 1
        conn.commit()
    finally:
        conn.close()

    if store_figi == "USD_RUB":
        con = sqlite3.connect(INVEST_DB, timeout=30)
        try:
            _ensure_fx(con)
            cur = con.cursor()
            for ts, dt, close in rows:
                cur.execute("""
                    INSERT OR REPLACE INTO fx_rates (timestamp, ts_epoch, pair, source, close)
                    VALUES (datetime(?, 'unixepoch'), ?, 'USD/RUB', ?, ?)
                """, (ts, ts, source, close))
            con.commit()
        finally:
            con.close()
    return added


def plan(weeks):
    """Список (interval, chunk_days, from_days_ago, to_days_ago) от старых к новым."""
    total_days = weeks * 7
    return [
        ("hour", 7, total_days, 14),
        ("5min", 1, 14, 2),
        ("1min", 1, 2, 0),
    ]


def backfill_tinkoff(store_figi, weeks, dry_run=False):
    figi, ticker, class_code, name = TINKOFF_INSTRUMENTS[store_figi]
    now = datetime.now(timezone.utc)
    total = 0
    for interval_key, chunk_days, from_days, to_days in plan(weeks):
        cur_from = now - timedelta(days=from_days)
        end = now - timedelta(days=to_days)
        while cur_from < end:
            chunk_end = min(cur_from + timedelta(days=chunk_days), end)
            try:
                rows = fetch_tinkoff(figi, cur_from, chunk_end, interval_key)
                got = len(rows)
                if not dry_run:
                    total += save_rows(rows, store_figi, ticker, class_code)
                print(f"  {name} {interval_key:5s} {cur_from:%d.%m %H:%M}→{chunk_end:%d.%m %H:%M}"
                      f" | свечей {got}", flush=True)
            except Exception as e:
                print(f"  {name} {interval_key:5s} ERR {e}", flush=True)
            cur_from = chunk_end
            time.sleep(0.35)
    return total


def backfill_yahoo(store_figi, weeks, dry_run=False):
    symbol, ticker, name = YAHOO_INSTRUMENTS[store_figi]
    total = 0
    # Yahoo: 60m за весь период + 5m за последнюю неделю (лимит 60 дней)
    jobs = [("60m", f"{weeks * 7}d"), ("5m", "7d")]
    for interval, rng in jobs:
        try:
            rows = fetch_yahoo(symbol, interval=interval, rng=rng)
            if not dry_run:
                total += save_rows(rows, store_figi, ticker, "yahoo")
            print(f"  {name} {interval:5s} range={rng} | свечей {len(rows)}", flush=True)
        except Exception as e:
            print(f"  {name} {interval:5s} ERR {e}", flush=True)
        time.sleep(0.5)
    return total


def report():
    conn = sqlite3.connect(TICKERS_DB)
    try:
        for store_figi, (_, ticker, _, _) in TINKOFF_INSTRUMENTS.items():
            row = conn.execute(
                "SELECT COUNT(*), MIN(ts_epoch), MAX(ts_epoch) FROM last_prices WHERE figi=?",
                (store_figi,)).fetchone()
            print(f"  {ticker:8s} n={row[0]:<6} {_fmt(row[1])} → {_fmt(row[2])}")
        for store_figi, (_, ticker, _) in YAHOO_INSTRUMENTS.items():
            row = conn.execute(
                "SELECT COUNT(*), MIN(ts_epoch), MAX(ts_epoch) FROM last_prices WHERE figi=?",
                (store_figi,)).fetchone()
            print(f"  {ticker:8s} n={row[0]:<6} {_fmt(row[1])} → {_fmt(row[2])}")
    finally:
        conn.close()


def _fmt(ts):
    if not ts:
        return "—"
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%d.%m %H:%M")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--weeks", type=int, default=8)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", default="", help="TGLD,USD,BRENT,XAU через запятую")
    args = p.parse_args()

    if not API_TOKEN:
        raise SystemExit("API_TOKEN не задан")

    only = {s.strip().upper() for s in args.only.split(",") if s.strip()}
    mapping = {"TGLD": "TCS80A101X50", "USD": "USD_RUB", "BRENT": "BRENT", "XAU": "XAU_USD"}

    print(f"=== Бэкфилл {args.weeks} недель (UTC {datetime.now(timezone.utc):%d.%m %H:%M}) ===")
    for key, store_figi in mapping.items():
        if only and key not in only:
            continue
        if store_figi in YAHOO_INSTRUMENTS:
            backfill_yahoo(store_figi, args.weeks, args.dry_run)
        else:
            backfill_tinkoff(store_figi, args.weeks, args.dry_run)

    print("=== Итог по БД ===")
    report()
