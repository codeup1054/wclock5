# invest_repo.py
"""Единый слой доступа к данным инвестиций (mediation/DTO).

Время:
- Канонический формат хранения: UTC ISO '2026-08-21T08:13:08.467243+00:00'
- Для фильтрации/сортировки/бакетинга: ts_epoch INTEGER (Unix-секунды) —
  числовое сравнение, не зависящее от текстового формата timestamp
- parse_ts() принимает любой из исторических форматов ('T' или пробел,
  с TZ и без; наивные строки считаются UTC)

Все потребители (демоны, API) работают только через этот модуль.
"""

import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "parsers", "invest", "invest_portfolio.db")
TICKERS_DB_PATH = os.path.join(BASE_DIR, "parsers", "invest", "tracked_tickers.db")

RETENTION_RAW_DAYS = 1        # сырые снапшоты храним сутки, старше — схлопываем в часовые свечи
RETENTION_CANDLE_DAYS = 120   # часовые свечи храним 4 месяца

DAY_INTERVAL_SEC = 10         # частый опрос днём
NIGHT_INTERVAL_SEC = 60       # базовый интервал ночью

# ================================================================
# timeutil
# ================================================================

def now_dt():
    return datetime.now(timezone.utc)


def to_iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")


def now_iso():
    return to_iso(now_dt())


def parse_ts(value):
    """Любой из встречающихся форматов → aware datetime (UTC)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        if " " in s and "T" not in s:
            s = s.replace(" ", "T", 1)
        dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def to_epoch(value):
    """str | datetime → Unix-секунды."""
    return int(parse_ts(value).timestamp())


_PERIOD_RE = re.compile(r"^(-[\d.]+)\s*(day|hour|minute|second)s?$")
_UNIT_SECONDS = {"day": 86400, "hour": 3600, "minute": 60, "second": 1}


def period_to_seconds(period):
    """'-3 hour' / '-1.5 day' → секунды. Нераспознанное → 35 дней."""
    m = _PERIOD_RE.match(str(period).strip())
    if not m:
        return 35 * 86400
    return int(abs(float(m.group(1))) * _UNIT_SECONDS[m.group(2)])


def cutoff_epoch(period):
    """Начало периода 'X назад' в Unix-секундах."""
    return int(now_dt().timestamp()) - period_to_seconds(period)


def current_interval(base=NIGHT_INTERVAL_SEC):
    """Адаптивный интервал опроса: 10с днём (08:00–24:00 МСК), ночью — base."""
    h = now_dt().hour  # UTC; МСК = UTC+3 → день 05:00–21:00 UTC
    if 5 <= h < 21:
        return min(base, DAY_INTERVAL_SEC)
    return max(base, NIGHT_INTERVAL_SEC)


# ================================================================
# DTO
# ================================================================

@dataclass
class Position:
    instrument_type: str = ""
    name: str = ""
    ticker: str = ""
    quantity: float = 0.0
    price: float = 0.0
    value: float = 0.0
    source: str = "tinkoff"


@dataclass
class Snapshot:
    source: str = "tinkoff"
    positions: list = field(default_factory=list)
    timestamp: str = None
    ts_epoch: int = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = now_iso()
        if self.ts_epoch is None:
            self.ts_epoch = to_epoch(self.timestamp)

    def total(self):
        return sum(p.value for p in self.positions)


# ================================================================
# Соединение
# ================================================================

def connect(db_path=None):
    conn = sqlite3.connect(db_path or DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.row_factory = sqlite3.Row
    return conn


# ================================================================
# Запись снапшотов
# ================================================================

MIN_POSITIONS = {"tinkoff": 2, "finam": 1}


def write_snapshot(snap, db_path=None):
    """Пишет позиции + итог в историю. Возвращает total или None если снепшот неполный."""
    if len(snap.positions) < MIN_POSITIONS.get(snap.source, 1):
        print(f"⚠️ Пропущен снепшот {snap.source}: только {len(snap.positions)} позиций", flush=True)
        return None

    conn = connect(db_path)
    cur = conn.cursor()
    for p in snap.positions:
        cur.execute("""
            INSERT INTO portfolio_positions
                (timestamp, ts_epoch, instrument_type, name, ticker, quantity, price, value, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (snap.timestamp, snap.ts_epoch, p.instrument_type, p.name, p.ticker,
              p.quantity, p.price, p.value, snap.source))
    cur.execute("""
        INSERT INTO portfolio_history (timestamp, ts_epoch, total_value, source)
        VALUES (?, ?, ?, ?)
    """, (snap.timestamp, snap.ts_epoch, round(snap.total(), 2), snap.source))
    conn.commit()
    conn.close()
    return snap.total()


# ================================================================
# Retention: сырые данные → часовые свечи по (час, source)
# ================================================================

def apply_retention(db_path=None):
    conn = connect(db_path)
    cur = conn.cursor()

    raw_cutoff = int(now_dt().timestamp()) - RETENTION_RAW_DAYS * 86400

    rows = cur.execute("""
        SELECT ts_epoch, source, SUM(value) AS total
        FROM portfolio_positions
        WHERE ts_epoch < ?
        GROUP BY ts_epoch, source
        ORDER BY ts_epoch ASC
    """, (raw_cutoff,)).fetchall()

    # Группируем по часовым бакетам (epoch // 3600)
    hours = {}  # (bucket, source) -> dict
    for r in rows:
        bucket = r["ts_epoch"] // 3600 * 3600
        key = (bucket, r["source"] or "tinkoff")
        h = hours.setdefault(key, {"open": r["total"], "close": r["total"],
                                   "high": r["total"], "low": r["total"], "volume": 0})
        h["close"] = r["total"]
        h["high"] = max(h["high"], r["total"])
        h["low"] = min(h["low"], r["total"])
        h["volume"] += 1

    for (bucket, source), h in hours.items():
        cur.execute("""
            INSERT INTO portfolio_hourly (timestamp, ts_epoch, source, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ts_epoch, source) DO UPDATE SET
                high = MAX(high, excluded.high),
                low = MIN(low, excluded.low),
                close = excluded.close,
                volume = volume + excluded.volume
        """, (to_iso(datetime.fromtimestamp(bucket, tz=timezone.utc)), bucket, source,
              h["open"], h["high"], h["low"], h["close"], h["volume"]))

    # Удаляем схлопнутые сырые данные и устаревшие свечи
    cur.execute("DELETE FROM portfolio_positions WHERE ts_epoch < ?", (raw_cutoff,))
    cur.execute("DELETE FROM portfolio_history WHERE ts_epoch < ?", (raw_cutoff,))
    candle_cutoff = int(now_dt().timestamp()) - RETENTION_CANDLE_DAYS * 86400
    cur.execute("DELETE FROM portfolio_hourly WHERE ts_epoch < ?", (candle_cutoff,))

    conn.commit()
    conn.close()

    if hours:
        total_snaps = sum(h["volume"] for h in hours.values())
        print(f"📊 Агрегация: {len(hours)} часовых свечей из {total_snaps} снапшотов", flush=True)


# ================================================================
# Чтение для /api/invest/history (формат ответа сохранён)
# ================================================================

def read_history(period="-35 day", bucket_size=3600, db_path=None):
    if not os.path.exists(db_path or DB_PATH):
        return {"_error": "Invest DB not found", "_error_code": 404}
    try:
        cutoff = cutoff_epoch(period)
        conn = connect(db_path)
        cur = conn.cursor()

        raw_rows = cur.execute("""
            SELECT timestamp, ts_epoch, source, SUM(value) AS total
            FROM portfolio_positions
            WHERE ts_epoch >= ?
            GROUP BY ts_epoch, source
            ORDER BY ts_epoch ASC
        """, (cutoff,)).fetchall()

        candles = []
        has_hourly = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_hourly'"
        ).fetchone() is not None
        if has_hourly:
            candles = cur.execute("""
                SELECT timestamp, ts_epoch, source, close AS total
                FROM portfolio_hourly
                WHERE ts_epoch >= ?
                ORDER BY ts_epoch ASC
            """, (cutoff,)).fetchall()

        # Обратная совместимость: если за период пусто — отдаём всё, что есть
        if not raw_rows and not candles:
            raw_rows = cur.execute("""
                SELECT timestamp, ts_epoch, source, SUM(value) AS total
                FROM portfolio_positions
                GROUP BY ts_epoch, source
                ORDER BY ts_epoch ASC
            """).fetchall()

        if not raw_rows and not candles:
            conn.close()
            return {}

        # Слияние: ключ (epoch, source); свечи только там, где нет сырых точек
        points = {}     # (epoch, source) -> [display_ts, value]
        raw_epochs = set()
        for r in raw_rows:
            src = r["source"] or "tinkoff"
            if r["total"] is None:
                continue
            points[(r["ts_epoch"], src)] = [r["timestamp"], round(r["total"], 2)]
            raw_epochs.add(r["ts_epoch"])
        for c in candles:
            src = c["source"] or "tinkoff"
            if c["total"] is None or c["ts_epoch"] in raw_epochs:
                continue
            points[(c["ts_epoch"], src)] = [c["timestamp"], round(c["total"], 2)]

        # Бакетинг: последний снапшот за (бакет, source) побеждает
        aggregated = {}  # bucket -> {last_epoch, display_ts, by_source{}}
        for (epoch, src) in sorted(points.keys()):
            display_ts, value = points[(epoch, src)]
            bucket = epoch // bucket_size * bucket_size
            agg = aggregated.setdefault(bucket, {"last_epoch": epoch, "ts": display_ts, "by_source": {}})
            agg["by_source"][src] = value
            if epoch >= agg["last_epoch"]:
                agg["last_epoch"] = epoch
                agg["ts"] = display_ts

        # Последние позиции — отдельно по каждому источнику
        latest_positions = []
        latest_epoch = None
        src_latest = cur.execute(
            "SELECT source, MAX(ts_epoch) AS e FROM portfolio_positions GROUP BY source"
        ).fetchall()
        for row in src_latest:
            src_epoch = row["e"]
            src = row["source"] or "tinkoff"
            if src_epoch is None:
                continue
            if latest_epoch is None or src_epoch > latest_epoch:
                latest_epoch = src_epoch
            pos_rows = cur.execute("""
                SELECT instrument_type, name, ticker, quantity, value, source
                FROM portfolio_positions
                WHERE ts_epoch = ? AND source = ?
                ORDER BY value DESC
            """, (src_epoch, src)).fetchall()
            for r in pos_rows:
                latest_positions.append({
                    "type": r["instrument_type"] or "Other",
                    "name": r["name"] or r["ticker"] or "Unknown",
                    "quantity": round(r["quantity"], 4),
                    "value": round(r["value"], 2),
                    "source": r["source"] or "tinkoff",
                })

        conn.close()

        result = {}
        for bucket in sorted(aggregated.keys()):
            agg = aggregated[bucket]
            items = [
                {"type": "total", "name": "Портфель", "value": round(v, 2), "source": s}
                for s, v in sorted(agg["by_source"].items())
            ]
            result[agg["ts"]] = items
        if latest_positions:
            # Позиции всегда в ПОСЛЕДНЕМ ключе, чтобы баннер не читал totals
            target = max(result.keys()) if result else next(
                (ts for (e, _), (ts, _) in points.items() if e == latest_epoch), None)
            if target is not None:
                result[target] = latest_positions
        return result

    except Exception as e:
        print(f"[ERROR] read_history(): {e}")
        import traceback
        traceback.print_exc()
        return {"_error": str(e), "_error_code": 500}


# ================================================================
# Тикеры (tracked_tickers.db / last_prices)
# ================================================================

def write_price(figi, ticker, class_code, price, db_path=None):
    conn = connect(db_path or TICKERS_DB_PATH)
    cur = conn.cursor()
    ts = now_iso()
    cur.execute("""
        INSERT INTO last_prices (timestamp, ts_epoch, figi, ticker, class_code, price)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (ts, to_epoch(ts), figi, ticker, class_code, price))
    conn.commit()
    conn.close()


def read_prices(period="-28 day", figi=None, db_path=None):
    """Строки last_prices за период; числовой фильтр по ts_epoch. period=None → без фильтра."""
    conn = connect(db_path or TICKERS_DB_PATH)
    if figi:
        sql = "SELECT timestamp, price, ticker, class_code FROM last_prices"
        params = []
        if period is not None:
            sql += " WHERE figi = ? AND ts_epoch >= ?"
            params += [figi, cutoff_epoch(period)]
        else:
            sql += " WHERE figi = ?"
            params += [figi]
        sql += " ORDER BY ts_epoch ASC"
        rows = conn.execute(sql, params).fetchall()
    else:
        sql = "SELECT figi, ticker, class_code, timestamp, price FROM last_prices"
        params = []
        if period is not None:
            sql += " WHERE ts_epoch >= ?"
            params += [cutoff_epoch(period)]
        sql += " ORDER BY figi, ts_epoch ASC"
        rows = conn.execute(sql, params).fetchall()
    conn.close()
    return rows


def apply_ticker_retention(days=120, db_path=None):
    conn = connect(db_path or TICKERS_DB_PATH)
    cutoff = int(now_dt().timestamp()) - days * 86400
    conn.execute("DELETE FROM last_prices WHERE ts_epoch < ?", (cutoff,))
    conn.commit()
    conn.close()


# ================================================================
# Миграции (идемпотентные)
# ================================================================

def run_migrations(db_path=None, tickers_db_path=None):
    _migrate_portfolio_db(db_path or DB_PATH)
    _migrate_tickers_db(tickers_db_path or TICKERS_DB_PATH)


def _table_cols(cur, table):
    return [r[1] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()]


def _migrate_portfolio_db(db_path):
    if not os.path.exists(db_path):
        return
    conn = connect(db_path)
    cur = conn.cursor()

    # 1) ts_epoch в positions/history + бэкфил из текста
    for table in ("portfolio_positions", "portfolio_history"):
        cols = _table_cols(cur, table)
        if "ts_epoch" not in cols:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN ts_epoch INTEGER")
        cur.execute(f"""
            UPDATE {table}
            SET ts_epoch = CAST(strftime('%s', substr(timestamp, 1, 19)) AS INTEGER)
            WHERE ts_epoch IS NULL
        """)
        cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_epoch ON {table}(ts_epoch)")

    # 2) portfolio_hourly: rebuild под UNIQUE(ts_epoch, source)
    cols = _table_cols(cur, "portfolio_hourly")
    if not cols:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS portfolio_hourly (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                ts_epoch INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'tinkoff',
                open REAL, high REAL, low REAL, close REAL,
                volume INTEGER DEFAULT 0,
                UNIQUE(ts_epoch, source)
            )
        """)
    elif "ts_epoch" not in cols or "source" not in cols:
        cur.execute("ALTER TABLE portfolio_hourly RENAME TO portfolio_hourly_old")
        cur.execute("""
            CREATE TABLE portfolio_hourly (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                ts_epoch INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'tinkoff',
                open REAL, high REAL, low REAL, close REAL,
                volume INTEGER DEFAULT 0,
                UNIQUE(ts_epoch, source)
            )
        """)
        cur.execute("""
            INSERT INTO portfolio_hourly (id, timestamp, ts_epoch, source, open, high, low, close, volume)
            SELECT id, timestamp,
                   COALESCE(CAST(strftime('%s', substr(timestamp, 1, 19)) AS INTEGER), 0),
                   'tinkoff', open, high, low, close, volume
            FROM portfolio_hourly_old
        """)
        cur.execute("DROP TABLE portfolio_hourly_old")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_hourly_epoch_source ON portfolio_hourly(ts_epoch, source)")

    conn.commit()
    n = cur.execute("SELECT COUNT(*) FROM portfolio_hourly").fetchone()[0]
    conn.close()
    print(f"✅ Миграция invest_portfolio.db завершена (свечей: {n})", flush=True)


def _migrate_tickers_db(db_path):
    if not os.path.exists(db_path):
        return
    conn = connect(db_path or TICKERS_DB_PATH)
    cur = conn.cursor()
    cols = _table_cols(cur, "last_prices")
    if "ts_epoch" not in cols:
        cur.execute("ALTER TABLE last_prices ADD COLUMN ts_epoch INTEGER")
    cur.execute("""
        UPDATE last_prices
        SET ts_epoch = CAST(strftime('%s', substr(timestamp, 1, 19)) AS INTEGER)
        WHERE ts_epoch IS NULL
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_last_prices_epoch ON last_prices(figi, ts_epoch)")
    conn.commit()
    conn.close()
    print("✅ Миграция tracked_tickers.db завершена", flush=True)


if __name__ == "__main__":
    run_migrations()

# ============================================================
# TRADES / TURNOVER — сырые сделки + дневные итоги оборота
# ============================================================

# Тариф Finam «Трейдер n6»: ставка по брекету дневного оборота (МосБиржа)
FINAM_MOEX_TIERS = [
    (1_000_000, 0.00025),     # до 1 млн включительно — 0,025%
    (5_000_000, 0.00015),     # свыше 1–5 млн — 0,015%
    (30_000_000, 0.00010),    # свыше 5–30 млн — 0,01%
    (100_000_000, 0.00005),   # свыше 30–100 млн — 0,005%
    (250_000_000, 0.000025),  # свыше 100–250 млн — 0,0025%
    (float('inf'), 0.00001),  # свыше 250 млн — 0,001%
]
FINAM_SPB_RATE = 0.0001         # СПБ Биржа — брокерская ставка 0,01%
FINAM_SETTLE_MOEX = 0.0003      # урегулирование сделок МосБиржа (кроме облигаций) 0,03%
FINAM_SETTLE_SPB = 0.0001       # урегулирование сделок СПБ Биржа 0,01%


def finam_commission_estimate(moex_sum, spb_sum):
    """Комиссия Finam за день = брокерская ставка по брекету суммарного оборота
    + урегулирование сделок отдельно по площадкам."""
    total_rf = moex_sum + spb_sum
    rate = FINAM_MOEX_TIERS[-1][1]
    for cap, r in FINAM_MOEX_TIERS:
        if total_rf <= cap:
            rate = r
            break
    return total_rf * rate + moex_sum * FINAM_SETTLE_MOEX + spb_sum * FINAM_SETTLE_SPB


def guess_exchange(symbol):
    """Эвристика биржи по символу Finam: @SPB → spb, иначе moex."""
    sym = (symbol or "").upper()
    if "@SPB" in sym or "@SPBX" in sym:
        return "spb"
    return "moex"


def init_trades_tables(db_path=None):
    """Создаёт таблицы trades и turnover_daily (идемпотентно)."""
    conn = connect(db_path or DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id TEXT NOT NULL,
            source TEXT NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            sum REAL NOT NULL,
            commission REAL NOT NULL DEFAULT 0,
            exchange TEXT NOT NULL DEFAULT 'moex',
            ts_epoch INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            UNIQUE(source, trade_id)
        )
    """)
    if "commission" not in _table_cols(cur, "trades"):
        cur.execute("ALTER TABLE trades ADD COLUMN commission REAL NOT NULL DEFAULT 0")
    if "exchange" not in _table_cols(cur, "trades"):
        cur.execute("ALTER TABLE trades ADD COLUMN exchange TEXT NOT NULL DEFAULT 'moex'")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_epoch ON trades(ts_epoch)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_src_day ON trades(source, ts_epoch)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS turnover_daily (
            day TEXT NOT NULL,
            source TEXT NOT NULL,
            buy REAL NOT NULL DEFAULT 0,
            sell REAL NOT NULL DEFAULT 0,
            commission REAL NOT NULL DEFAULT 0,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, source)
        )
    """)
    if "commission" not in _table_cols(cur, "turnover_daily"):
        cur.execute("ALTER TABLE turnover_daily ADD COLUMN commission REAL NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


def upsert_trades(trades, db_path=None):
    """
    trades: [{trade_id, source, symbol, side('buy'|'sell'), quantity, price, sum, ts_epoch}]
    Вставляет новые сделки, пересчитывает дневные агрегаты затронутых дней.
    Возвращает число новых сделок.
    """
    if not trades:
        return 0
    conn = connect(db_path or DB_PATH)
    cur = conn.cursor()
    days_touched = set()
    new_count = 0
    for t in trades:
        cur.execute(
            "INSERT OR IGNORE INTO trades (trade_id, source, symbol, side, quantity, price, sum, commission, exchange, ts_epoch, timestamp)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (str(t["trade_id"]), t["source"], t["symbol"], t["side"],
             float(t["quantity"]), float(t["price"]), float(t["sum"]),
             float(t.get("commission", 0)),
             str(t.get("exchange", "moex")),
             int(t["ts_epoch"]),
             to_iso(datetime.fromtimestamp(int(t["ts_epoch"]), tz=timezone.utc))))
        if cur.rowcount > 0:
            new_count += 1
            days_touched.add(datetime.fromtimestamp(int(t["ts_epoch"]), tz=timezone.utc).strftime("%Y-%m-%d"))
    # Пересчёт агрегатов только за затронутые дни (+ сегодня на всякий случай)
    days_touched.add(datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    for day in days_touched:
        day_start = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
        day_end = day_start + 86400
        cur.execute("DELETE FROM turnover_daily WHERE day=? ", (day,))
        cur.execute("""
            INSERT INTO turnover_daily (day, source, buy, sell, commission, count)
            SELECT ?, source,
                   COALESCE(SUM(CASE WHEN side='buy' THEN sum END), 0),
                   COALESCE(SUM(CASE WHEN side='sell' THEN sum END), 0),
                   0,
                   COUNT(CASE WHEN side IN ('buy','sell') THEN 1 END)
            FROM trades WHERE ts_epoch >= ? AND ts_epoch < ?
            GROUP BY source
        """, (day, day_start, day_end))
        # Комиссия: Tinkoff — реальная из API; Finam — оценка по тарифу
        ex_rows = cur.execute(
            "SELECT source, exchange, SUM(sum) AS total, SUM(commission) AS real_comm"
            " FROM trades WHERE ts_epoch >= ? AND ts_epoch < ? GROUP BY source, exchange",
            (day_start, day_end)).fetchall()
        by_src = {}
        for er in ex_rows:
            src = er[0]
            d = by_src.setdefault(src, {"moex": 0.0, "spb": 0.0, "real": 0.0})
            if src == "finam":
                d[er[1] if er[1] in ("moex", "spb") else "moex"] += float(er[2] or 0)
            else:
                d["real"] += float(er[3] or 0)
        for src, d in by_src.items():
            comm = d["real"] if src != "finam" else finam_commission_estimate(d["moex"], d["spb"])
            cur.execute("UPDATE turnover_daily SET commission=? WHERE day=? AND source=?",
                        (round(comm, 2), day, src))
    conn.commit()
    conn.close()
    return new_count


def read_turnover_since(since_epoch, db_path=None):
    """
    Оборот по источникам с указанного момента (из сырых сделок):
    {tinkoff: {buy, sell, total, commission, count}, finam: {...}}
    """
    conn = connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT source,
               COALESCE(SUM(CASE WHEN side='buy' THEN sum END), 0) AS buy,
               COALESCE(SUM(CASE WHEN side='sell' THEN sum END), 0) AS sell,
               COALESCE(SUM(commission), 0) AS commission,
               COUNT(CASE WHEN side IN ('buy','sell') THEN 1 END) AS cnt
        FROM trades WHERE ts_epoch >= ?
        GROUP BY source
    """, (int(since_epoch),)).fetchall()
    out = {}
    for r in rows:
        out[r["source"]] = {
            "buy": r["buy"], "sell": r["sell"],
            "total": r["buy"] + r["sell"],
            "commission": r["commission"], "count": r["cnt"],
        }
    conn.close()
    return out


def read_turnover(days=90, db_path=None):
    """Дневные итоги по источникам: [{day, source, buy, sell, count}]"""
    conn = connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    cutoff = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    rows = conn.execute(
        "SELECT day, source, buy, sell, count FROM turnover_daily ORDER BY day DESC").fetchall()
    out = [dict(r) for r in rows]
    conn.close()
    return out
