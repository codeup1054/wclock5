#!/usr/bin/env python3
"""Сбор USD/RUB свечей из T-Invest GetCandles в fx_rates и tracked_tickers.db"""
import http.client
import json
import os
import sqlite3
import ssl
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
INVEST_DB = HERE / "invest_portfolio.db"
TICKERS_DB = HERE / "tracked_tickers.db"
HOST = "invest-public-api.tbank.ru"
CANDLES_EP = "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles"
API_TOKEN = os.environ.get("API_TOKEN", "").strip() or os.environ.get("TINKOFF_TOKEN", "").strip()

FIGI = "BBG0013HGFT4"  # USD000UTSTOM
PAIR = "USD/RUB"
STORE_FIGI = "USD_RUB"
CLASS_CODE = "tinkoff"
SOURCE = "tinkoff"

INTERVAL_MAP = {
    "1min": "CANDLE_INTERVAL_1_MIN",
    "5min": "CANDLE_INTERVAL_5_MIN",
    "10min": "CANDLE_INTERVAL_10_MIN",
    "15min": "CANDLE_INTERVAL_15_MIN",
    "hour": "CANDLE_INTERVAL_HOUR",
    "day": "CANDLE_INTERVAL_DAY",
}


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _quotation(q):
    if not q:
        return 0.0
    return float(q.get("units", 0)) + float(q.get("nano", 0)) / 1e9


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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fx_rates_ts_pair ON fx_rates(ts_epoch, pair, source)")


def _ensure_tickers(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS last_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            ts_epoch INTEGER,
            figi TEXT NOT NULL,
            ticker TEXT NOT NULL,
            class_code TEXT,
            price REAL NOT NULL
        )
    """)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(last_prices)")]
    if "ts_epoch" not in cols:
        try:
            conn.execute("ALTER TABLE last_prices ADD COLUMN ts_epoch INTEGER")
        except Exception:
            pass


def fetch_candles(frm, to, interval="CANDLE_INTERVAL_1_MIN"):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(HOST, timeout=30, context=ctx)
    payload = json.dumps({
        "instrumentId": FIGI,
        "from": _iso(frm),
        "to": _iso(to),
        "interval": interval,
    })
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {API_TOKEN}"}
    try:
        conn.request("POST", CANDLES_EP, payload, headers)
        res = conn.getresponse()
        body = res.read().decode()
        if res.status != 200:
            raise RuntimeError(f"HTTP {res.status}: {body[:300]}")
        data = json.loads(body)
        return data.get("candles") or []
    finally:
        conn.close()


def upsert_all(candles):
    if not candles:
        return 0
    cnt = 0
    # fx_rates
    try:
        con_fx = sqlite3.connect(INVEST_DB, timeout=30)
        _ensure_fx(con_fx)
        cur_fx = con_fx.cursor()
        for c in candles:
            try:
                dt = datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
                ts = int(dt.timestamp())
                close = round(_quotation(c.get("close")), 4)
                if close <= 0:
                    continue
                cur_fx.execute("""
                    INSERT OR REPLACE INTO fx_rates (timestamp, ts_epoch, pair, source, close, bid, ask)
                    VALUES (datetime(?, 'unixepoch'), ?, ?, ?, ?, ?, ?)
                """, (ts, ts, PAIR, SOURCE, close, None, None))
            except Exception:
                continue
        con_fx.commit()
        con_fx.close()
    except Exception as e:
        print(f"fx_rates err: {e}", flush=True)

    # tracked_tickers
    try:
        con_t = sqlite3.connect(TICKERS_DB, timeout=30)
        _ensure_tickers(con_t)
        cur_t = con_t.cursor()
        for c in candles:
            try:
                dt = datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
                ts = int(dt.timestamp())
                iso = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
                close = round(_quotation(c.get("close")), 4)
                if close <= 0:
                    continue
                # избегаем дублей по (figi, ts_epoch)
                cur_t.execute("""
                    INSERT INTO last_prices (timestamp, ts_epoch, figi, ticker, class_code, price)
                    SELECT ?, ?, ?, ?, ?, ?
                    WHERE NOT EXISTS (
                        SELECT 1 FROM last_prices WHERE figi=? AND ts_epoch=?
                    )
                """, (iso, ts, STORE_FIGI, PAIR, CLASS_CODE, close, STORE_FIGI, ts))
                if cur_t.rowcount:
                    cnt += 1
            except Exception:
                continue
        con_t.commit()
        con_t.close()
    except Exception as e:
        print(f"tracked_tickers err: {e}", flush=True)
    return cnt


def backfill(days=2, interval_key="1min"):
    if not API_TOKEN:
        raise SystemExit("API_TOKEN/TINKOFF_TOKEN не задан")
    interval = INTERVAL_MAP[interval_key]
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    total = 0
    chunk_h = 24
    cur = start
    while cur < now:
        end = min(cur + timedelta(hours=chunk_h), now)
        try:
            candles = fetch_candles(cur, end, interval)
            if candles:
                total += upsert_all(candles)
            print(f"  {cur.strftime('%Y-%m-%d %H:%M')} → {end.strftime('%Y-%m-%d %H:%M')} | {len(candles)} свечей (+{total})", flush=True)
        except Exception as e:
            print(f"  ERR {e}", flush=True)
        cur = end
        time.sleep(1)
    print(f"[OK] USD/RUB backfill done, added {total}", flush=True)


def update_once(minutes=90, interval_key="1min"):
    if not API_TOKEN:
        return 0
    interval = INTERVAL_MAP.get(interval_key, "CANDLE_INTERVAL_1_MIN")
    now = datetime.now(timezone.utc)
    start = now - timedelta(minutes=minutes)
    try:
        candles = fetch_candles(start, now, interval)
        return upsert_all(candles) if candles else 0
    except Exception as e:
        print(f"fx_candles update_once err: {e}", flush=True)
        return 0


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--backfill", action="store_true")
    p.add_argument("--days", type=int, default=2)
    p.add_argument("--interval", default="1min")
    p.add_argument("--minutes", type=int, default=90)
    args = p.parse_args()
    if args.backfill:
        backfill(days=args.days, interval_key=args.interval)
    else:
        print(update_once(minutes=args.minutes, interval_key=args.interval))
