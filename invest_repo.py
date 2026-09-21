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

RETENTION_MIN_DAYS = 30       # минутные свечи храним 30 дней (детальный анализ), старше — в часовые
RETENTION_CANDLE_DAYS = 120   # часовые свечи храним 4 месяца
RAW_FOLD_WINDOW_SEC = 90      # секундные снапшоты старше этого — схлопываем в минутные свечи
RAW_FOLD_PERIOD_SEC = 60      # схлопывание секунд→минуты раз в минуту
RETENTION_RAW_DAYS = 1        # legacy-алиас (старая политика «сырьё сутки»)

NIGHT_INTERVAL_SEC = 60          # вне пика (ночь / не-трейдинговые окна)
PEAK_INTERVAL_SEC = 1            # пик 10:00–19:00 МСК — опрос раз в секунду
PEAK_FROM_HOUR_UTC = 7           # 10:00 МСК → 07:00 UTC
PEAK_TO_HOUR_UTC = 16            # 19:00 МСК → 16:00 UTC

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
    """Две полосы записи:
    10:00–19:00 МСК (07:00–16:00 UTC) — 1с, вне пика — 60с.
    base — только «не быстрее», чтобы настройка не превышала целевой интервал."""
    h = now_dt().hour  # UTC; МСК = UTC+3
    if PEAK_FROM_HOUR_UTC <= h < PEAK_TO_HOUR_UTC:
        return min(base, PEAK_INTERVAL_SEC)
    return min(base, NIGHT_INTERVAL_SEC)


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
    conn = sqlite3.connect(db_path or DB_PATH, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.row_factory = sqlite3.Row
    return conn


# ================================================================
# Запись снапшотов
# ================================================================

MIN_POSITIONS = {"tinkoff": 0, "finam": 0}


def write_snapshot(snap, db_path=None):
    """Пишет позиции + итог в историю. Возвращает total или None если снепшот неполный."""
    if len(snap.positions) < MIN_POSITIONS.get(snap.source, 0):
        print(f"⚠️ Пропущен снепшот {snap.source}: только {len(snap.positions)} позиций", flush=True)
        return None

    snap_total = snap.total()
    conn = connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        wrote_pos = False
        for p in snap.positions:
            cur.execute("""
                INSERT INTO portfolio_positions
                    (timestamp, ts_epoch, instrument_type, name, ticker, quantity, price, value, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (snap.timestamp, snap.ts_epoch, p.instrument_type, p.name, p.ticker,
                  p.quantity, p.price, p.value, snap.source))
            wrote_pos = True
        if not wrote_pos:
            cur.execute("""
                INSERT INTO portfolio_positions
                    (timestamp, ts_epoch, instrument_type, name, ticker, quantity, price, value, source)
                VALUES (?, ?, 'total', ?, '', 0, 0, 0, ?)
            """, (snap.timestamp, snap.ts_epoch, "Портфель", snap.source))
        cur.execute("""
            INSERT INTO portfolio_history (timestamp, ts_epoch, total_value, source)
            VALUES (?, ?, ?, ?)
        """, (snap.timestamp, snap.ts_epoch, round(snap_total, 2), snap.source))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return snap_total


# ================================================================
# Retention: сырые данные → часовые свечи по (час, source)
# ================================================================

def apply_retention(db_path=None):
    """Секундные снапшоты → минутные свечи, старые минуты → часы.

    - Сырые секунды (portfolio_positions) старше RAW_FOLD_WINDOW_SEC схемлопываем
      в минуты (транзитные секунды в аналитике не нужны — хватает минут).
    - Минутные (portfolio_min) старше RETENTION_MIN_DAYS схлопываем в часы.
    - Часовые (portfolio_hourly) храним RETENTION_CANDLE_DAYS.
    """
    conn = connect(db_path)
    try:
        cur = conn.cursor()
        return apply_retention_impl(conn, cur, db_path)
    finally:
        conn.close()


_LAST_RAW_FOLD_TS = 0


def maybe_fold_raw(db_path=None):
    """Схлопывание секунд → минутные свечи раз в минуту (модульный таймер).

    Вызывается из цикла tinkoff-демона (единственного владельца ретеншена);
    не чаще раза в RAW_FOLD_PERIOD_SEC. Важно при 1с-кадденции пика, чтобы
    сырые секунды не копились целый день.
    """
    global _LAST_RAW_FOLD_TS
    now = int(now_dt().timestamp())
    if now - _LAST_RAW_FOLD_TS < RAW_FOLD_PERIOD_SEC:
        return False
    _LAST_RAW_FOLD_TS = now
    apply_retention(db_path)
    return True


def apply_retention_impl(conn, cur, db_path=None):
    now = int(now_dt().timestamp())
    raw_cutoff = now - RAW_FOLD_WINDOW_SEC
    min_cutoff = now - RETENTION_MIN_DAYS * 86400
    candle_cutoff = now - RETENTION_CANDLE_DAYS * 86400

    # ---------- Шаг 1: сырые → минуты ----------
    raw_rows = cur.execute("""
        SELECT ts_epoch, source, SUM(value) AS total
        FROM portfolio_positions
        WHERE ts_epoch < ?
        GROUP BY ts_epoch, source
        ORDER BY ts_epoch ASC
    """, (raw_cutoff,)).fetchall()

    raw_tgld = cur.execute("""
        SELECT ts_epoch, source,
               SUM(CASE WHEN ticker LIKE '%TGLD%' OR name LIKE '%TGLD%' THEN value ELSE 0 END) AS tgld_val,
               SUM(CASE WHEN ticker LIKE '%TMON%' OR name LIKE '%TMON%' THEN value ELSE 0 END) AS tmon_val,
               SUM(CASE WHEN ticker LIKE '%LQDT%' OR name LIKE '%LQDT%' THEN value ELSE 0 END) AS lqdt_val,
               SUM(value) AS total_val
        FROM portfolio_positions
        WHERE ts_epoch < ?
        GROUP BY ts_epoch, source
        ORDER BY ts_epoch ASC
    """, (raw_cutoff,)).fetchall()
    raw_tgld_map = {}
    for t in raw_tgld:
        raw_tgld_map[(t["ts_epoch"], t["source"] or "tinkoff")] = (
            round(t["tgld_val"], 2), round(t["tmon_val"], 2), round(t["lqdt_val"], 2), round(t["total_val"], 2))

    mins = {}  # (bucket, source) -> {"open","close","high","low","volume"}
    for r in raw_rows:
        bucket = r["ts_epoch"] // 60 * 60
        key = (bucket, r["source"] or "tinkoff")
        m = mins.setdefault(key, {"open": r["total"], "close": r["total"],
                                  "high": r["total"], "low": r["total"], "volume": 0})
        m["close"] = r["total"]
        m["high"] = max(m["high"], r["total"])
        m["low"] = min(m["low"], r["total"])
        m["volume"] += 1

    raw_tgld_hours = {}  # (bucket, source) -> [tgld,tmon,lqdt,total,last_epoch]
    for (epoch, source), (tv, tm, lq, tot) in raw_tgld_map.items():
        bucket = epoch // 60 * 60
        key = (bucket, source)
        if key not in raw_tgld_hours or epoch > raw_tgld_hours[key][4]:
            raw_tgld_hours[key] = [tv, tm, lq, tot, epoch]

    for (bucket, source), m in mins.items():
        te = raw_tgld_hours.get((bucket, source))
        cur.execute("""
            INSERT INTO portfolio_min (timestamp, ts_epoch, source, open, high, low, close, volume, tgld_value, tgld_total, tmon_value, lqdt_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ts_epoch, source) DO UPDATE SET
                high = MAX(high, excluded.high),
                low = MIN(low, excluded.low),
                close = excluded.close,
                volume = volume + excluded.volume,
                tgld_value = COALESCE(excluded.tgld_value, tgld_value),
                tgld_total = COALESCE(excluded.tgld_total, tgld_total),
                tmon_value = COALESCE(excluded.tmon_value, tmon_value),
                lqdt_value = COALESCE(excluded.lqdt_value, lqdt_value)
        """, (to_iso(datetime.fromtimestamp(bucket, tz=timezone.utc)), bucket, source,
              m["open"], m["high"], m["low"], m["close"], m["volume"],
              te[0] if te else None, te[3] if te else None,
              te[1] if te else None, te[2] if te else None))
    if mins:
        print(f"📊 Агрегация: {len(mins)} минутных свечей из "
              f"{sum(m['volume'] for m in mins.values())} снапшотов", flush=True)

    # ---------- Шаг 2: минуты → часы (старше RETENTION_MIN_DAYS) ----------
    min_rows = cur.execute("""
        SELECT ts_epoch, source, close AS total
        FROM portfolio_min
        WHERE ts_epoch < ?
        ORDER BY ts_epoch ASC
    """, (min_cutoff,)).fetchall()
    min_tgld = cur.execute("""
        SELECT ts_epoch, source, tgld_value, tgld_total, tmon_value, lqdt_value
        FROM portfolio_min
        WHERE ts_epoch < ?
        ORDER BY ts_epoch ASC
    """, (min_cutoff,)).fetchall()
    min_tgld_map = {}
    for t in min_tgld:
        min_tgld_map[(t["ts_epoch"], t["source"] or "tinkoff")] = (
            t["tgld_value"], t["tmon_value"], t["lqdt_value"], t["tgld_total"])

    hours = {}  # (bucket, source) -> {"open","close","high","low","volume"}
    for r in min_rows:
        bucket = r["ts_epoch"] // 3600 * 3600
        key = (bucket, r["source"] or "tinkoff")
        h = hours.setdefault(key, {"open": r["total"], "close": r["total"],
                                   "high": r["total"], "low": r["total"], "volume": 0})
        h["close"] = r["total"]
        h["high"] = max(h["high"], r["total"])
        h["low"] = min(h["low"], r["total"])
        h["volume"] += 1

    min_tgld_hours = {}  # (bucket, source) -> [tgld,tmon,lqdt,total,last_epoch]
    for (epoch, source), (tv, tm, lq, tot) in min_tgld_map.items():
        bucket = epoch // 3600 * 3600
        key = (bucket, source)
        if key not in min_tgld_hours or epoch > min_tgld_hours[key][4]:
            min_tgld_hours[key] = [tv, tm, lq, tot, epoch]

    for (bucket, source), h in hours.items():
        te = min_tgld_hours.get((bucket, source))
        cur.execute("""
            INSERT INTO portfolio_hourly (timestamp, ts_epoch, source, open, high, low, close, volume, tgld_value, tgld_total, tmon_value, lqdt_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ts_epoch, source) DO UPDATE SET
                high = MAX(high, excluded.high),
                low = MIN(low, excluded.low),
                close = excluded.close,
                volume = volume + excluded.volume,
                tgld_value = COALESCE(excluded.tgld_value, tgld_value),
                tgld_total = COALESCE(excluded.tgld_total, tgld_total),
                tmon_value = COALESCE(excluded.tmon_value, tmon_value),
                lqdt_value = COALESCE(excluded.lqdt_value, lqdt_value)
        """, (to_iso(datetime.fromtimestamp(bucket, tz=timezone.utc)), bucket, source,
              h["open"], h["high"], h["low"], h["close"], h["volume"],
              te[0] if te else None, te[3] if te else None,
              te[1] if te else None, te[2] if te else None))
    if hours:
        print(f"📊 Агрегация: {len(hours)} часовых свечей из "
              f"{sum(h['volume'] for h in hours.values())} минутных", flush=True)

    # ---------- Чистка ----------
    cur.execute("DELETE FROM portfolio_positions WHERE ts_epoch < ?", (raw_cutoff,))
    cur.execute("DELETE FROM portfolio_history WHERE ts_epoch < ?", (raw_cutoff,))
    cur.execute("DELETE FROM portfolio_min WHERE ts_epoch < ?", (min_cutoff,))
    cur.execute("DELETE FROM portfolio_hourly WHERE ts_epoch < ?", (candle_cutoff,))

    conn.commit()


# ================================================================
# Чтение для /api/invest/history (формат ответа сохранён)
# ================================================================

def read_history(period="-35 day", bucket_size=3600, db_path=None, start_epoch=None, end_epoch=None, after_ts=None):
    if not os.path.exists(db_path or DB_PATH):
        return {"_error": "Invest DB not found", "_error_code": 404}
    try:
        tail = after_ts is not None
        if tail:
            # Докачка: только бакеты со снапшотами >= after_ts (включая бакет,
            # содержащий after_ts — живой хвост пересчитывается заново).
            cutoff = int(after_ts)
            period_sec = None
            prev_cutoff = None   # _prev хранится на клиенте с полной загрузкой
        elif start_epoch is not None:
            cutoff = int(start_epoch)
            period_sec = (int(end_epoch) - cutoff) if end_epoch is not None else period_to_seconds(period)
        else:
            cutoff = cutoff_epoch(period)
            period_sec = period_to_seconds(period)
            prev_cutoff = cutoff - period_sec  # начало предыдущего периода
        conn = connect(db_path)
        cur = conn.cursor()

        # Опциональная верхняя граница для явного диапазона from/to
        upper_sql = " AND ts_epoch <= ?" if end_epoch is not None else ""
        upper_params = ([] if end_epoch is None else [int(end_epoch)])

        raw_rows = cur.execute("""
            SELECT timestamp, ts_epoch, source,
                   SUM(value) AS total,
                   SUM(CASE WHEN ticker LIKE '%TGLD%' OR name LIKE '%TGLD%' THEN value ELSE 0 END) AS tgld_val,
                   SUM(CASE WHEN ticker LIKE '%TMON%' OR name LIKE '%TMON%' THEN value ELSE 0 END) AS tmon_val,
                   SUM(CASE WHEN ticker LIKE '%LQDT%' OR name LIKE '%LQDT%' THEN value ELSE 0 END) AS lqdt_val
            FROM portfolio_positions
            WHERE ts_epoch >= ?""" + upper_sql + """
            GROUP BY ts_epoch, source
            ORDER BY ts_epoch ASC
        """, [cutoff] + upper_params).fetchall()

        candles = []
        has_hourly = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_hourly'"
        ).fetchone() is not None
        if has_hourly:
            candles = cur.execute("""
                SELECT timestamp, ts_epoch, source, close AS total, tgld_value, tgld_total, tmon_value, lqdt_value
                FROM portfolio_hourly
                WHERE ts_epoch >= ?""" + upper_sql + """
                ORDER BY ts_epoch ASC
            """, [cutoff] + upper_params).fetchall()

        min_candles = []
        has_min = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_min'"
        ).fetchone() is not None
        if has_min:
            min_candles = cur.execute("""
                SELECT timestamp, ts_epoch, source, close AS total, tgld_value, tgld_total, tmon_value, lqdt_value
                FROM portfolio_min
                WHERE ts_epoch >= ?""" + upper_sql + """
                ORDER BY ts_epoch ASC
            """, [cutoff] + upper_params).fetchall()

        # Обратная совместимость: если за период пусто — отдаём всё, что есть
        # (только в полном режиме; tail-запрос с будущим after_ts = пустая дельта)
        if not tail and not raw_rows and not candles and not min_candles:
            raw_rows = cur.execute("""
                SELECT timestamp, ts_epoch, source,
                       SUM(value) AS total,
                       SUM(CASE WHEN ticker LIKE '%TGLD%' OR name LIKE '%TGLD%' THEN value ELSE 0 END) AS tgld_val,
                       SUM(CASE WHEN ticker LIKE '%TMON%' OR name LIKE '%TMON%' THEN value ELSE 0 END) AS tmon_val,
                       SUM(CASE WHEN ticker LIKE '%LQDT%' OR name LIKE '%LQDT%' THEN value ELSE 0 END) AS lqdt_val
                FROM portfolio_positions
                GROUP BY ts_epoch, source
                ORDER BY ts_epoch ASC
            """).fetchall()

        if not raw_rows and not candles and not min_candles:
            conn.close()
            return {}

        # Ошибки API (spike-фильтр источников) в диапазоне — для меток на графике
        api_errors = []
        has_bot_events = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_events'"
        ).fetchone() is not None
        if has_bot_events:
            err_rows = cur.execute("""
                SELECT ts_epoch, update_type, text
                FROM bot_events
                WHERE chat='API Finam' AND update_type='spike'
                  AND ts_epoch >= ?""" + upper_sql + """
                ORDER BY ts_epoch ASC
            """, [cutoff] + upper_params).fetchall()
            for er in err_rows:
                api_errors.append({"ts_epoch": er["ts_epoch"],
                                   "type": er["update_type"] or "spike",
                                   "text": er["text"] or ""})

        # Слияние: ключ (epoch, source); приоритет raw > min > hourly
        points = {}     # (epoch, source) -> [display_ts, value, tgld_value, tgld_total, tmon_value, lqdt_value]
        raw_epochs = set()
        for r in raw_rows:
            src = r["source"] or "tinkoff"
            if r["total"] is None:
                continue
            tgld_v = r["tgld_val"] if r["tgld_val"] is not None else None
            tmon_v = r["tmon_val"] if r["tmon_val"] is not None else None
            lqdt_v = r["lqdt_val"] if r["lqdt_val"] is not None else None
            points[(r["ts_epoch"], src)] = [
                r["timestamp"], round(r["total"], 2),
                tgld_v, round(r["total"], 2) if tgld_v is not None else None,
                tmon_v, lqdt_v,
            ]
            raw_epochs.add(r["ts_epoch"])
        min_epochs = set()
        for c in min_candles:
            src = c["source"] or "tinkoff"
            if c["total"] is None or c["ts_epoch"] in raw_epochs:
                continue
            min_epochs.add(c["ts_epoch"])
            points[(c["ts_epoch"], src)] = [
                c["timestamp"], round(c["total"], 2),
                c["tgld_value"] if c["tgld_value"] is not None else None,
                c["tgld_total"] if c["tgld_total"] is not None else None,
                c["tmon_value"] if c["tmon_value"] is not None else None,
                c["lqdt_value"] if c["lqdt_value"] is not None else None,
            ]
        for c in candles:
            src = c["source"] or "tinkoff"
            if c["total"] is None or c["ts_epoch"] in raw_epochs or c["ts_epoch"] in min_epochs:
                continue
            points[(c["ts_epoch"], src)] = [
                c["timestamp"], round(c["total"], 2),
                c["tgld_value"] if c["tgld_value"] is not None else None,
                c["tgld_total"] if c["tgld_total"] is not None else None,
                c["tmon_value"] if c["tmon_value"] is not None else None,
                c["lqdt_value"] if c["lqdt_value"] is not None else None,
            ]

        # Бакетинг: последний снапшот за (бакет, source) побеждает
        aggregated = {}  # bucket -> {last_epoch, display_ts, by_source{}, tgld{}}
        for (epoch, src) in sorted(points.keys()):
            display_ts, value, tgld_val, tgld_tot, tmon_val, lqdt_val = points[(epoch, src)]
            bucket = epoch // bucket_size * bucket_size
            agg = aggregated.setdefault(bucket, {
                "last_epoch": epoch, "ts": display_ts,
                "by_source": {}, "tgld": {}
            })
            agg["by_source"][src] = value
            if tgld_val is not None:
                agg["tgld"][src] = {"value": tgld_val, "total": tgld_tot,
                                    "tmon": tmon_val, "lqdt": lqdt_val}
            if epoch >= agg["last_epoch"]:
                agg["last_epoch"] = epoch
                agg["ts"] = display_ts

        # Последние позиции — отдельно по каждому источнику
        latest_positions = []
        latest_epoch = None
        src_latest = cur.execute(
            "SELECT source, MAX(ts_epoch) AS e FROM portfolio_positions GROUP BY source"
        ).fetchall()
        hist_sources = {}
        has_hist = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_history'"
        ).fetchone() is not None
        if has_hist:
            for hr in cur.execute(
                "SELECT source, MAX(ts_epoch) AS e FROM portfolio_history GROUP BY source"
            ).fetchall():
                hist_sources[hr["source"] or "tinkoff"] = hr["e"]
        handled_sources = set()
        for row in src_latest:
            src_epoch = row["e"]
            src = row["source"] or "tinkoff"
            if src_epoch is None:
                continue
            handled_sources.add(src)
            if latest_epoch is None or src_epoch > latest_epoch:
                latest_epoch = src_epoch
            pos_rows = cur.execute("""
                SELECT instrument_type, name, ticker, quantity, value, source
                FROM portfolio_positions
                WHERE ts_epoch = ? AND source = ?
                ORDER BY value DESC
            """, (src_epoch, src)).fetchall()
            if not pos_rows:
                continue
            for r in pos_rows:
                latest_positions.append({
                    "type": r["instrument_type"] or "Other",
                    "name": r["name"] or r["ticker"] or "Unknown",
                    "quantity": round(r["quantity"], 4),
                    "value": round(r["value"], 2),
                    "source": r["source"] or "tinkoff",
                })
        # Источники с пустым снепшотом (0 позиций, но есть portfolio_history) —
        # добавляем синтетическую запись со значением 0, чтобы баннер показывал 0.
        for src, src_epoch in hist_sources.items():
            if src in handled_sources:
                continue
            if latest_epoch is None or src_epoch > latest_epoch:
                latest_epoch = src_epoch
            latest_positions.append({
                "type": "total",
                "name": "Портфель",
                "quantity": 0,
                "value": 0.0,
                "source": src,
            })

        # Previous period data for start-label prevDelta (только полная загрузка,
        # в tail-режиме _prev уже есть на клиенте)
        prev_data = {}
        if not tail:
            try:
                # Check both portfolio_positions and portfolio_hourly
                for tbl in ["portfolio_positions", "portfolio_hourly"]:
                    val_col = "value" if tbl == "portfolio_positions" else "close"
                    prev_rows = cur.execute(f"""
                        SELECT source, MIN(ts_epoch) AS first_e, MAX(ts_epoch) AS last_e
                        FROM {tbl}
                        WHERE ts_epoch >= ? AND ts_epoch < ?
                        GROUP BY source
                    """, (prev_cutoff, cutoff)).fetchall()
                    for pr in prev_rows:
                        src = pr["source"] or "tinkoff"
                        first_val = cur.execute(
                            f"SELECT SUM({val_col}) FROM {tbl} WHERE ts_epoch = ? AND source = ?",
                            (pr["first_e"], src)
                        ).fetchone()[0]
                        last_val = cur.execute(
                            f"SELECT SUM({val_col}) FROM {tbl} WHERE ts_epoch = ? AND source = ?",
                            (pr["last_e"], src)
                        ).fetchone()[0]
                        if first_val and last_val:
                            if src not in prev_data:
                                prev_data[src] = {"start": round(first_val, 2), "end": round(last_val, 2)}
            except Exception:
                pass

        conn.close()

        result = {}
        for bucket in sorted(aggregated.keys()):
            agg = aggregated[bucket]
            items = []
            for s, v in sorted(agg["by_source"].items()):
                item = {"type": "total", "name": "Портфель", "value": round(v, 2), "source": s}
                tgld_info = agg.get("tgld", {}).get(s)
                if tgld_info and tgld_info["total"] and tgld_info["total"] > 0:
                    item["tgld_share"] = round(tgld_info["value"] / tgld_info["total"], 4)
                    if tgld_info.get("tmon") is not None:
                        item["tmon_share"] = round(tgld_info["tmon"] / tgld_info["total"], 4)
                    if tgld_info.get("lqdt") is not None:
                        item["lqdt_share"] = round(tgld_info["lqdt"] / tgld_info["total"], 4)
                items.append(item)
            result[agg["ts"]] = items
        if latest_positions:
            # Позиции всегда в ПОСЛЕДНЕМ ключе, чтобы баннер не читал totals
            target = max(result.keys()) if result else next(
                (ts for (e, _), (ts, _) in points.items() if e == latest_epoch), None)
            if target is not None:
                result[target] = latest_positions
        if prev_data:
            result["_prev"] = prev_data
        if api_errors:
            result["_api_errors"] = api_errors
        if latest_epoch:
            # Точка продолжения дельты (токен секции invest.history) и число
            # бакетов — всегда, чтобы медиатор после полной загрузки мог
            # переключиться на хвост после _latest_epoch.
            result["_latest_epoch"] = latest_epoch
            result["_count"] = len([k for k in result if not k.startswith("_")])
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


def read_prices(period="-28 day", figi=None, db_path=None, start_epoch=None, end_epoch=None):
    """Строки last_prices за период; числовой фильтр по ts_epoch. period=None → без фильтра.
    start_epoch/end_epoch — явный диапазон from/to (перекрывает period)."""
    conn = connect(db_path or TICKERS_DB_PATH)
    def range_clause():
        if start_epoch is not None:
            params = [int(start_epoch)]
            cond = "ts_epoch >= ?"
            if end_epoch is not None:
                cond += " AND ts_epoch <= ?"
                params.append(int(end_epoch))
            return cond, params
        if period is not None:
            return "ts_epoch >= ?", [cutoff_epoch(period)]
        return None, []
    rng, rparams = range_clause()
    if figi:
        sql = "SELECT timestamp, price, ticker, class_code FROM last_prices"
        params = []
        if rng:
            sql += " WHERE figi = ? AND " + rng
            params = [figi] + rparams
        else:
            sql += " WHERE figi = ?"
            params = [figi]
        sql += " ORDER BY ts_epoch ASC"
        rows = conn.execute(sql, params).fetchall()
    else:
        sql = "SELECT figi, ticker, class_code, timestamp, price FROM last_prices"
        params = []
        if rng:
            sql += " WHERE " + rng
            params = rparams
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

    # 3.5) portfolio_min: минутные свечи (детальный анализ за 30 дней)
    mcols = _table_cols(cur, "portfolio_min")
    if not mcols:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS portfolio_min (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                ts_epoch INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'tinkoff',
                open REAL, high REAL, low REAL, close REAL,
                volume INTEGER DEFAULT 0,
                UNIQUE(ts_epoch, source)
            )
        """)
    for mc in ("tgld_value", "tgld_total", "tmon_value", "lqdt_value"):
        if mc not in _table_cols(cur, "portfolio_min"):
            cur.execute(f"ALTER TABLE portfolio_min ADD COLUMN {mc} REAL")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_min_epoch_source ON portfolio_min(ts_epoch, source)")

    # 3) tgld_value / tgld_total / tmon_value / lqdt_value в portfolio_hourly
    cols = _table_cols(cur, "portfolio_hourly")
    if "tgld_value" not in cols:
        cur.execute("ALTER TABLE portfolio_hourly ADD COLUMN tgld_value REAL")
    if "tgld_total" not in cols:
        cur.execute("ALTER TABLE portfolio_hourly ADD COLUMN tgld_total REAL")
    if "tmon_value" not in cols:
        cur.execute("ALTER TABLE portfolio_hourly ADD COLUMN tmon_value REAL")
    if "lqdt_value" not in cols:
        cur.execute("ALTER TABLE portfolio_hourly ADD COLUMN lqdt_value REAL")

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


def finam_tier_rate(total):
    """Брокерская ставка «Трейдер n6» по брекету дневного оборота (регрессивная шкала)."""
    for cap, r in FINAM_MOEX_TIERS:
        if total <= cap:
            return r
    return FINAM_MOEX_TIERS[-1][1]


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
    try:
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
            # Комиссия: Tinkoff — реальная из API; Finam — оценка по тарифу:
            # брекетная ставка дневного оборота + урегулирование СПБ 0,01%
            # (стратегия Финама торгует по СПБ; guess_exchange-биржа не влияет).
            for src, d in (er := cur.execute(
                    "SELECT source, SUM(sum) AS total, SUM(commission) AS real_comm"
                    " FROM trades WHERE ts_epoch >= ? AND ts_epoch < ? GROUP BY source",
                    (day_start, day_end)).fetchall()):
                comm = (float(d["real_comm"] or 0) if src != "finam"
                        else finam_commission_estimate(0, float(d["total"] or 0)))
                cur.execute("UPDATE turnover_daily SET commission=? WHERE day=? AND source=?",
                            (round(comm, 2), day, src))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
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


def read_report(period="-90 day", db_path=None):
    """Дневные строки отчёта за период (БЕЗ итогов — агрегацию строк по интервалу
    и итоги периода делает клиент).

    На каждый (день, источник) отдаёт:
      cap_start / cap_end — первая/последняя часовая свеча дня (portfolio_hourly),
      volume — объём торгов (turnover_daily buy+sell, фолбэк strategy_summary.turnover),
      commission — комиссия дня (turnover_daily.commission; фолбэк strategy_summary,
        иначе расчёт: tinkoff 0.02% объёма, finam тариф «Трейдер»),
      rate — ставка комиссии % (tinkoff 0.02; finam фактическая commission/объём).

    Дни без данных по капиталу (нет hourly) — cap_start/cap_end = None
    (ячейки таблицы остаются пустыми).
    """
    cutoff = cutoff_epoch(period)
    conn = connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row

    # Капитал: первая/последняя точка (день, источник) из portfolio_hourly +
    # portfolio_positions (сырые снапшоты так же, как /api/invest/history).
    # Hourly покрывает начало/конец ночи и старые дни; positions уточняют
    # конец текущего дня, когда hourly-демон остановился.
    hourly = conn.execute("""
        SELECT date(timestamp) AS d, source, ts_epoch, close
        FROM portfolio_hourly
        WHERE ts_epoch >= ?
        ORDER BY ts_epoch ASC
    """, (cutoff,)).fetchall()
    positions = conn.execute("""
        SELECT date(timestamp) AS d, source, ts_epoch, SUM(value) AS total
        FROM portfolio_positions
        WHERE ts_epoch >= ?
        GROUP BY ts_epoch, source
        ORDER BY ts_epoch ASC
    """, (cutoff,)).fetchall()
    cap = {}  # (day, source) -> {"start": .., "end": ..}
    def add_cap_point(day, src, ts, val):
        if val is None:
            return
        key = (day, src or "tinkoff")
        e = cap.setdefault(key, {"start": None, "end": None, "e0": None, "e1": None})
        if e["e0"] is None or ts < e["e0"]:
            e["e0"], e["start"] = ts, val
        if e["e1"] is None or ts > e["e1"]:
            e["e1"], e["end"] = ts, val
    for h in hourly:
        add_cap_point(h["d"], h["source"], h["ts_epoch"], h["close"])
    for p in positions:
        add_cap_point(p["d"], p["source"], p["ts_epoch"], p["total"])

    # Объём/комиссия: turnover_daily
    vol = {}  # (day, source) -> {"volume": .., "commission": ..}
    for r in conn.execute(
            "SELECT day, source, buy, sell, commission FROM turnover_daily"
            " WHERE day >= ?", (datetime.fromtimestamp(cutoff, tz=timezone.utc).strftime("%Y-%m-%d"),)).fetchall():
        src = r["source"] or "tinkoff"
        vol[(r["day"], src)] = {
            "volume": round((r["buy"] or 0) + (r["sell"] or 0), 2),
            "commission": r["commission"] or 0.0,
        }

    # Фолбэк объёма/комиссии: сводки стратегии из Telegram
    strat = {}
    for r in conn.execute(
            "SELECT day, source, turnover, commission FROM strategy_summary"
            " WHERE day IS NOT NULL AND day != '' AND day >= ?",
            (datetime.fromtimestamp(cutoff, tz=timezone.utc).strftime("%Y-%m-%d"),)).fetchall():
        src = r["source"] or "tinkoff"
        key = (r["day"], src)
        if r["turnover"]:
            v = strat.setdefault(key, {"volume": 0.0, "commission": None})
            v["volume"] = max(v["volume"], float(r["turnover"]))
            if r["commission"]:
                v["commission"] = float(r["commission"])
    conn.close()

    days = {}
    for (day, src) in set(cap) | set(vol) | set(strat):
        if day not in days:
            days[day] = {}
        c = cap.get((day, src), {})
        s = strat.get((day, src), {})
        v = vol.get((day, src), {}).get("volume")
        # Аномальный turnover_daily (например, счёт номиналов TGLD на T) —
        # берём оборот стратегии, если тот заметно меньше.
        if v is not None and s.get("volume") and v > 3 * s["volume"]:
            v = s["volume"]
        if v is None:
            v = s.get("volume", 0.0) or 0.0
        comm = vol.get((day, src), {}).get("commission")
        if comm is None:
            comm = s.get("commission")
        if comm is None:
            comm = round(v * 0.0002, 2) if src == "tinkoff" else round(finam_commission_estimate(0, v), 2)
        if src == "tinkoff":
            rate = 0.02
        elif v:
            # брокерская ставка «Трейдер n6» по брекету + урегулирование СПБ 0,01%
            rate = round((finam_tier_rate(v) + FINAM_SETTLE_SPB) * 100, 4)
        else:
            rate = None
        days[day][src] = {
            "cap_start": c.get("start"),
            "cap_end": c.get("end"),
            "volume": round(v, 2),
            "commission": round(comm, 2),
            "rate": rate,
        }

    return {d: days[d] for d in sorted(days)}


# ================================================================
# Размер и структура капитала (последний снимок по источникам)
# ================================================================

def read_capital_structure(db_path=None):
    """Последний снимок по каждому источнику: размер и структура капитала.

    Возвращает {source: {ts, total, cash: {CUR: amount}, positions: [...]}}.
    Позиции — инструменты из последнего совмока; cash — псевдопозиции
    юниксу (instrument_type 'Currency'), которые демоны кладут отдельно.
    total = сумма всех позиций (включая кэш) в снепшоте.
    """
    conn = connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    out = {}
    latest = conn.execute(
        "SELECT source, MAX(ts_epoch) AS e FROM portfolio_positions GROUP BY source"
    ).fetchall()
    for row in latest:
        src = row["source"] or "tinkoff"
        e = row["e"]
        if e is None:
            continue
        ts_row = conn.execute(
            "SELECT timestamp FROM portfolio_positions WHERE source=? AND ts_epoch=? LIMIT 1",
            (src, e)).fetchone()
        pos_rows = conn.execute(
            "SELECT instrument_type, name, ticker, quantity, price, value"
            " FROM portfolio_positions WHERE source=? AND ts_epoch=?"
            " ORDER BY value DESC", (src, e)).fetchall()
        positions, cash, total = [], {}, 0.0
        for r in pos_rows:
            val = round(r["value"] or 0, 2)
            total += val
            if (r["instrument_type"] or "").lower() == "currency":
                cash[r["ticker"] or "RUB"] = val
            else:
                positions.append({
                    "instrument_type": r["instrument_type"] or "Other",
                    "name": r["name"] or r["ticker"] or "Unknown",
                    "ticker": r["ticker"] or "",
                    "quantity": round(r["quantity"] or 0, 4),
                    "price": round(r["price"] or 0, 6),
                    "value": val,
                })
        out[src] = {
            "ts": ts_row["timestamp"] if ts_row else None,
            "total": round(total, 2),
            "cash": cash,
            "positions": positions,
        }
    conn.close()
    return out


# ================================================================
# Отчёты об ошибках бота (bot_events)
# --------------------------------
# Классификация на лету по тексту сообщений каналов
# «Сделки Бота — ПРОД … (TGLD)». Уровни: block / warn / info.
# ================================================================

BOT_LEVELS = ["block", "warn", "info"]

# Категории: balance, ratio, order, stat, tradecycle, lib, reminder,
#            ok, session, analytics, balance_chip, other
_BOT_TICKER_RE = re.compile(r"(TGLD@|GLDRUB[_A-Za-z0-9]*|BTCUSDperp[A-Za-z0-9]*|BTC)")
_BOT_ACC_RE = re.compile(r"(?:account=|на счёте |order-poster |на )([A-Za-z][A-Za-z0-9_.]+)")
_BOT_KNOWN_ACC = [
    "sergey_brok", "prod_finam_tgld_sergey", "preprod_tinv_btc_david",
    "prod_tinkoff_tgld_sergey", "preprod_finam_tgld_sergey",
    "preprod_tinkoff_tgld_sergey",
]


def classify_bot_event(text):
    """Классификация сообщения бота по реальным шаблонам каналов стратегии.
    Возвращает (level, category) или None для пустого текста."""
    if not text:
        return None
    if ("СТОП-ТОРГИ" in text
            or "не удалось подтвердить, что все ордера" in text
            or "остановлена до конца дня" in text):
        return "block", "order"
    if "BalanceChecker" in text or "пробил порог" in text or "пробил стоп" in text:
        return "block", "balance"
    if "RatioChecker" in text and ("приостановил" in text or "НЕ в норме" in text):
        return "block", "ratio"
    if "❌" in text:
        return "block", "other"
    if text.startswith("[spike]") or "Источник: API Finam" in text:
        return "warn", "other"
    if "ADH" in text and "УМЕР" in text:
        return "warn", "other"
    if "T-test" in text or "t_obs=" in text:
        return "warn", "stat"
    if "ошибка в торговом цикле" in text:
        return "warn", "tradecycle"
    if "order-poster" in text and "залип" in text:
        return "warn", "order"
    if "недостаточная ликвидность" in text:
        return "warn", "lib"
    if "ВСЁ ЕЩЁ остановлена" in text or text.startswith("⏰"):
        return "warn", "reminder"
    if "✅" in text:
        return "info", "ok"
    if "📈" in text or "Результаты торговой сессии" in text:
        return "info", "session"
    if "📊" in text or "Kalman" in text or "Графики продовых данных" in text \
            or "Комплексные данные" in text or "сравнение anchor" in text:
        return "info", "analytics"
    if text.startswith("💼"):
        return "info", "balance_chip"
    return "info", "other"


def bot_account(text, chat):
    """Аккаунт из текста сообщения; фолбэк — короткое имя канала.
    Принимаем только известные имена стратегии: явный allowlist либо
    (prod|preprod)_* — случайные слова вроде 'REST'/'WSS' отбрасываются."""
    m = _BOT_ACC_RE.search(text or "")
    if m:
        cand = m.group(1).rstrip(".").rstrip("_")
        if cand in _BOT_KNOWN_ACC or cand.startswith(("prod_", "preprod_")):
            return cand
    for a in _BOT_KNOWN_ACC:
        if a in (text or ""):
            return a
    if "Финам" in (chat or ""):
        return "finam"
    if "Т-Инвест" in (chat or "") or "Тинькофф" in (chat or ""):
        return "tinkoff"
    return "other"


def bot_ticker(text):
    m = _BOT_TICKER_RE.search(text or "")
    return m.group(1) if m else ""


def read_bot_events(period="-35 day", db_path=None):
    """События бота за период: {events: [...], summary: {...}}.
    Классификация и парсинг полей — на лету, БД хранит raw-текст."""
    cutoff = cutoff_epoch(period)
    conn = connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT chat, ts_epoch, update_type, text, msg_id"
        " FROM bot_events WHERE ts_epoch >= ?"
        " AND (chat LIKE 'Сделки Бота %' OR chat = 'API Finam')"
        " ORDER BY ts_epoch ASC", (cutoff,)).fetchall()
    conn.close()

    events = []
    summary = {
        "total": 0,
        "levels": {k: 0 for k in BOT_LEVELS},
        "categories": {},
        "accounts": {},
        "channels": {},
        "first_ts": None,
        "last_ts": None,
    }
    for r in rows:
        cls = classify_bot_event(r["text"]) or ("info", "other")
        lvl, cat = cls
        acc = bot_account(r["text"], r["chat"])
        ticker = bot_ticker(r["text"])
        events.append({
            "ts": r["ts_epoch"],
            "msg_id": r["msg_id"],
            "chat": r["chat"],
            "type": r["update_type"],
            "level": lvl,
            "category": cat,
            "account": acc,
            "ticker": ticker,
            "text": r["text"] or "",
        })
        s = summary
        s["total"] += 1
        s["levels"][lvl] += 1
        if s["first_ts"] is None or r["ts_epoch"] < s["first_ts"]:
            s["first_ts"] = r["ts_epoch"]
        if s["last_ts"] is None or r["ts_epoch"] > s["last_ts"]:
            s["last_ts"] = r["ts_epoch"]
        c = s["categories"].setdefault(cat, {"total": 0, "levels": {k: 0 for k in BOT_LEVELS}})
        c["total"] += 1
        c["levels"][lvl] += 1
        s["accounts"][acc] = s["accounts"].get(acc, 0) + 1
        s["channels"][r["chat"]] = s["channels"].get(r["chat"], 0) + 1

    for c in summary["categories"].values():
        s = c["levels"]
        if s.get("block"):
            c["level"] = "block"
        elif s.get("warn"):
            c["level"] = "warn"
        else:
            c["level"] = "info"

    return {"events": events, "summary": summary}
