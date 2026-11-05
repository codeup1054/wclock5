"""Запись истории планшета в горячую БД WClock.

Пишем в две таблицы:
  • invest_buckets (res='min') — её читают графики;
  • portfolio_history — совместимость и индикатор свежести.
Ключ дедупликации: (source, ts_epoch). Расхождения фиксируются, но не
перезаписывают живое значение десктопа.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

TOL_ABS = 1.0
TOL_REL = 3e-3   # 0.3%: точки сняты в разные секунды, это шум


def _differs(a: float, b: float) -> bool:
    return abs(a - b) > max(TOL_ABS, abs(a) * TOL_REL)


def _hour_end_match(cur, src: str, ts: int, val: float) -> bool:
    """Seed планшета: метка = начало часа, значение = close одной из минут часа.

    Seed собирается из незавершённого часа, поэтому значение может совпасть
    с любой минутой внутри [ts, ts+1ч). Совпадение = другая семантика метки,
    а не расхождение данных.
    """
    if ts % 3600 != 0:
        return False
    rows = cur.execute(
        "SELECT close FROM invest_buckets "
        "WHERE source=? AND res='min' AND ts_epoch>=? AND ts_epoch<?",
        (src, ts, ts + 3600)).fetchall()
    return any(r[0] is not None and not _differs(val, float(r[0])) for r in rows)


class HotDB:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.conn.execute("PRAGMA busy_timeout=5000")
        self._ensure_index()

    def _ensure_index(self) -> None:
        try:
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_portfolio_history_source_ts "
                "ON portfolio_history(source, ts_epoch)")
        except Exception:
            pass

    def merge(self, points: list[dict], now_ms: int | None = None) -> dict:
        added_hist = added_bucket = 0
        diverged: dict[tuple, dict] = {}
        if not points:
            return {"added_history": 0, "added_buckets": 0,
                    "diverged": [], "total": self.count()}
        now_ms = int(now_ms or 0)
        cur = self.conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            for p in points:
                src = p["source"]
                if src == "total":
                    continue
                ts = int(p["ts"]) // 1000
                val = float(p["value"])
                iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()

                # portfolio_history — живая таблица: демоны сворачивают и
                # удаляют из неё старое. Исторические точки планшета туда не
                # пишем, иначе каждый sync заново вставляет сотни строк.
                fresh = now_ms and (now_ms - int(p["ts"])) <= 10 * 60 * 1000
                if fresh:
                    row = cur.execute(
                        "SELECT total_value FROM portfolio_history "
                        "WHERE source=? AND ts_epoch=? ORDER BY id DESC LIMIT 1",
                        (src, ts)).fetchone()
                    if row is None:
                        cur.execute(
                            "INSERT INTO portfolio_history(timestamp, ts_epoch, total_value, source) "
                            "VALUES (?,?,?,?)", (iso, ts, val, src))
                        added_hist += 1
                    elif _differs(val, float(row[0])) and not _hour_end_match(cur, src, ts, val):
                        diverged.setdefault((src, ts), {
                            "source": src, "ts": ts * 1000,
                            "hot": float(row[0]), "tablet": val})

                brow = cur.execute(
                    "SELECT close FROM invest_buckets "
                    "WHERE ts_epoch=? AND source=? AND res='min'",
                    (ts, src)).fetchone()
                if brow is None:
                    cur.execute(
                        "INSERT INTO invest_buckets(timestamp, ts_epoch, source, res, "
                        "open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,?,0)",
                        (iso, ts, src, "min", val, val, val, val))
                    added_bucket += 1
                elif brow[0] is not None and _differs(val, float(brow[0]))                         and not _hour_end_match(cur, src, ts, val):
                    diverged.setdefault((src, ts), {
                        "source": src, "ts": ts * 1000,
                        "hot": float(brow[0]), "tablet": val})
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise
        return {"added_history": added_hist, "added_buckets": added_bucket,
                "diverged": list(diverged.values()), "total": self.count()}

    def count(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) FROM portfolio_history").fetchone()
        return int(row[0] or 0)

    def max_ts_by_source(self) -> dict:
        return {r[0]: int(r[1] or 0) for r in self.conn.execute(
            "SELECT source, MAX(ts_epoch) FROM portfolio_history GROUP BY source")}

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass
